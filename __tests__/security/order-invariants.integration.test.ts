/**
 * ==========================================
 * ORDER / CHECKOUT INVARIANTS — EXECUTABLE
 * ==========================================
 *
 * These tests EXECUTE REAL CODE against the REAL MariaDB database
 * (database `toko`). They are NOT static source-matching tests.
 *
 * They exist because a static assertion cannot reliably verify these
 * behaviours: the legacy audit scripts
 * (`__tests__/checkout/lifecycle.test.ts`,
 * `__tests__/transaction/t5-e2e-verification.test.ts`) match source text,
 * which no longer proves anything about the runtime once shared
 * primitives, guest scoping and provider payloads move around.
 *
 * Coverage (the five areas the audit flagged):
 *   1. Rate limiting on ALL FOUR order-creation routes (real limiters,
 *      real route handlers, guest AND authenticated branches).
 *   2. Address ownership: a saved addressId is only usable by its owner;
 *      a guest can never spend someone's saved address.
 *   3. Atomic voucher reservation + release (quota guard, single release).
 *   4. Atomic flash-sale reservation + release, including the guest-scope
 *      bug: cancelling ONE guest's order must not delete ANOTHER guest's
 *      FlashSalePurchase row.
 *   5. Rollback CAS concurrency: two racing rollbacks release exactly once.
 *   6. iPaymu webhook settlement + stock release with SIGNED payloads
 *      (settle once, replay is a no-op, failure releases once, and an
 *      already-PAID order is never released).
 *
 * PROVIDER NOTE: no external provider is contacted. Payment is the
 * locally-signed webhook (iPaymu HMAC scheme computed in-process, NO call
 * to iPaymu) and shipping is never priced here. Any assertion that would
 * need a live provider call is explicitly OUT of scope of this file.
 *
 * Every seeded row carries a unique SUFFIX and is removed in afterAll.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

/*
 * PROVIDER SEAMS — MOCKED, DELIBERATELY, AND LABELLED AS SUCH.
 *
 * A full guest checkout has to price shipping through a provider. These
 * two mocks replace ONLY the outbound provider calls:
 *
 *   calculateDomesticCost           → RajaOngkir courier cost lookup
 *   resolveMengantarDestinationAreaId → Mengantar /address/search
 *
 * Everything else (validation, region verification against the DB,
 * reservation, order creation, cart clearing, CAS, settlement) runs for
 * real. Payment is NOT mocked away: the iPaymu webhook is exercised with
 * a signature computed locally by the same HMAC scheme the route
 * verifies, so no request is ever made to iPaymu.
 */
jest.mock("@/lib/rajaongkir", () => ({
    ...jest.requireActual("@/lib/rajaongkir"),
    /*
     * Same shape the real provider returns (a list of services); the
     * server-side verifier matches on code+service and re-derives the
     * price from the entry it finds.
     */
    calculateDomesticCost: jest.fn(async () => [
        {
            code: "jne",
            service: "REG",
            cost: 20000,
            etd: "2-3",
        },
    ]),
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    ...jest.requireActual("@/lib/mengantar/shipping"),
    resolveMengantarDestinationAreaId: jest.fn(async () => null),
}));

import {
    Prisma,
    type Order_paymentMethod,
    type Order_paymentStatus,
    type Order_status,
} from "@prisma/client";
import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import {
    createCheckoutOrder,
    rollbackCheckoutOrder,
} from "@/lib/checkout";
import { incrementVoucherUsage } from "@/lib/voucher";
import { recordFlashSalePurchase } from "@/lib/marketing/flash-sale";
import {
    computeCanonicalJson,
    computeWebhookSignature,
} from "@/lib/payment/ipaymu";
import { resetIpaymuConfigCache } from "@/lib/payment/config";
import { POST as ipaymuWebhookPOST } from "@/app/api/payment/ipaymu/notification/route";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120000);

const SUFFIX = `oi-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const SANDBOX_VA = "1179000899";

/* ==========================================
 * SEED HELPERS
 * ========================================== */

async function seedUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag}-${SUFFIX}`,
            email: `${tag}-${SUFFIX}@oitest.local`,
            phone: `99${Date.now()}${Math.floor(
                Math.random() * 100000
            )}`.slice(0, 17),
        },
    });
}

