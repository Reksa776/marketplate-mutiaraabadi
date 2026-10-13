import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
    ownerKeyForGuest,
    ownerKeyForUser,
} from "@/lib/guest-identity";

// ==========================================
// TYPES
// ==========================================

export type EligibilityResult = {
    enabled: boolean;
    eligible: boolean;
    campaignId: number | null;
    minimumSpend: number;
    currentSpend: number;
    remainingSpend: number;
    spinsRemaining: number;
    hasSpun: boolean;
    rewards: Array<{ id: number; name: string; type: string }>;
    /** true when SPIN_WHEEL_TEST_MODE=true AND user is ADMIN */
    isTestMode: boolean;
    /** Total milestones earned from lifetime spending */
    totalMilestones: number;
    /** Spending progress toward next milestone (0 to minimumSpend) */
    spendingProgress: number;
};

export type SpinResult = {
    success: boolean;
    spinId?: number;
    reward?: {
        id: number;
        name: string;
        type: string;
        value: number;
        maxDiscount: number | null;
    };
    message?: string;
};

// ==========================================
// ELIGIBILITY CHECK — MILESTONE SYSTEM
// ==========================================

/*
 * ==========================================
 * SPIN OWNER SCOPE
 * ==========================================
 *
 * The storefront is guest-only for customers, so a spin can be earned
 * by a buyer who has no account. Ownership/eligibility is therefore
 * expressed as a scope:
 *
 *   authenticated → "user:<userId>"          (unchanged behaviour)
 *   guest         → "guest:<hashed email/phone>"
 *
 * Guests pass a scope object; existing callers may still pass a bare
 * userId string, which resolves to the historical user scope.
 *
 * `userScope` is the query fragment used to find that owner's PAID
 * orders, so a guest's milestone progress is derived from their own
 * guest orders (matched on the hashed identity) — never from someone
 * else's.
 */
export type SpinOwner =
    | string
    | {
          userId?: string | null;
          guestIdentityKey?: string | null;
      };

type ResolvedSpinOwner = {
    ownerKey: string;
    userScope:
        | { userId: string }
        | { guestIdentityKey: string };
    userId: string | null;
};

function resolveSpinOwner(
    owner: SpinOwner
): ResolvedSpinOwner {
    if (typeof owner === "string") {
        return {
            ownerKey: ownerKeyForUser(owner),
            userScope: { userId: owner },
            userId: owner,
        };
    }

    if (owner.userId) {
        return {
            ownerKey: ownerKeyForUser(owner.userId),
            userScope: { userId: owner.userId },
            userId: owner.userId,
        };
    }

    if (owner.guestIdentityKey) {
        return {
            ownerKey: ownerKeyForGuest(
                owner.guestIdentityKey
            ),
            userScope: {
                guestIdentityKey:
                    owner.guestIdentityKey,
            },
            userId: null,
        };
    }

    /*
     * Fail loudly: without a scope a spin could not be attributed or
     * rate-capped, which would allow unlimited free spins.
     */
    throw new Error(
        "Identitas pemilik spin tidak tersedia."
    );
}

/**
 * Check if user is eligible to spin in an active campaign.
 *
 * MILESTONE SYSTEM:
 * - Every `minimumSpend` of eligible orders grants 1 spin opportunity.
 * - Spending that exceeds a milestone carries over to the next.
 * - Using a spin consumes one opportunity but does NOT reset spending.
 * - Progress = totalEligibleSpend - (milestonesConsumed * minimumSpend)
 *
 * Example with minimumSpend = 100000:
 *   Spending 250000 → 2 milestones earned → 2 spins
 *   After using 1 spin → 1 available, progress 50000
 *   Spend 50000 more → progress 100000 → +1 spin → 2 available, progress 0
 */
