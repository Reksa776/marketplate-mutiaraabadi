import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkEligibility } from "@/lib/spin-wheel";
import { resolveSpinScope } from "@/lib/spin-owner";

// ==========================================
// GET /api/spin-wheel
// ==========================================
// Check if the caller is eligible to spin.
//
// Guests are supported: the storefront has no customer accounts, so
// eligibility is resolved from the session when present and otherwise
// from the orders this browser can prove it owns (see
// lib/spin-owner.ts). A visitor with no provable order history gets the
// normal "not eligible yet" campaign state instead of a login wall.

export async function GET() {
    try {
        const session = await auth();

        const scope = await resolveSpinScope();

        if (!scope.ownerKey) {
            /*
             * No session and no verifiable guest order on this
             * browser → nothing can be earned yet. This is NOT an
             * error: the campaign copy tells the buyer to keep
             * shopping. A 401 here would be a login wall that no
             * longer exists.
             */
            return NextResponse.json({
                success: true,
                data: {
                    enabled: false,
                    eligible: false,
                    campaignId: null,
                    minimumSpend: 0,
                    currentSpend: 0,
                    remainingSpend: 0,
                    spinsRemaining: 0,
                    hasSpun: false,
                    rewards: [],
                    isTestMode: false,
                    totalMilestones: 0,
                    spendingProgress: 0,
                },
            });
        }

        const eligibility = await checkEligibility(
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

        return NextResponse.json({
            success: true,
            data: eligibility,
        });
    } catch (error) {
        console.error("SPIN_WHEEL_ELIGIBILITY_ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: "Gagal memeriksa kelayakan spin.",
            },
            { status: 500 }
        );
    }
}
