import { Prisma } from "@prisma/client";
import { orderOwnerKey } from "@/lib/guest-identity";

/* ==========================================
 * RELEASE STOCK + VOUCHER FOR ORDER
 * ==========================================
 *
 * Shared logic for restoring reserved stock
 * and voucher usage when an order is cancelled,
 * expired, failed, or refunded.
 *
 * Used by:
 *   - Payment webhook (expire/fail/refund)
 *   - Admin order status change (PAID → CANCELLED)
 *   - Checkout rollback
 *
 * Idempotent: if stock was already released,
 * conditional updates prevent double-restoring.
 *
 * Must be called INSIDE a Prisma transaction.
 */

/**
 * Check if an order item was purchased via flash sale.
 * FlashSale has @@unique([variantId]), so at most one record.
 */
async function isFlashSaleItem(
    tx: Prisma.TransactionClient,
    variantId: number | null
): Promise<boolean> {
    if (variantId === null) return false;
    const fs = await tx.flashSale.findFirst({
        where: { variantId },
        select: { id: true },
    });
    return fs !== null;
}

export async function releaseStockAndVoucherForOrder(
    tx: Prisma.TransactionClient,
    orderId: number
): Promise<void> {
    const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
    });

    if (!order) return;

    /*
     * The scope that consumed this order's limited resources: userId for
     * a logged-in buyer, hashed guest identity for a guest order. Every
     * per-scope release below MUST use it — filtering by `userId` alone
     * would, for a guest order (userId = NULL), match EVERY guest's
     * bucket instead of only the order's own.
     */
    const orderScope = orderOwnerKey(order);

    // ==========================================
    // RESTORE STOCK
    // ==========================================

    for (const item of order.items) {
        if (item.variantId === null) continue;

        const isFlashSale = await isFlashSaleItem(tx, item.variantId);

        if (isFlashSale) {
            // Flash sale: restore flash-sale stock
            await tx.$executeRaw`
                UPDATE flashsale
                SET saleStock = saleStock + ${item.quantity},
                    soldCount = GREATEST(0, soldCount - ${item.quantity})
                WHERE variantId = ${item.variantId}
                  AND soldCount >= ${item.quantity}
            `;

            /*
             * Cleanup purchase record so the buyer can re-attempt.
             *
             * Scoped by ownerKey (not userId) so a guest order releases
             * its OWN reservation: a guest purchase row has userId = NULL,
             * so filtering by userId would delete every guest's row for
             * this sale and reset their purchase caps.
             */
            if (orderScope) {
                await tx.flashSalePurchase.deleteMany({
                    where: {
                        flashSale: { variantId: item.variantId },
                        ownerKey: orderScope,
                    },
                });
            }
        } else {
            // Regular item: restore ProductVariant stock
            await tx.productVariant.update({
                where: { id: item.variantId },
                data: { stock: { increment: item.quantity } },
            });
        }

        // Restore sold count for both types
        if (item.productId !== null) {
            await tx.$executeRaw`
                UPDATE product
                SET sold = GREATEST(0, sold - ${item.quantity})
                WHERE id = ${item.productId}
            `;
        }
    }

    // ==========================================
    // RESTORE VOUCHER USAGE
    // ==========================================

    if (order.voucherId) {
        // Decrement global usedCount
        await tx.voucher.updateMany({
            where: {
                id: order.voucherId,
                usedCount: { gt: 0 },
            },
            data: { usedCount: { decrement: 1 } },
        });

        /*
         * Decrement per-scope usage.
         *
         * The scope is derived from the ORDER (userId for a logged-in
         * buyer, hashed guest identity for a guest order), so release is
         * always applied to the same bucket that consumed it.
         */
        const userUsage = orderScope
            ? await tx.voucherUserUsage.findUnique({
                  where: {
                      voucherId_ownerKey: {
                          voucherId: order.voucherId,
                          ownerKey: orderScope,
                      },
                  },
              })
            : null;

        if (userUsage && userUsage.usageCount > 0) {
            await tx.voucherUserUsage.update({
                where: { id: userUsage.id },
                data: { usageCount: { decrement: 1 } },
            });
        }
    }
}
