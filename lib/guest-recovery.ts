import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import {
    findOrderBySecondFactor,
    persistGuestAccessToken,
} from "@/lib/guest-order-access";
import {
    generateGuestAccessToken,
    generateRecoveryCode,
    hashContact,
    hashRecoveryCode,
    normalizeEmail,
    normalizePhone,
    safeEqual,
} from "@/lib/guest-identity";
import { sendRawNotificationNow } from "@/lib/notification/order-status-handler";

/**
 * ==========================================
 * GUEST ORDER RECOVERY — TWO-PHASE OTP
 * ==========================================
 *
 * The storefront is 100% guest-based for customers, so a buyer has no
 * account to fall back on: their order is reachable through the
 * httpOnly access-token cookie issued at checkout.
 *
 * This module is the recovery path for the two cases that cookie
 * cannot cover:
 *
 *   1. the buyer cleared cookies / switched device or browser, or
 *   2. the order's 30-day access window expired.
 *
 * ----------------------------------------------------------------
 * PHASE 1 — REQUEST   (startGuestRecovery)
 * ----------------------------------------------------------------
 * The buyer supplies the order number PLUS the email or phone used at
 * checkout. Both must match the order. That alone is NOT ownership —
 * both values are things an attacker who read an old confirmation
 * email could hold — so it only ever results in a ONE-TIME CODE being
 * sent to a contact captured on the order. NO access token is
 * rotated, issued or revealed at this point.
 *
 * ----------------------------------------------------------------
 * DELIVERY CHANNEL
 * ----------------------------------------------------------------
 * The code can go out over either channel, and the buyer chooses:
 *
 *   "whatsapp" (default) — to the checkout phone on the order.
 *   "email"             — to the checkout EMAIL on the order. This
 *                          channel additionally requires the email
 *                          factor itself to match (a phone-only match
 *                          may not open an email delivery), and the
 *                          recipient is always the address STORED ON
 *                          THE ORDER, never one typed into the form.
 *
 * Both channels share one challenge model: same code, same hashing,
 * same TTL, same attempt limit, same single-use redemption, same
 * contact binding and the same burn-on-delivery-failure rule.
 *
 * ----------------------------------------------------------------
 * PHASE 2 — CONFIRM   (confirmGuestRecovery)
 * ----------------------------------------------------------------
 * The buyer returns the challenge id, the code, and the SAME contact.
 * Only when all three verify is a fresh access token minted (30-day
 * server-side window) and handed to the route for the httpOnly cookie.
 *
 * ----------------------------------------------------------------
 * PROPERTIES OF A CHALLENGE
 * ----------------------------------------------------------------
 *   * SINGLE USE — the redemption claim is a conditional update on
 *     `consumedAt`, so a replayed code (or two concurrent confirmations)
 *     can never mint two tokens.
 *   * SHORT LIVED — RECOVERY_CODE_TTL_MS (10 minutes).
 *   * ATTEMPT LIMITED — RECOVERY_CODE_MAX_ATTEMPTS failures burn it, so
 *     the 6-digit space cannot be brute-forced.
 *   * ORDER + CONTACT BOUND — the challenge stores the order id and a
 *     KEYED HASH of the exact checkout contact that was matched in
 *     phase 1; phase 2 must re-present that same contact.
 *   * FAIL CLOSED — a challenge whose OTP could not be handed to the
 *     provider is consumed immediately and is never usable, so a
 *     delivery failure can not silently degrade into an unauthenticated
 *     recovery.
 *
 * Only keyed hashes are persisted: the raw code and the raw contact are
 * never written to the database, never logged, and never returned in a
 * response body.
 */

/** How long a delivered code stays usable. */
export const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;

/** Wrong-code attempts before the challenge is burned. */
export const RECOVERY_CODE_MAX_ATTEMPTS = 5;

/** TTL in whole minutes, as quoted in the message copy. */
const RECOVERY_TTL_MINUTES = Math.round(
    RECOVERY_CODE_TTL_MS / 60000
);

/** Digits in the OTP. */
export const RECOVERY_CODE_LENGTH = 6;

/**
 * How the one-time code reaches the buyer. Both are transports for the
 * SAME challenge model — only the delivery endpoint differs.
 */
export type RecoveryChannel = "whatsapp" | "email";

/**
 * WhatsApp remains the default, so an unchanged caller (and any older
 * client) keeps the exact behaviour it had before email existed.
 */
export const DEFAULT_RECOVERY_CHANNEL: RecoveryChannel =
    "whatsapp";

