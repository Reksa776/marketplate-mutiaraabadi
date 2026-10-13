import { prisma } from "@/lib/prisma";
import { BroadcastType, BroadcastStatus, NotificationChannel as NotificationChannelEnum, Prisma } from "@prisma/client";
import { getWhatsAppService } from "@/lib/whatsapp/service";
import { normalizePhoneToJid, isValidIndonesianPhone } from "@/lib/whatsapp/phone";
import { getNotificationQueue } from "@/lib/notification/queue";

/**
 * VALID BROADCAST STATUS TRANSITIONS
 * ==========================================
 * Only these transitions are allowed:
 *   DRAFT     → SENDING, DRAFT
 *   SCHEDULED → SENDING, DRAFT, SCHEDULED
 *   SENDING   → COMPLETED, FAILED
 *   COMPLETED → (terminal)
 *   FAILED    → DRAFT (for retry)
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
    DRAFT:     ["DRAFT", "SENDING"],
    SCHEDULED: ["DRAFT", "SCHEDULED", "SENDING"],
    SENDING:   ["COMPLETED", "FAILED"],
    COMPLETED: [],
    FAILED:    ["DRAFT"],
};

/**
 * Validate broadcast status transition.
 * Throws if transition is not allowed.
 */
function validateStatusTransition(current: string, next: string) {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.includes(next)) {
        throw new Error(
            `Transisi dari ${current} ke ${next} tidak diperbolehkan.`
        );
    }
}

/**
 * DELAY BETWEEN MESSAGES (ms)
 * Prevents WhatsApp rate-limiting.
 */
const MESSAGE_DELAY_MS = 500;

/**
 * ==========================================
 * AUDIENCE MEMBER FROM AN ORDER
 * ==========================================
 *
 * Broadcast audiences are ACCOUNT-based: they are built from the
 * `user` relation, which is what the admin audience UI has always
 * shown.
 *
 * Since guest checkout, `Order.userId` and `Order.user` can both be
 * NULL. Such orders have no account contact attached and are skipped
 * here — the historical, account-based audience is preserved exactly
 * and no guest is silently mapped onto someone else's account.
 *
 * (Reaching guest buyers by `Order.customerEmail` / `Order.phone` is a
 * separate product decision, reported as an open item.)
 */
function audienceMemberFromUser(
    order: {
        userId: string | null;
        user: {
            id: string;
            name: string | null;
            phone: string | null;
            email: string | null;
        } | null;
    },
    reason: string
) {
    const user = order.user;

    if (!order.userId || !user) {
        return null;
    }

    if (!user.phone && !user.email) {
        return null;
    }

    return {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        reason,
    };
}

/**
 * Sleep utility.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ==========================================
 * BROADCAST SERVICE
 * ==========================================
 *
 * Manages marketing broadcasts:
 * - Audience targeting (server-side)
 * - Message preparation
 * - Delivery tracking
 *
 * Delivery channels:
 * - WhatsApp (via existing WhatsApp service)
 * - Email (future)
 * - Push notification (future)
 *
 * IMPORTANT:
 * - Audience is always calculated server-side
 * - Never trust client-provided audience lists
 * - Broadcast targets existing user/order data only
 */

// ==========================================
// TYPES
// ==========================================

export type BroadcastAudienceMember = {
    userId: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    reason: string;
};

export type BroadcastWithStats = {
    id: number;
    name: string;
    type: BroadcastType;
    channel: string;
    subject: string | null;
    message: string;
    imageUrl: string | null;
    link: string | null;
    status: BroadcastStatus;
    scheduledAt: Date | null;
    sentAt: Date | null;
    audienceCount: number;
    sentCount: number;
    failedCount: number;
    createdAt: Date;
    updatedAt: Date;
};

// ==========================================
// CRUD
// ==========================================

