import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
    recordFlashSalePurchase,
} from "./marketing/flash-sale";

/* ==========================================
 * REPAYMENT ELIGIBILITY
 * ==========================================
 *
 * Determines if an order is eligible for repayment.
 *
 * Rules:
 * - Order must exist and belong to the user
 * - Order must be in a repayable state:
 *   - paymentStatus = FAILED (auto-cancelled after failure)
 *   - paymentStatus = EXPIRED (auto-cancelled after expiry)
 *   - paymentStatus = PENDING + status = PENDING (still awaiting payment)
 * - Order status must not be COMPLETED/SHIPPED/REFUNDED
 *
 * Server-authoritative: all values from DB.
 */

export type RepayEligibility =
    | {
          eligible: true;
          needsStockRestore: boolean;
          orderTotal: Prisma.Decimal;
      }
    | { eligible: false; reason: string };

const REPAYABLE_PAYMENT_STATUSES = ["FAILED", "EXPIRED", "PENDING"];
const REPAYABLE_ORDER_STATUSES = [
    "PENDING",
    "CANCELLED", // auto-cancelled after payment failure/expiry
];

export function checkRepayEligibility(
    orderStatus: string,
    paymentStatus: string
): RepayEligibility {
    // Already paid
    if (paymentStatus === "PAID") {
        return {
            eligible: false,
            reason: "Pesanan sudah dibayar.",
        };
    }

    // Already refunded
    if (paymentStatus === "REFUNDED") {
        return {
            eligible: false,
            reason: "Pesanan sudah direfund.",
        };
    }

    // Must be in a repayable payment status
    if (!REPAYABLE_PAYMENT_STATUSES.includes(paymentStatus)) {
        return {
            eligible: false,
            reason: `Pesanan dengan status pembayaran ${paymentStatus} tidak dapat dibayar ulang.`,
        };
    }

    // Order must be in a repayable state
    if (!REPAYABLE_ORDER_STATUSES.includes(orderStatus)) {
        return {
            eligible: false,
            reason: `Pesanan dengan status ${orderStatus} tidak dapat dibayar ulang.`,
        };
    }

    // For PENDING payment status, order must also be PENDING
    if (paymentStatus === "PENDING" && orderStatus !== "PENDING") {
        return {
            eligible: false,
            reason: "Pesanan tidak dalam status yang memungkinkan pembayaran ulang.",
        };
    }

    // Stock was released if order was auto-cancelled
    const needsStockRestore =
        orderStatus === "CANCELLED" &&
        (paymentStatus === "FAILED" || paymentStatus === "EXPIRED");

    return {
        eligible: true,
        needsStockRestore,
        orderTotal: new Prisma.Decimal(0),
    };
}

/* ==========================================
 * RE-RESERVE STOCK FOR REPAYMENT
 * ==========================================
 *
 * When an order was auto-cancelled due to payment
 * failure/expiry, stock was already released.
 * Before creating a new payment attempt, we need
 * to re-reserve the stock.
 *
 * This is the INVERSE of releaseStockAndVoucherForOrder.
 *
 * Must be called INSIDE a Prisma transaction.
 */

