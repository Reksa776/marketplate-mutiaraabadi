/**
 * ==========================================
 * COD QUOTA + NO-DUPLICATE SHIPMENT
 * ==========================================
 *
 * Regression tests for the P0 hotfix, part 2.
 *
 *  A. ACTIVE-COD QUOTA (`countActiveGuestCodOrders`)
 *     The Mengantar pipeline never writes `Order.status`, so a COD
 *     order that was shipped and CONFIRMED DELIVERED kept
 *     `status = PENDING` and occupied the buyer's open-COD allowance
 *     forever — a legitimate repeat buyer then had every later order
 *     held for review. A confirmed delivery must release the slot,
 *     while a NULL (legacy) shipment state must keep counting.
 *
 *  B. DUPLICATE PROTECTION
 *     `POST /order` on Mengantar is NOT idempotent, so an order that
 *     already carries a `providerShipmentId` must never create a second
 *     shipment, and the outbox can only ever hold one job per order.
 *
 *  C. FRAUD PROTECTION INTACT
 *     The HIGH_VALUE threshold is unchanged.
 *
 * Only prisma and the Mengantar client are mocked: no provider call, no
 * database, no network.
 */

const mockOrder = {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
};

const mockShipmentJob = {
    upsert: jest.fn(async () => ({ id: 1 })),
    updateMany: jest.fn(async () => ({ count: 1 })),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
        orderItem: {
            findMany: jest.fn(async () => [
                {
                    productName: "Kaos",
                    variantName: "L",
                    quantity: 1,
                    variant: { weight: 1000 },
                },
            ]),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {},
    createMengantarOrder: jest.fn(),
    estimateMengantarShipping: jest.fn(),
    payMengantarUnpaid: jest.fn(),
    toInternalCourier: (name: string) =>
        String(name).toLowerCase(),
    toMengantarCourier: (code: unknown) =>
        String(code ?? "").toLowerCase() === "jne"
            ? "JNE"
            : null,
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    buildMengantarShippingOptions: jest.fn(),
    getMengantarOriginConfig: jest.fn(async () => ({
        originAreaId: "origin-area",
        pickupAddressId: "pickup-addr",
        pickupTimeId: null,
    })),
    resolveMengantarDestinationAreaId: jest.fn(
        async () => "dest-area"
    ),
}));

import { prisma } from "@/lib/prisma";
import { createMengantarOrder } from "@/lib/mengantar";
import {
    createShipmentForOrder,
} from "@/lib/mengantar/shipment";
import { enqueueShipmentJob } from "@/lib/mengantar/shipment-worker";
import {
    assessCodRisk,
    COD_ACTIVE_STATUSES,
    COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
    COD_REVIEW_AMOUNT_THRESHOLD,
    countActiveGuestCodOrders,
} from "@/lib/cod-policy";

const mockedCreateOrder =
    createMengantarOrder as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
};
const mockedJob = prisma.shipmentJob as unknown as {
    upsert: jest.Mock;
};

const GUEST_KEY = "g1:abc:def";

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 985,
        orderNumber: "ORD-985",
        recipientName: "Budi",
        phone: "081234567890",
        address: "Jl. Contoh No. 1",
        province: "DKI JAKARTA",
        city: "JAKARTA SELATAN",
        district: "KEBAYORAN BARU",
        postalCode: "12120",
        status: "PENDING",
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        shippingProvider: "MENGANTAR",
        providerCourier: "jne",
        providerShipmentId: null,
        providerBatchId: null,
        shipmentStatus: "NOT_CREATED",
        shippingPaymentStatus: "NOT_APPLICABLE",
        trackingNumber: null,
        total: 95000,
        shippingCost: 10000,
        codAmount: 95000,
        requiresCodReview: false,
        codReviewStatus: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockedOrder.updateMany.mockResolvedValue({ count: 1 });
});

/* ==========================================
 * A. ACTIVE-COD QUOTA
 * ========================================== */

