import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
    requireUsageScope,
    resolveUsageScope,
} from "@/lib/guest-identity";
import {
    FlashSaleNotFoundError,
    FlashSaleNotActiveError,
    FlashSaleOutOfStockError,
    FlashSalePurchaseLimitError,
} from "./errors";

/**
 * ==========================================
 * FLASH SALE SERVICE
 * ==========================================
 *
 * Flash sale stock is SEPARATE from ProductVariant.stock.
 *
 * IMPORTANT:
 * - Never modify regular product stock when displaying flash sale data
 * - When checkout consumes flash-sale inventory, use atomic DB operations
 * - Sale price is always read from database, never from client
 * - Purchase limit enforced via FlashSalePurchase with @@unique([flashSaleId, userId])
 */

// ==========================================
// TYPES
// ==========================================

export type FlashSaleWithProduct = Awaited<
    ReturnType<typeof prisma.flashSale.findUnique>
>;

// ==========================================
// CRUD OPERATIONS
// ==========================================

/**
 * Create a flash sale.
 */
export async function createFlashSale(data: {
    name: string;
    productId: number;
    variantId: number;
    salePrice: number;
    saleStock: number;
    purchaseLimit?: number | null;
    startAt: Date;
    endAt: Date;
    isActive?: boolean;
}) {
    if (data.endAt <= data.startAt) {
        throw new Error("Tanggal berakhir harus setelah tanggal mulai.");
    }

    if (data.salePrice <= 0) {
        throw new Error("Harga flash sale harus lebih dari 0.");
    }

    if (data.saleStock <= 0) {
        throw new Error("Stok flash sale harus lebih dari 0.");
    }

    // Validate product and variant exist
    const variant = await prisma.productVariant.findFirst({
        where: {
            id: data.variantId,
            productId: data.productId,
        },
        include: { product: true },
    });

    if (!variant) {
        throw new Error("Produk atau variant tidak ditemukan.");
    }

    // Check if variant already has an active flash sale
    const existingSale = await prisma.flashSale.findUnique({
        where: { variantId: data.variantId },
    });

    if (existingSale) {
        throw new Error(
            "Variant ini sudah memiliki flash sale. Hapus yang lama terlebih dahulu."
        );
    }

    return prisma.flashSale.create({
        data: {
            name: data.name,
            productId: data.productId,
            variantId: data.variantId,
            salePrice: data.salePrice,
            saleStock: data.saleStock,
            purchaseLimit: data.purchaseLimit ?? 1,
            startAt: data.startAt,
            endAt: data.endAt,
            isActive: data.isActive ?? true,
        },
        include: {
            product: true,
            variant: true,
        },
    });
}

/**
 * Update a flash sale.
 */
export async function updateFlashSale(
    id: number,
    data: {
        name?: string;
        salePrice?: number;
        saleStock?: number;
        purchaseLimit?: number | null;
        startAt?: Date;
        endAt?: Date;
        isActive?: boolean;
    }
) {
    const existing = await prisma.flashSale.findUnique({ where: { id } });

    if (!existing) {
        throw new FlashSaleNotFoundError();
    }

    if (data.startAt && data.endAt && data.endAt <= data.startAt) {
        throw new Error("Tanggal berakhir harus setelah tanggal mulai.");
    }

    if (data.salePrice !== undefined && data.salePrice <= 0) {
        throw new Error("Harga flash sale harus lebih dari 0.");
    }

    if (data.saleStock !== undefined && data.saleStock < existing.soldCount) {
        throw new Error(
            `Stok flash sale tidak boleh kurang dari ${existing.soldCount} unit yang sudah terjual.`
        );
    }

    return prisma.flashSale.update({
        where: { id },
        data,
        include: {
            product: true,
            variant: true,
        },
    });
}

/**
 * Delete a flash sale.
 *
 * SAFETY: Rejects deletion when pending orders
 * contain items for this variant that may need
 * rollback. Prevents flash-sale stock leakage.
 */
