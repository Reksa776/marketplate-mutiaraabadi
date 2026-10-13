import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
    requireUsageScope,
    resolveUsageScope,
} from "@/lib/guest-identity";

type ValidateVoucherResult =
    | {
          valid: true;
          voucher: {
              id: number;
              code: string;
              type: "PERCENTAGE" | "FIXED";
          };
          discount: number;
      }
    | {
          valid: false;
          message: string;
      };

/*
 * ==========================================
 * VALIDATE & CALCULATE DISCOUNT
 * ==========================================
 *
 * Dipakai di DUA tempat:
 *
 * 1. POST /api/voucher/validate
 *    -> preview diskon di halaman checkout, pakai `prisma` biasa.
 *
 * 2. Di DALAM transaction pembuatan order
 *    (buy-now maupun checkout keranjang)
 *    -> WAJIB pakai `tx` (transaction client), bukan `prisma`
 *    biasa, dan WAJIB dipanggil ulang di sana meskipun sudah
 *    divalidasi di langkah 1. Jangan pernah percaya nilai
 *    discount yang dikirim dari client.
 */
export async function validateAndCalculateVoucher(
    code: string,
    subtotal: number,
    client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<ValidateVoucherResult> {
    const trimmedCode = code.trim().toUpperCase();

    if (!trimmedCode) {
        return {
            valid: false,
            message: "Kode voucher tidak boleh kosong.",
        };
    }

    if (!Number.isFinite(subtotal) || subtotal <= 0) {
        return {
            valid: false,
            message: "Subtotal tidak valid.",
        };
    }

    const voucher = await client.voucher.findUnique({
        where: { code: trimmedCode },
    });

    if (!voucher) {
        return {
            valid: false,
            message: "Kode voucher tidak ditemukan.",
        };
    }

    if (!voucher.isActive) {
        return {
            valid: false,
            message: "Voucher ini sudah tidak aktif.",
        };
    }

    const now = new Date();

    if (voucher.startDate && now < voucher.startDate) {
        return {
            valid: false,
            message: "Voucher ini belum bisa digunakan.",
        };
    }

    if (voucher.endDate && now > voucher.endDate) {
        return {
            valid: false,
            message: "Voucher ini sudah kedaluwarsa.",
        };
    }

    if (voucher.quota !== null && voucher.usedCount >= voucher.quota) {
        return {
            valid: false,
            message: "Kuota voucher ini sudah habis.",
        };
    }

    const minPurchase = voucher.minPurchase
        ? Number(voucher.minPurchase)
        : 0;

    if (subtotal < minPurchase) {
        return {
            valid: false,
            message: `Minimal belanja Rp ${minPurchase.toLocaleString(
                "id-ID"
            )} untuk pakai voucher ini.`,
        };
    }

    let discount = 0;

    if (voucher.type === "PERCENTAGE") {
        discount = (subtotal * Number(voucher.value)) / 100;

        const maxDiscount = voucher.maxDiscount
            ? Number(voucher.maxDiscount)
            : null;

        if (maxDiscount !== null && discount > maxDiscount) {
            discount = maxDiscount;
        }
    } else {
        discount = Number(voucher.value);
    }

    /*
     * Diskon nggak boleh lebih besar dari subtotal
     * (mencegah total order jadi negatif).
     */
    if (discount > subtotal) {
        discount = subtotal;
    }

    discount = Math.round(discount);

    return {
        valid: true,
        voucher: {
            id: voucher.id,
            code: voucher.code,
            type: voucher.type,
        },
        discount,
    };
}

/*
 * ==========================================
 * MARK VOUCHER USED (ATOMIC)
 * ==========================================
 *
 * WAJIB dipanggil di dalam transaction yang SAMA
 * dengan pembuatan order, SETELAH order berhasil
 * dibuat, supaya:
 *
 * - Kalau order gagal dibuat (misal stock habis
 *   di tengah jalan), usedCount voucher nggak
 *   ikut naik.
 *
 * - Kalau dua request masuk bersamaan pas kuota
 *   tinggal 1, cuma salah satu yang berhasil
 *   (pakai UPDATE ber-syarat via raw SQL, bukan
 *   read-then-write biasa yang rawan race
 *   condition).
 *
 * Return `true` kalau berhasil dipakai, `false`
 * kalau ternyata kuota baru saja habis (harus
 * di-throw sebagai error dan rollback transaction-nya).
 */
export async function incrementVoucherUsage(
    tx: Prisma.TransactionClient,
    voucherId: number
): Promise<boolean> {
    const updated = await tx.$executeRaw`
        UPDATE voucher
        SET usedCount = usedCount + 1
        WHERE id = ${voucherId}
          AND isActive = true
          AND (quota IS NULL OR usedCount < quota)
    `;

    return updated === 1;
}

/*
 * ==========================================
 * ENHANCED VOUCHER VALIDATION
 * ==========================================
 *
 * Extended validation supporting:
 * - Per-user usage limits
 * - Product restrictions
 * - Category restrictions
 * - Campaign restriction
 *
 * Used by the pricing engine and future checkout integration.
 *
 * Input items must be trusted from the DATABASE, not from client.
 */

export type VoucherValidationItem = {
    productId: number;
    variantId: number;
    quantity: number;
    price: number; // from database, not client
    category?: string | null; // from product.category
};

export type EnhancedValidateVoucherResult =
    | {
          valid: true;
          voucher: {
              id: number;
              code: string;
              type: "PERCENTAGE" | "FIXED";
          };
          discount: number;
          eligibleSubtotal: number;
      }
    | {
          valid: false;
          message: string;
      };

/**
 * Enhanced voucher validation with:
 * 1. Per-user usage limit
 * 2. Product restrictions
 * 3. Category restrictions
 * 4. Campaign restriction
 *
 * @param code - Voucher code (normalized to uppercase)
 * @param subtotal - Cart subtotal (from server-computed values)
 * @param items - Cart items (from DATABASE, not client)
 * @param userId - Legacy logged-in user id. Guests pass null and use
 *                 `ownerKey` instead.
 * @param campaignId - Active campaign ID (for campaign restriction)
 * @param client - Prisma client or transaction client
 * @param ownerKey - Authoritative per-identity limit scope for the
 *                   voucher (`maxUsagePerUser` and the NEW_USER /
 *                   RETURNING_USER eligibility). For a guest this is
 *                   `guest:<hashed email/phone>`; for a logged-in
 *                   buyer it defaults to `user:<userId>`. The raw
 *                   contact value is never used or exposed here.
 */
export async function validateAndCalculateVoucherEnhanced(
    code: string,
    subtotal: number,
    items: VoucherValidationItem[],
    userId: string | null,
    campaignId: number | null,
    client: Prisma.TransactionClient | typeof prisma = prisma,
    ownerKey?: string | null
): Promise<EnhancedValidateVoucherResult> {
    const usageScope = resolveUsageScope({
        ownerKey,
        userId,
    });
    const trimmedCode = code.trim().toUpperCase();

    if (!trimmedCode) {
        return {
            valid: false,
            message: "Kode voucher tidak boleh kosong.",
        };
    }

    if (!Number.isFinite(subtotal) || subtotal <= 0) {
        return {
            valid: false,
            message: "Subtotal tidak valid.",
        };
    }

    // ==========================================
    // 1. FETCH VOUCHER
    // ==========================================

    const voucher = await client.voucher.findUnique({
        where: { code: trimmedCode },
        include: {
            productRestrictions: true,
            categoryRestrictions: true,
        },
    });

    if (!voucher) {
        return {
            valid: false,
            message: "Kode voucher tidak ditemukan.",
        };
    }

    // ==========================================
    // 2. BASIC VALIDATION
    // ==========================================

    if (!voucher.isActive) {
        return {
            valid: false,
            message: "Voucher ini sudah tidak aktif.",
        };
    }

    const now = new Date();

    if (voucher.startDate && now < voucher.startDate) {
        return {
            valid: false,
            message: "Voucher ini belum bisa digunakan.",
        };
    }

    if (voucher.endDate && now > voucher.endDate) {
        return {
            valid: false,
            message: "Voucher ini sudah kedaluwarsa.",
        };
    }

    // ==========================================
    // 3. GLOBAL QUOTA
    // ==========================================

    if (voucher.quota !== null && voucher.usedCount >= voucher.quota) {
        return {
            valid: false,
            message: "Kuota voucher ini sudah habis.",
        };
    }

    // ==========================================
    // 4. PER-USER USAGE LIMIT
    // ==========================================

    if (usageScope && voucher.maxUsagePerUser) {
        const userUsage = await client.voucherUserUsage.findUnique({
            where: {
                voucherId_ownerKey: {
                    voucherId: voucher.id,
                    ownerKey: usageScope,
                },
            },
        });

        const usageCount = userUsage?.usageCount ?? 0;

        if (usageCount >= voucher.maxUsagePerUser) {
            return {
                valid: false,
                message: `Anda sudah mencapai batas penggunaan voucher ini (${voucher.maxUsagePerUser}x).`,
            };
        }
    }

    // ==========================================
    // 5. CAMPAIGN RESTRICTION
    // ==========================================

    if (voucher.campaignId) {
        // Voucher is tied to a campaign
        if (campaignId === null || campaignId !== voucher.campaignId) {
            return {
                valid: false,
                message:
                    "Voucher ini hanya berlaku dalam kampanye tertentu.",
            };
        }

        // Verify the campaign is actually active
        const campaign = await client.campaign.findUnique({
            where: { id: voucher.campaignId },
        });

        if (!campaign) {
            return {
                valid: false,
                message: "Kampanye terkait voucher tidak ditemukan.",
            };
        }

        // Server-side campaign status check
        const campaignActive =
            campaign.status === "ACTIVE" &&
            now >= campaign.startAt &&
            now <= campaign.endAt;

        if (!campaignActive) {
            return {
                valid: false,
                message: "Kampanye terkait voucher sedang tidak aktif.",
            };
        }
    }

    // ==========================================
    // 6. ELIGIBILITY (NEW_USER / RETURNING_USER)
    // ==========================================

    /*
     * Buyer scope for the eligibility history check.
     *
     * A logged-in buyer is identified by userId; a guest buyer by the
     * hashed contact identity captured at checkout. Both are matched so
     * NEW_USER / RETURNING_USER keep working after guest checkout — a
     * guest who already bought is NOT treated as a new user.
     */
    const guestIdentityKey =
        !userId &&
        typeof ownerKey === "string" &&
        ownerKey.startsWith("guest:")
            ? ownerKey.slice("guest:".length)
            : null;

    const buyerScope = userId
        ? { userId }
        : guestIdentityKey
          ? { guestIdentityKey }
          : null;

    if (
        voucher.eligibility &&
        voucher.eligibility !== "ALL" &&
        buyerScope
    ) {
        // Count paid/completed orders for this buyer scope
        const paidOrderCount = await client.order.count({
            where: {
                ...buyerScope,
                status: { in: ["PAID", "PROCESSING", "SHIPPED", "COMPLETED"] },
                paymentStatus: "PAID",
            },
        });

        if (voucher.eligibility === "NEW_USER" && paidOrderCount > 0) {
            return {
                valid: false,
                message: "Voucher ini hanya berlaku untuk pengguna baru.",
            };
        }

        if (voucher.eligibility === "RETURNING_USER" && paidOrderCount === 0) {
            return {
                valid: false,
                message: "Voucher ini hanya berlaku untuk pengguna yang sudah pernah berbelanja.",
            };
        }
    }

    // ==========================================
    // 7. PRODUCT RESTRICTIONS
    // ==========================================

    if (voucher.productRestrictions.length > 0) {
        const allowedProductIds = new Set(
            voucher.productRestrictions.map((pr) => pr.productId)
        );

        const hasDisallowedProduct = items.some(
            (item) => !allowedProductIds.has(item.productId)
        );

        if (hasDisallowedProduct) {
            return {
                valid: false,
                message:
                    "Voucher ini tidak berlaku untuk beberapa produk di keranjang Anda.",
            };
        }
    }

    // ==========================================
    // 7. CATEGORY RESTRICTIONS
    // ==========================================

    if (voucher.categoryRestrictions.length > 0) {
        const allowedCategories = new Set(
            voucher.categoryRestrictions.map((cr) =>
                cr.category.toLowerCase()
            )
        );

        const hasDisallowedCategory = items.some((item) => {
            if (!item.category) return true; // Item without category is not allowed
            return !allowedCategories.has(item.category.toLowerCase());
        });

        if (hasDisallowedCategory) {
            return {
                valid: false,
                message:
                    "Voucher ini tidak berlaku untuk beberapa kategori produk di keranjang Anda.",
            };
        }
    }

    // ==========================================
    // 8. MINIMUM PURCHASE
    // ==========================================

    const minPurchase = voucher.minPurchase
        ? Number(voucher.minPurchase)
        : 0;

    if (subtotal < minPurchase) {
        return {
            valid: false,
            message: `Minimal belanja Rp ${minPurchase.toLocaleString(
                "id-ID"
            )} untuk pakai voucher ini.`,
        };
    }

    // ==========================================
    // 9. CALCULATE DISCOUNT
    // ==========================================

    let discount = 0;

    if (voucher.type === "PERCENTAGE") {
        discount = (subtotal * Number(voucher.value)) / 100;

        const maxDiscount = voucher.maxDiscount
            ? Number(voucher.maxDiscount)
            : null;

        if (maxDiscount !== null && discount > maxDiscount) {
            discount = maxDiscount;
        }
    } else {
        discount = Number(voucher.value);
    }

    // Discount can never exceed eligible subtotal
    if (discount > subtotal) {
        discount = subtotal;
    }

    // Discount can never make subtotal negative
    discount = Math.max(0, discount);
    discount = Math.round(discount);

    return {
        valid: true,
        voucher: {
            id: voucher.id,
            code: voucher.code,
            type: voucher.type,
        },
        discount,
        eligibleSubtotal: subtotal,
    };
}

/**
 * Increment per-user voucher usage count.
 *
 * MUST be called inside a transaction.
 * Uses atomic upsert to prevent race conditions.
 *
 * Returns the NEW usage count after increment.
 * Caller MUST validate the returned count against
 * maxUsagePerUser to catch concurrent race conditions
 * where two transactions both read the same stale count.
 */
export async function incrementVoucherUserUsage(
    tx: Prisma.TransactionClient,
    voucherId: number,
    userId: string | null,
    ownerKey?: string | null
): Promise<number> {
    /*
     * Fail-closed: consuming a voucher without a limit scope would
     * silently remove `maxUsagePerUser` for that buyer.
     */
    const scope = requireUsageScope({ ownerKey, userId });

    const record = await tx.voucherUserUsage.upsert({
        where: {
            voucherId_ownerKey: {
                voucherId,
                ownerKey: scope,
            },
        },
        create: {
            voucherId,
            ownerKey: scope,
            userId: userId ?? undefined,
            usageCount: 1,
        },
        update: {
            usageCount: { increment: 1 },
        },
    });

    return record.usageCount;
}

/**
 * Get the usage count for a specific voucher under a limit scope.
 * Returns 0 when no scope can be resolved (nothing recorded).
 */
export async function getUserVoucherUsageCount(
    voucherId: number,
    userId: string | null,
    ownerKey?: string | null
): Promise<number> {
    const scope = resolveUsageScope({ ownerKey, userId });

    if (!scope) {
        return 0;
    }

    const usage = await prisma.voucherUserUsage.findUnique({
        where: {
            voucherId_ownerKey: {
                voucherId,
                ownerKey: scope,
            },
        },
    });

    return usage?.usageCount ?? 0;
}
