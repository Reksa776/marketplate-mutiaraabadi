import { NextResponse } from "next/server";
import { z } from "zod";

import {
    getClientIp,
    guestDeviceKey,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import {
    RECOVERY_CODE_TTL_MS,
    startGuestRecovery,
} from "@/lib/guest-recovery";
import {
    hashContact,
    normalizeEmail,
    normalizePhone,
} from "@/lib/guest-identity";

/**
 * ==========================================
 * GUEST ORDER RECOVERY — PHASE 1 (REQUEST)
 * /api/orders/recover
 * ==========================================
 *
 * A guest buyer has no account, so their order is normally reachable
 * through the httpOnly access-token cookie issued at checkout. This
 * endpoint is the RECOVERY path for the two cases that cookie cannot
 * cover:
 *
 *   1. the buyer cleared cookies / switched device or browser, or
 *   2. the 30-day access window of that token expired.
 *
 * TWO FACTORS, IN ORDER:
 *   - the order number (printed on the confirmation page), AND
 *   - a contact detail captured at checkout (email OR phone).
 *
 * DELIVERY CHANNEL
 * ----------------
 * The buyer chooses where the code goes:
 *   - "whatsapp" (default) → the checkout phone on the order, or
 *   - "email"              → the checkout email on the order, which
 *                            additionally requires the EMAIL factor to
 *                            match (a phone-only match may not open an
 *                            email delivery).
 * The recipient is always read from the ORDER, never from the request
 * body, so the code can only reach a contact the buyer already used.
 *
 * WHY THIS IS ONLY PHASE 1
 * ------------------------
 * Order number + contact is KNOWLEDGE, not proof of ownership: both sit
 * in an old confirmation email or a chat thread. So this endpoint NEVER
 * rotates or reveals an access token. It can only cause a one-time code
 * to be sent to the phone number stored on the order; the token is
 * minted exclusively by /api/orders/recover/confirm, after that code is
 * verified (see lib/guest-recovery.ts).
 *
 * GUARANTEES
 * ----------
 *  - Uniform 404 for "no such order" AND "contact mismatch": this
 *    endpoint is not an order-existence oracle.
 *  - Rate limited per IP AND per hashed identity, so neither one IP nor
 *    one buyer's contact can grind order numbers.
 *  - FAIL CLOSED: if the code cannot be handed to the provider for the
 *    chosen channel, the request fails and the challenge is burned — no
 *    undelivered code is ever usable.
 *  - Raw contact values and identity hashes are NEVER returned, and the
 *    code itself never appears in a response or a log line.
 */

const recoverSchema = z.object({
    orderNumber: z
        .string()
        .trim()
        .min(3)
        .max(64),

    /* At least one contact detail is required. */
    email: z.string().trim().max(191).optional(),
    phone: z.string().trim().max(32).optional(),

    /*
     * Where the code should be sent. Optional so an older client keeps
     * the original WhatsApp behaviour.
     */
    channel: z
        .enum(["email", "whatsapp"])
        .optional()
        .default("whatsapp"),
});

export async function POST(request: Request) {
    try {
        const ip = getClientIp(request);

        /*
         * IP bucket first: it is the cheapest gate and it also caps
         * enumeration across many different order numbers.
         */
        if (
            !rateLimiters.guestRecoveryRequest(
                guestIpKey({ ip, scope: "recover" })
            ).allowed
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Terlalu banyak percobaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message: "Data tidak valid.",
                },
                { status: 400 }
            );
        }

        const parsed = recoverSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Nomor pesanan dan email atau nomor telepon wajib diisi.",
                },
                { status: 400 }
            );
        }

        const email = normalizeEmail(
            parsed.data.email
        );
        const phone = normalizePhone(
            parsed.data.phone
        );

        if (!email && !phone) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Email atau nomor telepon tidak valid.",
                },
                { status: 400 }
            );
        }

        /*
         * Per-identity bucket (normalized + hashed contact) so a
         * single buyer grinding their OWN order number cannot consume
         * the whole IP budget, and one IP cannot enumerate a single
         * buyer's orders cheaply.
         */
        const identityScopedKey = guestDeviceKey({
            ip,
            scope: "recover-request",
            /*
             * Keyed hash, not the raw contact: the limiter keeps its
             * keys in memory, and a raw email/phone must not live
             * there (same rule as Order.guestIdentityKey).
             */
            deviceKey: email
                ? `e:${hashContact(email)}`
                : `p:${hashContact(phone!)}`,
        });

        if (
            identityScopedKey &&
            !rateLimiters.guestOrderLookupIdentity(
                identityScopedKey
            ).allowed
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Terlalu banyak percobaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const result = await startGuestRecovery({
            orderNumber: parsed.data.orderNumber,
            email,
            phone,
            channel: parsed.data.channel,
        });

        /* Copy that names the channel the buyer actually chose. */
        const channelLabel =
            parsed.data.channel === "email"
                ? "email"
                : "WhatsApp";

        if (!result.ok) {
            /*
             * Uniform 404 for "no such order" and "contact mismatch" — a
             * distinct response would confirm that an order number exists
             * (and turn this into an enumeration oracle).
             */
            if (result.reason === "NOT_FOUND") {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Pesanan tidak ditemukan. Periksa kembali nomor pesanan dan kontak yang digunakan saat checkout.",
                    },
                    { status: 404 }
                );
            }

            /*
             * An account-owned order is recovered by signing in. The
             * caller has already proved knowledge of the order number
             * AND the checkout contact, so naming the correct next step
             * reveals nothing they do not have.
             */
            if (result.reason === "ACCOUNT_ORDER") {
                return NextResponse.json(
                    {
                        success: false,
                        requiresLogin: true,
                        message:
                            "Pesanan ini terhubung ke akun. Silakan masuk untuk mengaksesnya.",
                    },
                    { status: 409 }
                );
            }

            /*
             * FAIL CLOSED: no code left this server, so the buyer is
             * told the truth and the challenge can never be redeemed.
             */
            return NextResponse.json(
                {
                    success: false,
                    message: `Kode verifikasi gagal dikirim ke ${channelLabel}. Coba lagi beberapa saat lagi.`,
                },
                { status: 502 }
            );
        }

        return NextResponse.json({
            success: true,
            message:
                parsed.data.channel === "email"
                    ? "Kode verifikasi telah dikirim ke email yang terdaftar pada pesanan."
                    : "Kode verifikasi telah dikirim ke nomor WhatsApp yang terdaftar pada pesanan.",
            data: {
                challengeId: result.challengeId,
                channel: parsed.data.channel,
                expiresInSeconds: Math.round(
                    RECOVERY_CODE_TTL_MS / 1000
                ),
            },
        });
    } catch (error) {
        console.error("GUEST ORDER RECOVER ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal memproses permintaan. Coba lagi nanti.",
            },
            { status: 500 }
        );
    }
}