export async function deleteFlashSale(id: number) {
    const existing = await prisma.flashSale.findUnique({ where: { id } });

    if (!existing) {
        throw new FlashSaleNotFoundError();
    }

    // Check for pending orders with items for this variant
    const pendingOrderCount = await prisma.orderItem.count({
        where: {
            variantId: existing.variantId,
            order: {
                status: { in: ["PENDING", "PROCESSING"] },
            },
        },
    });

    if (pendingOrderCount > 0) {
        throw new Error(
            `Flash sale tidak bisa dihapus karena masih ada ${pendingOrderCount} pesanan aktif yang menggunakan variant ini. Hapus atau batalkan pesanan terlebih dahulu.`
        );
    }

    return prisma.flashSale.delete({ where: { id } });
}

/**
 * Get flash sale by ID.
 */
export async function getFlashSale(id: number) {
    const sale = await prisma.flashSale.findUnique({
        where: { id },
        include: {
            product: true,
            variant: true,
        },
    });

    if (!sale) {
        throw new FlashSaleNotFoundError();
    }

    return sale;
}

/**
 * Get all currently active flash sales.
 */
export async function getActiveFlashSales(now: Date = new Date()) {
    return prisma.flashSale.findMany({
        where: {
            isActive: true,
            startAt: { lte: now },
            endAt: { gte: now },
            saleStock: { gt: 0 },
        },
        include: {
            product: true,
            variant: true,
        },
        orderBy: { startAt: "asc" },
    });
}

/**
 * Get active flash sale for a specific variant.
 */
export async function getActiveFlashSaleForVariant(
    variantId: number,
    now: Date = new Date()
) {
    return prisma.flashSale.findFirst({
        where: {
            variantId,
            isActive: true,
            startAt: { lte: now },
            endAt: { gte: now },
            saleStock: { gt: 0 },
        },
        include: {
            product: true,
            variant: true,
        },
    });
}

// ==========================================
// ATOMIC STOCK OPERATIONS
// ==========================================

/**
 * Reserve flash sale stock atomically.
 *
 * Uses atomic UPDATE with condition:
 *   saleStock >= requestedQuantity
 *
 * If affected rows = 0 → OUT_OF_STOCK or INSUFFICIENT_STOCK
 *
 * MUST be called inside a transaction.
 *
 * @returns The updated flash sale record
 * @throws FlashSaleOutOfStockError if stock insufficient
 */
export async function reserveFlashSaleStock(
    tx: Prisma.TransactionClient,
    flashSaleId: number,
    quantity: number
) {
    // Atomic update with stock condition
    const affectedRows = await tx.$executeRaw`
        UPDATE flashsale
        SET saleStock = saleStock - ${quantity},
            soldCount = soldCount + ${quantity}
        WHERE id = ${flashSaleId}
          AND isActive = true
          AND saleStock >= ${quantity}
    `;

    if (affectedRows === 0) {
        // Check if the flash sale exists to give a better error
        const sale = await tx.flashSale.findUnique({
            where: { id: flashSaleId },
        });

        if (!sale) {
            throw new FlashSaleNotFoundError();
        }

        if (!sale.isActive) {
            throw new FlashSaleNotActiveError();
        }

        if (sale.saleStock < quantity) {
            throw new FlashSaleOutOfStockError();
        }

        // Should not reach here, but safety fallback
        throw new FlashSaleOutOfStockError();
    }

    // Return the updated record
    return tx.flashSale.findUnique({
        where: { id: flashSaleId },
    });
}

/**
 * Release flash sale stock (e.g., when order is cancelled).
 *
 * MUST be called inside a transaction.
 */
export async function releaseFlashSaleStock(
    tx: Prisma.TransactionClient,
    flashSaleId: number,
    quantity: number
) {
    await tx.flashSale.update({
        where: { id: flashSaleId },
        data: {
            saleStock: { increment: quantity },
            soldCount: { decrement: quantity },
        },
    });
}