export async function createBroadcast(data: {
    name: string;
    type: BroadcastType;
    channel: NotificationChannelEnum | string;
    subject?: string | null;
    message: string;
    imageUrl?: string | null;
    link?: string | null;
    scheduledAt?: Date | null;
}) {
    // Calculate audience count
    const audience = await getBroadcastAudience(data.type);
    const audienceCount = audience.length;

    return prisma.broadcast.create({
        data: {
            name: data.name,
            type: data.type,
            channel: data.channel as NotificationChannelEnum,
            subject: data.subject ?? null,
            message: data.message,
            imageUrl: data.imageUrl ?? null,
            link: data.link ?? null,
            status: data.scheduledAt ? "SCHEDULED" : "DRAFT",
            scheduledAt: data.scheduledAt ?? null,
            audienceCount,
        },
    });
}

export async function updateBroadcast(
    id: number,
    data: {
        name?: string;
        subject?: string | null;
        message?: string;
        imageUrl?: string | null;
        link?: string | null;
        scheduledAt?: Date | null;
        status?: BroadcastStatus;
    }
) {
    const existing = await prisma.broadcast.findUnique({ where: { id } });
    if (!existing) throw new Error("Broadcast tidak ditemukan.");

    if (existing.status === "COMPLETED" || existing.status === "SENDING") {
        throw new Error("Broadcast yang sudah dikirim tidak bisa diubah.");
    }

    // Validate status transition (B2-3 FIX)
    if (data.status !== undefined && data.status !== existing.status) {
        validateStatusTransition(existing.status, data.status);
    }

    return prisma.broadcast.update({ where: { id }, data });
}

export async function deleteBroadcast(id: number) {
    const existing = await prisma.broadcast.findUnique({ where: { id } });
    if (!existing) throw new Error("Broadcast tidak ditemukan.");

    if (existing.status === "SENDING") {
        throw new Error("Broadcast sedang dikirim, tidak bisa dihapus.");
    }

    return prisma.broadcast.delete({ where: { id } });
}

export async function getBroadcast(id: number) {
    const broadcast = await prisma.broadcast.findUnique({ where: { id } });
    if (!broadcast) throw new Error("Broadcast tidak ditemukan.");
    return broadcast;
}

export async function listBroadcasts(options?: {
    type?: BroadcastType;
    status?: BroadcastStatus;
    search?: string;
    limit?: number;
    offset?: number;
}) {
    const where: any = {};
    if (options?.type) where.type = options.type;
    if (options?.status) where.status = options.status;
    if (options?.search && options.search.trim()) {
        where.name = { contains: options.search.trim() };
    }

    const [items, total] = await Promise.all([
        prisma.broadcast.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: options?.limit ?? 50,
            skip: options?.offset ?? 0,
        }),
        prisma.broadcast.count({ where }),
    ]);

    return { items, total };
}

// ==========================================
// AUDIENCE TARGETING (SERVER-SIDE)
// ==========================================

/**
 * Calculate broadcast audience based on type.
 * All targeting is server-side from existing order/user data.
 */
export async function getBroadcastAudience(
    type: BroadcastType
): Promise<BroadcastAudienceMember[]> {
    switch (type) {
        case "BEST_SELLER":
            return getBestSellerAudience();
        case "NEW_PRODUCT":
            return getNewProductAudience();
        case "BUY_AGAIN":
            return getBuyAgainAudience();
        case "INACTIVE_BUYER":
            return getInactiveBuyerAudience();
        case "PRICE_DROP":
            return getPriceDropAudience();
        case "CART_REMINDER":
            return getCartReminderAudience();
        case "CHECKOUT_REMINDER":
            return getCheckoutReminderAudience();
        case "THANK_YOU":
            return getThankYouAudience();
        default:
            return [];
    }
}

/**
 * Best sellers: customers who purchased bestseller products
 * → Recommend related products in the same category
 */
