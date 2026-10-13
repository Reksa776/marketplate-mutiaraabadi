import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSpinScope } from "@/lib/spin-owner";

// ==========================================
// GET /api/spin-wheel/my-rewards
// ==========================================
// Get the caller's spin wheel rewards — session or guest.
//
// Scoped by `ownerKey` so a guest sees exactly the rewards earned by
// the identity their verified order tokens point at. `ownerKey` is a
// server-side scope and is never included in the payload.

export async function GET() {
    try {
        const scope = await resolveSpinScope();

        if (!scope.ownerKey) {
            /* No session, no verifiable guest order → no rewards. */
            return NextResponse.json({
                success: true,
                data: [],
            });
        }

        const spins = await prisma.spinWheelSpin.findMany({
            where: {
                ownerKey: scope.ownerKey,
            },
            include: {
                reward: true,
                campaign: {
                    select: {
                        name: true,
                    },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        // Auto-expire rewards past their expiry date
        const now = new Date();
        const expiredSpins = spins.filter(
            (s) =>
                s.status === "AVAILABLE" &&
                s.expiresAt &&
                s.expiresAt < now
        );

        if (expiredSpins.length > 0) {
            await prisma.spinWheelSpin.updateMany({
                where: {
                    id: {
                        in: expiredSpins.map((s) => s.id),
                    },
                },
                data: {
                    status: "EXPIRED",
                },
            });

            // Update local state
            for (const spin of spins) {
                if (
                    spin.status === "AVAILABLE" &&
                    spin.expiresAt &&
                    spin.expiresAt < now
                ) {
                    spin.status = "EXPIRED";
                }
            }
        }

        return NextResponse.json({
            success: true,
            data: spins.map((s) => ({
                id: s.id,
                status: s.status,
                createdAt: s.createdAt.toISOString(),
                expiresAt: s.expiresAt?.toISOString() ?? null,
                usedAt: s.usedAt?.toISOString() ?? null,
                orderId: s.orderId,
                reward: {
                    id: s.reward.id,
                    name: s.reward.name,
                    type: s.reward.type,
                    value: Number(s.reward.value),
                    maxDiscount: s.reward.maxDiscount
                        ? Number(s.reward.maxDiscount)
                        : null,
                },
                campaign: {
                    name: s.campaign.name,
                },
            })),
        });
    } catch (error) {
        console.error("MY_REWARDS_ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil data reward.",
            },
            { status: 500 }
        );
    }
}