export async function checkEligibility(
    owner: SpinOwner,
    userRole?: string
): Promise<EligibilityResult> {
    const {
        ownerKey,
        userScope,
    } = resolveSpinOwner(owner);

    const now = new Date();

    // Find active campaign
    const campaign = await prisma.spinWheelCampaign.findFirst({
        where: {
            isActive: true,
            startAt: { lte: now },
            endAt: { gte: now },
        },
        orderBy: { createdAt: "desc" },
    });

    if (!campaign) {
        return {
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
        };
    }

    const minimumSpend = Number(campaign.minimumSpend);

    // ==========================================
    // Calculate total eligible spending (PAID orders only)
    // ==========================================
    const paidOrders = await prisma.order.aggregate({
        where: {
            ...userScope,
            paymentStatus: "PAID",
        },
        _sum: {
            subtotal: true,
        },
    });

    const totalPaidSpend = Number(paidOrders._sum.subtotal ?? 0);

    // ==========================================
    // Count existing spins (AVAILABLE + USED) per campaign
    // ==========================================
    const existingSpins = await prisma.spinWheelSpin.count({
        where: {
            campaignId: campaign.id,
            ownerKey,
            status: { in: ["AVAILABLE", "USED"] },
        },
    });

    // Count only USED spins (consumed milestones)
    const usedSpins = await prisma.spinWheelSpin.count({
        where: {
            campaignId: campaign.id,
            ownerKey,
            status: "USED",
        },
    });

    // ==========================================
    // MILESTONE CALCULATION
    // ==========================================
    const totalMilestones =
        minimumSpend > 0
            ? Math.floor(totalPaidSpend / minimumSpend)
            : 0;

    // Available spins = milestones earned - spins created (AVAILABLE + USED)
    // Using existingSpins (not usedSpins) ensures creating a spin
    // immediately consumes a milestone, preventing unlimited spins.
    const availableSpins = Math.max(
        0,
        totalMilestones - existingSpins
    );

    // Optional campaign cap (maxSpinsPerUser > 1 means cap is active)
    // maxSpinsPerUser = 0 or 1 means no effective cap beyond milestones
    const maxSpinsCap = campaign.maxSpinsPerUser > 1
        ? campaign.maxSpinsPerUser
        : Infinity;

    const spinsRemaining = Math.min(
        availableSpins,
        Math.max(0, maxSpinsCap - existingSpins)
    );

    // Spending progress toward NEXT milestone
    const spendingProgress =
        minimumSpend > 0
            ? totalPaidSpend % minimumSpend
            : 0;

    // Debug logs
    console.log(`[SpinWheel] totalPaidSpend: ${totalPaidSpend}`);
    console.log(`[SpinWheel] minimumSpend: ${minimumSpend}`);
    console.log(`[SpinWheel] totalMilestones: ${totalMilestones}`);
    console.log(`[SpinWheel] existingSpins: ${existingSpins}`);
    console.log(`[SpinWheel] usedSpins: ${usedSpins}`);
    console.log(`[SpinWheel] availableSpins: ${availableSpins}`);
    console.log(`[SpinWheel] spendingProgress: ${spendingProgress}`);
    console.log(`[SpinWheel] maxSpinsPerUser: ${campaign.maxSpinsPerUser}`);

    // ==========================================
    // TEST MODE: bypass minimum spend for ADMIN
    // ==========================================
    const isTestMode =
        process.env.SPIN_WHEEL_TEST_MODE === "true" &&
        userRole === "ADMIN";

    // User is eligible if:
    // - they have available spins, OR
    // - they are in test mode (admin with SPIN_WHEEL_TEST_MODE=true)
    const eligible =
        spinsRemaining > 0 ||
        (isTestMode && totalMilestones > 0);

    // ==========================================
    // Fetch active rewards for frontend segment mapping
    // ==========================================
    const campaignRewards = await prisma.spinWheelReward.findMany({
        where: {
            campaignId: campaign.id,
            isActive: true,
        },
        orderBy: { id: "asc" },
        select: {
            id: true,
            name: true,
            type: true,
        },
    });

    return {
        enabled: true,
        eligible,
        campaignId: campaign.id,
        minimumSpend,
        currentSpend: spendingProgress,
        remainingSpend: Math.max(0, minimumSpend - spendingProgress),
        spinsRemaining,
        hasSpun: existingSpins > 0,
        rewards: campaignRewards,
        isTestMode,
        totalMilestones,
        spendingProgress,
    };
}

// ==========================================
// WEIGHTED RANDOM REWARD SELECTION
// ==========================================

/**
 * Select a reward from campaign rewards using weighted random.
 * This runs SERVER-SIDE only. Never trust client for reward selection.
 *
 * Algorithm: cumulative weight approach
 * 1. Sum all active rewards' weights
 * 2. Generate random number in [0, totalWeight)
 * 3. Walk through rewards until cumulative weight exceeds random number
 *
 * Also respects remaining quantity: rewards with totalQuantity set
 * and usedQuantity >= totalQuantity are excluded.
 */
