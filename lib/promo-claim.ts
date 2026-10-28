import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

const PROMO_TIME_ZONE = "Asia/Jakarta";

export function promoQuotaDate(now = new Date()): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: PROMO_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return new Date(
        Date.UTC(
            Number(values.year),
            Number(values.month) - 1,
            Number(values.day)
        )
    );
}

export function hashPromoVisitorKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

export function isPromoActive(
    promo: { isActive: boolean; startAt: Date; endAt: Date },
    now = new Date()
): boolean {
    return promo.isActive && promo.startAt <= now && promo.endAt >= now;
}

export function isVoucherClaimable(
    voucher: {
        isActive: boolean;
        startDate: Date | null;
        endDate: Date | null;
        quota: number | null;
        usedCount: number;
    },
    now = new Date()
): boolean {
    return (
        voucher.isActive &&
        (!voucher.startDate || voucher.startDate <= now) &&
        (!voucher.endDate || voucher.endDate >= now) &&
        (voucher.quota === null || voucher.usedCount < voucher.quota)
    );
}

export type PromoClaimResult =
    | { status: "CLAIMED"; voucherCode: string; alreadyClaimed: boolean }
    | { status: "NOT_FOUND" | "INACTIVE" | "QUOTA_EXHAUSTED" };

export async function claimDailyPromo(input: {
    slug: string;
    visitorKeyHash: string;
    now?: Date;
}): Promise<PromoClaimResult> {
    const now = input.now ?? new Date();
    const quotaDate = promoQuotaDate(now);

    try {
        return await prisma.$transaction(async (tx) => {
            const promo = await tx.promoLanding.findUnique({
                where: { slug: input.slug },
                include: { voucher: true },
            });

            if (!promo) return { status: "NOT_FOUND" };
            if (
                !isPromoActive(promo, now) ||
                !isVoucherClaimable(promo.voucher, now)
            ) {
                return { status: "INACTIVE" };
            }

            const priorClaim = await tx.promoClaim.findUnique({
                where: {
                    promoId_quotaDate_visitorKeyHash: {
                        promoId: promo.id,
                        quotaDate,
                        visitorKeyHash: input.visitorKeyHash,
                    },
                },
            });

            if (priorClaim) {
                return {
                    status: "CLAIMED",
                    voucherCode: priorClaim.voucherCode,
                    alreadyClaimed: true,
                };
            }

            await tx.promoDailyQuota.upsert({
                where: {
                    promoId_quotaDate: {
                        promoId: promo.id,
                        quotaDate,
                    },
                },
                create: { promoId: promo.id, quotaDate },
                update: {},
            });

            const reservation = await tx.promoDailyQuota.updateMany({
                where: {
                    promoId: promo.id,
                    quotaDate,
                    claimedCount: { lt: promo.dailyQuota },
                },
                data: { claimedCount: { increment: 1 } },
            });

            if (reservation.count !== 1) {
                return { status: "QUOTA_EXHAUSTED" };
            }

            await tx.promoClaim.create({
                data: {
                    promoId: promo.id,
                    quotaDate,
                    visitorKeyHash: input.visitorKeyHash,
                    voucherCode: promo.voucher.code,
                },
            });

            return {
                status: "CLAIMED",
                voucherCode: promo.voucher.code,
                alreadyClaimed: false,
            };
        });
    } catch (error) {
        // Concurrent requests from the same browser are idempotent. The
        // losing transaction rolls its quota increment back before this read.
        if ((error as { code?: string })?.code === "P2002") {
            const promo = await prisma.promoLanding.findUnique({
                where: { slug: input.slug },
                select: { id: true },
            });
            if (!promo) return { status: "NOT_FOUND" };
            const priorClaim = await prisma.promoClaim.findUnique({
                where: {
                    promoId_quotaDate_visitorKeyHash: {
                        promoId: promo.id,
                        quotaDate,
                        visitorKeyHash: input.visitorKeyHash,
                    },
                },
            });
            if (priorClaim) {
                return {
                    status: "CLAIMED",
                    voucherCode: priorClaim.voucherCode,
                    alreadyClaimed: true,
                };
            }
        }
        throw error;
    }
}
