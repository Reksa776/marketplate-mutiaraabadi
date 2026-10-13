/**
 * ==========================================
 * P0 REMEDIATION — BEHAVIORAL INTEGRATION TESTS
 * ==========================================
 *
 * These tests EXECUTE REAL CODE AGAINST THE REAL
 * MariaDB DATABASE (database `toko`). They are NOT
 * static source-matching tests.
 *
 * Coverage:
 *   A. User cancel  → soft-cancel, reservations restored,
 *                     settlement cannot resurrect CANCELLED order
 *   B. Payout       → PAID consumes commissions (FIFO),
 *                     balance decreases, no double-spend
 *   C. Concurrent withdrawal → exactly one wins the race
 *   D. Webhook      → settlement vs CANCELLED/EXPIRED, duplicate idempotency
 *   E. Admin affiliate detail GET → real MariaDB execution (C5/F1)
 *
 * All seeded rows use a unique suffix and are removed in afterAll.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import {
    cancelOwnPendingOrder,
} from "@/lib/checkout";
import {
    createWithdrawalRequest,
    getAvailableBalance,
    settleCommissionsForPayout,
} from "@/lib/affiliate/commission";

import { POST as webhookPOST } from "@/app/api/payment/midtrans/notification/route";
import { PATCH as payoutPATCH } from "@/app/api/admin/affiliate/payouts/[id]/route";
import { GET as affiliateDetailGET } from "@/app/api/admin/affiliate/[id]/route";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(60000);

const SUFFIX = `p0-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const ADMIN_ID = "admin-p0-test";

/* ==========================================
 * SEED HELPERS
 * ========================================== */

async function seedUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag}-${SUFFIX}`,
            email: `${tag}-${SUFFIX}@p0test.local`,
            phone: `999${Date.now()}${Math.floor(
                Math.random() * 100000
            )}`.slice(0, 17),
        },
    });
}

async function seedProductVariant(stock = 5, weight = 100) {
    const product = await prisma.product.create({
        data: {
            name: `P0-TEST-${SUFFIX}`,
            slug: `p0-test-${SUFFIX}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
            category: "test",
        },
    });
    const variant = await prisma.productVariant.create({
        data: {
            name: "default",
            price: new Prisma.Decimal(10000),
            stock,
            weight,
            productId: product.id,
        },
    });
    return { product, variant };
}

async function seedAffiliate(userId: string) {
    return prisma.affiliateProfile.create({
        data: {
            userId,
            status: "APPROVED",
            affiliateCode: `P${Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase()}`,
            commissionRate: new Prisma.Decimal(5),
        },
    });
}

/** A `PATCH /api/admin/affiliate/payouts/[id]` request. */
function payoutActionRequest(
    payoutId: number,
    action: string,
    extra: Record<string, unknown> = {}
) {
    return new Request(
        `http://localhost/api/admin/affiliate/payouts/${payoutId}`,
        {
            method: "PATCH",
            body: JSON.stringify({ action, ...extra }),
            headers: { "content-type": "application/json" },
        }
    );
}

function payoutContext(payoutId: number) {
    return {
        params: Promise.resolve({ id: String(payoutId) }),
    };
}

/** A payout sitting in a specific status (fixture for the action paths). */
function seedPayout(
    affiliateId: number,
    amount: number,
    status: "PENDING" | "PROCESSING" | "PAID",
    overrides: Record<string, unknown> = {}
) {
    return prisma.affiliatePayout.create({
        data: {
            affiliateId,
            amount: new Prisma.Decimal(amount),
            status,
            bankName: "BCA",
            bankAccountName: "P0 TESTER",
            bankAccountNumber: "1234567890",
            ...overrides,
        },
    });
}

function makeWebhookRequest(payload: Record<string, unknown>) {
    return new NextRequest(
        "http://localhost/api/payment/midtrans/notification",
        {
            method: "POST",
            body: JSON.stringify(payload),
            headers: { "content-type": "application/json" },
        }
    );
}

function sign(orderId: string, statusCode: string, gross: string) {
    const serverKey =
        process.env.MIDTRANS_SERVER_KEY ?? "";
    return crypto
        .createHash("sha512")
        .update(`${orderId}${statusCode}${gross}${serverKey}`)
        .digest("hex");
}

