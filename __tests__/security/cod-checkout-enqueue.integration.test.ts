/**
 * ==========================================
 * COD CHECKOUT → SHIPMENT ENQUEUE — REAL DATABASE INTEGRATION
 * ==========================================
 *
 * The P0 regression is "COD stopped creating a Mengantar shipment":
 * before the COD review gate existed, a normal COD order was handed to
 * the shipment pipeline automatically, and after the gate was added the
 * held path leaked into the normal path (order #985: MENGANTAR /
 * NOT_CREATED / requiresCodReview=true / PENDING / providerShipmentId
 * NULL / ShipmentJob []).
 *
 * A mocked Prisma client cannot prove the fix, because the whole bug was
 * about WHAT ACTUALLY GOT PERSISTED. So these tests run the REAL
 * `createCheckoutOrder` and the REAL admin review endpoint against the
 * REAL MariaDB (database `toko`), and assert on the rows the database
 * really holds:
 *
 *   1. a NORMAL COD order (unflagged, Mengantar) leaves the transaction
 *      with exactly ONE PENDING ShipmentJob and the post-response worker
 *      nudge fired — i.e. it ships WITHOUT an admin click;
 *   2. a FLAGGED COD order (HIGH_VALUE, and separately
 *      TOO_MANY_OPEN_COD) leaves with NO ShipmentJob and no nudge — the
 *      hold is real, not just a flag;
 *   3. the COD quota RELEASES a slot when the parcel is DELIVERED, and
 *      still counts a legacy NULL shipmentStatus (the SQL
 *      `NULL NOT IN (...)` trap) — the exact regression the quota fix
 *      addresses;
 *   4. approving a flagged order THROUGH THE REAL ENDPOINT transitions
 *      the review, creates exactly ONE ShipmentJob and nudges the
 *      worker; a repeat approval creates no second job and never touches
 *      the buyer's paymentStatus (still UNPAID for COD).
 *
 * PROVIDER NOTE: no Mengantar / payment call is ever made. The only
 * outbound seams mocked are the Mengantar shipping ESTIMATE (re-priced
 * locally) and the shipment creation helper; the worker itself is never
 * invoked (the post-response nudge is a spy). Everything else —
 * validation, reservation, order create, enqueue, the review
 * transition — runs for real.
 *
 * Every seeded row carries a unique suffix and is deleted in afterAll.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

/*
 * Only the OUTBOUND provider seams are replaced:
 *   verifyMengantarShippingCost      → Mengantar estimate API
 *   resolveMengantarDestinationAreaId→ Mengantar /address/search
 * The checkout's own re-pricing logic still runs (it consumes this
 * value as the authoritative cost).
 */
jest.mock("@/lib/mengantar/shipping", () => ({
    ...jest.requireActual("@/lib/mengantar/shipping"),
    verifyMengantarShippingCost: jest.fn(async () => 20000),
    resolveMengantarDestinationAreaId: jest.fn(
        async () => "area-it-cod-destination"
    ),
}));

/*
 * The shipment worker module is PARTIALLY mocked: `enqueueShipmentJobTx`
 * (used INSIDE the checkout transaction) stays REAL, so "was a
 * ShipmentJob actually persisted?" is the real assertion, while the
 * post-response nudge is a spy. Nothing may reach Mengantar from here.
 */
jest.mock("@/lib/mengantar/shipment-worker", () => ({
    ...jest.requireActual("@/lib/mengantar/shipment-worker"),
    scheduleShipmentProcessing: jest.fn(async () => undefined),
}));

jest.mock("@/lib/mengantar/shipment", () => ({
    createMengantarOrder: jest.fn(async () => {
        throw new Error("PROVIDER CALL NOT EXPECTED IN THIS SUITE");
    }),
    createShipmentForOrder: jest.fn(async () => {
        throw new Error("PROVIDER CALL NOT EXPECTED IN THIS SUITE");
    }),
    payUnpaidShipmentForOrder: jest.fn(async () => {
        throw new Error("PROVIDER CALL NOT EXPECTED IN THIS SUITE");
    }),
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onOrderStatusChanged: jest.fn(async () => undefined),
    onShipmentStatusChanged: jest.fn(async () => undefined),
}));

