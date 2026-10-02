/**
 * ==========================================
 * MENGANTAR SHIPMENT STATE — PROVIDER TRUTH
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-shipment-state.test.ts
 *
 * Guards the production bug where a shipment that Mengantar HAD
 * created was reported as "Gagal dibuat":
 *
 *  - create + ORDER_ID + cnote_no           → CREATED / PAID
 *  - create + ORDER_ID + cnote_no = null     → WAITING_SHIPPING_PAYMENT / UNPAID
 *  - provider queue/pending                  → WAITING_SHIPPING_PAYMENT (not FAILED)
 *  - provider reject (no ORDER_ID)           → FAILED, retryable
 *  - provider timeout                        → claim released, error propagated
 *  - DB finalize miss after provider success → ORDER_ID backfilled (no retry POST)
 *  - retry                                   → never a second provider POST
 *  - shipmentStatus vs shippingPaymentStatus → never swapped
 *  - admin UI                                → shows providerShipmentId, shows a
 *                                              resi ONLY when one exists
 *
 * The provider is fully MOCKED — no request reaches Mengantar.
 */

import { readFileSync } from "fs";

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
    estimateMengantarShipping: jest.fn(),
    payMengantarUnpaid: jest.fn(),
    toInternalCourier: (name: string) =>
        String(name).toLowerCase(),
    toMengantarCourier: (code: unknown) =>
        String(code ?? "").toLowerCase() === "jne" ? "JNE" : null,
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    getMengantarOriginConfig: jest.fn(),
    resolveMengantarDestinationAreaId: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
    createMengantarOrder,
    estimateMengantarShipping,
} from "@/lib/mengantar";
import {
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
const mockedEstimate =
    estimateMengantarShipping as unknown as jest.Mock;
const mockedOrigin =
    getMengantarOriginConfig as unknown as jest.Mock;
const mockedResolveDestination =
    resolveMengantarDestinationAreaId as unknown as jest.Mock;

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 10,
        orderNumber: "ORD-10",
        status: "PAID",
        recipientName: "Budi",
        phone: "081234567890",
        address: "Jl. Contoh No. 1",
        province: "DKI JAKARTA",
        city: "JAKARTA SELATAN",
        district: "KEBAYORAN BARU",
        postalCode: "12120",
        paymentMethod: "BANK_TRANSFER",
        paymentStatus: "PAID",
        shippingProvider: "MENGANTAR",
        providerCourier: "jne",
        providerShipmentId: null,
        providerBatchId: null,
        shipmentStatus: "NOT_CREATED",
        shippingPaymentStatus: "UNPAID",
        trackingNumber: null,
        total: 110000,
        shippingCost: 10000,
        codAmount: null,
        ...overrides,
    };
}

/** A provider item exactly as documented by Mengantar. */
function providerItem(
    overrides: Record<string, unknown> = {}
) {
    return {
        ORDER_ID: "260130OVBBOO",
        batch_id: "697c58034fa61abe7c700da6",
        cnote_no: "11000009548385",
        isPaid: true,
        queueStatus: "COMPLETED",
        status: "active",
        statusCategory: "active",
        error: null,
        ...overrides,
    };
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

    // dropOff mode → no pickup-schedule network call.
    mockedOrigin.mockResolvedValue({
        originAreaId: "origin-area",
        pickupAddressId: "pickup-addr",
        pickupTimeId: null,
    });

    mockedResolveDestination.mockResolvedValue("dest-area");

    // Default: claim succeeds, finalize succeeds.
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
});

function finalizeCall() {
    // call 0 = claim, call 1 = CAS finalize.
    return mockPrisma.order.updateMany.mock.calls[1]?.[0];
}