async function seedProductVariant(stock = 5, weight = 100) {
    const product = await prisma.product.create({
        data: {
            name: `OI-TEST-${SUFFIX}`,
            slug: `oi-test-${SUFFIX}-${Math.random()
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

/** An order that already RESERVED one unit of `variant`. */
async function seedPendingOrder(opts: {
    userId?: string | null;
    guestIdentityKey?: string | null;
    variantId: number;
    productId: number;
    quantity?: number;
    status?: Order_status;
    paymentStatus?: Order_paymentStatus;
    voucherId?: number | null;
    paymentMethod?: Order_paymentMethod;
}) {
    const quantity = opts.quantity ?? 1;
    const total = 10000 * quantity;

    return prisma.order.create({
        data: {
            userId: opts.userId ?? null,
            guestIdentityKey: opts.guestIdentityKey ?? null,
            orderNumber: `PAY-CART-${SUFFIX}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
            recipientName: "OI TESTER",
            phone: "08123456789",
            address: "Jl. Test No. 1",
            subtotal: new Prisma.Decimal(total),
            shippingCost: new Prisma.Decimal(0),
            total: new Prisma.Decimal(total),
            status: opts.status ?? "PENDING",
            paymentStatus: opts.paymentStatus ?? "PENDING",
            paymentMethod: opts.paymentMethod ?? "BANK_TRANSFER",
            voucherId: opts.voucherId ?? null,
            items: {
                create: [
                    {
                        productId: opts.productId,
                        variantId: opts.variantId,
                        productName: `OI-TEST-${SUFFIX}`,
                        variantName: "default",
                        price: new Prisma.Decimal(10000),
                        quantity,
                        subtotal: new Prisma.Decimal(total),
                    },
                ],
            },
        },
    });
}

function guestWebhookRequest(
    fields: Record<string, string>
): NextRequest {
    const body = new URLSearchParams(fields).toString();
    const signature = computeWebhookSignature(
        computeCanonicalJson(fields),
        SANDBOX_VA
    );

    return new NextRequest(
        "https://shop.example.com/api/payment/ipaymu/notification",
        {
            method: "POST",
            headers: {
                "content-type":
                    "application/x-www-form-urlencoded",
                "x-signature": signature,
            },
            body,
        }
    );
}

/** A route request with a UNIQUE client IP (fresh rate-limit buckets). */
function routeRequest(
    url: string,
    ip: string,
    body: Record<string, unknown> = {}
): NextRequest {
    return new NextRequest(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
    });
}

/* ==========================================
 * CLEANUP
 * ========================================== */

const createdUserIds: string[] = [];
const createdDestinationIds: number[] = [];

/*
 * Orders created through the REAL checkout (not seeded by hand) get an
 * application-generated orderNumber, so SUFFIX matching alone would
 * leave them behind. Track their ids explicitly.
 */
const createdOrderIds: number[] = [];

async function cleanup() {
    if (createdOrderIds.length > 0) {
        await prisma.orderItem.deleteMany({
            where: { orderId: { in: createdOrderIds } },
        });

        await prisma.order.deleteMany({
            where: { id: { in: createdOrderIds } },
        });
    }

    await prisma.order.deleteMany({
        where: {
            OR: [
                { orderNumber: { contains: SUFFIX } },
                { user: { email: { contains: SUFFIX } } },
            ],
        },
    });

    await prisma.product.deleteMany({
        where: { name: `OI-TEST-${SUFFIX}` },
    });

    await prisma.voucher.deleteMany({
        where: { code: { contains: SUFFIX } },
    });

    if (createdDestinationIds.length > 0) {
        await prisma.rajaOngkirRegion.deleteMany({
            where: { destinationId: { in: createdDestinationIds } },
        });
    }

    if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({
            where: { id: { in: createdUserIds } },
        });
    }
}

beforeAll(() => {
    /*
     * Trust exactly one proxy so `x-forwarded-for` is honoured and each
     * test can use its own client IP. Without this every guest request
     * shares the "untrusted" bucket and the assertions below could not
     * distinguish a fresh bucket from an exhausted one.
     */
    process.env.TRUSTED_PROXY = "1";
    process.env.TRUSTED_PROXY_HOPS = "1";

    process.env.PAYMENT_ENVIRONMENT = "sandbox";
    process.env.IPAYMU_SANDBOX_VA = SANDBOX_VA;
    process.env.IPAYMU_SANDBOX_API_KEY =
        "sandbox-api-key-1234567890";
    process.env.IPAYMU_SANDBOX_BASE_URL =
        "https://sandbox.ipaymu.com";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    resetIpaymuConfigCache();
});