import { Prisma } from "@prisma/client";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createCheckoutOrder } from "@/lib/checkout";
import { countActiveGuestCodOrders } from "@/lib/cod-policy";
import {
    createShipmentForOrder,
    payUnpaidShipmentForOrder,
} from "@/lib/mengantar/shipment";
import { scheduleShipmentProcessing } from "@/lib/mengantar/shipment-worker";
import { POST as codReviewPOST } from "@/app/api/admin/orders/[id]/cod-review/route";

const mockedAuth = auth as unknown as jest.Mock;

const mockedCreateShipment =
    createShipmentForOrder as unknown as jest.Mock;
const mockedPayShipment =
    payUnpaidShipmentForOrder as unknown as jest.Mock;
const mockedSchedule =
    scheduleShipmentProcessing as unknown as jest.Mock;

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET ||
    "cod-checkout-enqueue-integration-secret";

jest.setTimeout(120000);

const SUFFIX = `cce-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const createdOrderIds: number[] = [];
const createdProductIds: number[] = [];
const createdDestinationIds: number[] = [];

let regionCounter = 0;

/* ==========================================
 * SEEDING
 * ========================================== */

/**
 * A product+variant at `price`, plus a VERIFIED destination row so the
 * guest address survives server-side resolution unchanged.
 */
async function seedProductVariant(price: number, tag: string) {
    const product = await prisma.product.create({
        data: {
            name: `CCE-TEST-${SUFFIX}-${tag}`,
            slug: `cce-test-${SUFFIX}-${tag}`,
            category: "test",
        },
    });

    const variant = await prisma.productVariant.create({
        data: {
            productId: product.id,
            name: `CCE-VARIANT-${tag}`,
            price: new Prisma.Decimal(price),
            stock: 10,
            weight: 1000,
        },
    });

    createdProductIds.push(product.id);

    regionCounter += 1;

    const destinationId =
        8_000_000 + Math.floor(Math.random() * 900_000);
    const subdistrict = `CCE-${SUFFIX}-${regionCounter}`;

    await prisma.rajaOngkirRegion.create({
        data: {
            destinationId,
            province: "DKI Jakarta",
            city: "Jakarta Selatan",
            district: "Kebayoran Baru",
            subdistrict,
            postalCode: "12160",
        },
    });

    createdDestinationIds.push(destinationId);

    return { product, variant, destinationId, subdistrict };
}

/**
 * A REAL guest COD + Mengantar checkout through `createCheckoutOrder`.
 */
async function runCodCheckout(input: {
    price: number;
    tag: string;
    guestIdentityKey?: string;
    /** Logged-in buyer id (skips the guest COD quota entirely). */
    userId?: string | null;
}) {
    const { product, variant, destinationId, subdistrict } =
        await seedProductVariant(input.price, input.tag);

    const result = await createCheckoutOrder({
        userId: input.userId ?? null,
        mode: "BUY_NOW",
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
        guestIdentityKey: input.guestIdentityKey ?? null,
        guestAddress: {
            recipientName: "CCE TESTER",
            phone: "081298760001",
            email: `cce-${input.tag}-${SUFFIX}@cce.local`,
            address: "Jl. COD No. 1",
            province: "DKI Jakarta",
            city: "Jakarta Selatan",
            district: "Kebayoran Baru",
            subdistrict,
            postalCode: "12160",
            rajaOngkirDestinationId: destinationId,
        },
        shipping: {
            provider: "MENGANTAR",
            courier: "jne",
            service: "REG",
            // Client claim; the server re-derives it (mocked → 20000).
            cost: 20000,
        },
        paymentMethod: "COD",
    });

    createdOrderIds.push(result.order.id);

    const order = await prisma.order.findUnique({
        where: { id: result.order.id },
        select: {
            id: true,
            orderNumber: true,
            userId: true,
            guestIdentityKey: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            shippingProvider: true,
            shipmentStatus: true,
            shippingPaymentStatus: true,
            subtotal: true,
            discount: true,
            shippingCost: true,
            total: true,
            codAmount: true,
            requiresCodReview: true,
            codReviewStatus: true,
            providerShipmentId: true,
            shippingDiscountId: true,
        },
    });

    const job = await prisma.shipmentJob.findUnique({
        where: { orderId: result.order.id },
        select: { id: true, status: true },
    });

    return { result, order, job };
}

/** A COD order row seeded directly (quota tests). */
async function seedCodOrder(input: {
    guestIdentityKey: string;
    shipmentStatus: string | null;
    status?: "PENDING" | "PAID" | "CANCELLED";
    paymentMethod?: "COD" | "BANK_TRANSFER";
}) {
    const order = await prisma.order.create({
        data: {
            guestIdentityKey: input.guestIdentityKey,
            orderNumber: `CCE-Q-${SUFFIX}-${createdOrderIds.length}-${Math.random()
                .toString(36)
                .slice(2, 6)}`,
            recipientName: "CCE QUOTA",
            phone: "081298760002",
            address: "Jl. Quota No. 1",
            subtotal: new Prisma.Decimal(50_000),
            shippingCost: new Prisma.Decimal(10_000),
            total: new Prisma.Decimal(60_000),
            status: input.status ?? "PENDING",
            paymentStatus: "UNPAID",
            paymentMethod: input.paymentMethod ?? "COD",
            shippingProvider: "MENGANTAR",
            shipmentStatus: input.shipmentStatus,
        },
    });

    createdOrderIds.push(order.id);

    return order;
}

function approveRequest(orderId: number, action = "APPROVE") {
    return codReviewPOST(
        new Request("http://test/api/admin/cod-review", {
            method: "POST",
            body: JSON.stringify({ action }),
        }),
        {
            params: Promise.resolve({ id: String(orderId) }),
        } as never
    );
}

beforeEach(() => {
    jest.clearAllMocks();

    mockedAuth.mockResolvedValue({
        user: { id: "admin-integration", role: "ADMIN" },
    });
});

afterAll(async () => {
    if (createdOrderIds.length > 0) {
        // Cascades items + shipmentJob; audit rows are mocked away.
        await prisma.order.deleteMany({
            where: { id: { in: createdOrderIds } },
        });
    }

    if (createdProductIds.length > 0) {
        await prisma.product.deleteMany({
            where: { id: { in: createdProductIds } },
        });
    }

    if (createdDestinationIds.length > 0) {
        await prisma.rajaOngkirRegion.deleteMany({
            where: {
                destinationId: { in: createdDestinationIds },
            },
        });
    }

    await prisma.$disconnect();
});

/* ==========================================
 * 1 — NORMAL COD IS ENQUEUED AT CHECKOUT
 * ========================================== */

describe("TARGET 1 — normal COD auto-enqueue (real checkout)", () => {
    test("a normal COD + Mengantar order persists exactly one PENDING ShipmentJob", async () => {
        const { order, job } = await runCodCheckout({
            price: 10_000,
            tag: "normal",
        });

        expect(order).not.toBeNull();
        expect(order!.paymentMethod).toBe("COD");
        expect(order!.shippingProvider).toBe("MENGANTAR");

        // NOT flagged: no admin review is required for a normal order.
        expect(order!.requiresCodReview).toBe(false);
        expect(order!.codReviewStatus).toBeNull();

        // The buyer still owes the courier: COD never marks itself PAID.
        expect(order!.paymentStatus).toBe("UNPAID");
        expect(order!.shipmentStatus).toBe("NOT_CREATED");
        expect(order!.shippingPaymentStatus).toBe(
            "NOT_APPLICABLE"
        );

        /*
         * Server-derived shipping: the mocked estimate (20.000), UNLESS
         * an ACTIVE code-less auto-apply shipping discount reduced it.
         *
         * `lib/marketing/shipping-discount.ts` auto-applies the first
         * active discount row when no code is supplied, and other suites
         * in this repo seed such rows against the SAME database. That is
         * real product behaviour, so the BASE PRICE is pinned whenever no
         * discount was applied and the money CONTRACT below must hold
         * either way (never a hard-coded total).
         */
        expect(Number(order!.shippingCost)).toBeGreaterThan(0);
        expect(Number(order!.shippingCost)).toBeLessThanOrEqual(
            20_000
        );

        if (order!.shippingDiscountId === null) {
            expect(Number(order!.shippingCost)).toBe(20_000);
        }

        // Money is coherent: ITEM-LEVEL COD VALUE.
        expect(Number(order!.subtotal)).toBe(10_000);

        /*
         * codAmount must equal the RM45 contract:
         *   total = subtotal − discount + shippingCost
         * and codAmount = total, so the courier collects the FULL order
         * value including shipping exactly once.
         */
        expect(Number(order!.codAmount)).toBe(
            Number(order!.total)
        );
        expect(Number(order!.total)).toBe(
            Number(order!.subtotal) -
                Number(order!.discount) +
                Number(order!.shippingCost)
        );

        // THE REGRESSION: a durable job really exists in the database.
        expect(job).not.toBeNull();
        expect(job!.status).toBe("PENDING");

        // …and the worker was nudged in the same request, so the
        // shipment does not wait for an external cron sweep.
        expect(mockedSchedule).toHaveBeenCalledTimes(1);

        // No provider call happened in this process.
        expect(mockedCreateShipment).not.toHaveBeenCalled();
        expect(mockedPayShipment).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 2 — FLAGGED COD IS REALLY HELD
 * ========================================== */

describe("TARGET 2/3/4 — flagged COD is held, never auto-approved", () => {
    test("a HIGH_VALUE COD order gets NO ShipmentJob and no worker nudge", async () => {
        // ≥ COD_REVIEW_AMOUNT_THRESHOLD (default 2.000.000).
        const { order, job } = await runCodCheckout({
            price: 2_500_000,
            tag: "highvalue",
        });

        expect(order!.requiresCodReview).toBe(true);
        expect(order!.codReviewStatus).toBe("PENDING");

        // Held, not cancelled and not paid.
        expect(order!.status).toBe("PENDING");
        expect(order!.paymentStatus).toBe("UNPAID");
        expect(order!.shipmentStatus).toBe("NOT_CREATED");
        expect(order!.providerShipmentId).toBeNull();

        // Nothing may be handed to Mengantar before a human decides.
        expect(job).toBeNull();
        expect(mockedSchedule).not.toHaveBeenCalled();
        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });

    test("TOO_MANY_OPEN_COD flags the 4th open COD order of the same identity", async () => {
        const identity = `cce-quota-${SUFFIX}-flag`;

        for (let index = 0; index < 3; index += 1) {
            await seedCodOrder({
                guestIdentityKey: identity,
                shipmentStatus: "NOT_CREATED",
            });
        }

        // Sanity: the quota really sees three open COD orders.
        expect(
            await countActiveGuestCodOrders(prisma, identity)
        ).toBe(3);

        const { order, job } = await runCodCheckout({
            price: 10_000,
            tag: "toomany",
            guestIdentityKey: identity,
        });

        expect(order!.requiresCodReview).toBe(true);
        expect(order!.codReviewStatus).toBe("PENDING");
        expect(job).toBeNull();
        expect(mockedSchedule).not.toHaveBeenCalled();
    });

    test("the quota counts legacy NULL shipmentStatus but RELEASES DELIVERED", async () => {
        const identity = `cce-quota-${SUFFIX}-release`;

        /*
         * The exact SQL trap the fix addresses: `shipmentStatus NOT IN
         * ('DELIVERED')` is NULL (not TRUE) for a legacy row, so NULL
         * rows must be listed explicitly or they silently stop counting.
         */
        await seedCodOrder({
            guestIdentityKey: identity,
            shipmentStatus: null,
        });

        await seedCodOrder({
            guestIdentityKey: identity,
            shipmentStatus: "IN_TRANSIT",
        });

        // Delivered → the slot is given back.
        await seedCodOrder({
            guestIdentityKey: identity,
            shipmentStatus: "DELIVERED",
        });

        // Not COD → never consumes a COD slot.
        await seedCodOrder({
            guestIdentityKey: identity,
            shipmentStatus: "NOT_CREATED",
            paymentMethod: "BANK_TRANSFER",
        });

        // Cancelled → no longer open.
        await seedCodOrder({
            guestIdentityKey: identity,
            shipmentStatus: "NOT_CREATED",
            status: "CANCELLED",
        });

        expect(
            await countActiveGuestCodOrders(prisma, identity)
        ).toBe(2);

        /*
         * End to end: an identity with only ONE open COD order
         * (2 delivered, 1 open) is NOT flagged, and its order DOES get
         * the automatic shipment job.
         */
        const releasedIdentity = `cce-quota-${SUFFIX}-released`;

        await seedCodOrder({
            guestIdentityKey: releasedIdentity,
            shipmentStatus: "DELIVERED",
        });

        await seedCodOrder({
            guestIdentityKey: releasedIdentity,
            shipmentStatus: "DELIVERED",
        });

        await seedCodOrder({
            guestIdentityKey: releasedIdentity,
            shipmentStatus: "IN_TRANSIT",
        });

        const { order, job } = await runCodCheckout({
            price: 10_000,
            tag: "released",
            guestIdentityKey: releasedIdentity,
        });

        expect(order!.requiresCodReview).toBe(false);
        expect(order!.codReviewStatus).toBeNull();
        expect(job).not.toBeNull();
        expect(job!.status).toBe("PENDING");
        expect(mockedSchedule).toHaveBeenCalledTimes(1);
    });
});

/* ==========================================
 * 3 — APPROVAL THROUGH THE REAL ENDPOINT
 * ========================================== */

describe("TARGET 2/5/6 — approving a flagged COD order (real endpoint)", () => {
    test("one approval enqueues exactly one job; a repeat adds nothing", async () => {
        const { order, job } = await runCodCheckout({
            price: 2_500_000,
            tag: "approve",
        });

        const orderId = order!.id;

        // Pre-condition (the order-#985 shape): flagged, held, no job.
        expect(order!.requiresCodReview).toBe(true);
        expect(order!.codReviewStatus).toBe("PENDING");
        expect(job).toBeNull();
        expect(mockedSchedule).not.toHaveBeenCalled();

        /* ---- First click: APPROVE ---- */
        const first = await approveRequest(orderId);
        const firstBody = await first.json();

        expect(first.status).toBe(200);
        expect(firstBody.success).toBe(true);
        expect(firstBody.data.changed).toBe(true);
        expect(firstBody.data.codReviewStatus).toBe(
            "APPROVED"
        );
        expect(firstBody.data.shipmentEnqueued).toBe(true);

        const afterFirst = await prisma.order.findUnique({
            where: { id: orderId },
            select: {
                codReviewStatus: true,
                codReviewedBy: true,
                codReviewedAt: true,
                paymentStatus: true,
                shipmentStatus: true,
            },
        });

        expect(afterFirst!.codReviewStatus).toBe("APPROVED");
        expect(afterFirst!.codReviewedBy).toBe(
            "admin-integration"
        );
        expect(afterFirst!.codReviewedAt).not.toBeNull();

        // Approving does NOT settle the customer's COD payment.
        expect(afterFirst!.paymentStatus).toBe("UNPAID");
        expect(afterFirst!.shipmentStatus).toBe(
            "NOT_CREATED"
        );

        const jobsAfterFirst = await prisma.shipmentJob.findMany({
            where: { orderId },
            select: { id: true, status: true },
        });

        expect(jobsAfterFirst).toHaveLength(1);
        expect(jobsAfterFirst[0].status).toBe("PENDING");
        expect(mockedSchedule).toHaveBeenCalledTimes(1);

        /* ---- Second click: replay must be inert ---- */
        const second = await approveRequest(orderId);
        const secondBody = await second.json();

        expect(second.status).toBe(200);
        expect(secondBody.success).toBe(true);
        expect(secondBody.data.changed).toBe(false);

        const jobsAfterSecond = await prisma.shipmentJob.findMany({
            where: { orderId },
            select: { id: true, status: true },
        });

        // Still exactly ONE job — the unique ShipmentJob.orderId holds.
        expect(jobsAfterSecond).toHaveLength(1);
        expect(jobsAfterSecond[0].status).toBe("PENDING");

        // …and nothing was handed to the provider by this process.
        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });

    test("a non-admin cannot decide the review", async () => {
        const { order } = await runCodCheckout({
            price: 2_500_000,
            tag: "forbidden",
        });

        mockedAuth.mockResolvedValue({
            user: { id: "u-1", role: "CUSTOMER" },
        });

        const response = await approveRequest(order!.id);

        expect(response.status).toBe(403);

        const after = await prisma.order.findUnique({
            where: { id: order!.id },
            select: {
                codReviewStatus: true,
                shipmentJob: { select: { id: true } },
            },
        });

        expect(after!.codReviewStatus).toBe("PENDING");
        expect(after!.shipmentJob).toBeNull();
    });
});