async function getBestSellerAudience(): Promise<BroadcastAudienceMember[]> {
    // Find users who purchased bestseller products
    const bestsellerProducts = await prisma.product.findMany({
        where: { bestseller: true, isArchived: false },
        select: { id: true },
    });

    if (bestsellerProducts.length === 0) return [];

    const orders = await prisma.order.findMany({
        where: {
            status: { in: ["PAID", "PROCESSING", "SHIPPED", "COMPLETED"] },
            items: {
                some: {
                    productId: { in: bestsellerProducts.map((p) => p.id) },
                },
            },
        },
        select: {
            userId: true,
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
        distinct: ["userId"],
    });

    return orders
        .map((o) =>
            audienceMemberFromUser(
                o,
                "Pembeli produk terlaris"
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

/**
 * New product launch: target customers who purchased products
 * in the same category as the new product
 */
async function getNewProductAudience(): Promise<BroadcastAudienceMember[]> {
    // Find recent products (last 7 days) and their categories
    const recentProducts = await prisma.product.findMany({
        where: {
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            isArchived: false,
            category: { not: null },
        },
        select: { id: true, category: true },
    });

    const categories = [...new Set(recentProducts.map((p) => p.category).filter(Boolean))] as string[];
    if (categories.length === 0) return [];

    const orders = await prisma.order.findMany({
        where: {
            status: { in: ["PAID", "PROCESSING", "SHIPPED", "COMPLETED"] },
            items: {
                some: {
                    product: { category: { in: categories } },
                },
            },
        },
        select: {
            userId: true,
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
        distinct: ["userId"],
    });

    return orders
        .map((o) =>
            audienceMemberFromUser(
                o,
                "Pembeli kategori produk baru"
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

/**
 * Buy again: customers with completed orders (potential repeat buyers)
 */
async function getBuyAgainAudience(): Promise<BroadcastAudienceMember[]> {
    const orders = await prisma.order.findMany({
        where: {
            status: { in: ["PAID", "PROCESSING", "SHIPPED", "COMPLETED"] },
            paymentStatus: "PAID",
        },
        select: {
            userId: true,
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
        distinct: ["userId"],
    });

    return orders
        .map((o) =>
            audienceMemberFromUser(
                o,
                "Pembeli aktif — ajakan beli lagi"
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

/**
 * Inactive buyers: customers who haven't purchased in X days
 */
async function getInactiveBuyerAudience(): Promise<BroadcastAudienceMember[]> {
    const inactiveThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    // Find users whose last order is older than threshold
    const usersWithRecentOrder = await prisma.order.groupBy({
        by: ["userId"],
        where: {
            createdAt: { gte: inactiveThreshold },
        },
    });

    const recentUserIds = new Set(
        usersWithRecentOrder
            .map((g) => g.userId)
            .filter((id): id is string => id !== null)
    );

    // Find all users with at least one order but no recent order.
    // Guest orders (userId NULL) have no account, so they are excluded
    // from this account-based audience.
    const allBuyingUsers = await prisma.order.groupBy({
        by: ["userId"],
    });

    const inactiveUserIds = allBuyingUsers
        .map((g) => g.userId)
        .filter((id): id is string => id !== null)
        .filter((id) => !recentUserIds.has(id));

    if (inactiveUserIds.length === 0) return [];

    const users = await prisma.user.findMany({
        where: { id: { in: inactiveUserIds } },
        select: { id: true, name: true, phone: true, email: true },
    });

    return users
        .filter((u) => u.phone || u.email)
        .map((u) => ({
            userId: u.id,
            name: u.name,
            phone: u.phone,
            email: u.email,
            reason: "Pembeli tidak aktif > 30 hari",
        }));
}

/**
 * Price drop: customers who previously purchased products
 * whose effective price has decreased
 *
 * NOTE: Requires comparing stored order price vs current price.
 * Since we store OrderItem.price (server-resolved), we can compare
 * with current batch pricing.
 */
async function getPriceDropAudience(): Promise<BroadcastAudienceMember[]> {
    // Find recent orders (last 60 days) with items
    const recentOrders = await prisma.order.findMany({
        where: {
            createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
            status: { in: ["PAID", "PROCESSING", "SHIPPED", "COMPLETED"] },
        },
        include: {
            items: { select: { productId: true, variantId: true, price: true } },
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
    });

    if (recentOrders.length === 0) return [];

    // Group by user → their purchased variantIds with order prices
    const userPurchases = new Map<string, { name: string | null; phone: string | null; email: string | null; items: { variantId: number; orderPrice: number }[] }>();

    for (const order of recentOrders) {
        // Guest orders (userId/user NULL) are not part of this
        // account-based audience.
        if (!order.userId || !order.user) continue;

        if (!order.user.phone && !order.user.email) continue;

        const existing = userPurchases.get(order.userId) ?? {
            name: order.user.name,
            phone: order.user.phone,
            email: order.user.email,
            items: [],
        };

        for (const item of order.items) {
            if (item.variantId) {
                existing.items.push({
                    variantId: item.variantId,
                    orderPrice: Number(item.price),
                });
            }
        }

        userPurchases.set(order.userId, existing);
    }

    // Check current prices for these variants
    const allVariantIds = [...new Set([...userPurchases.values()].flatMap((u) => u.items.map((i) => i.variantId)))];

    if (allVariantIds.length === 0) return [];

    const currentVariants = await prisma.productVariant.findMany({
        where: { id: { in: allVariantIds } },
        select: { id: true, price: true },
    });

    const currentPriceMap = new Map(currentVariants.map((v) => [v.id, Number(v.price)]));

    // Find users whose purchased items now have lower prices
    const audience: BroadcastAudienceMember[] = [];

    for (const [userId, data] of userPurchases) {
        const hasPriceDrop = data.items.some((item) => {
            const currentPrice = currentPriceMap.get(item.variantId);
            return currentPrice !== undefined && currentPrice < item.orderPrice;
        });

        if (hasPriceDrop) {
            audience.push({
                userId,
                name: data.name,
                phone: data.phone,
                email: data.email,
                reason: "Harga produk yang pernah dibeli turun",
            });
        }
    }

    return audience;
}

/**
 * Cart reminder: users with non-empty carts
 */
async function getCartReminderAudience(): Promise<BroadcastAudienceMember[]> {
    const carts = await prisma.cart.findMany({
        where: {
            items: { some: {} },
        },
        include: {
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
    });

    return carts
        .map((c) =>
            audienceMemberFromUser(
                c,
                "Masih ada produk di keranjang"
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

/**
 * Checkout reminder: users with pending orders (not yet paid)
 */
async function getCheckoutReminderAudience(): Promise<BroadcastAudienceMember[]> {
    const orders = await prisma.order.findMany({
        where: {
            status: "PENDING",
            paymentStatus: { in: ["UNPAID", "PENDING"] },
        },
        select: {
            userId: true,
            orderNumber: true,
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
        distinct: ["userId"],
    });

    return orders
        .map((o) =>
            audienceMemberFromUser(
                o,
                `Pesanan ${o.orderNumber} belum dibayar`
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

/**
 * Thank you: users with recently completed orders
 */
async function getThankYouAudience(): Promise<BroadcastAudienceMember[]> {
    const orders = await prisma.order.findMany({
        where: {
            status: "COMPLETED",
            paymentStatus: "PAID",
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        select: {
            userId: true,
            user: { select: { id: true, name: true, phone: true, email: true } },
        },
        distinct: ["userId"],
    });

    return orders
        .map((o) =>
            audienceMemberFromUser(
                o,
                "Pesanan selesai — ucapan terima kasih"
            )
        )
        .filter(
            (
                member
            ): member is BroadcastAudienceMember =>
                member !== null
        );
}

// ==========================================
// BROADCAST TYPE LABELS
// ==========================================

export const BROADCAST_TYPE_LABELS: Record<BroadcastType, string> = {
    BEST_SELLER: "Produk Terlaris",
    NEW_PRODUCT: "Produk Baru",
    BUY_AGAIN: "Beli Lagi",
    INACTIVE_BUYER: "Pembeli Tidak Aktif",
    PRICE_DROP: "Harga Turun",
    CART_REMINDER: "Keranjang",
    CHECKOUT_REMINDER: "Reminder Checkout",
    THANK_YOU: "Terima Kasih",
};

export const BROADCAST_TYPE_DESCRIPTIONS: Record<BroadcastType, string> = {
    BEST_SELLER: "Bagikan info produk terlaris kepada pembeli yang relevan",
    NEW_PRODUCT: "Umumkan peluncuran produk baru kepada target yang sesuai",
    BUY_AGAIN: "Dorong pembeli untuk membeli lagi",
    INACTIVE_BUYER: "Tarik pembeli yang sudah lama tidak berbelanja",
    PRICE_DROP: "Ingatkan bahwa harga produk yang pernah dibeli turun",
    CART_REMINDER: "Ingatkan masih ada produk di keranjang",
    CHECKOUT_REMINDER: "Ingatkan untuk checkout pesanan yang tertunda",
    THANK_YOU: "Ucapan terima kasih setelah pembeli menyelesaikan pesanan",
};

// ==========================================
// SEND BROADCAST
// ==========================================

/**
 * Send a broadcast to all audience members.
 *
 * Flow:
 * 1. Validate status transition (DRAFT/SCHEDULED → SENDING)
 * 2. Recalculate audience (fresh, not stale snapshot)
 * 3. For each member: personalize message → send via WhatsApp
 * 4. Update sentCount / failedCount
 * 5. Set status to COMPLETED or FAILED
 *
 * This runs synchronously within the API request.
 * For large audiences (>50), consider background processing.
 */
export async function sendBroadcast(
    broadcastId: number
): Promise<{ sentCount: number; failedCount: number; total: number }> {
    const broadcast = await prisma.broadcast.findUnique({
        where: { id: broadcastId },
    });

    if (!broadcast) {
        throw new Error("Broadcast tidak ditemukan.");
    }

    // Validate status transition
    validateStatusTransition(broadcast.status, "SENDING");

    // Atomically set status to SENDING (CAS: only if DRAFT or SCHEDULED)
    const affectedRows = await prisma.$executeRaw`
        UPDATE broadcast
        SET status = 'SENDING'
        WHERE id = ${broadcastId}
          AND status IN ('DRAFT', 'SCHEDULED')
    `;

    if (affectedRows === 0) {
        throw new Error("Broadcast sudah dalam status pengiriman atau selesai.");
    }

    // Recalculate audience (fresh, not stale)
    const audience = await getBroadcastAudience(broadcast.type);
    const total = audience.length;

    if (total === 0) {
        // No audience → mark as completed immediately
        await prisma.broadcast.update({
            where: { id: broadcastId },
            data: {
                status: "COMPLETED",
                sentAt: new Date(),
                audienceCount: 0,
                sentCount: 0,
                failedCount: 0,
            },
        });
        return { sentCount: 0, failedCount: 0, total: 0 };
    }

    // Update audience count with fresh value
    await prisma.broadcast.update({
        where: { id: broadcastId },
        data: { audienceCount: total },
    });

    // Check WhatsApp connection if channel is whatsapp
    if (broadcast.channel === "whatsapp") {
        const service = getWhatsAppService();
        const status = service.getStatus();
        if (status.status !== "CONNECTED") {
            await prisma.broadcast.update({
                where: { id: broadcastId },
                data: {
                    status: "FAILED",
                    sentAt: new Date(),
                    failedCount: total,
                },
            });
            throw new Error(`WhatsApp tidak terkoneksi (status: ${status.status}).`);
        }
    }

    let sentCount = 0;
    let failedCount = 0;

    // Send to each audience member
    for (const member of audience) {
        try {
            // Determine recipient phone
            const recipientPhone = member.phone;

            if (!recipientPhone || !isValidIndonesianPhone(recipientPhone)) {
                failedCount++;
                continue;
            }

            // Personalize message
            const personalizedMessage = personalizeMessage(
                broadcast.message,
                member
            );

            // Send via WhatsApp
            if (broadcast.channel === "whatsapp") {
                const service = getWhatsAppService();
                const jid = normalizePhoneToJid(recipientPhone);

                if (!jid) {
                    failedCount++;
                    continue;
                }

                const result = await service.sendMessage(jid, personalizedMessage);

                if (result.success) {
                    sentCount++;
                } else {
                    failedCount++;
                    console.error(
                        `[BROADCAST] Failed to send to ${recipientPhone}: ${result.errorMessage}`
                    );
                }
            } else {
                // Non-WhatsApp channels not yet implemented
                failedCount++;
            }

            // Delay between messages to avoid rate-limiting
            if (sentCount + failedCount < total) {
                await sleep(MESSAGE_DELAY_MS);
            }
        } catch (error) {
            failedCount++;
            console.error(
                `[BROADCAST] Error sending to ${member.phone}:`,
                error
            );
        }
    }

    // Determine final status
    const finalStatus = failedCount === total ? "FAILED" : "COMPLETED";

    await prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
            status: finalStatus,
            sentAt: new Date(),
            sentCount,
            failedCount,
        },
    });

    console.log(
        `[BROADCAST] Completed | ID: ${broadcastId} | ` +
        `Sent: ${sentCount} | Failed: ${failedCount} | Total: ${total}`
    );

    return { sentCount, failedCount, total };
}

/**
 * Personalize broadcast message with member data.
 * Supports {name} placeholder.
 */
function personalizeMessage(
    template: string,
    member: BroadcastAudienceMember
): string {
    return template
        .replace(/{name}/g, member.name || "Pelanggan")
        .replace(/{phone}/g, member.phone || "")
        .replace(/{email}/g, member.email || "");
}

// ==========================================
// SCHEDULED BROADCAST PROCESSOR
// ==========================================

/**
 * Process scheduled broadcasts whose scheduledAt has passed.
 * Called by cron job or periodic check.
 *
 * Flow:
 * 1. Find all SCHEDULED broadcasts with scheduledAt <= now
 * 2. Send each one
 * 3. Log results
 */
export async function processScheduledBroadcasts(): Promise<void> {
    const now = new Date();

    const scheduledBroadcasts = await prisma.broadcast.findMany({
        where: {
            status: "SCHEDULED",
            scheduledAt: { not: null, lte: now },
        },
        orderBy: { scheduledAt: "asc" },
        take: 5, // Process max 5 at a time
    });

    for (const broadcast of scheduledBroadcasts) {
        console.log(
            `[BROADCAST] Processing scheduled | ID: ${broadcast.id} | Name: ${broadcast.name}`
        );

        try {
            await sendBroadcast(broadcast.id);
        } catch (error) {
            console.error(
                `[BROADCAST] Failed to process scheduled | ID: ${broadcast.id}:`,
                error
            );
        }
    }
}

// ==========================================
// VALID STATUS TRANSITIONS (exported for tests)
// ==========================================

export { VALID_TRANSITIONS, validateStatusTransition };

// ==========================================
// BACKGROUND WORKER (in-memory queue)
// ==========================================

/**
 * Register the broadcast worker on the in-memory notification queue.
 *
 * F26 FIX: broadcast sending no longer blocks the HTTP request path.
 * The send route enqueues a job here and returns immediately; the
 * worker drains the queue and runs `sendBroadcast` in the background
 * (500ms latency between messages protects against WhatsApp rate-limit).
 *
 * Idempotent: registering again simply replaces the handler with the
 * same logic, so it is safe to call on every request/module load.
 *
 * NOTE: in-memory queue is lost on server restart. For production with
 * large audiences, swap this for a durable queue (Redis/BullMQ).
 */
export function registerBroadcastQueueWorker(
    queue = getNotificationQueue()
): void {
    queue.onProcess<{ broadcastId: number }>(
        async (payload) => {
            await sendBroadcast(payload.broadcastId);
        }
    );
}
