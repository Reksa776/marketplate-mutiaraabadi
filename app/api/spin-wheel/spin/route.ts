import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { executeSpin } from "@/lib/spin-wheel";
import { resolveSpinScope } from "@/lib/spin-owner";
import {
    getClientIp,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";

// ==========================================
// POST /api/spin-wheel/spin
// ==========================================
// Execute a spin for the caller (session OR guest).
// Server determines the reward — never trust client.

export async function POST(request: Request) {
    try {
        const session = await auth();
        const scope = await resolveSpinScope();

        if (!scope.ownerKey) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Belum ada pesanan yang dapat dipakai untuk spin.",
                },
                { status: 401 }
            );
        }

        /*
         * Guests have no userId, so the existing per-user spin limiter
         * cannot apply — rate limit anonymous spins by IP instead.
         * (The milestone/cap logic inside executeSpin is the real
         * entitlement check; this only stops hammering.)
         */
        if (!scope.userId) {
            const ip = getClientIp(request);

            if (
                !rateLimiters.guestSpin(
                    guestIpKey({
                        ip,
                        scope: "spin-wheel",
                    })
                ).allowed
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Terlalu banyak percobaan spin. Coba lagi nanti.",
                    },
                    { status: 429 }
                );
            }
        }

        const result = await executeSpin(
            {
                userId: scope.userId,
                guestIdentityKey:
                    scope.guestIdentityKey,
            },
            session?.user
                ? (session.user as { role?: string })
                      .role
                : undefined
        );

        if (!result.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: result.message,
                },
                { status: 400 }
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                spinId: result.spinId,
                reward: result.reward,
            },
        });
    } catch (error) {
        console.error("SPIN_WHEEL_SPIN_ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: "Gagal melakukan spin. Silakan coba lagi.",
            },
            { status: 500 }
        );
    }
}