export async function selectReward(
    tx: Prisma.TransactionClient,
    campaignId: number
): Promise<{
    id: number;
    name: string;
    type: string;
    value: number;
    maxDiscount: number | null;
} | null> {
    const rewards = await tx.spinWheelReward.findMany({
        where: {
            campaignId,
            isActive: true,
        },
        orderBy: { id: "asc" },
    });

    if (rewards.length === 0) return null;

    // Filter out rewards that are out of stock
    const availableRewards = rewards.filter((r) => {
        if (r.totalQuantity === null) return true;
        return r.usedQuantity < r.totalQuantity;
    });

    if (availableRewards.length === 0) return null;

    // Calculate total weight
    const totalWeight = availableRewards.reduce(
        (sum, r) => sum + r.weight,
        0
    );

    if (totalWeight <= 0) return null;

    // Server-side random: use crypto for better randomness
    const crypto = await import("crypto");
    const randomBytes = crypto.randomBytes(4);
    const randomValue =
        (randomBytes.readUInt32BE(0) / 0xffffffff) * totalWeight;

    // Select reward based on cumulative weight
    let cumulative = 0;
    for (const reward of availableRewards) {
        cumulative += reward.weight;
        if (randomValue < cumulative) {
            return {
                id: reward.id,
                name: reward.name,
                type: reward.type,
                value: Number(reward.value),
                maxDiscount: reward.maxDiscount
                    ? Number(reward.maxDiscount)
                    : null,
            };
        }
    }

    // Fallback: return last reward (shouldn't happen due to float math)
    const lastReward =
        availableRewards[availableRewards.length - 1];
    return {
        id: lastReward.id,
        name: lastReward.name,
        type: lastReward.type,
        value: Number(lastReward.value),
        maxDiscount: lastReward.maxDiscount
            ? Number(lastReward.maxDiscount)
            : null,
    };
}

// ==========================================
// EXECUTE SPIN
// ==========================================

/**
 * Execute a spin for a user. Uses transaction + count check
 * to prevent exceeding maxSpinsPerUser.
 *
 * Flow:
 * 1. Find active campaign
 * 2. Verify eligibility (minimum spend / test mode)
 * 3. Check spin availability (count existing spins)
 * 4. Select reward server-side (weighted random)
 * 5. Create spin record
 * 6. Increment reward usedQuantity
 * 7. Return reward to client (for animation)
 */