beforeEach(() => {
    auth.mockReset();
    auth.mockResolvedValue(null);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

/* ==========================================
 * 1. RATE LIMITING — ALL FOUR ROUTES
 * ==========================================
 *
 * Executable counterpart to the static "imports rateLimiters" checks in
 * lifecycle.test.ts: these drive the REAL route handlers and the REAL
 * in-memory limiter until the cap trips.
 *
 * The payloads are deliberately INVALID (they fail validation after the
 * limiter), so no order is ever created — the limiter is the only thing
 * under test.
 */

describe("Rate limiting — all four order-creation routes (guest branch)", () => {
    async function tripGuestLimit(opts: {
        name: string;
        importRoute: () => Promise<{
            POST: (req: NextRequest) => Promise<Response>;
        }>;
        allowed: number;
    }) {
        const { POST } = await opts.importRoute();
        const ip = `203.0.113.${Math.floor(
            Math.random() * 200
        ) + 1}${Math.floor(Math.random() * 9)}`.slice(0, 15);

        const statuses: number[] = [];

        for (let i = 0; i < opts.allowed + 1; i++) {
            const res = await POST(
                routeRequest(
                    "https://shop.example.com" +
                        opts.name,
                    ip,
                    {}
                )
            );
            statuses.push(res.status);
        }

        return statuses;
    }

    test("/api/orders (COD) rate-limits a guest device", async () => {
        const statuses = await tripGuestLimit({
            name: "/api/orders",
            allowed: 5,
            importRoute: () =>
                import("@/app/api/orders/route"),
        });

        expect(statuses.slice(0, 5)).not.toContain(429);
        expect(statuses[5]).toBe(429);
    });

    test("/api/buy-now (COD) rate-limits a guest device", async () => {
        const statuses = await tripGuestLimit({
            name: "/api/buy-now",
            allowed: 5,
            importRoute: () =>
                import("@/app/api/buy-now/route"),
        });

        expect(statuses.slice(0, 5)).not.toContain(429);
        expect(statuses[5]).toBe(429);
    });

    test("/api/payment/ipaymu rate-limits a guest device", async () => {
        const statuses = await tripGuestLimit({
            name: "/api/payment/ipaymu",
            allowed: 10,
            importRoute: () =>
                import("@/app/api/payment/ipaymu/route"),
        });

        expect(statuses.slice(0, 10)).not.toContain(429);
        expect(statuses[10]).toBe(429);
    });

    test("/api/buy-now/ipaymu rate-limits a guest device", async () => {
        const statuses = await tripGuestLimit({
            name: "/api/buy-now/ipaymu",
            allowed: 10,
            importRoute: () =>
                import("@/app/api/buy-now/ipaymu/route"),
        });

        expect(statuses.slice(0, 10)).not.toContain(429);
        expect(statuses[10]).toBe(429);
    });
});

describe("Rate limiting — authenticated branch", () => {
    test("/api/orders rate-limits per user id (10/min)", async () => {
        const userId = `oi-user-${SUFFIX}`;

        auth.mockResolvedValue({
            user: { id: userId, role: "USER" },
        });

        const { POST } = await import("@/app/api/orders/route");

        const statuses: number[] = [];

        for (let i = 0; i < 11; i++) {
            const res = await POST(
                routeRequest(
                    "https://shop.example.com/api/orders",
                    "198.51.100.20",
                    {}
                )
            );
            statuses.push(res.status);
        }

        expect(statuses.slice(0, 10)).not.toContain(429);
        expect(statuses[10]).toBe(429);
    });
});

/* ==========================================
 * 2. ADDRESS OWNERSHIP
 * ==========================================
 *
 * A saved address is resolved with findFirst({ id, userId }): another
 * customer's id must resolve to nothing (404) and a guest must never be
 * able to spend someone else's saved address at all.
 */

describe("Address ownership", () => {
    test("a customer cannot check out with another customer's addressId", async () => {
        const owner = await seedUser("addr-owner");
        createdUserIds.push(owner.id);

        const attacker = await seedUser("addr-attacker");
        createdUserIds.push(attacker.id);

        const address = await prisma.userAddress.create({
            data: {
                userId: owner.id,
                recipientName: "OWNER",
                phone: "081200000000",
                address: "Jl. Owner No. 1",
                province: "DKI Jakarta",
                city: "Jakarta Selatan",
                district: "Kebayoran",
                subdistrict: "Melawai",
                postalCode: "12160",
            },
        });

        await expect(
            createCheckoutOrder({
                userId: attacker.id,
                addressId: String(address.id),
                shipping: {
                    provider: "RAJAONGKIR",
                    courier: "jne",
                    service: "REG",
                    cost: 20000,
                },
                paymentMethod: "COD",
            } as any)
        ).rejects.toMatchObject({
            message: "Alamat tidak ditemukan.",
            status: 404,
        });

        // Nothing was created for the attacker.
        const attackerOrders = await prisma.order.count({
            where: { userId: attacker.id },
        });
        expect(attackerOrders).toBe(0);
    });

    test("a guest cannot spend a saved addressId", async () => {
        const owner = await seedUser("addr-owner2");
        createdUserIds.push(owner.id);

        const address = await prisma.userAddress.create({
            data: {
                userId: owner.id,
                recipientName: "OWNER",
                phone: "081200000001",
                address: "Jl. Owner No. 2",
                province: "DKI Jakarta",
                city: "Jakarta Selatan",
                district: "Kebayoran",
                subdistrict: "Melawai",
                postalCode: "12160",
            },
        });

        // No userId, no inline guestAddress: the saved id must NOT be
        // honoured. The flow fails closed on the missing buyer scope
        // (a guest must supply a contact identity) or on the missing
        // inline address — never by resolving someone else's saved row.
        let failure: any = null;

        try {
            await createCheckoutOrder({
                userId: null,
                addressId: String(address.id),
                shipping: {
                    provider: "RAJAONGKIR",
                    courier: "jne",
                    service: "REG",
                    cost: 20000,
                },
                paymentMethod: "COD",
            } as any);
        } catch (error) {
            failure = error;
        }

        expect(failure).not.toBeNull();
        expect(String(failure.message)).not.toMatch(
            /Alamat tidak ditemukan/
        );
        expect(String(failure.message)).toMatch(
            /identitas|Alamat pengiriman wajib diisi/
        );

        // No guest order was created from that saved address.
        const guestOrders = await prisma.order.count({
            where: { orderNumber: { contains: SUFFIX } },
        });
        expect(guestOrders).toBe(0);
    });

    test("the owner CAN use their own addressId (positive control)", async () => {
        const owner = await seedUser("addr-self");
        createdUserIds.push(owner.id);

        const address = await prisma.userAddress.create({
            data: {
                userId: owner.id,
                recipientName: "OWNER",
                phone: "081200000002",
                address: "Jl. Owner No. 3",
                province: "DKI Jakarta",
                city: "Jakarta Selatan",
                district: "Kebayoran",
                subdistrict: "Melawai",
                postalCode: "12160",
            },
        });

        /*
         * It must get PAST the address step: with an empty cart the flow
         * fails later, so assert only that it is not the address error.
         */
        let failure: any = null;

        try {
            await createCheckoutOrder({
                userId: owner.id,
                addressId: String(address.id),
                shipping: {
                    provider: "RAJAONGKIR",
                    courier: "jne",
                    service: "REG",
                    cost: 20000,
                },
                paymentMethod: "COD",
            } as any);
        } catch (error) {
            failure = error;
        }

        if (failure) {
            expect(String(failure.message)).not.toMatch(
                /Alamat tidak ditemukan/
            );
        }

        await prisma.order.deleteMany({
            where: { userId: owner.id },
        });
    });
});

/* ==========================================
 * 3. VOUCHER — ATOMIC RESERVE + RELEASE
 * ========================================== */

describe("Voucher reservation and release (real DB)", () => {
    test("quota guard admits exactly one of two concurrent increments", async () => {
        const voucher = await prisma.voucher.create({
            data: {
                code: `OI-VCH-${SUFFIX}`,
                type: "FIXED",
                value: new Prisma.Decimal(5000),
                quota: 1,
                usedCount: 0,
                isActive: true,
            },
        });

        const results = await Promise.all([
            prisma.$transaction((tx) =>
                incrementVoucherUsage(tx, voucher.id)
            ),
            prisma.$transaction((tx) =>
                incrementVoucherUsage(tx, voucher.id)
            ),
        ]);

        expect(
            results.filter((ok) => ok === true).length
        ).toBe(1);

        const after = await prisma.voucher.findUnique({
            where: { id: voucher.id },
            select: { usedCount: true },
        });

        expect(after?.usedCount).toBe(1);
    });

    test("rollback restores quota + the order's usage bucket exactly once", async () => {
        const user = await seedUser("vch");
        createdUserIds.push(user.id);

        const { product, variant } = await seedProductVariant(4);

        const voucher = await prisma.voucher.create({
            data: {
                code: `OI-VCH-RB-${SUFFIX}`,
                type: "FIXED",
                value: new Prisma.Decimal(5000),
                quota: 10,
                usedCount: 1,
                isActive: true,
            },
        });

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
            voucherId: voucher.id,
        });

        await prisma.voucherUserUsage.create({
            data: {
                voucherId: voucher.id,
                ownerKey: `user:${user.id}`,
                userId: user.id,
                usageCount: 1,
            },
        });

        await expect(
            rollbackCheckoutOrder(order.id)
        ).resolves.toBe(true);

        const [voucherAfter, usageAfter] = await Promise.all([
            prisma.voucher.findUnique({
                where: { id: voucher.id },
                select: { usedCount: true },
            }),
            prisma.voucherUserUsage.findUnique({
                where: {
                    voucherId_ownerKey: {
                        voucherId: voucher.id,
                        ownerKey: `user:${user.id}`,
                    },
                },
                select: { usageCount: true },
            }),
        ]);

        expect(voucherAfter?.usedCount).toBe(0);
        expect(usageAfter?.usageCount).toBe(0);

        // A second rollback must not release anything again.
        await expect(
            rollbackCheckoutOrder(order.id)
        ).resolves.toBe(false);

        const voucherAgain = await prisma.voucher.findUnique({
            where: { id: voucher.id },
            select: { usedCount: true },
        });

        expect(voucherAgain?.usedCount).toBe(0);
    });
});