export type StartRecoveryResult =
    | { ok: true; challengeId: string }
    | {
          ok: false;
          reason:
              | "NOT_FOUND"
              | "ACCOUNT_ORDER"
              | "DELIVERY_FAILED";
      };

export type ConfirmRecoveryResult =
    | {
          ok: true;
          orderId: number;
          orderNumber: string;
          /** RAW token — only ever handed to the httpOnly cookie. */
          token: string;
      }
    | {
          ok: false;
          reason:
              | "NOT_FOUND"
              | "INVALID"
              | "EXPIRED"
              | "EXHAUSTED";
      };

/**
 * ==========================================
 * PHASE 1 — REQUEST A CODE
 * ==========================================
 */
export async function startGuestRecovery(input: {
    orderNumber: string;
    email?: unknown;
    phone?: unknown;
    /** Delivery channel; defaults to WhatsApp. */
    channel?: RecoveryChannel;
}): Promise<StartRecoveryResult> {
    /*
     * Normalized once, so an unknown/absent value can only ever fall
     * back to the original WhatsApp behaviour.
     */
    const channel: RecoveryChannel =
        input.channel === "email" ? "email" : "whatsapp";

    const order = await findOrderBySecondFactor({
        orderNumber: input.orderNumber,
        email: input.email,
        phone: input.phone,
    });

    /*
     * Uniform NOT_FOUND for "no such order" and "contact mismatch", so
     * this endpoint cannot be used to test whether an order number
     * exists.
     */
    if (!order) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    /*
     * A logged-in order is recovered by signing in, not by an OTP: the
     * session is the stronger factor and re-issuing a guest token for an
     * account-owned order would create a second, weaker credential.
     */
    if (order.userId) {
        return { ok: false, reason: "ACCOUNT_ORDER" };
    }

    /*
     * The delivery endpoints are the contacts STORED ON THE ORDER —
     * never values supplied by the caller. Without one for the chosen
     * channel there is nothing to prove ownership over, so recovery
     * must not proceed.
     */
    const deliveryPhone = normalizePhone(order.phone);
    const storedEmail = normalizeEmail(order.customerEmail);

    /*
     * Which checkout contact did the buyer actually match on? Recorded
     * (as a hash) so phase 2 can require the SAME factor again, and so
     * the audit trail shows what was proven.
     */
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);

    const matchedEmail = Boolean(
        email &&
            storedEmail &&
            email === storedEmail
    );
    const matchedPhone = Boolean(
        phone && phone === deliveryPhone
    );

    if (!matchedEmail && !matchedPhone) {
        /* Unreachable via findOrderBySecondFactor — fail closed anyway. */
        return { ok: false, reason: "NOT_FOUND" };
    }

    /*
     * ==========================================
     * CHANNEL-SPECIFIC RECIPIENT
     * ==========================================
     *
     * The recipient is DERIVED FROM THE ORDER, so "email penerima harus
     * cocok dengan email yang tersimpan pada order" holds by
     * construction rather than by trusting the form.
     *
     * The email channel is additionally gated on the EMAIL factor
     * having matched: knowing the phone (or the order number) must not
     * be enough to make the server mail a code out. A caller that
     * cannot prove the email gets the same uniform NOT_FOUND as a
     * wrong order number, so this is not an email-existence oracle.
     */
    let recipient: string | null;

    if (channel === "email") {
        if (!matchedEmail) {
            return { ok: false, reason: "NOT_FOUND" };
        }

        recipient = storedEmail;
    } else {
        recipient = deliveryPhone;
    }

    if (!recipient) {
        /*
         * No usable endpoint for this channel → FAIL CLOSED, exactly as
         * for a delivery failure. Never fall back to another channel:
         * the code must only travel where the buyer asked, and never
         * hand out a token on contact knowledge alone.
         */
        console.error(
            "[GUEST RECOVERY] Order has no usable delivery contact | order:",
            order.orderNumber,
            "| channel:",
            channel
        );

        return { ok: false, reason: "DELIVERY_FAILED" };
    }

    const challengeId = crypto.randomUUID();
    const code = generateRecoveryCode();
    const expiresAt = new Date(Date.now() + RECOVERY_CODE_TTL_MS);

    /*
     * Exactly ONE live code per order: requesting a new code invalidates
     * every outstanding challenge for that order, so an older (possibly
     * leaked) code can never be redeemed after a re-request.
     */
    await prisma.$transaction(async (tx) => {
        await tx.guestRecoveryChallenge.updateMany({
            where: {
                orderId: order.id,
                consumedAt: null,
            },
            data: {
                consumedAt: new Date(),
                deliveryError:
                    "Digantikan oleh permintaan kode verifikasi baru.",
            },
        });

        await tx.guestRecoveryChallenge.create({
            data: {
                id: challengeId,
                orderId: order.id,
                orderNumber: order.orderNumber,
                /** Transport used for this challenge's code. */
                channel,
                contactChannel: matchedEmail
                    ? "email"
                    : "phone",
                contactHash: hashContact(
                    matchedEmail
                        ? email!
                        : phone!
                ),
                codeHash: hashRecoveryCode(
                    challengeId,
                    code
                ),
                maxAttempts: RECOVERY_CODE_MAX_ATTEMPTS,
                expiresAt,
            },
        });
    });

    /*
     * Deliver through the EXISTING notification pipeline (same provider
     * selection, same Notification table, now channel-aware), but
     * SYNCHRONOUSLY: the buyer must be told the truth about whether a
     * code was actually sent, and an undelivered code must never look
     * like a usable one.
     */
    const delivery = await sendRawNotificationNow({
        orderId: order.id,
        channel,
        notificationType: "GUEST_RECOVERY_OTP",
        /* Order-derived for the chosen channel (see above). */
        recipient,
        orderNumber: order.orderNumber,
        /* One key per challenge: a re-request is a new message. */
        idempotencyKey: `notif_recovery_otp_${challengeId}`,
        rawMessage:
            channel === "email"
                ? buildRecoveryEmail({
                      code,
                      orderNumber: order.orderNumber,
                  })
                : buildRecoveryMessage({
                      code,
                      orderNumber: order.orderNumber,
                  }),
    });

    if (!delivery.success) {
        /*
         * FAIL CLOSED: burn the challenge. There is no code in
         * circulation, so nothing may redeem one.
         */
        await prisma.guestRecoveryChallenge.updateMany({
            where: { id: challengeId },
            data: {
                consumedAt: new Date(),
                deliveryError:
                    delivery.errorCode ??
                    "DELIVERY_FAILED",
            },
        });

        console.error(
            "[GUEST RECOVERY] OTP delivery failed | order:",
            order.orderNumber,
            "| channel:",
            channel,
            "| code:",
            delivery.errorCode ?? "UNKNOWN"
        );

        return { ok: false, reason: "DELIVERY_FAILED" };
    }

    await prisma.guestRecoveryChallenge.updateMany({
        where: { id: challengeId },
        data: {
            deliveredAt: new Date(),
            notificationId: delivery.notificationId ?? null,
        },
    });

    console.log(
        "[GUEST RECOVERY] Challenge created | order:",
        order.orderNumber,
        "| challenge:",
        challengeId,
        "| channel:",
        channel,
        "| expires:",
        expiresAt.toISOString()
    );

    return { ok: true, challengeId };
}