describe("createShipmentForOrder — provider truth", () => {
    it("create success + ORDER_ID + cnote_no → CREATED/PAID", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "697c58034fa61abe7c700da6",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.shipmentStatus).toBe("CREATED");
        expect(result.shippingPaymentStatus).toBe("PAID");
        expect(result.trackingNumber).toBe("11000009548385");
        expect(result.shipmentId).toBe("260130OVBBOO");

        const data = finalizeCall().data;
        expect(data.providerShipmentId).toBe("260130OVBBOO");
        expect(data.providerBatchId).toBe(
            "697c58034fa61abe7c700da6"
        );
        expect(data.trackingNumber).toBe("11000009548385");
        expect(data.shipmentStatus).toBe("CREATED");
        expect(data.shippingPaymentStatus).toBe("PAID");
    });

    it("create success + ORDER_ID + cnote_no null → WAITING_SHIPPING_PAYMENT, ORDER_ID persisted, NO fake resi", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                providerItem({
                    cnote_no: null,
                    isPaid: false,
                    queueStatus: "PENDING",
                }),
            ],
            batch_id: "697c58034fa61abe7c700da6",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.shipmentStatus).toBe(
            "WAITING_SHIPPING_PAYMENT"
        );
        expect(result.shippingPaymentStatus).toBe("UNPAID");
        expect(result.trackingNumber).toBeNull();

        const data = finalizeCall().data;
        // The provider order EXISTS → its id must be stored.
        expect(data.providerShipmentId).toBe("260130OVBBOO");
        // No resi may be fabricated.
        expect(data.trackingNumber).toBeNull();
        expect(data.shipmentStatus).toBe(
            "WAITING_SHIPPING_PAYMENT"
        );
    });

    it("provider queue/pending → correct state, never 'Gagal dibuat'", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                providerItem({
                    isPaid: false,
                    cnote_no: null,
                    queueStatus: "PROCESSING",
                    status: "active",
                    statusCategory: "active",
                }),
            ],
            batch_id: "BATCH-Q",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.shipmentStatus).not.toBe("FAILED");
        expect(result.shipmentStatus).toBe(
            "WAITING_SHIPPING_PAYMENT"
        );
        expect(result.shipmentId).toBe("260130OVBBOO");
    });

    it("provider reject (no ORDER_ID at all) → FAILED and retryable", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [],
            batch_id: "",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe(
            "Mengantar menolak pembuatan shipment. Silakan cek data pesanan."
        );
        // Claim released to FAILED so the admin can retry.
        expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { shipmentStatus: "FAILED" },
            })
        );
    });

    it("rejects an item that carries an error and NO provider id", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                providerItem({
                    ORDER_ID: "",
                    cnote_no: null,
                    isPaid: false,
                    error: { message: "alamat tidak valid" },
                }),
            ],
            batch_id: "BATCH-ERR",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(result.shipmentStatus).toBeUndefined();
    });

    it("never marks a shipment CREATED without a provider ORDER_ID", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem({ ORDER_ID: "" })],
            batch_id: "BATCH-1",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(
            mockPrisma.order.updateMany
        ).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    providerShipmentId: "",
                }),
            })
        );
    });

    it("provider timeout → claim released back to NOT_CREATED and the error propagates", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockRejectedValue(
            new Error("UPSTREAM_TIMEOUT")
        );

        await expect(createShipmentForOrder(10)).rejects.toThrow(
            "UPSTREAM_TIMEOUT"
        );

        expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { shipmentStatus: "NOT_CREATED" },
            })
        );
    });

    it("DB finalize miss after provider success → ORDER_ID is backfilled", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "697c58034fa61abe7c700da6",
        });

        // claim ok, CAS finalize MISSES (count 0), recovery write ok.
        mockPrisma.order.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 1 });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(
            mockPrisma.order.updateMany
        ).toHaveBeenCalledTimes(3);

        const recovery = mockPrisma.order.updateMany.mock
            .calls[2][0];
        expect(recovery.where).toEqual(
            expect.objectContaining({
                id: 10,
                providerShipmentId: null,
            })
        );
        expect(recovery.data.providerShipmentId).toBe(
            "260130OVBBOO"
        );
        expect(recovery.data.trackingNumber).toBe(
            "11000009548385"
        );
    });

    it("retry never issues a second provider POST for an existing shipment", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                providerShipmentId: "260130OVBBOO",
                providerBatchId: "BATCH-1",
                shipmentStatus: "CREATED",
                shippingPaymentStatus: "PAID",
                trackingNumber: "CN-1",
            })
        );

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(false);
        expect(result.shipmentId).toBe("260130OVBBOO");
        expect(mockedCreateOrder).not.toHaveBeenCalled();
        expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("a backfilled order is idempotent on the next retry", async () => {
        // After the finalize-miss recovery the row has the provider id,
        // so a later retry short-circuits instead of re-POSTing.
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                providerShipmentId: "260130OVBBOO",
                shipmentStatus: "WAITING_SHIPPING_PAYMENT",
                shippingPaymentStatus: "UNPAID",
            })
        );

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("never swaps shipmentStatus and shippingPaymentStatus", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-1",
        });

        const result = await createShipmentForOrder(10);

        // providerShipmentId holds the ORDER_ID, trackingNumber the resi.
        expect(result.shippingPaymentStatus).toBe("PAID");
        expect(result.shipmentStatus).toBe("CREATED");
        expect(result.shipmentId).toBe("260130OVBBOO");
        expect(result.trackingNumber).toBe("11000009548385");
    });

    it("COD keeps shippingPaymentStatus NOT_APPLICABLE", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                paymentMethod: "COD",
                paymentStatus: "UNPAID",
                shippingPaymentStatus: "NOT_APPLICABLE",
                codAmount: 110000,
            })
        );

        mockedEstimate.mockResolvedValue({
            JNE: { unsupported: false, unsupported_cod: false },
        });

        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-COD",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.shippingPaymentStatus).toBe(
            "NOT_APPLICABLE"
        );
        expect(result.shipmentStatus).toBe("CREATED");
    });

    it("never writes the marketplace paymentStatus", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [providerItem()],
            batch_id: "BATCH-1",
        });

        await createShipmentForOrder(10);

        for (const call of mockPrisma.order.updateMany.mock.calls) {
            expect(call[0].data).not.toHaveProperty(
                "paymentStatus"
            );
        }
    });
});

describe("Admin order-detail shipment panel (source guards)", () => {
    const adminPage = readFileSync(
        "app/admin/orders/[id]/page.tsx",
        "utf-8"
    );

    it("shows the provider shipment id and a resi only when present", () => {
        expect(adminPage).toContain("{shipmentId ?? \"-\"}");
        expect(adminPage).toContain("{trackingNumber ??");
        expect(adminPage).toContain(
            "? ` • Resi ${trackingNumber}`"
        );
    });

    it("keeps shipment status and shipping-payment labels separate", () => {
        expect(adminPage).toContain("SHIPMENT_STATUS_LABELS");
        expect(adminPage).toContain("SHIPPING_PAYMENT_LABELS");
        // "Belum dibayar" belongs to the seller's ongkir payment only.
        expect(adminPage).toContain(
            "UNPAID: \"Belum dibayar\""
        );
        expect(adminPage).toContain(
            "FAILED: \"Gagal dibuat\""
        );
    });

    it("offers the manual create button only when nothing was created", () => {
        expect(adminPage).toContain("!shipmentId &&");
        expect(adminPage).toContain('status === "FAILED"');
    });
});