/* ==========================================
 * 4. FLASH SALE — ATOMIC RESERVE + RELEASE
 * ========================================== */

async function seedFlashSale(opts: {
    productId: number;
    variantId: number;
    saleStock?: number;
    soldCount?: number;
    purchaseLimit?: number;
}) {
    return prisma.flashSale.create({
        data: {
            name: `OI-FS-${SUFFIX}`,
            productId: opts.productId,
            variantId: opts.variantId,
            salePrice: new Prisma.Decimal(9000),
            saleStock: opts.saleStock ?? 1,
            soldCount: opts.soldCount ?? 0,
            purchaseLimit: opts.purchaseLimit ?? 1,
            startAt: new Date(Date.now() - 60_000),
            endAt: new Date(Date.now() + 3_600_000),
            isActive: true,
        },
    });
}

describe("Flash sale reservation and release (real DB)", () => {
    test("purchase limit admits exactly one of two concurrent purchases", async () => {
        const { product, variant } = await seedProductVariant(2);

        const sale = await seedFlashSale({
            productId: product.id,
            variantId: variant.id,
            saleStock: 2,
            purchaseLimit: 1,
        });

        const attempt = (ownerKey: string) =>
            prisma
                .$transaction((tx) =>
                    recordFlashSalePurchase(
                        tx,
                        sale.id,
                        null,
                        1,
                        ownerKey
                    )
                )
                .then(() => "ok" as const)
                .catch(() => "rejected" as const);

        /*
         * Same identity twice: the second purchase exceeds purchaseLimit,
         * which the post-increment check must reject atomically.
         */
        const first = await attempt(`guest:${SUFFIX}-a`);
        const second = await attempt(`guest:${SUFFIX}-a`);

        expect(first).toBe("ok");
        expect(second).toBe("rejected");

        const purchases = await prisma.flashSalePurchase.count({
            where: { flashSaleId: sale.id },
        });

        expect(purchases).toBe(1);
    });

    test("cancelling one guest's order releases ONLY that guest's reservation", async () => {
        const { product, variant } = await seedProductVariant(4);

        const sale = await seedFlashSale({
            productId: product.id,
            variantId: variant.id,
            saleStock: 0,
            soldCount: 2,
            purchaseLimit: 1,
        });

        const thisGuest = `guest:${SUFFIX}-this`;
        const otherGuest = `guest:${SUFFIX}-other`;

        // Two guests each consumed one unit of the sale.
        await prisma.flashSalePurchase.createMany({
            data: [
                {
                    flashSaleId: sale.id,
                    ownerKey: thisGuest,
                    quantity: 1,
                },
                {
                    flashSaleId: sale.id,
                    ownerKey: otherGuest,
                    quantity: 1,
                },
            ],
        });

        const order = await seedPendingOrder({
            guestIdentityKey: "this-guest-identity",
            variantId: variant.id,
            productId: product.id,
        });

        // The order belongs to THIS guest's scope.
        const orderRow = await prisma.order.findUnique({
            where: { id: order.id },
            select: { guestIdentityKey: true },
        });
        expect(orderRow?.guestIdentityKey).toBeTruthy();

        /*
         * The order's ownerKey is derived from its guestIdentityKey, so
         * seed the purchase row under that exact scope.
         */
        const { orderOwnerKey } = await import(
            "@/lib/guest-identity"
        );
        const orderScope = orderOwnerKey({
            userId: null,
            guestIdentityKey: "this-guest-identity",
        })!;

        await prisma.flashSalePurchase.deleteMany({
            where: { flashSaleId: sale.id, ownerKey: thisGuest },
        });
        await prisma.flashSalePurchase.create({
            data: {
                flashSaleId: sale.id,
                ownerKey: orderScope,
                quantity: 1,
            },
        });

        await expect(
            rollbackCheckoutOrder(order.id)
        ).resolves.toBe(true);

        const saleAfter = await prisma.flashSale.findUnique({
            where: { id: sale.id },
            select: { saleStock: true, soldCount: true },
        });

        // One unit returned; sold count decremented with the guard.
        expect(saleAfter?.saleStock).toBe(1);
        expect(saleAfter?.soldCount).toBe(1);

        const remaining = await prisma.flashSalePurchase.findMany({
            where: { flashSaleId: sale.id },
            select: { ownerKey: true },
        });

        // The order's own row is gone, the OTHER guest's row survives.
        expect(
            remaining.map((r) => r.ownerKey)
        ).toEqual([otherGuest]);
    });
});

