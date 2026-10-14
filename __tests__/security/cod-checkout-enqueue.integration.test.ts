/**
 * ==========================================
 * COD CHECKOUT → SHIPMENT ENQUEUE — REAL DATABASE INTEGRATION
 * ==========================================
 *
 * REQUIREMENT (owner correction): EVERY successful COD checkout using the
 * MENGANTAR provider must enqueue a ShipmentJob so the existing worker
 * requests the shipment/pickup automatically — INCLUDING a flagged order
 * whose COD review is still PENDING, and while Order.status is still
 * PENDING. An admin must never have to click Approve for a parcel to be
 * requested.
 *
 * A mocked Prisma client cannot prove the fix, because the whole bug was
 * about WHAT ACTUALLY GOT PERSISTED (order #985: MENGANTAR /
 * NOT_CREATED / requiresCodReview=true / PENDING / providerShipmentId
 * NULL / ShipmentJob []). So these tests run the REAL
 * `createCheckoutOrder` and the REAL admin review endpoint against the
 * REAL MariaDB (database `toko`), and assert the rows the database
 * really holds:
 *
 *   1. a NORMAL COD order leaves the transaction with exactly ONE
 *      PENDING ShipmentJob and the post-response worker nudge fired;
 *   2. a FLAGGED COD order (HIGH_VALUE, and separately
 *      TOO_MANY_OPEN_COD) leaves with EXACTLY THE SAME job — the review
 *      is a risk marker, not a hold;
 *   3. Order.status stays PENDING and does not stop that;
 *   4. the COD quota still counts a legacy NULL shipmentStatus and still
 *      RELEASES a slot when the parcel is DELIVERED;
 *   5. APPROVING later is a decision only: it cannot create a second job
 *      and does not touch the buyer's paymentStatus (UNPAID for COD).
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION: no Mengantar / payment call is ever
 * made. The only outbound seams mocked are the Mengantar shipping
 * ESTIMATE (re-priced locally) and the provider create/pay helpers, all
 * of which THROW if called — so "the checkout never calls the provider
 * inside its database transaction" is enforced, not just asserted.
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

/*
 * The legacy RajaOngkir path is used by S8 below: a COD order that is NOT
 * fulfilled by Mengantar must never enter the Mengantar outbox.
 */