describe("active COD quota", () => {
    test("a confirmed DELIVERED shipment releases the slot, NULL still counts", async () => {
        const client = {
            order: { count: jest.fn(async () => 2) },
        };

        const count = await countActiveGuestCodOrders(
            client as never,
            GUEST_KEY
        );

        expect(count).toBe(2);

        /*
         * The filter must be NULL-SAFE: `notIn` alone would drop every
         * legacy row (shipmentStatus IS NULL) because SQL three-valued
         * logic makes `NULL NOT IN (...)` neither TRUE nor FALSE.
         */
        expect(client.order.count).toHaveBeenCalledWith({
            where: {
                guestIdentityKey: GUEST_KEY,
                paymentMethod: "COD",
                status: { in: COD_ACTIVE_STATUSES },
                OR: [
                    { shipmentStatus: null },
                    {
                        shipmentStatus: {
                            notIn: [
                                ...COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
                            ],
                        },
                    },
                ],
            },
        });
    });

    test("only a confirmed delivery is released — returns/undelivered keep counting", () => {
        expect([
            ...COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
        ]).toEqual(["DELIVERED"]);

        for (const stillCounted of [
            "UNDELIVERED",
            "RETURNED",
            "CREATED",
            "IN_TRANSIT",
            "CANCELLED",
        ]) {
            expect(
                (
                    COD_QUOTA_RELEASED_SHIPMENT_STATUSES as
                        readonly string[]
                ).includes(stillCounted)
            ).toBe(false);
        }
    });

    test("a repeat buyer is no longer flagged once the cap is released", () => {
        const stillHeld = assessCodRisk({
            total: 95_000,
            activeCodOrders: 3,
            isGuest: true,
        });

        expect(stillHeld.requiresReview).toBe(true);
        expect(stillHeld.reasons).toContain(
            "TOO_MANY_OPEN_COD"
        );

        // One of the three was delivered → released → below the cap.
        const released = assessCodRisk({
            total: 95_000,
            activeCodOrders: 2,
            isGuest: true,
        });

        expect(released.requiresReview).toBe(false);
    });
});

/* ==========================================
 * B. DUPLICATE PROTECTION
 * ========================================== */

describe("duplicate shipment protection", () => {
    test("an order that already has a providerShipmentId never calls the provider again", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({
                providerShipmentId: "ORD-PROVIDER-1",
                providerBatchId: "BATCH-1",
                shipmentStatus: "CREATED",
                trackingNumber: "CN-1",
            })
        );

        const result = await createShipmentForOrder(985);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    test("a non-Mengantar order is refused before any provider call", async () => {
        mockedOrder.findUnique.mockResolvedValue(
            baseOrder({ shippingProvider: null })
        );

        const result = await createShipmentForOrder(985);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    test("enqueueing is an upsert on the UNIQUE orderId, so a second enqueue cannot duplicate a job", async () => {
        await enqueueShipmentJob(985);
        await enqueueShipmentJob(985);

        expect(mockedJob.upsert).toHaveBeenCalledTimes(2);

        for (const call of mockedJob.upsert.mock.calls) {
            expect(call[0]).toEqual({
                where: { orderId: 985 },
                create: { orderId: 985 },
                update: {},
            });
        }
    });
});

/* ==========================================
 * C. FRAUD PROTECTION INTACT
 * ========================================== */

describe("COD fraud protection is preserved", () => {
    test("the HIGH_VALUE threshold still flags a high-value COD order", () => {
        const risk = assessCodRisk({
            total: COD_REVIEW_AMOUNT_THRESHOLD,
            activeCodOrders: 0,
            isGuest: true,
        });

        expect(risk.requiresReview).toBe(true);
        expect(risk.reasons).toContain("HIGH_VALUE");
    });

    test("the threshold is still a positive amount, not disabled", () => {
        expect(COD_REVIEW_AMOUNT_THRESHOLD).toBeGreaterThan(0);
    });
});
