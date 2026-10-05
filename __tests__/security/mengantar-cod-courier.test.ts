/**
 * ==========================================
 * MENGANTAR COD COURIER RESOLUTION
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-cod-courier.test.ts
 *
 * ROOT CAUSE this guards:
 * `createShipmentForOrder` used to reject COD whenever the customer's
 * chosen courier did not support COD for the destination — even when
 * OTHER couriers did — so a perfectly valid COD order failed with
 * "Kurir tidak melayani tujuan ini untuk COD." and no shipment was
 * created.
 *
 * FIX (COD only): the COD-capable courier set is resolved from the
 * provider estimate through the project's shared normalizer
 * (`buildMengantarShippingOptions` → `supportsCod`, which mirrors the
 * documented `unsupported` / `unsupported_cod` fields):
 *   - keep the customer's courier when it supports COD;
 *   - otherwise fall back to another available COD courier (cheapest
 *     first, the UI's default ordering);
 *   - fail ONLY when no courier supports COD — and never POST.
 * The resolved courier is used for the provider POST AND persisted as
 * `providerCourier` / `shippingCourier`, so the UI/state never shows a
 * courier different from the one sent.
 *
 * NON-COD is completely untouched (its courier, payload, validation
 * and error handling are unchanged).
 *
 * The provider and the Mengantar shipping layer are fully MOCKED — no
 * request ever reaches Mengantar.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        orderItem: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {
        status?: number;
        code?: string;
    },
    createMengantarOrder: jest.fn(),
    createMengantarPickupTime: jest.fn(),
    payMengantarUnpaid: jest.fn(),
    estimateMengantarShipping: jest.fn(),
    // Inverse mapping, mirroring the real module for the codes we use.
    toMengantarCourier: (code: unknown) =>
        String(code ?? "").trim().toLowerCase() === "jne"
            ? "JNE"
            : null,
    toInternalCourier: (name: unknown) => {
        switch (String(name ?? "").trim().toLowerCase()) {
            case "jne":
                return "jne";
            case "jt":
                return "jnt";
            default:
                return String(name ?? "").trim().toLowerCase();
        }
    },
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    buildMengantarShippingOptions: jest.fn(),
    getMengantarOriginConfig: jest.fn(),
    resolveMengantarDestinationAreaId: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { createMengantarOrder } from "@/lib/mengantar";
import {
    buildMengantarShippingOptions,
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import { createShipmentForOrder } from "@/lib/mengantar/shipment";

const mockPrisma = prisma as unknown as {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
    orderItem: { findMany: jest.Mock };
};

const mockedCreateOrder =
    createMengantarOrder as unknown as jest.Mock;
const mockedBuildOptions =
    buildMengantarShippingOptions as unknown as jest.Mock;
const mockedOrigin =
    getMengantarOriginConfig as unknown as jest.Mock;
const mockedResolveDestination =
    resolveMengantarDestinationAreaId as unknown as jest.Mock;

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 969,
        orderNumber: "ORD-969",
        status: "PENDING",
        recipientName: "Budi",
        phone: "081234567890",
        address: "Jl. Contoh No. 1",
        province: "DKI JAKARTA",
        city: "JAKARTA SELATAN",
        district: "KEBAYORAN BARU",
        postalCode: "12120",
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        shippingProvider: "MENGANTAR",
        providerCourier: "jne",
        providerShipmentId: null,
        providerBatchId: null,
        shipmentStatus: "NOT_CREATED",
        shippingPaymentStatus: "NOT_APPLICABLE",
        trackingNumber: null,
        total: 110000,
        shippingCost: 10000,
        codAmount: 110000,
        ...overrides,
    };
}

function providerItem(overrides: Record<string, unknown> = {}) {
    return {
        ORDER_ID: "260130OVBBOO",
        batch_id: "697c58034fa61abe7c700da6",
        cnote_no: "11000009548385",
        isPaid: true,
        ...overrides,
    };
}

function updateManyCalls() {
    return mockPrisma.order.updateMany.mock.calls.map(
        (call: unknown[]) => call[0] as { data?: Record<string, unknown> }
    );
}

function finalizeCall() {
    // call 0 = claim, call 1 = CAS finalize (claim always succeeds).
    return updateManyCalls()[1];
}

beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma.orderItem.findMany.mockResolvedValue([
        {
            productName: "Kaos",
            variantName: "L",
            quantity: 1,
            variant: { weight: 1000 },
        },
    ]);

    mockedOrigin.mockResolvedValue({
        originAreaId: "origin-area",
        pickupAddressId: "pickup-addr",
        pickupTimeId: null,
    });

    mockedResolveDestination.mockResolvedValue("dest-area");

    // Default: claim succeeds, finalize succeeds.
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
});

describe("A. COD + a courier that supports COD → used as-is", () => {
    it("creates the shipment with the customer's COD-capable courier", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedBuildOptions.mockResolvedValue([
            { courier: "JNE", supportsCod: true, cost: 11000 },
        ]);
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-COD",
        });

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(true);
        expect(result.shipmentStatus).toBe("CREATED");
        // COD is never seller-paid: no PAY step.
        expect(result.shippingPaymentStatus).toBe(
            "NOT_APPLICABLE"
        );

        const payload = mockedCreateOrder.mock.calls[0][0];
        expect(payload.courier).toBe("JNE");
        expect(payload.orders[0].COD).toBe(110000);

        // The resolved COD set is derived from the provider estimate
        // WITH the exact COD amount.
        expect(mockedBuildOptions).toHaveBeenCalledWith(
            expect.objectContaining({ codAmount: 110000 })
        );

        // A supported courier needs no persisted re-resolution.
        expect(finalizeCall().data?.providerCourier).toBe("JNE");
    });
});

describe("B. COD + the chosen courier cannot do COD, an alternative can", () => {
    it("resolves to an available COD courier and uses it for the POST", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedBuildOptions.mockResolvedValue([
            // The customer's choice — serves the area, PREPAID only.
            { courier: "JNE", supportsCod: false, cost: 11000 },
            // An available COD option.
            { courier: "JT", supportsCod: true, cost: 12000 },
        ]);
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem({ ORDER_ID: "ORD-JT" })],
            batch_id: "BATCH-JT",
        });

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(true);

        // The provider POST uses the RESOLVED courier.
        const payload = mockedCreateOrder.mock.calls[0][0];
        expect(payload.courier).toBe("JT");
        expect(payload.orders[0].COD).toBe(110000);

        // ...and the state/UI is adjusted to the SAME courier so they
        // never disagree (claim persists it before the POST).
        const claim = updateManyCalls()[0];
        expect(claim.data).toMatchObject({
            shipmentStatus: "CREATING",
            providerCourier: "JT",
            shippingCourier: "jnt",
        });
        expect(finalizeCall().data?.providerCourier).toBe("JT");
    });
});

describe("C. COD + no courier can do COD → clean failure, no POST", () => {
    it("fails with the documented error and never creates a shipment", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedBuildOptions.mockResolvedValue([
            { courier: "JNE", supportsCod: false, cost: 11000 },
            { courier: "lion", supportsCod: false, cost: 13000 },
        ]);

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(false);
        expect(result.changed).toBe(false);
        expect(result.reason).toBe(
            "Kurir tidak melayani tujuan ini untuk COD."
        );

        // No invalid provider POST...
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        // ...and no claim → the job can never be double-processed.
        expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    });
});

describe("D. NON-COD regression — courier flow is unchanged", () => {
    it("uses the stored courier and never runs COD resolution", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                paymentMethod: "BANK_TRANSFER",
                paymentStatus: "PAID",
                shippingPaymentStatus: "UNPAID",
                codAmount: null,
            })
        );
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-NONCOD",
        });

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(true);
        expect(result.shipmentStatus).toBe("CREATED");
        expect(result.shippingPaymentStatus).toBe("PAID");

        const payload = mockedCreateOrder.mock.calls[0][0];
        expect(payload.courier).toBe("JNE");
        // NON-COD sends goodsValue, never COD.
        expect(payload.orders[0].COD).toBeUndefined();

        // COD resolution is COD-only.
        expect(mockedBuildOptions).not.toHaveBeenCalled();
        // NON-COD never rewrites the persisted courier.
        expect(
            updateManyCalls()[0].data
        ).not.toHaveProperty("providerCourier");
    });

    it("still rejects an unsupported courier for NON-COD (unchanged)", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                paymentMethod: "BANK_TRANSFER",
                paymentStatus: "PAID",
                shippingPaymentStatus: "UNPAID",
                codAmount: null,
                providerCourier: "ninja",
            })
        );

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe(
            "Kurir Mengantar pada pesanan ini tidak valid."
        );
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockedBuildOptions).not.toHaveBeenCalled();
    });
});

describe("E. COD lifecycle invariants stay intact", () => {
    it("never writes paymentStatus and keeps COD UNPAID", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedBuildOptions.mockResolvedValue([
            { courier: "JNE", supportsCod: true, cost: 11000 },
        ]);
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-COD",
        });

        const result = await createShipmentForOrder(969);

        expect(result.ok).toBe(true);

        for (const call of updateManyCalls()) {
            expect(call.data).not.toHaveProperty("paymentStatus");
        }
        expect(
            mockPrisma.order.updateMany
        ).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "CANCELLED",
                }),
            })
        );
    });
});