jest.mock("@/lib/rajaongkir", () => ({
    ...jest.requireActual("@/lib/rajaongkir"),
    calculateDomesticCost: jest.fn(async () => [
        {
            code: "jne",
            service: "REG",
            cost: 20000,
            etd: "2-3",
        },
    ]),
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
}) {
    const { product, variant, destinationId, subdistrict } =
        await seedProductVariant(input.price, input.tag);

    const result = await createCheckoutOrder({
        userId: null,
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
        select: { id: true, status: true, stage: true },
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

/** A guest COD checkout through the RAJAONGKIR path (no Mengantar). */
async function runRajaOngkirCodCheckout() {
    const { product, variant, destinationId, subdistrict } =
        await seedProductVariant(10_000, "rajaongkir");

    const result = await createCheckoutOrder({
        userId: null,
        mode: "BUY_NOW",
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
        guestAddress: {
            recipientName: "CCE LEGACY",
            phone: "081298760003",
            email: `cce-legacy-${SUFFIX}@cce.local`,
            address: "Jl. Legacy No. 1",
            province: "DKI Jakarta",
            city: "Jakarta Selatan",
            district: "Kebayoran Baru",
            subdistrict,
            postalCode: "12160",
            rajaOngkirDestinationId: destinationId,
        },
        shipping: {
            provider: "RAJAONGKIR",
            courier: "jne",
            service: "REG",
            cost: 20000,
        },
        paymentMethod: "COD",
    });

    createdOrderIds.push(result.order.id);

    const order = await prisma.order.findUnique({
        where: { id: result.order.id },
        select: {
            id: true,
            shippingProvider: true,
            shipmentStatus: true,
            paymentMethod: true,
        },
    });

    const job = await prisma.shipmentJob.findUnique({
        where: { orderId: result.order.id },
        select: { id: true, status: true },
    });

    return { order, job };
}

/**
 * A REAL guest NON-COD + Mengantar checkout.
 *
 * Non-COD money settles through the payment webhook, so the checkout must
 * NOT enqueue a Mengantar job and must NOT nudge the worker — that is the
 * pre-existing behaviour this change has to leave untouched.
 */
async function runNonCodMengantarCheckout(
    paymentMethod: "BANK_TRANSFER" | "QRIS"
) {
    const { product, variant, destinationId, subdistrict } =
        await seedProductVariant(10_000, `noncod-${paymentMethod}`);

    const result = await createCheckoutOrder({
        userId: null,
        mode: "BUY_NOW",
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
        guestAddress: {
            recipientName: "CCE NONCOD",
            phone: "081298760004",
            email: `cce-noncod-${SUFFIX}@cce.local`,
            address: "Jl. Non COD No. 1",
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
            cost: 20000,
        },
        paymentMethod,
    });

    createdOrderIds.push(result.order.id);

    const order = await prisma.order.findUnique({
        where: { id: result.order.id },
        select: {
            id: true,
            paymentMethod: true,
            paymentStatus: true,
            status: true,
            shippingProvider: true,
            shipmentStatus: true,
            requiresCodReview: true,
            codReviewStatus: true,
            subtotal: true,
            shippingCost: true,
            total: true,
        },
    });

    const job = await prisma.shipmentJob.findUnique({
        where: { orderId: result.order.id },
        select: { id: true, status: true },
    });

    return { order, job };
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
         * `lib/marketing/shipping-discount.ts` auto-applies the first
         * active discount row when no code is supplied, and other suites
         * seed such rows against the SAME database. That is real product
         * behaviour, so the BASE PRICE is pinned whenever no discount was
         * applied and the money CONTRACT below must hold either way
         * (never a hard-coded total).
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
         * codAmount must equal the COD contract:
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

        /*
         * NO PROVIDER CALL during checkout: the transaction only writes a
         * ShipmentJob row. Both provider helpers are throwing spies, so a
         * call from the checkout would fail the test itself.
         */
        expect(mockedCreateShipment).not.toHaveBeenCalled();
        expect(mockedPayShipment).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 2 — A FLAGGED COD ORDER IS ENQUEUED TOO
 * ========================================== */

describe("TARGET 2/3 — a flagged COD order still ships automatically", () => {
    test("a HIGH_VALUE COD order gets its ShipmentJob and the worker nudge", async () => {
        // ≥ COD_REVIEW_AMOUNT_THRESHOLD (default 2.000.000).
        const { order, job } = await runCodCheckout({
            price: 2_500_000,
            tag: "highvalue",
        });

        // Flagged for review…
        expect(order!.requiresCodReview).toBe(true);
        expect(order!.codReviewStatus).toBe("PENDING");

        // …and NOT held: order still PENDING, buyer still owes.
        expect(order!.status).toBe("PENDING");
        expect(order!.paymentStatus).toBe("UNPAID");
        expect(order!.shipmentStatus).toBe("NOT_CREATED");
        expect(order!.providerShipmentId).toBeNull();

        // THE REQUIREMENT: the automatic shipment is requested anyway.
        expect(job).not.toBeNull();
        expect(job!.status).toBe("PENDING");
        expect(mockedSchedule).toHaveBeenCalledTimes(1);

        // Still no provider call inside the checkout transaction.
        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });

    test("TOO_MANY_OPEN_COD also flags AND enqueues the 4th open COD order", async () => {
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

        // A risk flag is not a hold.
        expect(job).not.toBeNull();
        expect(job!.status).toBe("PENDING");
        expect(mockedSchedule).toHaveBeenCalledTimes(1);
    });

    test("the quota counts legacy NULL shipmentStatus but RELEASES DELIVERED", async () => {
        const identity = `cce-quota-${SUFFIX}-release`;

        /*
         * The exact SQL trap the quota fix addresses: `shipmentStatus NOT
         * IN ('DELIVERED')` is NULL (not TRUE) for a legacy row, so NULL
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
         * End to end: an identity with only ONE open COD order (2
         * delivered, 1 open) is NOT flagged, and its order is enqueued.
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
 * 8 — NON-MENGANTAR COD NEVER ENTERS THE OUTBOX
 * ========================================== */

describe("TARGET 8 — a non-Mengantar COD order gets no Mengantar job", () => {
    test("a RAJAONGKIR COD checkout creates no ShipmentJob and is never nudged", async () => {
        const { order, job } = await runRajaOngkirCodCheckout();

        expect(order!.paymentMethod).toBe("COD");
        // Legacy provider path: no Mengantar fulfilment state at all.
        expect(order!.shippingProvider).toBeNull();
        expect(order!.shipmentStatus).toBeNull();

        // The Mengantar outbox must stay empty…
        expect(job).toBeNull();

        // …and no Mengantar work may be scheduled for it.
        expect(mockedSchedule).not.toHaveBeenCalled();
        expect(mockedCreateShipment).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 10 — NON-COD PAYMENT BEHAVIOUR IS UNCHANGED
 * ========================================== */

describe("TARGET 10 — a non-COD order keeps its own settlement trigger", () => {
    /*
     * The checkout change widened NOTHING: the enqueue and the worker
     * nudge are both still scoped to `paymentMethod === "COD"`. A
     * non-COD order must therefore leave the transaction with an EMPTY
     * Mengantar outbox and wait for its payment webhook exactly as
     * before.
     */
    test.each(["BANK_TRANSFER", "QRIS"] as const)(
        "a %s + Mengantar checkout enqueues no job and is never nudged",
        async (paymentMethod) => {
            const { order, job } =
                await runNonCodMengantarCheckout(paymentMethod);

            expect(order).not.toBeNull();
            expect(order!.paymentMethod).toBe(paymentMethod);
            expect(order!.shippingProvider).toBe("MENGANTAR");

            /*
             * The COD risk assessment is COD-scoped: a non-COD order is
             * never flagged for COD review, even on the Mengantar path.
             */
            expect(order!.requiresCodReview).toBe(false);
            expect(order!.codReviewStatus).toBeNull();

            /*
             * Nothing is settled at checkout — the payment webhook owns
             * that transition. A non-COD order awaits an ONLINE payment
             * (PENDING), which is deliberately a DIFFERENT value from the
             * COD one (UNPAID); this change must not have moved either.
             */
            expect(order!.paymentStatus).toBe("PENDING");
            expect(order!.shipmentStatus).toBe("NOT_CREATED");

            // No Mengantar outbox row at checkout…
            expect(job).toBeNull();

            // …and no worker nudge: the settlement webhook triggers it.
            expect(mockedSchedule).not.toHaveBeenCalled();
            expect(mockedCreateShipment).not.toHaveBeenCalled();
            expect(mockedPayShipment).not.toHaveBeenCalled();
        }
    );
});

/* ==========================================
 * 5 — APPROVE IS A DECISION, NOT A PREREQUISITE
 * ========================================== */

describe("TARGET 5 — the review decision never creates a shipment", () => {
    test("the job already exists BEFORE any approval", async () => {
        const { order, job } = await runCodCheckout({
            price: 2_500_000,
            tag: "approve",
        });

        const orderId = order!.id;

        // Pre-condition (the order-#985 shape, but FIXED): flagged,
        // review open, and the automatic job is already queued.
        expect(order!.requiresCodReview).toBe(true);
        expect(order!.codReviewStatus).toBe("PENDING");
        expect(job).not.toBeNull();
        expect(job!.status).toBe("PENDING");

        const jobsBefore = await prisma.shipmentJob.findMany({
            where: { orderId },
            select: { id: true, status: true },
        });
        expect(jobsBefore).toHaveLength(1);

        /* ---- The approval is a pure decision ---- */
        const first = await approveRequest(orderId);
        const firstBody = await first.json();

        expect(first.status).toBe(200);
        expect(firstBody.success).toBe(true);
        expect(firstBody.data.changed).toBe(true);
        expect(firstBody.data.codReviewStatus).toBe(
            "APPROVED"
        );

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

        // …and it creates NO second job: exactly one, all along.
        const jobsAfterFirst = await prisma.shipmentJob.findMany({
            where: { orderId },
            select: { id: true, status: true },
        });

        expect(jobsAfterFirst).toHaveLength(1);
        expect(jobsAfterFirst[0].status).toBe("PENDING");
        expect(jobsAfterFirst[0].id).toBe(jobsBefore[0].id);

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

        // Nothing was handed to the provider by this process.
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
                shipmentStatus: true,
            },
        });

        // Untouched decision, and fulfilment still going its own way.
        expect(after!.codReviewStatus).toBe("PENDING");
        expect(after!.shipmentStatus).toBe("NOT_CREATED");

        const jobs = await prisma.shipmentJob.findMany({
            where: { orderId: order!.id },
            select: { id: true, status: true },
        });

        expect(jobs).toHaveLength(1);
        expect(jobs[0].status).toBe("PENDING");
    });
});