async function reReserveStockForOrder(
    tx: Prisma.TransactionClient,
    orderId: number
): Promise<void> {
    const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
    });

    if (!order) return;

    for (const item of order.items) {
        if (item.variantId === null) continue;

        // Check if flash sale item
        const flashSale = await tx.flashSale.findFirst({
            where: { variantId: item.variantId },
            select: { id: true, isActive: true, saleStock: true },
        });

        if (flashSale && flashSale.isActive) {
            // F18: re-reserve flash stock AND re-enforce the per-user
            // purchase limit. recordFlashSalePurchase pre-checks AND
            // post-validates against purchaseLimit (race-safe).
            try {
                await recordFlashSalePurchase(
                    tx,
                    flashSale.id,
                    order.userId,
                    item.quantity
                );
            } catch (error) {
                const { FlashSalePurchaseLimitError } =
                    await import("./marketing/errors");
                if (error instanceof FlashSalePurchaseLimitError) {
                    throw new Error(
                        `Batas pembelian flash sale ${item.productName} sudah tercapai untuk pembayaran ulang.`
                    );
                }
                throw error;
            }

            // Flash sale: re-reserve flash sale stock
            const affectedRows = await tx.$executeRaw`
                UPDATE flashsale
                SET saleStock = saleStock - ${item.quantity},
                    soldCount = soldCount + ${item.quantity}
                WHERE id = ${flashSale.id}
                  AND isActive = true
                  AND saleStock >= ${item.quantity}
            `;

            if (affectedRows === 0) {
                throw new Error(
                    `Stok flash sale ${item.productName} tidak mencukupi untuk pembayaran ulang.`
                );
            }

            // F5: keep Product.sold in sync for flash items (the
            // generic branch below only handles non-flash items).
            if (item.productId !== null) {
                await tx.product.update({
                    where: { id: item.productId },
                    data: { sold: { increment: item.quantity } },
                });
            }
        } else {
            // Regular item: re-reserve variant stock
            const stockUpdate = await tx.productVariant.updateMany({
                where: {
                    id: item.variantId,
                    stock: { gte: item.quantity },
                },
                data: {
                    stock: { decrement: item.quantity },
                },
            });

            if (stockUpdate.count !== 1) {
                throw new Error(
                    `Stok ${item.productName} - ${item.variantName} tidak mencukupi untuk pembayaran ulang.`
                );
            }

            // Restore sold count
            if (item.productId !== null) {
                await tx.product.update({
                    where: { id: item.productId },
                    data: { sold: { increment: item.quantity } },
                });
            }
        }
    }

    // Re-reserve voucher usage
    if (typeof order.voucherId === "number") {
        const { incrementVoucherUsage } = await import("@/lib/voucher");

        // F18: re-enforce the per-user cap before re-consuming it.
        const voucher = await tx.voucher.findUnique({
            where: { id: order.voucherId },
            select: { id: true, maxUsagePerUser: true },
        });

        if (voucher?.maxUsagePerUser) {
            const usageRow = await tx.voucherUserUsage.findUnique({
                where: {
                    voucherId_userId: {
                        voucherId: order.voucherId,
                        userId: order.userId,
                    },
                },
            });

            const currentUsage = usageRow?.usageCount ?? 0;
            if (currentUsage >= voucher.maxUsagePerUser) {
                throw new Error(
                    "Batas pemakaian voucher sudah tercapai untuk pembayaran ulang."
                );
            }
        }

        const voucherReserved = await incrementVoucherUsage(tx, order.voucherId);

        if (!voucherReserved) {
            throw new Error(
                "Kuota voucher tidak mencukupi untuk pembayaran ulang."
            );
        }

        await tx.voucherUserUsage.upsert({
            where: {
                voucherId_userId: {
                    voucherId: order.voucherId,
                    userId: order.userId,
                },
            },
            create: {
                voucherId: order.voucherId,
                userId: order.userId,
                usageCount: 1,
            },
            update: { usageCount: { increment: 1 } },
        });
    }

    // Re-reserve spin wheel reward
    let spinRecord: { id: number } | null = null;

    if (order.originalSpinWheelSpinId != null) {
        /*
         * F18: use the EXACT spin the original checkout consumed
         * (identity persisted on the order). Re-reserve it only if
         * cancel has released it and no OTHER order took it since.
         */
        spinRecord = await tx.spinWheelSpin.findFirst({
            where: {
                id: order.originalSpinWheelSpinId,
                userId: order.userId,
                status: "AVAILABLE",
                orderId: null,
            },
            select: { id: true },
        });
    }

    if (!spinRecord && order.originalSpinWheelSpinId == null) {
        // Legacy orders without an original-spin snapshot keep the
        // previous behavior (latest available spin). Orders WITH a
        // snapshot never grab a DIFFERENT spin if the original was
        // already consumed elsewhere or expired.
        spinRecord = await tx.spinWheelSpin.findFirst({
            where: {
                userId: order.userId,
                status: "AVAILABLE",
                orderId: null,
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
    }

    if (spinRecord) {
        await tx.spinWheelSpin.update({
            where: { id: spinRecord.id },
            data: {
                status: "USED",
                usedAt: new Date(),
                orderId: order.id,
            },
        });
    }
}

/* ==========================================
 * PROCESS REPAYMENT
 * ==========================================
 *
 * Creates a new payment attempt for an existing order.
 *
 * Security:
 * - Ownership check (userId matches)
 * - Server-side amount (order.total from DB)
 * - CAS on order status (reset to PENDING)
 * - Idempotent (status check prevents double processing)
 * - Rate limited by caller
 */

export type RepayOrderResult =
    | {
          ok: true;
          orderId: number;
          orderNumber: string;
          grossAmount: number;
          paymentMethod: string;
          needsStockRestore: boolean;
      }
    | { ok: false; reason: string };

export async function processRepayment(
    userId: string,
    orderId: number,
    paymentMethod: string,
    expected?: {
        status: string;
        paymentStatus: string;
    }
): Promise<RepayOrderResult> {
    // ==========================================
    // VALIDATE PAYMENT METHOD
    // ==========================================

    const validMethods = ["BANK_TRANSFER", "E_WALLET", "QRIS"];
    if (!validMethods.includes(paymentMethod)) {
        return {
            ok: false,
            reason: "Metode pembayaran tidak valid.",
        };
    }

    return prisma.$transaction(
        async (tx): Promise<RepayOrderResult> => {
            // ==========================================
            // 1. FIND ORDER + OWNERSHIP CHECK
            // ==========================================

            const order = await tx.order.findFirst({
                where: {
                    id: orderId,
                    userId,
                },
                select: {
                    id: true,
                    orderNumber: true,
                    status: true,
                    paymentStatus: true,
                    paymentMethod: true,
                    total: true,
                },
            });

            if (!order) {
                return {
                    ok: false,
                    reason: "Order tidak ditemukan.",
                };
            }

            // ==========================================
            // 2. ELIGIBILITY CHECK
            // ==========================================

            const eligibility = checkRepayEligibility(
                order.status,
                order.paymentStatus
            );

            if (!eligibility.eligible) {
                return {
                    ok: false,
                    reason: eligibility.reason,
                };
            }

            // ==========================================
            // 3. CAS: CLAIM THE ORDER (SINGLE WINNER)
            // ==========================================
            //
            // Claim the order BEFORE touching stock/voucher.
            //
            // When the caller supplies the state it observed before
            // the transaction (`expected`), the CAS uses those exact
            // values. This is what guarantees a single winner: a
            // concurrent repay that read the same pre-state will find
            // the order already moved and fail, instead of both
            // succeeding because the intermediate PENDING/PENDING
            // state also happens to be repayable.
            //
            // Prevents:
            // - Resurrecting a PAID/COMPLETED order
            // - Race with concurrent webhook
            // - Double reservation / duplicate instruction by
            //   concurrent repays

            const expectedStatus =
                expected?.status ?? order.status;
            const expectedPaymentStatus =
                expected?.paymentStatus ?? order.paymentStatus;

            const affectedRows = await tx.$executeRaw`
                UPDATE \`order\`
                SET status = 'PENDING',
                    paymentStatus = 'PENDING',
                    paymentMethod = ${paymentMethod}
                WHERE id = ${orderId}
                  AND status = ${expectedStatus}
                  AND paymentStatus = ${expectedPaymentStatus}
            `;

            if (affectedRows === 0) {
                return {
                    ok: false,
                    reason:
                        "Status order berubah saat pemrosesan. Silakan coba lagi.",
                };
            }

            // ==========================================
            // 4. RE-RESERVE STOCK IF NEEDED
            // ==========================================
            //
            // If the order was auto-cancelled (FAILED/EXPIRED), stock
            // was already released. Re-reserve AFTER the claim. Any
            // failure THROWS so the claim and every partial
            // reservation are rolled back atomically; the outer catch
            // converts it to ok:false.

            if (eligibility.needsStockRestore) {
                await reReserveStockForOrder(tx, orderId);
            }

            // ==========================================
            // 5. AUDIT LOG
            // ==========================================

            try {
                const { createAuditLog } = await import(
                    "@/lib/admin/audit-log"
                );
                await createAuditLog({
                    adminId: userId,
                    action: "REPAYMENT_INITIATED",
                    entityType: "Order",
                    entityId: orderId,
                    description: `Repayment initiated: Rp ${order.total.toString()} via ${paymentMethod}`,
                    metadata: {
                        orderId,
                        orderNumber: order.orderNumber,
                        amount: order.total.toString(),
                        paymentMethod,
                        previousPaymentStatus: order.paymentStatus,
                    },
                });
            } catch {
                /* non-critical */
            }

            return {
                ok: true,
                orderId: order.id,
                orderNumber: order.orderNumber,
                grossAmount: Number(order.total.toString()),
                paymentMethod,
                needsStockRestore: eligibility.needsStockRestore,
            };
        },
        {
            timeout: 15000,
            maxWait: 10000,
        }
    ).catch((error: unknown) => ({
        ok: false as const,
        reason:
            error instanceof Error && error.message
                ? error.message
                : "Gagal memproses pembayaran ulang.",
    }));
}