/** Seed a full pending Midtrans-style order with reservation side effects */
async function seedPendingOrder(opts: {
    userId: string;
    variantId?: number;
    productId?: number;
    total: number;
    withVoucher?: boolean;
    status?: "PENDING" | "PAID" | "PROCESSING" | "SHIPPED" | "COMPLETED" | "CANCELLED";
    paymentStatus?:
        | "UNPAID"
        | "PENDING"
        | "FAILED"
        | "EXPIRED"
        | "PAID"
        | "REFUNDED"
}) {
    let voucherId: number | undefined;
    if (opts.withVoucher) {
        const voucher = await prisma.voucher.create({
            data: {
                code: `P0V${Math.random()
                    .toString(36)
                    .slice(2, 8)
                    .toUpperCase()}`,
                type: "FIXED",
                value: new Prisma.Decimal(5000),
                quota: 5,
                usedCount: 1,
                isActive: true,
            },
        });
        voucherId = voucher.id;
        await prisma.voucherUserUsage.create({
            data: {
                voucherId,
                ownerKey: `user:${opts.userId}`,
                userId: opts.userId,
                usageCount: 1,
            },
        });
    }

    const hasRealVariant =
        typeof opts.variantId === "number" &&
        typeof opts.productId === "number";

    // Simulate reservation: decrement variant stock like checkout does
    if (hasRealVariant) {
        await prisma.productVariant.update({
            where: { id: opts.variantId! },
            data: { stock: { decrement: 2 } },
        });
    }

    const orderNumber = `PAY-CART-P0-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    const order = await prisma.order.create({
        data: {
            userId: opts.userId,
            orderNumber,
            recipientName: "P0 Test",
            phone: "08120000",
            address: "Jl. Test",
            subtotal: new Prisma.Decimal(opts.total - 10000),
            shippingCost: new Prisma.Decimal(10000),
            total: new Prisma.Decimal(opts.total),
            discount: opts.withVoucher
                ? new Prisma.Decimal(5000)
                : new Prisma.Decimal(0),
            voucherId,
            status: opts.status ?? "PENDING",
            paymentMethod: "BANK_TRANSFER",
            paymentStatus: opts.paymentStatus ?? "PENDING",
            items: {
                create: [
                    {
                        productId: opts.productId ?? null,
                        variantId: opts.variantId ?? null,
                        productName: "P0 Product",
                        variantName: "default",
                        price: new Prisma.Decimal(10000),
                        quantity: 2,
                        subtotal: new Prisma.Decimal(
                            opts.total - 10000 - (opts.withVoucher ? 5000 : 0)
                        ),
                    },
                ],
            },
        },
    });

    return order;
}

/* ==========================================
 * A + D. USER CANCEL & WEBHOOK GUARD
 * ========================================== */

describe("A. User cancel — soft-cancel restores everything", () => {
    it("cancels pending order without deleting; restores stock/voucher; cancels commission", async () => {
        const user = await seedUser("cancel");
        const affiliateUser = await seedUser("cancel-aff");
        const affiliate = await seedAffiliate(affiliateUser.id);
        const { product, variant } = await seedProductVariant(5);

        const order = await seedPendingOrder({
            userId: user.id,
            productId: product.id,
            variantId: variant.id,
            total: 30000,
            withVoucher: true,
        });
        await prisma.product.update({
            where: { id: product.id },
            data: { sold: { increment: 2 } },
        });

        const conversion = await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: order.id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(15000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(750),
                status: "PENDING",
            },
        });

        const result = await cancelOwnPendingOrder(
            user.id,
            order.id
        );

        expect(result).toEqual({ ok: true });

        // Order still exists — NOT deleted
        const after = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(after).not.toBeNull();
        expect(after!.status).toBe("CANCELLED");
        expect(after!.paymentStatus).toBe("FAILED");

        // Stock restored (5 → reserved to 3 → back to 5)
        const v = await prisma.productVariant.findUnique({
            where: { id: variant.id },
        });
        expect(v!.stock).toBe(5);

        // Sold restored via GREATEST guard
        const p = await prisma.product.findUnique({
            where: { id: product.id },
        });
        expect(p!.sold).toBe(0);

        // Voucher quota + per-user usage restored
        const voucherRow = await prisma.voucherUserUsage.findUnique({
            where: {
                voucherId_ownerKey: {
                    voucherId: after!.voucherId!,
                    ownerKey: `user:${user.id}`,
                },
            },
        });
        expect(voucherRow!.usageCount).toBe(0);
        const vch = await prisma.voucher.findUnique({
            where: { id: after!.voucherId! },
        });
        expect(vch!.usedCount).toBe(0);

        // Commission cancelled
        const convAfter = await prisma.affiliateConversion.findUnique({
            where: { id: conversion.id },
        });
        expect(convAfter!.status).toBe("CANCELLED");
    });

    it("rejects cancelling someone else's order and non-pending orders", async () => {
        const owner = await seedUser("own");
        const attacker = await seedUser("attacker");
        const { product, variant } = await seedProductVariant(3);
        const order = await seedPendingOrder({
            userId: owner.id,
            productId: product.id,
            variantId: variant.id,
            total: 30000,
        });

        // IDOR attempt
        const res1 = await cancelOwnPendingOrder(attacker.id, order.id);
        expect(res1).toEqual({ ok: false, reason: "NOT_FOUND" });
        expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe("PENDING");

        // Already paid → not cancellable
        const paidOrder = await seedPendingOrder({
            userId: owner.id,
            productId: product.id,
            variantId: variant.id,
            total: 30000,
            status: "PAID",
            paymentStatus: "PAID",
        });
        const res2 = await cancelOwnPendingOrder(owner.id, paidOrder.id);
        expect(res2).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
    });
});

describe("D. Webhook settlement CAS guard", () => {
    it("settlement after CANCELLED does NOT resurrect the order", async () => {
        const user = await seedUser("whx");
        const { product, variant } = await seedProductVariant(5);
        const order = await seedPendingOrder({
            userId: user.id,
            productId: product.id,
            variantId: variant.id,
            total: 30000,
        });

        await cancelOwnPendingOrder(user.id, order.id);

        const gross = "30000.00";
        const res = await webhookPOST(
            makeWebhookRequest({
                order_id: order.orderNumber,
                transaction_status: "settlement",
                status_code: "200",
                gross_amount: gross,
                signature_key: sign(
                    order.orderNumber,
                    "200",
                    gross
                ),
                transaction_id: "txn-late-1",
            })
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toMatch(/ignored/i);

        const after = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(after!.status).toBe("CANCELLED");
        expect(after!.paymentStatus).toBe("FAILED");
        expect(after!.paidAt).toBeNull();

        // Stock must remain restored (not re-reserved / negative)
        const v = await prisma.productVariant.findUnique({
            where: { id: variant.id },
        });
        expect(v!.stock).toBe(5);
    });

    it("normal settlement marks PAID once; duplicate settlement is idempotent", async () => {
        const user = await seedUser("whok");
        const { product, variant } = await seedProductVariant(5);
        const order = await seedPendingOrder({
            userId: user.id,
            productId: product.id,
            variantId: variant.id,
            total: 25000,
        });

        const payload = {
            order_id: order.orderNumber,
            transaction_status: "settlement",
            status_code: "200",
            gross_amount: "25000.00",
            signature_key: sign(order.orderNumber, "200", "25000.00"),
            transaction_id: "txn-ok-1",
        };

        const res1 = await webhookPOST(makeWebhookRequest(payload));
        expect(res1.status).toBe(200);
        expect((await res1.json()).message).toMatch(/processed/i);

        const after1 = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(after1!.status).toBe("PAID");
        expect(after1!.paymentStatus).toBe("PAID");
        expect(after1!.paidAt).not.toBeNull();

        // Stock stays decremented (reserved) after success
        const v1 = await prisma.productVariant.findUnique({
            where: { id: variant.id },
        });
        expect(v1!.stock).toBe(3);

        // Duplicate settlement — must be ignored, state unchanged
        payload.transaction_id = "txn-ok-duplicate";
        payload.signature_key = sign(order.orderNumber, "200", "25000.00");
        const res2 = await webhookPOST(makeWebhookRequest(payload));
        expect((await res2.json()).message).toMatch(/ignored/i);

        const after2 = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(after2!.status).toBe("PAID");
        expect(after2!.paymentReference).toBe("txn-ok-1"); // first txn preserved

        const v2 = await prisma.productVariant.findUnique({
            where: { id: variant.id },
        });
        expect(v2!.stock).toBe(3); // no double restore/reserve
    });

    it("settlement after EXPIRED does NOT resurrect; invalid signature rejected; amount mismatch rejected", async () => {
        const user = await seedUser("whexp");
        const { product, variant } = await seedProductVariant(5);
        const order = await seedPendingOrder({
            userId: user.id,
            productId: product.id,
            variantId: variant.id,
            total: 30000,
            status: "CANCELLED",
            paymentStatus: "EXPIRED",
        });

        // Valid signature but order expired/final → ignored
        const gross = "30000.00";
        const res = await webhookPOST(
            makeWebhookRequest({
                order_id: order.orderNumber,
                transaction_status: "settlement",
                status_code: "200",
                gross_amount: gross,
                signature_key: sign(order.orderNumber, "200", gross),
            })
        );
        expect((await res.json()).message).toMatch(/ignored/i);
        expect(
            (await prisma.order.findUnique({ where: { id: order.id } }))!
                .status
        ).toBe("CANCELLED");

        // Invalid signature → 401
        const resBad = await webhookPOST(
            makeWebhookRequest({
                order_id: order.orderNumber,
                transaction_status: "settlement",
                status_code: "200",
                gross_amount: gross,
                signature_key: "deadbeef".repeat(8),
            })
        );
        expect(resBad.status).toBe(401);

        // Amount mismatch → 400 even with valid signature
        const resAmt = await webhookPOST(
            makeWebhookRequest({
                order_id: order.orderNumber,
                transaction_status: "settlement",
                status_code: "200",
                gross_amount: "99999.00",
                signature_key: sign(order.orderNumber, "200", "99999.00"),
            })
        );
        expect(resAmt.status).toBe(400);

        void product;
        void variant;
    });
});

/* ==========================================
 * B. PAYOUT CONSUMES BALANCE
 * ========================================== */

describe("B. Payout PAID consumes commissions (ledger balance)", () => {
    it("balance decreases on request, PAID settles FIFO conversions, second over-balance withdrawal rejected", async () => {
        const user = await seedUser("pay");
        const affiliate = await seedAffiliate(user.id);

        const now = Date.now();
        const c1 = await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: (
                    await seedPendingOrder({
                        userId: user.id,
                                                total: 100000,
                        status: "COMPLETED",
                        paymentStatus: "PAID",
                    })
                ).id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(1000000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(50000),
                status: "APPROVED",
                createdAt: new Date(now),
            },
        });
        const c2 = await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: (
                    await seedPendingOrder({
                        userId: user.id,
                                                total: 60000,
                        status: "COMPLETED",
                        paymentStatus: "PAID",
                    })
                ).id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(600000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(30000),
                status: "APPROVED",
                createdAt: new Date(now + 10),
            },
        });

        // Balance before anything = 80000
        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(80000);

        // Request withdrawal of 50000 → PENDING reserves it
        const w = await createWithdrawalRequest(
            affiliate.id,
            50000,
            "BCA",
            "P0 TESTER",
            "1234567890"
        );

        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(30000); // reserved by PENDING

        // Second concurrent-ish withdrawal exceeding remaining → rejected
        await expect(
            createWithdrawalRequest(
                affiliate.id,
                40000,
                "BCA",
                "P0 TESTER",
                "1234567890"
            )
        ).rejects.toThrow(/Saldo tidak mencukupi|sedang diproses/);

        // Admin marks PAID via the actual handler
        auth.mockResolvedValue({
            user: { id: ADMIN_ID, role: "ADMIN" },
        });

        // First APPROVE (PENDING → PROCESSING)
        const reqApprove = new Request(
            "http://localhost/api/admin/affiliate/payouts/" + w.id,
            {
                method: "PATCH",
                body: JSON.stringify({ action: "APPROVE" }),
                headers: { "content-type": "application/json" },
            }
        );
        const resApprove = await payoutPATCH(reqApprove, {
            params: Promise.resolve({ id: String(w.id) }),
        });
        expect(resApprove.status).toBe(200);

        /*
         * The provider confirms SYNCHRONOUSLY in this environment
         * (disbursement dev/mock mode), so APPROVE drove the whole
         * PENDING → PROCESSING → PAID path and settled the commissions
         * in the SAME request. The PROCESSING → PAID + settle paths
         * (STATUS, CONFIRM_PAID) are covered in section F.
         */
        const paid = await prisma.affiliatePayout.findUnique({
            where: { id: w.id },
            select: {
                status: true,
                providerStatus: true,
                providerTransactionId: true,
                paidAt: true,
            },
        });
        expect(paid!.status).toBe("PAID");
        expect(paid!.providerStatus).toBe("success");
        expect(paid!.providerTransactionId).toBeTruthy();
        expect(paid!.paidAt).not.toBeNull();

        // STATUS only applies to a PROCESSING payout: on an already-PAID
        // one the route refuses it rather than settling twice.
        const resStatus = await payoutPATCH(
            payoutActionRequest(w.id, "STATUS"),
            payoutContext(w.id)
        );
        expect(resStatus.status).toBe(400);

        // A repeat APPROVE cannot double-settle either.
        const resApproveAgain = await payoutPATCH(
            payoutActionRequest(w.id, "APPROVE"),
            payoutContext(w.id)
        );
        expect(resApproveAgain.status).toBe(400);

        // Balance after PAID stays consumed (30000), never returns
        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(30000);

        // FIFO settlement: oldest conversion fully consumed
        const c1After = await prisma.affiliateConversion.findUnique({
            where: { id: c1.id },
        });
        const c2After = await prisma.affiliateConversion.findUnique({
            where: { id: c2.id },
        });
        expect(c1After!.status).toBe("PAID");
        expect(c2After!.status).toBe("APPROVED");

        // Over-balance withdrawal rejected against settled state
        await expect(
            createWithdrawalRequest(
                affiliate.id,
                40000,
                "BCA",
                "P0 TESTER",
                "1234567890"
            )
        ).rejects.toThrow(/Saldo tidak mencukupi/);

        // Exact remaining withdrawal works
        const w2 = await createWithdrawalRequest(
            affiliate.id,
            30000,
            "BCA",
            "P0 TESTER",
            "1234567890"
        );
        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(0);
        void w2;

        // settleCommissionsForPayout is idempotent when re-run
        const again = await settleCommissionsForPayout(w.id);
        expect(again).toBeGreaterThanOrEqual(0);

        // …and the settled conversion is still settled exactly once.
        const c1SettledAgain =
            await prisma.affiliateConversion.findUnique({
                where: { id: c1.id },
                select: { status: true },
            });
        expect(c1SettledAgain!.status).toBe("PAID");
    });
});

/* ==========================================
 * C. CONCURRENT WITHDRAWAL RACE
 * ========================================== */

describe("C. Concurrent withdrawals are serialized", () => {
    it("only one of two racing withdrawals succeeds when balance fits one", async () => {
        const user = await seedUser("race");
        const affiliate = await seedAffiliate(user.id);

        const order = await seedPendingOrder({
            userId: user.id,
                        total: 120000,
            status: "COMPLETED",
            paymentStatus: "PAID",
        });
        await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: order.id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(1200000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(60000),
                status: "APPROVED",
            },
        });

        const args = [45000, "BCA", "P0 TESTER", "1234567890"] as const;

        const results = await Promise.allSettled([
            createWithdrawalRequest(affiliate.id, ...args),
            createWithdrawalRequest(affiliate.id, ...args),
        ]);

        const fulfilled = results.filter(
            (r) => r.status === "fulfilled"
        );
        const rejected = results.filter(
            (r) => r.status === "rejected"
        );

        // Exactly one wins
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);

        // DB invariant: aggregate payouts ≤ earned balance
        const [sumAgg] = await Promise.all([
            prisma.affiliatePayout.aggregate({
                where: {
                    affiliateId: affiliate.id,
                    status: { in: ["PENDING", "PROCESSING", "PAID"] },
                },
                _sum: { amount: true },
            }),
            prisma.affiliateConversion.aggregate({
                where: {
                    affiliateId: affiliate.id,
                    status: { in: ["APPROVED", "PAID"] },
                },
                _sum: { commissionAmount: true },
            }),
        ]);
        const disbursed = sumAgg._sum?.amount?.toNumber() ?? 0;
        expect(disbursed).toBeLessThanOrEqual(60000);
        expect(disbursed).toBe(45000);
    });

    it("two racing withdrawals that individually fit but jointly exceed balance → only one succeeds", async () => {
        const user = await seedUser("race2");
        const affiliate = await seedAffiliate(user.id);

        const order = await seedPendingOrder({
            userId: user.id,
                        total: 80000,
            status: "COMPLETED",
            paymentStatus: "PAID",
        });
        await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: order.id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(800000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(40000),
                status: "APPROVED",
            },
        });

        const results = await Promise.allSettled([
            createWithdrawalRequest(
                affiliate.id,
                25000,
                "BCA",
                "P0 TESTER",
                "1234567890"
            ),
            createWithdrawalRequest(
                affiliate.id,
                25000,
                "BCA",
                "P0 TESTER",
                "1234567890"
            ),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        // 25k + 25k = 50k ≤ 40k? NO — only one may succeed
        expect(fulfilled.length).toBe(1);
    });
});

/* ==========================================
 * E. ADMIN AFFILIATE DETAIL (MariaDB raw SQL)
 * ========================================== */

describe("E. Admin affiliate detail executes against MariaDB", () => {
    it("GET returns 200 with correct stats (no P2010 / SQL syntax error)", async () => {
        auth.mockResolvedValue({
            user: { id: ADMIN_ID, role: "ADMIN" },
        });

        const user = await seedUser("detail");
        const affiliate = await seedAffiliate(user.id);

        await prisma.affiliateKyc.create({
            data: {
                affiliateId: affiliate.id,
                bankName: "BCA",
                bankAccountName: "P0 TESTER",
                bankAccountNumber: "1234567890",
            },
        });

        await prisma.affiliateClick.createMany({
            data: [
                { affiliateId: affiliate.id, code: affiliate.affiliateCode },
                { affiliateId: affiliate.id, code: affiliate.affiliateCode },
            ],
        });

        const order = await seedPendingOrder({
            userId: user.id,
                        total: 50000,
            status: "COMPLETED",
            paymentStatus: "PAID",
        });
        await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: order.id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(40000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(2000),
                status: "APPROVED",
            },
        });

        const req = new Request(
            `http://localhost/api/admin/affiliate/${affiliate.id}`
        );
        const res = await affiliateDetailGET(req, {
            params: Promise.resolve({ id: String(affiliate.id) }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.profile.id).toBe(affiliate.id);
        expect(json.data.stats.clicks).toBe(2);
        expect(json.data.stats.orders).toBe(1);

        // chart is an array of daily rows (90 days), real SQL executed
        const chart = json.data.chart as Array<{
            clicks: number;
            conversions: number;
        }>;
        expect(Array.isArray(chart)).toBe(true);
        expect(chart.length).toBe(90);
        expect(
            chart.reduce((s, d) => s + d.clicks, 0)
        ).toBe(2);
        expect(
            chart.reduce((s, d) => s + d.conversions, 0)
        ).toBe(1);
    });

    it("GET rejects non-admin", async () => {
        auth.mockResolvedValue({
            user: { id: "customer-p0", role: "CUSTOMER" },
        });
        const req = new Request(
            "http://localhost/api/admin/affiliate/999999"
        );
        const res = await affiliateDetailGET(req, {
            params: Promise.resolve({ id: "999999" }),
        });
        expect(res.status).toBe(403);
    });
});