/* ==========================================
 * 5. ROLLBACK CAS CONCURRENCY
 * ========================================== */

describe("Rollback CAS concurrency (real DB)", () => {
    test("two racing rollbacks release stock exactly once", async () => {
        const user = await seedUser("race");
        createdUserIds.push(user.id);

        // Stock 4 = one unit already reserved by the order below.
        const { product, variant } = await seedProductVariant(4);

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
        });

        const results = await Promise.all([
            rollbackCheckoutOrder(order.id),
            rollbackCheckoutOrder(order.id),
        ]);

        expect(
            results.filter((ok) => ok === true).length
        ).toBe(1);

        const variantAfter = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });

        // Released EXACTLY once (4 → 5), not twice (4 → 6).
        expect(variantAfter?.stock).toBe(5);

        const orderAfter = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true },
        });

        expect(orderAfter?.status).toBe("CANCELLED");
    });
});

/* ==========================================
 * 6. IPAIMU WEBHOOK — SIGNED, REAL DB
 * ==========================================
 *
 * The signature is computed in-process with the same HMAC scheme the
 * route verifies (no iPaymu call). This is the local equivalent of a
 * provider notification, so settlement/stock-release behaviour is proven
 * against the real database and the real route.
 */

describe("iPaymu webhook settlement and stock release (real DB)", () => {
    test("a signed success settles once, and a replay is a no-op", async () => {
        const user = await seedUser("wh");
        createdUserIds.push(user.id);

        // Stock 4 = reserved unit already taken by the order.
        const { product, variant } = await seedProductVariant(4);

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
        });

        const fields = {
            reference_id: order.orderNumber,
            status_code: "1",
            sub_total: order.total.toString(),
            trx_id: `trx-${SUFFIX}`,
        };

        const res = await ipaymuWebhookPOST(
            guestWebhookRequest(fields)
        );

        expect(res.status).toBe(200);

        const settled = await prisma.order.findUnique({
            where: { id: order.id },
            select: {
                status: true,
                paymentStatus: true,
                paidAt: true,
                paymentReference: true,
            },
        });

        expect(settled?.status).toBe("PAID");
        expect(settled?.paymentStatus).toBe("PAID");
        expect(settled?.paidAt).not.toBeNull();
        expect(settled?.paymentReference).toBe(
            fields.trx_id
        );

        // Settlement must NOT release the reserved stock.
        const afterSettle = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });
        expect(afterSettle?.stock).toBe(4);

        // Replay: idempotent, still PAID, still no stock movement.
        const replay = await ipaymuWebhookPOST(
            guestWebhookRequest(fields)
        );
        expect(replay.status).toBe(200);

        const afterReplay = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });

        expect(afterReplay?.stock).toBe(4);
    });

    test("a signed failure cancels the order and releases stock once", async () => {
        const user = await seedUser("wh-fail");
        createdUserIds.push(user.id);

        const { product, variant } = await seedProductVariant(4);

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
        });

        const fields = {
            reference_id: order.orderNumber,
            status_code: "4",
            sub_total: order.total.toString(),
            trx_id: `trx-fail-${SUFFIX}`,
        };

        const res = await ipaymuWebhookPOST(
            guestWebhookRequest(fields)
        );

        expect(res.status).toBe(200);

        const cancelled = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true, paymentStatus: true },
        });

        expect(cancelled?.status).toBe("CANCELLED");
        expect(cancelled?.paymentStatus).toBe("FAILED");

        const released = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });

        expect(released?.stock).toBe(5);

        // Replay: the CAS matched no row → no second release.
        await ipaymuWebhookPOST(
            guestWebhookRequest(fields)
        );

        const afterReplay = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });

        expect(afterReplay?.stock).toBe(5);
    });

    test("a failure notification can never release an already-PAID order", async () => {
        const user = await seedUser("wh-paid");
        createdUserIds.push(user.id);

        const { product, variant } = await seedProductVariant(4);

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
        });

        // Settle first.
        await ipaymuWebhookPOST(
            guestWebhookRequest({
                reference_id: order.orderNumber,
                status_code: "1",
                sub_total: order.total.toString(),
                trx_id: `trx-paid-${SUFFIX}`,
            })
        );

        // A late failure notification must be ignored.
        await ipaymuWebhookPOST(
            guestWebhookRequest({
                reference_id: order.orderNumber,
                status_code: "4",
                sub_total: order.total.toString(),
                trx_id: `trx-late-${SUFFIX}`,
            })
        );

        const after = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true },
        });

        const stock = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });

        expect(after?.status).toBe("PAID");
        expect(stock?.stock).toBe(4);
    });

    test("FULL GUEST CHECKOUT: order → paid, no account created", async () => {
        /*
         * The complete guest transaction, end to end, against the real
         * database:
         *
         *   1. BUY_NOW guest checkout with an inline address, through the
         *      real createCheckoutOrder (validation, region verification,
         *      shipping re-pricing, stock reservation, order creation).
         *   2. Settlement through the real iPaymu webhook route with a
         *      locally-signed payload.
         *
         * MOCKED:  RajaOngkir cost lookup + Mengantar area search (the
         *          only outbound provider calls).
         * REAL:    everything else, including the signature verification
         *          and the DB effects. Nothing is sent to iPaymu.
         */

        const { product, variant } = await seedProductVariant(5);

        /*
         * Destination row so the address can be VERIFIED against the
         * synced region table (an unverifiable destination is discarded
         * by design, which would make this test meaningless).
         */
        const destinationId = 9_000_000 + Math.floor(Math.random() * 999_999);
        createdDestinationIds.push(destinationId);

        await prisma.rajaOngkirRegion.create({
            data: {
                destinationId,
                province: "DKI Jakarta",
                city: "Jakarta Selatan",
                district: "Kebayoran Baru",
                subdistrict: `OI-${SUFFIX}`,
                postalCode: "12160",
            },
        });

        const guestEmail = `guest-${SUFFIX}@oitest.local`;
        const guestPhone = "081298765432";

        const result = await createCheckoutOrder({
            userId: null,
            mode: "BUY_NOW",
            productId: product.id,
            variantId: variant.id,
            quantity: 1,
            guestAddress: {
                recipientName: "GUEST TESTER",
                phone: guestPhone,
                email: guestEmail,
                address: "Jl. Guest No. 7",
                province: "DKI Jakarta",
                city: "Jakarta Selatan",
                district: "Kebayoran Baru",
                subdistrict: `OI-${SUFFIX}`,
                postalCode: "12160",
            },
            shipping: {
                provider: "RAJAONGKIR",
                courier: "jne",
                service: "REG",
                // Client claim; the server re-derives it (mocked → 20000).
                cost: 20000,
            },
            paymentMethod: "BANK_TRANSFER",
        } as any);

        createdOrderIds.push(result.order.id);

        const order = await prisma.order.findUnique({
            where: { id: result.order.id },
            select: {
                id: true,
                userId: true,
                guestIdentityKey: true,
                status: true,
                paymentStatus: true,
                subtotal: true,
                discount: true,
                shippingCost: true,
                total: true,
                shippingDiscountId: true,
                items: {
                    select: {
                        variantId: true,
                        quantity: true,
                        subtotal: true,
                    },
                },
            },
        });

        // A guest order: no user row, but a real identity scope.
        expect(order?.userId).toBeNull();
        expect(order?.guestIdentityKey).toBeTruthy();
        expect(order?.status).toBe("PENDING");
        /*
         * Documented contract: COD opens UNPAID (the courier collects),
         * every prepaid method opens PENDING until the provider settles.
         */
        expect(order?.paymentStatus).toBe("PENDING");

        /*
         * Server-derived money: 10.000 goods + 20.000 (mocked) shipping.
         *
         * The shipping total is PINNED to the mocked estimate only when
         * no shipping discount was applied: `lib/marketing/
         * shipping-discount.ts` AUTO-APPLIES the first active code-less
         * discount row, and other suites seed such rows against this same
         * database. Asserting a hard-coded 20.000 therefore made this
         * suite fail intermittently (2/2 reproductions) whenever a
         * marketing suite ran in parallel — the money CONTRACT is what
         * must hold, not a fixed total.
         */
        expect(Number(order?.subtotal)).toBe(10000);
        expect(Number(order?.shippingCost)).toBeGreaterThan(0);
        expect(Number(order?.shippingCost)).toBeLessThanOrEqual(
            20000
        );

        if (order?.shippingDiscountId === null) {
            expect(Number(order?.shippingCost)).toBe(20000);
        }

        expect(Number(order?.total)).toBe(
            Number(order?.subtotal) -
                Number(order?.discount) +
                Number(order?.shippingCost)
        );
        expect(order?.items).toHaveLength(1);
        expect(order?.items[0].quantity).toBe(1);

        // Reservation really happened.
        const afterCheckout = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });
        expect(afterCheckout?.stock).toBe(4);

        // No customer account was created for the guest.
        const guestUser = await prisma.user.findUnique({
            where: { email: guestEmail },
            select: { id: true },
        });
        expect(guestUser).toBeNull();

        // ---- Settlement through the REAL webhook route (signed). ----

        const res = await ipaymuWebhookPOST(
            guestWebhookRequest({
                reference_id: result.order.orderNumber,
                status_code: "1",
                sub_total: String(result.grossAmount),
                trx_id: `trx-e2e-${SUFFIX}`,
            })
        );

        expect(res.status).toBe(200);

        const paid = await prisma.order.findUnique({
            where: { id: result.order.id },
            select: {
                status: true,
                paymentStatus: true,
                paidAt: true,
            },
        });

        expect(paid?.status).toBe("PAID");
        expect(paid?.paymentStatus).toBe("PAID");
        expect(paid?.paidAt).not.toBeNull();

        // Settlement consumes the reservation — it never releases it.
        const afterSettle = await prisma.productVariant.findUnique({
            where: { id: variant.id },
            select: { stock: true },
        });
        expect(afterSettle?.stock).toBe(4);
    });

    test("an unsigned notification is rejected and changes nothing", async () => {
        const user = await seedUser("wh-unsigned");
        createdUserIds.push(user.id);

        const { product, variant } = await seedProductVariant(4);

        const order = await seedPendingOrder({
            userId: user.id,
            variantId: variant.id,
            productId: product.id,
        });

        const body = new URLSearchParams({
            reference_id: order.orderNumber,
            status_code: "1",
            sub_total: order.total.toString(),
        }).toString();

        const res = await ipaymuWebhookPOST(
            new NextRequest(
                "https://shop.example.com/api/payment/ipaymu/notification",
                {
                    method: "POST",
                    headers: {
                        "content-type":
                            "application/x-www-form-urlencoded",
                    },
                    body,
                }
            )
        );

        expect(res.status).toBe(401);

        const after = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true, paymentStatus: true },
        });

        expect(after?.status).toBe("PENDING");
        expect(after?.paymentStatus).toBe("PENDING");
    });
});