/**
 * Record a flash sale purchase (for purchase limit tracking).
 *
 * Uniqueness is enforced on @@unique([flashSaleId, ownerKey]) — the
 * `ownerKey` is the purchase-limit SCOPE:
 *   logged-in → "user:<userId>"   (see lib/guest-identity.ts)
 *   guest     → "guest:<hashed email/phone>"
 *
 * It cannot be keyed on userId alone: MySQL treats NULLs as distinct in
 * a unique index, which would silently disable the per-user purchase
 * limit for every guest.
 *
 * MUST be called inside a transaction.
 *
 * Returns the NEW quantity after increment.
 * Caller MUST validate against purchaseLimit to catch
 * concurrent race conditions.
 *
 * @param ownerKey Authoritative limit scope (guest path). When omitted,
 *                 it falls back to `user:<userId>` for logged-in
 *                 callers. There is NO silent unlimited fallback: a
 *                 call with neither scope throws.
 */
export async function recordFlashSalePurchase(
    tx: Prisma.TransactionClient,
    flashSaleId: number,
    userId: string | null,
    quantity: number,
    ownerKey?: string | null
): Promise<number> {
    // Fail-closed: never record a purchase without a limit scope,
    // otherwise the purchase cap would be silently skipped.
    const scope = requireUsageScope({ ownerKey, userId });

    // Check purchase limit
    const sale = await tx.flashSale.findUnique({
        where: { id: flashSaleId },
    });

    if (!sale) {
        throw new FlashSaleNotFoundError();
    }

    if (!sale.isActive) {
        throw new FlashSaleNotActiveError();
    }

    // Pre-check: reject if already at or over limit
    const existingPurchase = await tx.flashSalePurchase.findUnique({
        where: {
            flashSaleId_ownerKey: {
                flashSaleId,
                ownerKey: scope,
            },
        },
    });

    const purchaseLimit = sale.purchaseLimit ?? 1;
    const currentQuantity = existingPurchase?.quantity ?? 0;

    if (currentQuantity + quantity > purchaseLimit) {
        throw new FlashSalePurchaseLimitError(purchaseLimit);
    }

    // Upsert the purchase record
    let record;
    if (existingPurchase) {
        record = await tx.flashSalePurchase.update({
            where: {
                flashSaleId_ownerKey: {
                    flashSaleId,
                    ownerKey: scope,
                },
            },
            data: {
                quantity: { increment: quantity },
            },
        });
    } else {
        record = await tx.flashSalePurchase.create({
            data: {
                flashSaleId,
                ownerKey: scope,
                userId: userId ?? undefined,
                quantity,
            },
        });
    }

    // BUG FIX (P3-1): Post-increment validation.
    // Catches the race condition where two concurrent transactions
    // both read stale currentQuantity and both pass the pre-check.
    if (record.quantity > purchaseLimit) {
        throw new FlashSalePurchaseLimitError(purchaseLimit);
    }

    return record.quantity;
}

/**
 * Get the purchase count for a specific sale under a limit scope.
 *
 * Returns 0 when no scope can be resolved (nothing has been recorded
 * against that scope); this is a read-only helper and never consumes
 * anything.
 */
export async function getUserFlashSalePurchaseCount(
    flashSaleId: number,
    userId: string | null,
    ownerKey?: string | null
) {
    const scope = resolveUsageScope({ ownerKey, userId });

    if (!scope) {
        return 0;
    }

    const purchase = await prisma.flashSalePurchase.findUnique({
        where: {
            flashSaleId_ownerKey: {
                flashSaleId,
                ownerKey: scope,
            },
        },
    });

    return purchase?.quantity ?? 0;
}

/**
 * Check if a user has reached their flash sale purchase limit.
 */
export async function hasReachedFlashSaleLimit(
    flashSaleId: number,
    userId: string | null,
    ownerKey?: string | null
) {
    const sale = await prisma.flashSale.findUnique({
        where: { id: flashSaleId },
    });

    if (!sale) {
        return true; // If sale doesn't exist, treat as limited
    }

    const purchaseLimit = sale.purchaseLimit ?? 1;
    const currentCount = await getUserFlashSalePurchaseCount(
        flashSaleId,
        userId,
        ownerKey
    );

    return currentCount >= purchaseLimit;
}