/* ==========================================
 * F. PAYOUT SETTLEMENT JOINS THE CALLER'S TRANSACTION
 * ==========================================
 *
 * REGRESSION (P2028). The STATUS / CONFIRM_PAID / APPROVE paths lock the
 * payout row FOR UPDATE and then settle its commissions. Settlement used
 * to open a SECOND transaction, which blocked on that very lock until
 * the outer transaction expired (`Transaction already closed ... 5007 ms`,
 * P2028) — the admin got a 500 and NO settlement ran.
 *
 * These tests exercise the real routes against the real database, so a
 * reintroduced nested transaction fails them again.
 */

describe("F. Payout settlement is atomic with the status transition", () => {
    async function seedSettledAffiliate(tag: string) {
        const user = await seedUser(tag);
        const affiliate = await seedAffiliate(user.id);

        const conversion = await prisma.affiliateConversion.create({
            data: {
                affiliateId: affiliate.id,
                orderId: (
                    await seedPendingOrder({
                        userId: user.id,
                        total: 40000,
                        status: "COMPLETED",
                        paymentStatus: "PAID",
                    })
                ).id,
                affiliateCode: affiliate.affiliateCode,
                orderSubtotal: new Prisma.Decimal(40000),
                commissionRate: new Prisma.Decimal(5),
                commissionAmount: new Prisma.Decimal(2000),
                status: "APPROVED",
            },
        });

        return { user, affiliate, conversion };
    }

    it("STATUS finalises a PROCESSING payout and settles in the SAME commit", async () => {
        const { affiliate, conversion } =
            await seedSettledAffiliate("status");

        const payout = await seedPayout(
            affiliate.id,
            2000,
            "PROCESSING",
            {
                providerTransactionId: `DEV-STATUS-${SUFFIX}`,
                providerReference: `affiliate-payout-status-${SUFFIX}`,
            }
        );

        auth.mockResolvedValue({
            user: { id: ADMIN_ID, role: "ADMIN" },
        });

        const res = await payoutPATCH(
            payoutActionRequest(payout.id, "STATUS"),
            payoutContext(payout.id)
        );

        expect(res.status).toBe(200);

        const settled = await prisma.affiliatePayout.findUnique({
            where: { id: payout.id },
            select: {
                status: true,
                providerStatus: true,
                paidAt: true,
            },
        });

        expect(settled!.status).toBe("PAID");
        expect(settled!.providerStatus).toBe("success");
        expect(settled!.paidAt).not.toBeNull();

        // The PAID transition and the FIFO consumption committed
        // together — if settlement had been skipped, this row would
        // still be APPROVED.
        const conversionAfter =
            await prisma.affiliateConversion.findUnique({
                where: { id: conversion.id },
                select: { status: true },
            });

        expect(conversionAfter!.status).toBe("PAID");

        // The ledger reflects ONE consumption of the 2000 commission.
        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(0);
    });

    it("CONFIRM_PAID settles in the same commit as PROCESSING → PAID", async () => {
        const { affiliate, conversion } =
            await seedSettledAffiliate("confirm");

        const payout = await seedPayout(
            affiliate.id,
            2000,
            "PROCESSING"
        );

        auth.mockResolvedValue({
            user: { id: ADMIN_ID, role: "ADMIN" },
        });

        const res = await payoutPATCH(
            payoutActionRequest(payout.id, "CONFIRM_PAID", {
                proofFilePath: "storage/uploads/proof-p0.pdf",
            }),
            payoutContext(payout.id)
        );

        expect(res.status).toBe(200);

        const after = await prisma.affiliatePayout.findUnique({
            where: { id: payout.id },
            select: { status: true, proofFilePath: true },
        });

        expect(after!.status).toBe("PAID");
        expect(after!.proofFilePath).toBe(
            "storage/uploads/proof-p0.pdf"
        );

        expect(
            (
                await prisma.affiliateConversion.findUnique({
                    where: { id: conversion.id },
                    select: { status: true },
                })
            )!.status
        ).toBe("PAID");

        // Idempotent: a second CONFIRM_PAID is a conflict, not a
        // second settlement.
        const repeat = await payoutPATCH(
            payoutActionRequest(payout.id, "CONFIRM_PAID", {
                proofFilePath:
                    "storage/uploads/proof-p0-again.pdf",
            }),
            payoutContext(payout.id)
        );

        expect(repeat.status).toBe(400);

        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(0);
    });

    it("two concurrent APPROVEs settle exactly once", async () => {
        const { affiliate, conversion } =
            await seedSettledAffiliate("conc");

        const payout = await seedPayout(
            affiliate.id,
            2000,
            "PENDING"
        );

        auth.mockResolvedValue({
            user: { id: ADMIN_ID, role: "ADMIN" },
        });

        const [first, second] = await Promise.all([
            payoutPATCH(
                payoutActionRequest(payout.id, "APPROVE"),
                payoutContext(payout.id)
            ),
            payoutPATCH(
                payoutActionRequest(payout.id, "APPROVE"),
                payoutContext(payout.id)
            ),
        ]);

        const statuses = [first.status, second.status].sort(
            (a, b) => a - b
        );

        // Exactly one admin action happens; the loser is told it was
        // already handled (409) instead of getting a 500.
        expect(statuses).toEqual([200, 409]);

        const after = await prisma.affiliatePayout.findUnique({
            where: { id: payout.id },
            select: {
                status: true,
                providerTransactionId: true,
            },
        });

        expect(after!.status).toBe("PAID");
        expect(after!.providerTransactionId).toBeTruthy();

        // ONE settlement: the commission is consumed exactly once, so
        // the ledger nets to zero and can never be withdrawn twice.
        expect(
            (
                await prisma.affiliateConversion.findUnique({
                    where: { id: conversion.id },
                    select: { status: true },
                })
            )!.status
        ).toBe("PAID");

        expect(
            (await getAvailableBalance(affiliate.id)).toNumber()
        ).toBe(0);

        // And no second payout/financial row was created.
        expect(
            await prisma.affiliatePayout.count({
                where: { affiliateId: affiliate.id },
            })
        ).toBe(1);
    });
});