/**
 * ==========================================
 * PHASE 2 — CONFIRM THE CODE
 * ==========================================
 */
export async function confirmGuestRecovery(input: {
    challengeId: string;
    code: string;
    /** Same checkout contact that phase 1 matched. */
    email?: unknown;
    phone?: unknown;
}): Promise<ConfirmRecoveryResult> {
    const challenge =
        await prisma.guestRecoveryChallenge.findUnique({
            where: { id: input.challengeId },
        });

    /*
     * Everything that fails shape/ownership checks answers with the SAME
     * uniform NOT_FOUND, so a challenge id cannot be probed.
     */
    if (!challenge || challenge.consumedAt) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    /* Never delivered → never usable (fail closed). */
    if (!challenge.deliveredAt) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
        return { ok: false, reason: "EXPIRED" };
    }

    if (challenge.maxAttempts <= challenge.attempts) {
        return { ok: false, reason: "EXHAUSTED" };
    }

    /*
     * CONTACT BINDING — the challenge is bound to the order AND to the
     * checkout contact proven in phase 1, and the buyer must present
     * that same contact again. A stolen/guessed code is therefore not
     * enough on its own.
     */
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);

    const contactCandidates = [email, phone].filter(
        (value): value is string => Boolean(value)
    );

    const contactMatches = contactCandidates.some(
        (value) =>
            safeEqual(
                hashContact(value),
                challenge.contactHash
            )
    );

    if (!contactMatches) {
        await burnAttempt(challenge.id, challenge.maxAttempts);

        return { ok: false, reason: "INVALID" };
    }

    /*
     * Count the attempt BEFORE comparing, so a wrong code can never be
     * tried more than maxAttempts times even under concurrency.
     */
    const counted =
        await prisma.guestRecoveryChallenge.updateMany({
            where: {
                id: challenge.id,
                consumedAt: null,
                attempts: {
                    lt: challenge.maxAttempts,
                },
            },
            data: {
                attempts: { increment: 1 },
            },
        });

    if (counted.count === 0) {
        return { ok: false, reason: "EXHAUSTED" };
    }

    const expected = hashRecoveryCode(
        challenge.id,
        input.code
    );

    if (!safeEqual(expected, challenge.codeHash)) {
        const remaining = challenge.attempts + 1;

        if (remaining >= challenge.maxAttempts) {
            await burnAttempt(
                challenge.id,
                challenge.maxAttempts
            );

            return { ok: false, reason: "EXHAUSTED" };
        }

        return { ok: false, reason: "INVALID" };
    }

    /*
     * ==========================================
     * SINGLE-USE CLAIM
     * ==========================================
     *
     * The conditional update is the redemption: exactly one caller can
     * move a challenge from "unconsumed" to "consumed", so a replayed
     * code (or two parallel confirmations) mints at most one token.
     */
    const claimed =
        await prisma.guestRecoveryChallenge.updateMany({
            where: {
                id: challenge.id,
                consumedAt: null,
            },
            data: { consumedAt: new Date() },
        });

    if (claimed.count === 0) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    const order = await prisma.order.findUnique({
        where: { id: challenge.orderId },
        select: {
            id: true,
            orderNumber: true,
            userId: true,
        },
    });

    if (!order || order.userId) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    /*
     * ==========================================
     * TOKEN ISSUANCE (ONLY NOW)
     * ==========================================
     *
     * The raw token is minted here — after the OTP — and only its hash
     * plus the 30-day window are persisted. The caller puts the raw
     * value in an httpOnly cookie and nowhere else.
     */
    const token = await issueRecoveredToken(order.id);

    console.log(
        "[GUEST RECOVERY] Access restored | order:",
        order.orderNumber,
        "| challenge:",
        challenge.id
    );

    return {
        ok: true,
        orderId: order.id,
        orderNumber: order.orderNumber,
        token,
    };
}

