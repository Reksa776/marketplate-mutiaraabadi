/* ==========================================
 * RESI SCAN — SAFE APPLY + AUDIT
 * ==========================================
 *
 * Persists a confirmed tracking number with
 * strict safety checks performed again (not
 * trusted from the scan response):
 *   - order must exist
 *   - order status/payment must allow tracking
 *   - never overwrite an existing different resi
 *   - never reuse a resi already used by another
 *     order (race-safe inside a transaction)
 *   - tracking must pass format validation
 *
 * Every successful assignment writes an admin
 * audit log entry (AdminAuditLog via
 * lib/admin/audit-log.ts).
 */

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import { isPlausibleTrackingNumber } from "./extract";
import {
    isBlockedOrderStatus,
    isBlockedPaymentStatus,
} from "./engine";
import { createTrackingUrl } from "../tracking-url";
import type { ApplyScanItem, ApplyScanResult } from "./types";

import { createHash } from "crypto";

/**
 * MySQL advisory lock names must be short and
 * ASCII. We hash the natural keys so two
 * concurrent applies converge on the SAME lock
 * regardless of input phrasing (and the name
 * stays well under the 64-char GET_LOCK limit).
 */
function lockName(kind: string, value: string): string {
    const digest = createHash("sha256")
        .update(value)
        .digest("hex");
    return `scanapply:${kind}:${digest}`;
}

/**
 * Serialize the apply for a given order + tracking
 * using MySQL advisory locks. Without this, two
 * concurrent admins can both pass the "no
 * duplicate resi" check (MySQL REPEATABLE READ)
 * and the same resi ends up on two orders, or the
 * same order gets overwritten last-writer-wins.
 *
 * Locks are acquired and released on the SAME
 * transaction connection and always released in a
 * finally block (see acquireHeldLocks helpers
 * below, used inside the transaction callback).
 */

type LockRow = { ok: number | null };

async function acquireLock(
    tx: {
        $queryRaw: <T = unknown>(
            strings: TemplateStringsArray,
            ...values: unknown[]
        ) => Promise<T>;
    },
    name: string
): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<LockRow>>`
        SELECT GET_LOCK(${name}, 10) AS ok
    `;
    // 1 = acquired, 0 = timed out, NULL = error.
    return rows[0]?.ok === 1;
}

async function releaseLock(
    tx: {
        $queryRaw: <T = unknown>(
            strings: TemplateStringsArray,
            ...values: unknown[]
        ) => Promise<T>;
    },
    name: string
): Promise<void> {
    try {
        await tx.$queryRaw<Array<LockRow>>`
            SELECT RELEASE_LOCK(${name}) AS ok
        `;
    } catch {
        /* best-effort */
    }
}

/** Release some prefix of the held lock names. */
async function releaseLocks(
    tx: {
        $queryRaw: <T = unknown>(
            strings: TemplateStringsArray,
            ...values: unknown[]
        ) => Promise<T>;
    },
    names: string[],
    heldCount: number
): Promise<void> {
    for (let i = heldCount - 1; i >= 0; i--) {
        await releaseLock(tx, names[i]);
    }
}

function sanitizeAuditString(
    value: string | null | undefined,
    maxLength: number
): string | null {
    if (value == null) return null;
    const cleaned = value
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim();
    return cleaned
        ? cleaned.slice(0, maxLength)
        : null;
}