/* ==========================================
 * CLEANUP
 * ========================================== */

afterAll(async () => {
    try {
        const users = await prisma.user.findMany({
            where: { email: { contains: "@p0test.local" } },
            select: { id: true },
        });
        const userIds = users.map((u) => u.id);

        if (userIds.length > 0) {
            const profiles = await prisma.affiliateProfile.findMany({
                where: { userId: { in: userIds } },
                select: { id: true },
            });
            const profileIds = profiles.map((p) => p.id);

            await prisma.adminAuditLog.deleteMany({
                where: { adminId: ADMIN_ID },
            });
            if (profileIds.length > 0) {
                await prisma.affiliateConversion.deleteMany({
                    where: { affiliateId: { in: profileIds } },
                });
                await prisma.affiliatePayout.deleteMany({
                    where: { affiliateId: { in: profileIds } },
                });
                await prisma.affiliateKyc.deleteMany({
                    where: { affiliateId: { in: profileIds } },
                });
                await prisma.affiliateClick.deleteMany({
                    where: { affiliateId: { in: profileIds } },
                });
                await prisma.affiliateProfile.deleteMany({
                    where: { id: { in: profileIds } },
                });
            }

            await prisma.voucherUserUsage.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.cartItem.deleteMany({
                where: { cart: { userId: { in: userIds } } },
            });
            await prisma.cart.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.notification.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.orderItem.deleteMany({
                where: { order: { userId: { in: userIds } } },
            });
            await prisma.order.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.voucher.deleteMany({
                where: { code: { startsWith: "P0V" } },
            });
            await prisma.userAddress.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.affiliateProfile.deleteMany({
                where: { userId: { in: userIds } },
            });
            await prisma.user.deleteMany({
                where: { id: { in: userIds } },
            });
        }

        // Products created by this run
        await prisma.productVariant.deleteMany({
            where: {
                product: { name: { startsWith: "P0-TEST-" } },
            },
        });
        await prisma.product.deleteMany({
            where: { name: { startsWith: "P0-TEST-" } },
        });
    } catch (e) {
        console.error("CLEANUP ERROR:", e);
    } finally {
        await prisma.$disconnect();
    }
});