/**
 * ==========================================
 * INTERNAL
 * ==========================================
 */

/**
 * Burn the remaining attempts (used when the attempt budget is spent or
 * the contact binding fails), so a challenge can never be retried after
 * it is no longer trustworthy.
 */
async function burnAttempt(
    challengeId: string,
    maxAttempts: number
): Promise<void> {
    await prisma.guestRecoveryChallenge.updateMany({
        where: { id: challengeId },
        data: {
            attempts: maxAttempts,
            consumedAt: new Date(),
            deliveryError:
                "Batas percobaan verifikasi tercapai.",
        },
    });
}

/**
 * Mint + persist a fresh guest access token (hash and 30-day window in
 * one write) and return the RAW value for the cookie.
 */
async function issueRecoveredToken(
    orderId: number
): Promise<string> {
    const token = generateGuestAccessToken();

    await persistGuestAccessToken(orderId, token);

    return token;
}

/**
 * The WhatsApp body. The code is the ONLY sensitive part and it is
 * never logged — only this message (sent straight to the provider) ever
 * contains it.
 */
function buildRecoveryMessage(input: {
    code: string;
    orderNumber: string;
}): string {
    const minutes = RECOVERY_TTL_MINUTES;

    return [
        "*Kode Verifikasi Akses Pesanan*",
        "",
        `Kode: *${input.code}*`,
        "",
        `Pesanan: ${input.orderNumber}`,
        `Kode berlaku ${minutes} menit dan hanya dapat dipakai sekali.`,
        "",
        "Jika Anda tidak meminta kode ini, abaikan pesan ini. Jangan bagikan kode kepada siapa pun, termasuk yang mengaku sebagai tim kami.",
    ].join("\n");
}

/**
 * The EMAIL body (plain text; the provider renders the HTML part).
 *
 * Same single-use / expiry warning as WhatsApp, without the messaging
 * markdown. The code is the only sensitive part and this string is
 * handed straight to the mailer — never logged or persisted.
 */
function buildRecoveryEmail(input: {
    code: string;
    orderNumber: string;
}): string {
    const minutes = RECOVERY_TTL_MINUTES;

    return [
        "Kode Verifikasi Akses Pesanan",
        "",
        `Kode: ${input.code}`,
        "",
        `Pesanan: ${input.orderNumber}`,
        `Kode berlaku ${minutes} menit dan hanya dapat dipakai sekali.`,
        "",
        "Jika Anda tidak meminta kode ini, abaikan email ini. Jangan bagikan kode kepada siapa pun, termasuk yang mengaku sebagai tim kami.",
        "",
        "Email ini dikirim otomatis. Mohon tidak membalas.",
    ].join("\n");
}