export async function applyScanResi(
    item: ApplyScanItem,
    adminId: string
): Promise<ApplyScanResult> {
    // ---- INPUT SHAPE VALIDATION ----

    const tracking =
        item.trackingNumber?.trim().toUpperCase() ?? "";
    const orderId = item.orderId;

    // Audit metadata is never trusted verbatim:
    // clamp confidence to [0,1] and strip
    // control characters / length from free-text
    // fields before they hit the log.
    const auditConfidence =
        typeof item.confidence === "number" &&
        Number.isFinite(item.confidence)
            ? Math.min(1, Math.max(0, item.confidence))
            : 0;
    const auditFileName = sanitizeAuditString(
        item.fileName,
        255
    );
    const auditCourier = sanitizeAuditString(
        item.courier,
        60
    );

    if (!orderId || Number.isNaN(orderId) || orderId <= 0) {
        return {
            orderId: null,
            orderNumber: item.orderNumber ?? null,
            trackingNumber: tracking,
            status: "INVALID",
            message: "ID pesanan tidak valid.",
        };
    }

    if (!tracking) {
        return {
            orderId,
            orderNumber: item.orderNumber ?? null,
            trackingNumber: item.trackingNumber ?? "",
            status: "INVALID",
            message: "Nomor resi kosong.",
        };
    }

    if (!isPlausibleTrackingNumber(tracking)) {
        return {
            orderId,
            orderNumber: item.orderNumber ?? null,
            trackingNumber: tracking,
            status: "INVALID",
            message:
                "Format nomor resi tidak valid.",
        };
    }

    // ---- SAFE CHECK + UPDATE (one transaction) ----

    try {
        const result = await prisma.$transaction(
            async (tx) => {
                // Acquire advisory locks: one per order,
                // one per tracking. Serializes concurrent
                // applies so the duplicate/overwrite
                // checks below are race-free.
                const lockNames = [
                    lockName("order", String(orderId)),
                    lockName(
                        "tracking",
                        tracking.toUpperCase()
                    ),
                ];

                let heldLocks = 0;

                try {
                    for (const name of lockNames) {
                        const acquired =
                            await acquireLock(tx, name);
                        if (!acquired) {
                            await releaseLocks(
                                tx,
                                lockNames,
                                heldLocks
                            );
                            return {
                                orderId,
                                orderNumber:
                                    item.orderNumber ??
                                    null,
                                trackingNumber: tracking,
                                status: "CONFLICT" as const,
                                message:
                                    "Permintaan resi sedang diproses admin lain. Coba lagi.",
                            };
                        }
                        heldLocks++;
                    }

                    const order =
                        await tx.order.findUnique({
                            where: { id: orderId },
                            select: {
                                id: true,
                                orderNumber: true,
                                status: true,
                                paymentStatus: true,
                                trackingNumber: true,
                            },
                        });

                    if (!order) {
                        return {
                            orderId,
                            orderNumber:
                                item.orderNumber ?? null,
                            trackingNumber: tracking,
                            status: "NOT_FOUND" as const,
                            message:
                                "Order tidak ditemukan.",
                        };
                    }

                    if (
                        isBlockedOrderStatus(order.status) ||
                        isBlockedPaymentStatus(
                            order.paymentStatus
                        )
                    ) {
                        return {
                            orderId,
                            orderNumber: order.orderNumber,
                            trackingNumber: tracking,
                            status: "CONFLICT" as const,
                            message:
                                "Status order tidak mengizinkan penambahan resi.",
                        };
                    }

                    if (
                        order.trackingNumber &&
                        order.trackingNumber.toLowerCase() ===
                            tracking.toLowerCase()
                    ) {
                        return {
                            orderId,
                            orderNumber:
                                order.orderNumber,
                            trackingNumber: tracking,
                            status: "ALREADY_SAME" as const,
                            message:
                                "Order sudah memiliki nomor resi yang sama.",
                        };
                    }

                    if (order.trackingNumber) {
                        return {
                            orderId,
                            orderNumber:
                                order.orderNumber,
                            trackingNumber: tracking,
                            status: "CONFLICT" as const,
                            message:
                                "Order sudah memiliki nomor resi berbeda. Scan tidak menimpa resi existing.",
                        };
                    }

                    const duplicate =
                        await tx.order.findFirst({
                            where: {
                                trackingNumber: tracking,
                                id: { not: orderId },
                            },
                            select: { id: true },
                        });

                    if (duplicate) {
                        return {
                            orderId,
                            orderNumber:
                                order.orderNumber,
                            trackingNumber: tracking,
                            status: "CONFLICT" as const,
                            message:
                                "Nomor resi sudah digunakan order lain.",
                        };
                    }

                    const trackingUrl = createTrackingUrl(
                        item.courier ?? "",
                        tracking
                    );

                    await tx.order.update({
                        where: { id: orderId },
                        data: {
                            trackingNumber: tracking,
                            ...(trackingUrl
                                ? { trackingUrl }
                                : {}),
                        },
                    });

                    return {
                        orderId,
                        orderNumber: order.orderNumber,
                        trackingNumber: tracking,
                        status: "APPLIED" as const,
                        message:
                            "Resi berhasil ditambahkan.",
                    };
                } finally {
                    await releaseLocks(
                        tx,
                        lockNames,
                        heldLocks
                    );
                }
            }
        );

        if (result.status === "APPLIED") {
            await createAuditLog({
                adminId,
                action: "ORDER_TRACKING_ASSIGNED",
                entityType: "Order",
                entityId: result.orderId ?? undefined,
                description: `Resi ${result.trackingNumber} ditambahkan ke order ${result.orderNumber} melalui Scan Resi.`,
                metadata: {
                    orderNumber: result.orderNumber,
                    previousTrackingNumber: null,
                    newTrackingNumber:
                        result.trackingNumber,
                    courier: auditCourier,
                    source: item.source === "pdf-text"
                        ? "pdf-text"
                        : "ocr",
                    confidence: auditConfidence,
                    fileName: auditFileName,
                },
            });
        }

        return result;
    } catch (error) {
        console.error(
            "RESI_SCAN_APPLY_ERROR:",
            error instanceof Error ? error.message : error
        );

        return {
            orderId,
            orderNumber: item.orderNumber ?? null,
            trackingNumber: tracking,
            status: "INVALID",
            message:
                "Gagal menyimpan resi (database error).",
        };
    }
}