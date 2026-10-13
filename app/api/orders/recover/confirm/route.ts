import { NextResponse } from "next/server";
import { z } from "zod";

import {
    getClientIp,
    guestDeviceKey,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import { confirmGuestRecovery } from "@/lib/guest-recovery";
import { issueGuestOrderAccessCookie } from "@/lib/guest-order-access";
import {
    hashContact,
    normalizeEmail,
    normalizePhone,
} from "@/lib/guest-identity";

/**
 * ==========================================
 * GUEST ORDER RECOVERY — PHASE 2 (CONFIRM)
 * /api/orders/recover/confirm
 * ==========================================
 *
 * Verifies the one-time code requested by phase 1 and — ONLY THEN —
 * mints a fresh guest access token (hash + 30-day window persisted, raw
 * value delivered as an httpOnly cookie).
 *
 * The access token is never rotated before this point: phase 1 can only
 * send a code, so compromising the "order number + contact" pair on its
 * own grants nothing.
 *
 * The caller must present the SAME contact factor it used in phase 1,
 * because the challenge is bound to the order AND to that contact (see
 * lib/guest-recovery.ts) — a code alone is not enough.
 *
 * GUARANTEES
 * ----------
 *  - The code is SINGLE USE: redemption is a conditional update on
 *    `consumedAt`, so a replay (or a parallel double-submit) yields at
 *    most one token.
 *  - SHORT LIVED (10 minutes) and ATTEMPT LIMITED (5), so the 6-digit
 *    space cannot be brute-forced by the buyer or by anyone else.
 *  - Rate limited per IP and per hashed identity.
 *  - The raw token travels ONLY in the httpOnly cookie; the response
 *    body never contains it, nor the code, nor any raw contact value.
 */

const confirmSchema = z.object({
    challengeId: z
        .string()
        .trim()
        .min(8)
        .max(64),

    /* Exactly RECOVERY_CODE_LENGTH digits. */
    code: z
        .string()
        .trim()
        .regex(/^\d{6}$/),

    /* The same checkout contact that phase 1 matched. */
    email: z.string().trim().max(191).optional(),
    phone: z.string().trim().max(32).optional(),
});

export async function POST(request: Request) {
    try {
        const ip = getClientIp(request);

        if (
            !rateLimiters.guestRecoveryConfirm(
                guestIpKey({ ip, scope: "recover-confirm" })
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

        const parsed = confirmSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Kode verifikasi tidak valid.",
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

        const identityScopedKey = guestDeviceKey({
            ip,
            scope: "recover-confirm",
            deviceKey: email
                ? `e:${hashContact(email)}`
                : phone
                  ? `p:${hashContact(phone)}`
                  : null,
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

        const result = await confirmGuestRecovery({
            challengeId: parsed.data.challengeId,
            code: parsed.data.code,
            email,
            phone,
        });

        if (!result.ok) {
            /*
             * NOT_FOUND is deliberately uniform: an unknown id, a
             * consumed challenge and an undelivered one are answered
             * identically, so the endpoint cannot be used to probe
             * challenge ids.
             */
            if (result.reason === "NOT_FOUND") {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Kode verifikasi tidak ditemukan atau sudah dipakai. Minta kode baru.",
                    },
                    { status: 404 }
                );
            }

            if (result.reason === "EXPIRED") {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Kode verifikasi sudah kedaluwarsa. Minta kode baru.",
                    },
                    { status: 400 }
                );
            }

            if (result.reason === "EXHAUSTED") {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Percobaan kode verifikasi sudah habis. Minta kode baru.",
                    },
                    { status: 429 }
                );
            }

            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Kode verifikasi salah.",
                },
                { status: 400 }
            );
        }

        const response = NextResponse.json({
            success: true,
            message:
                "Akses pesanan berhasil dipulihkan.",
            data: {
                id: result.orderId,
                orderNumber: result.orderNumber,
            },
        });

        /*
         * The raw token travels ONLY in the httpOnly cookie — never in
         * the JSON body.
         */
        issueGuestOrderAccessCookie(
            response,
            result.orderId,
            result.token
        );

        return response;
    } catch (error) {
        console.error(
            "GUEST ORDER RECOVER CONFIRM ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal memverifikasi kode. Coba lagi nanti.",
            },
            { status: 500 }
        );
    }
}