export async function executeSpin(
    owner: SpinOwner,
    userRole?: string
): Promise<SpinResult> {
    const {
        ownerKey,
        userScope,
        userId,
    } = resolveSpinOwner(owner);

    const now = new Date();

    // Find active campaign
    const campaign = await prisma.spinWheelCampaign.findFirst({
        where: {
            isActive: true,
            startAt: { lte: now },
            endAt: { gte: now },
        },
        orderBy: { createdAt: "desc" },
    });

    if (!campaign) {
        return {
            success: false,
            message: "Tidak ada kampanye spin wheel aktif.",
        };
    }

    // Calculate paid spend
    const paidOrders = await prisma.order.aggregate({
        where: {
            ...userScope,
            paymentStatus: "PAID",
        },
        _sum: { subtotal: true },
    });

    const totalPaidSpend = Number(paidOrders._sum.subtotal ?? 0);
    const minimumSpend = Number(campaign.minimumSpend);

    // ==========================================
    // TEST MODE: bypass minimum spend for ADMIN
    // ==========================================
    const isTestMode =
        process.env.SPIN_WHEEL_TEST_MODE === "true" &&
        userRole === "ADMIN";

    // Check milestone eligibility
    const totalMilestones =
        minimumSpend > 0
            ? Math.floor(totalPaidSpend / minimumSpend)
            : 0;

    if (!isTestMode && totalMilestones <= 0) {
        return {
            success: false,
            message: "Belum memenuhi minimum belanja untuk spin.",
        };
    }

    // Check spin availability + create atomically
    return prisma.$transaction(async (tx) => {
        /*
         * F11: The old catch-all was the DB unique constraint
         * (campaignId, userId), REMOVED by migration
         * 20260826000000_remove_spin_unique_constraint (it blocks
         * maxSpinsPerUser > 1). Capacity is now enforced here by
         * serializing spins per campaign: taking a FOR UPDATE lock
         * on the campaign row makes concurrent executeSpin calls
         * queue up, so the per-user count below is race-free even
         * when the cap is crossed at the exact same instant.
         */
        await tx.$executeRaw`
            SELECT id FROM spinwheelcampaign
            WHERE id = ${campaign.id}
            FOR UPDATE
        `;

        // Count existing spins (all statuses that consume milestones)
        const existingSpins = await tx.spinWheelSpin.count({
            where: {
                campaignId: campaign.id,
                ownerKey,
                status: { in: ["AVAILABLE", "USED"] },
            },
        });

        // Count used spins (consumed milestones)
        const usedSpins = await tx.spinWheelSpin.count({
            where: {
                campaignId: campaign.id,
                ownerKey,
                status: "USED",
            },
        });

        // Available spins = milestones earned - spins created (AVAILABLE + USED)
        // Using existingSpins ensures creating a spin immediately consumes
        // a milestone, preventing unlimited spins via race conditions.
        const availableSpins = Math.max(
            0,
            totalMilestones - existingSpins
        );

        // Optional campaign cap
        const maxSpinsCap = campaign.maxSpinsPerUser > 1
            ? campaign.maxSpinsPerUser
            : Infinity;

        if (existingSpins >= maxSpinsCap) {
            return {
                success: false,
                message: "Semua kesempatan spin sudah digunakan.",
            };
        }

        if (!isTestMode && availableSpins <= 0) {
            return {
                success: false,
                message:
                    "Tidak ada kesempatan spin tersedia. Belanja lagi untuk mendapatkan kesempatan baru.",
            };
        }

        // Select reward server-side
        const reward = await selectReward(tx, campaign.id);

        if (!reward) {
            return {
                success: false,
                message: "Tidak ada reward tersedia saat ini.",
            };
        }

        // Create spin record
        let spinRecord: { id: number };
        try {
            spinRecord = await tx.spinWheelSpin.create({
                data: {
                    campaignId: campaign.id,
                    ownerKey,
                    userId: userId ?? undefined,
                    rewardId: reward.id,
                    status: "AVAILABLE",
                    expiresAt:
                        reward.type === "ZONK"
                            ? null
                            : new Date(
                                  now.getTime() + 30 * 24 * 60 * 60 * 1000
                              ), // 30 days
                },
            });
        } catch (err: any) {
            // P2002 = unique constraint violation.
            // After migration 20260826000000 the (campaignId, userId)
            // uniqueness is gone (it blocked maxSpinsPerUser > 1), so
            // this fires only if a narrower constraint is reintroduced.
            // The FOR UPDATE lock above is the real race guard now.
            if (err?.code === "P2002") {
                return {
                    success: false,
                    message:
                        "Anda sudah melakukan spin pada campaign ini.",
                };
            }
            throw err;
        }

        // Increment usedQuantity on reward
        await tx.spinWheelReward.update({
            where: { id: reward.id },
            data: {
                usedQuantity: { increment: 1 },
            },
        });

        return {
            success: true,
            spinId: spinRecord.id,
            reward,
        };
    });
}

// ==========================================
// CALCULATE DISCOUNT FROM REWARD
// ==========================================

/**
 * Calculate the actual discount amount from a spin wheel reward.
 * Used at checkout time.
 *
 * @param rewardType - The reward type
 * @param rewardValue - The reward value (percentage or fixed amount)
 * @param maxDiscount - Maximum discount cap (for percentage type)
 * @param subtotal - Order subtotal
 */
export function calculateSpinRewardDiscount(
    rewardType: string,
    rewardValue: number,
    maxDiscount: number | null,
    subtotal: number
): number {
    switch (rewardType) {
        case "PERCENTAGE": {
            let discount = (subtotal * rewardValue) / 100;
            if (maxDiscount !== null && discount > maxDiscount) {
                discount = maxDiscount;
            }
            if (discount > subtotal) {
                discount = subtotal;
            }
            return Math.round(discount);
        }

        case "FIXED": {
            let discount = rewardValue;
            if (discount > subtotal) {
                discount = subtotal;
            }
            return Math.round(discount);
        }

        case "FREE_SHIPPING":
            // Shipping discount handled separately in checkout
            return 0;

        case "CASHBACK":
            // Cashback is not a direct discount
            return 0;

        case "ZONK":
            return 0;

        default:
            return 0;
    }
}
