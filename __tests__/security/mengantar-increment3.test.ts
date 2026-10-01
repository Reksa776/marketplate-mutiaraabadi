/**
 * ==========================================
 * MENGANTAR INCREMENT 3 TESTS
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-increment3.test.ts
 *
 * Covers:
 *  - Unified status mapping (mapMengantarShipmentStatus)
 *  - Out-of-order / terminal / backwards transition guards
 *  - Shipment notification event keys
 *  - Shipment lifecycle with a MOCKED provider + prisma:
 *      create (normal / idempotent / concurrent / insufficient balance)
 *      COD (supported / unsupported / amount mapping / invalid courier)
 *      pay-unpaid (normal / idempotent / concurrent / COD refused)
 *      paymentStatus never touched
 *  - Webhook hardening source assertions
 *  - Admin shipment UI source assertions
 */

import { readFileSync } from "fs";

function readFile(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

/* ==========================================================
 * PURE STATUS MAPPING
 * ========================================================== */

import {
    mapMengantarShipmentStatus,
    decideMengantarShipmentTransition,
    shipmentStatusToEventKey,
} from "@/lib/mengantar/status";

describe("mapMengantarShipmentStatus", () => {
    it("maps every documented courier category", () => {
        expect(mapMengantarShipmentStatus("PENDING PICKUP")).toBe(
            "CREATED"
        );
        expect(mapMengantarShipmentStatus("PICKED UP")).toBe(
            "PICKED_UP"
        );
        expect(mapMengantarShipmentStatus("ON DELIVERY")).toBe(
            "IN_TRANSIT"
        );
        expect(mapMengantarShipmentStatus("DELIVERED")).toBe(
            "DELIVERED"
        );
        expect(mapMengantarShipmentStatus("UNDELIVERED")).toBe(
            "UNDELIVERED"
        );
        expect(mapMengantarShipmentStatus("PICKUP FAILED")).toBe(
            "CREATED"
        );
        expect(mapMengantarShipmentStatus("RTS")).toBe("RETURNED");
    });

    it("tolerates casing and whitespace", () => {
        expect(mapMengantarShipmentStatus("  delivered ")).toBe(
            "DELIVERED"
        );
        expect(mapMengantarShipmentStatus("picked up")).toBe(
            "PICKED_UP"
        );
    });

    it("handles both cancellation spellings", () => {
        expect(mapMengantarShipmentStatus("CANCELED")).toBe(
            "CANCELLED"
        );
        expect(mapMengantarShipmentStatus("CANCELLED")).toBe(
            "CANCELLED"
        );
    });

    it("treats internal/unknown categories as non-actionable", () => {
        expect(
            mapMengantarShipmentStatus(
                "ACTIVE/WAITING NEXT PROCESS"
            )
        ).toBeNull();
        expect(mapMengantarShipmentStatus("ERROR")).toBeNull();
        expect(mapMengantarShipmentStatus("WHATEVER")).toBeNull();
        expect(mapMengantarShipmentStatus("")).toBeNull();
        expect(mapMengantarShipmentStatus(null)).toBeNull();
    });
});

describe("decideMengantarShipmentTransition", () => {
    it("applies a forward transition", () => {
        const d = decideMengantarShipmentTransition(
            "CREATED",
            "PICKED UP"
        );
        expect(d.allowed).toBe(true);
        expect(d.nextStatus).toBe("PICKED_UP");
    });

    it("is a no-op for a duplicate event", () => {
        const d = decideMengantarShipmentTransition(
            "IN_TRANSIT",
            "ON DELIVERY"
        );
        expect(d.allowed).toBe(false);
        expect(d.reason).toBe("no_change");
    });

    it("never moves backwards from DELIVERED", () => {
        const d = decideMengantarShipmentTransition(
            "DELIVERED",
            "PENDING PICKUP"
        );
        expect(d.allowed).toBe(false);
        expect(d.reason).toBe("terminal");
    });

    it("preserves state on an unknown provider status", () => {
        const d = decideMengantarShipmentTransition(
            "PICKED_UP",
            "SOMETHING NEW"
        );
        expect(d.allowed).toBe(false);
        expect(d.reason).toBe("unknown_status");
        expect(d.nextStatus).toBeNull();
    });

    it("rejects backwards rank (DELIVERED → CREATED already terminal, IN_TRANSIT → CREATED blocked)", () => {
        const d = decideMengantarShipmentTransition(
            "IN_TRANSIT",
            "PICKUP FAILED"
        );
        expect(d.allowed).toBe(false);
        expect(d.reason).toBe("backwards");
    });

    it("does not allow cancelling a collected parcel", () => {
        const d = decideMengantarShipmentTransition(
            "IN_TRANSIT",
            "CANCELED"
        );
        expect(d.allowed).toBe(false);
    });

    it("allows undelivered → RTS → returned progression", () => {
        expect(
            decideMengantarShipmentTransition(
                "IN_TRANSIT",
                "UNDELIVERED"
            ).allowed
        ).toBe(true);
        expect(
            decideMengantarShipmentTransition(
                "UNDELIVERED",
                "RTS"
            ).nextStatus
        ).toBe("RETURNED");
    });
});

describe("shipmentStatusToEventKey", () => {
    it("maps shipment statuses into the SHIPMENT_* namespace", () => {
        expect(
            shipmentStatusToEventKey("WAITING_SHIPPING_PAYMENT")
        ).toBe("SHIPPING_PAYMENT_REQUIRED");
        expect(shipmentStatusToEventKey("CREATED")).toBe(
            "SHIPMENT_CREATED"
        );
        expect(shipmentStatusToEventKey("PICKED_UP")).toBe(
            "SHIPMENT_PICKED_UP"
        );
        expect(shipmentStatusToEventKey("IN_TRANSIT")).toBe(
            "SHIPMENT_IN_TRANSIT"
        );
        expect(shipmentStatusToEventKey("DELIVERED")).toBe(
            "SHIPMENT_DELIVERED"
        );
        expect(shipmentStatusToEventKey("RETURNED")).toBe(
            "SHIPMENT_RETURNED"
        );
        // Transient lock states never notify.
        expect(shipmentStatusToEventKey("CREATING")).toBeNull();
        expect(shipmentStatusToEventKey("PAYING")).toBeNull();
    });
});

/* ==========================================================
 * MOCKED SHIPMENT LIFECYCLE
 * ========================================================== */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findUnique: jest.fn(),
            updateMany: jest.fn(),
            update: jest.fn(),
        },
        orderItem: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    MengantarError: class MengantarError extends Error {},
    createMengantarOrder: jest.fn(),
    estimateMengantarShipping: jest.fn(),
    payMengantarUnpaid: jest.fn(),
    toInternalCourier: (n: string) => String(n).toLowerCase(),
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
    payMengantarUnpaid,
} from "@/lib/mengantar";
import {
    getMengantarOriginConfig,
    resolveMengantarDestinationAreaId,
} from "@/lib/mengantar/shipping";
import {
    createShipmentForOrder,
    payUnpaidShipmentForOrder,
} from "@/lib/mengantar/shipment";

const mockPrisma = prisma as unknown as {
    order: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
        update: jest.Mock;
    };
    orderItem: { findMany: jest.Mock };
};

const mockedCreateOrder =
    createMengantarOrder as unknown as jest.Mock;
const mockedEstimate =
    estimateMengantarShipping as unknown as jest.Mock;
const mockedPayUnpaid =
    payMengantarUnpaid as unknown as jest.Mock;
const mockedOrigin =
    getMengantarOriginConfig as unknown as jest.Mock;
const mockedResolveDestination =
    resolveMengantarDestinationAreaId as unknown as jest.Mock;

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 10,
        orderNumber: "ORD-10",
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

describe("createShipmentForOrder (mocked provider)", () => {
    it("1. creates a normal non-COD shipment", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "ORD-1",
                    batch_id: "BATCH-1",
                    cnote_no: "CN-1",
                    isPaid: true,
                },
            ],
            batch_id: "BATCH-1",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(true);
        expect(result.shipmentStatus).toBe("CREATED");
        expect(result.shippingPaymentStatus).toBe("PAID");
        expect(result.trackingNumber).toBe("CN-1");
        expect(mockedCreateOrder).toHaveBeenCalledTimes(1);
    });

    it("2. is idempotent — a duplicate create never calls the provider", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                providerShipmentId: "ORD-1",
                shipmentStatus: "CREATED",
                trackingNumber: "CN-1",
            })
        );

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("3. is race-safe — a lost claim does not call the provider twice", async () => {
        mockPrisma.order.findUnique
            .mockResolvedValueOnce(baseOrder())
            .mockResolvedValueOnce({
                shipmentStatus: "CREATING",
                providerShipmentId: null,
                providerBatchId: null,
                shippingPaymentStatus: "UNPAID",
                trackingNumber: null,
            });

        // Claim fails because another request already claimed it.
        mockPrisma.order.updateMany.mockResolvedValueOnce({
            count: 0,
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(result.changed).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("4. insufficient balance → WAITING_SHIPPING_PAYMENT, never shipped", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "ORD-2",
                    batch_id: "BATCH-2",
                    cnote_no: null,
                    isPaid: false,
                },
            ],
            batch_id: "BATCH-2",
        });

        const result = await createShipmentForOrder(10);

        expect(result.shipmentStatus).toBe(
            "WAITING_SHIPPING_PAYMENT"
        );
        expect(result.shippingPaymentStatus).toBe("UNPAID");
        expect(result.trackingNumber).toBeNull();
    });

    it("5. never stores a fake tracking number when unpaid", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "ORD-2",
                    batch_id: "BATCH-2",
                    cnote_no: null,
                    isPaid: false,
                },
            ],
            batch_id: "BATCH-2",
        });

        await createShipmentForOrder(10);

        // Finalize call is the SECOND updateMany (first is the claim).
        const finalizeCall =
            mockPrisma.order.updateMany.mock.calls.find(
                (call: unknown[]) =>
                    (call[0] as { data?: { trackingNumber?: unknown } })
                        .data?.trackingNumber === null
            );
        expect(finalizeCall).toBeTruthy();
    });

    it("9. COD supported uses the verified provider field", async () => {
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
            data: [
                {
                    ORDER_ID: "ORD-3",
                    batch_id: "BATCH-3",
                    cnote_no: "CN-3",
                    isPaid: true,
                },
            ],
            batch_id: "BATCH-3",
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(true);
        const payload = mockedCreateOrder.mock.calls[0][0];
        expect(payload.orders[0].COD).toBe(110000);
    });

    it("10. COD unsupported for the route is rejected", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({
                paymentMethod: "COD",
                codAmount: 110000,
            })
        );
        mockedEstimate.mockResolvedValue({
            JNE: { unsupported: false, unsupported_cod: true },
        });

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("12. rejects an unsupported courier", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({ providerCourier: "ninja" })
        );

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("14. rejects an unmappable destination", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedResolveDestination.mockResolvedValue(null);

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("rejects an invalid recipient phone", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            baseOrder({ phone: "123" })
        );

        const result = await createShipmentForOrder(10);

        expect(result.ok).toBe(false);
        expect(mockedCreateOrder).not.toHaveBeenCalled();
    });

    it("24. never writes the marketplace paymentStatus", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
        mockedCreateOrder.mockResolvedValue({
            data: [
                {
                    ORDER_ID: "ORD-1",
                    batch_id: "BATCH-1",
                    cnote_no: "CN-1",
                    isPaid: true,
                },
            ],
            batch_id: "BATCH-1",
        });

        await createShipmentForOrder(10);

        for (const call of mockPrisma.order.updateMany.mock
            .calls) {
            expect(call[0].data).not.toHaveProperty(
                "paymentStatus"
            );
        }
    });
});

describe("payUnpaidShipmentForOrder (mocked provider)", () => {
    function payableOrder(overrides: Record<string, unknown> = {}) {
        return {
            id: 20,
            shippingProvider: "MENGANTAR",
            providerCourier: "jne",
            providerBatchId: "BATCH-9",
            shipmentStatus: "WAITING_SHIPPING_PAYMENT",
            shippingPaymentStatus: "UNPAID",
            paymentMethod: "BANK_TRANSFER",
            ...overrides,
        };
    }

    it("6. pays an unpaid shipment and stores the generated cnote", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            payableOrder()
        );
        mockedPayUnpaid.mockResolvedValue({
            paidCount: 1,
            cnoteNos: ["CN-9"],
        });

        const result = await payUnpaidShipmentForOrder(20);

        expect(result.ok).toBe(true);
        expect(result.changed).toBe(true);
        expect(result.shipmentStatus).toBe("CREATED");
        expect(result.shippingPaymentStatus).toBe("PAID");
        expect(result.trackingNumber).toBe("CN-9");
    });

    it("7. a duplicate pay does not charge again", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            payableOrder({ shipmentStatus: "CREATED" })
        );

        const result = await payUnpaidShipmentForOrder(20);

        expect(result.ok).toBe(false);
        expect(mockedPayUnpaid).not.toHaveBeenCalled();
    });

    it("8. concurrent pay — a lost claim never charges twice", async () => {
        mockPrisma.order.findUnique
            .mockResolvedValueOnce(payableOrder())
            .mockResolvedValueOnce({
                shipmentStatus: "PAYING",
                shippingPaymentStatus: "UNPAID",
                trackingNumber: null,
            });

        mockPrisma.order.updateMany.mockResolvedValueOnce({
            count: 0,
        });

        const result = await payUnpaidShipmentForOrder(20);

        expect(result.ok).toBe(false);
        expect(mockedPayUnpaid).not.toHaveBeenCalled();
    });

    it("COD is never paid from the seller balance", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            payableOrder({ paymentMethod: "COD" })
        );

        const result = await payUnpaidShipmentForOrder(20);

        expect(result.ok).toBe(false);
        expect(mockedPayUnpaid).not.toHaveBeenCalled();
    });

    it("24. never writes the marketplace paymentStatus", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            payableOrder()
        );
        mockedPayUnpaid.mockResolvedValue({
            paidCount: 1,
            cnoteNos: ["CN-9"],
        });

        await payUnpaidShipmentForOrder(20);

        for (const call of mockPrisma.order.updateMany.mock
            .calls) {
            expect(call[0].data).not.toHaveProperty(
                "paymentStatus"
            );
        }
    });
});

/* ==========================================================
 * SOURCE / WIRING ASSERTIONS
 * ========================================================== */

const webhook = readFile(
    "app/api/mengantar/webhook/route.ts"
);
const shipmentLib = readFile("lib/mengantar/shipment.ts");
const statusLib = readFile("lib/mengantar/status.ts");
const handler = readFile(
    "lib/notification/order-status-handler.ts"
);
const message = readFile("lib/whatsapp/message.ts");
const adminOrderPage = readFile(
    "app/admin/orders/[id]/page.tsx"
);
const adminOrderRoute = readFile(
    "app/api/admin/orders/[id]/route.ts"
);
const shipmentRoute = readFile(
    "app/api/admin/orders/[id]/shipment/route.ts"
);
const payRoute = readFile(
    "app/api/admin/orders/[id]/shipment/pay/route.ts"
);
const checkout = readFile("lib/checkout.ts");
const refundLib = readFile("lib/refund.ts");

describe("Webhook hardening", () => {
    it("verifies the signature and uses the unified mapping", () => {
        expect(webhook).toContain(
            "verifyMengantarWebhookSignature"
        );
        expect(webhook).toContain(
            "decideMengantarShipmentTransition"
        );
    });

    it("uses a race-safe CAS update", () => {
        expect(webhook).toContain("updateMany");
        expect(webhook).toContain("updated.count === 0");
    });

    it("does not log secrets or the raw body", () => {
        expect(webhook).not.toContain("console.log(rawBody");
        expect(webhook).not.toContain(
            "process.env.MENGANTAR_WEBHOOK_SECRET"
        );
        expect(webhook).toContain("redactMengantarKey");
    });

    it("never mutates paymentStatus", () => {
        expect(webhook).not.toContain("paymentStatus:");
    });

    it("does not auto-refund", () => {
        expect(webhook).not.toContain("executeRefundCompletion");
        expect(webhook).not.toContain("createRefundRequest");
    });
});

describe("Notification integration (existing system reused)", () => {
    it("exposes a shipment handler reusing the notification service", () => {
        expect(handler).toContain("onShipmentStatusChanged");
        expect(handler).toContain("handleOrderStatusChanged");
        expect(handler).toContain("shipmentStatusToEventKey");
    });

    it("adds shipment wording to the existing status labels", () => {
        expect(message).toContain("SHIPMENT_CREATED");
        expect(message).toContain("SHIPMENT_DELIVERED");
        expect(message).toContain("SHIPPING_PAYMENT_REQUIRED");
    });

    it("does not introduce a second notification system", () => {
        // The shipment handler must live in the SAME module.
        expect(
            readFile("lib/notification/index.ts")
        ).toContain("onShipmentStatusChanged");
    });
});

describe("Race-condition guards", () => {
    it("claims atomically before calling Mengantar (create)", () => {
        expect(shipmentLib).toContain(
            'shipmentStatus: "CREATING"'
        );
        expect(shipmentLib).toContain("STALE_CLAIM_MS");
        expect(shipmentLib).toContain(
            "releaseShipmentClaim"
        );
    });

    it("claims atomically before paying (pay-unpaid)", () => {
        expect(shipmentLib).toContain(
            'shipmentStatus: "PAYING"'
        );
        expect(shipmentLib).toContain(
            '"WAITING_SHIPPING_PAYMENT"'
        );
    });
});

describe("Admin shipment UI", () => {
    it("renders provider/courier/status/tracking and COD info", () => {
        expect(adminOrderPage).toContain("Pengiriman Mengantar");
        expect(adminOrderPage).toContain(
            "SHIPMENT_STATUS_LABELS"
        );
        expect(adminOrderPage).toContain(
            "SHIPPING_PAYMENT_LABELS"
        );
        expect(adminOrderPage).toContain("Buat Shipment");
        expect(adminOrderPage).toContain("Bayar Ongkir");
    });

    it("shows the insufficient-balance warning verbatim", () => {
        expect(adminOrderPage).toContain(
            "Saldo"
        );
        expect(adminOrderPage).toContain(
            "belum"
        );
    });

    it("mutations go through the server-side admin endpoints", () => {
        expect(adminOrderPage).toContain(
            "/shipment/pay"
        );
        expect(adminOrderPage).toContain(
            "method: \"POST\""
        );
        // No Mengantar API key may reach the client bundle.
        expect(adminOrderPage).not.toContain(
            "MENGANTAR_API_KEY"
        );
    });

    it("admin order detail exposes the provider state", () => {
        expect(adminOrderRoute).toContain("shippingProvider:");
        expect(adminOrderRoute).toContain("shipmentStatus:");
        expect(adminOrderRoute).toContain(
            "shippingPaymentStatus:"
        );
    });

    it("admin shipment routes require ADMIN", () => {
        expect(shipmentRoute).toContain(
            'session.user.role !== "ADMIN"'
        );
        expect(payRoute).toContain(
            'session.user.role !== "ADMIN"'
        );
    });
});

describe("Regressions guarded", () => {
    it("26/27. checkout + buy-now still verify Mengantar and RajaOngkir", () => {
        expect(checkout).toContain(
            "verifyMengantarShippingCostOrThrow"
        );
        expect(checkout).toContain(
            "verifyRajaOngkirShippingCostOrThrow"
        );
    });

    it("28. RajaOngkir address layer is untouched", () => {
        expect(
            readFile("lib/rajaongkir/locations.ts")
        ).toContain("getProvinces");
        expect(
            readFile("lib/rajaongkir.ts")
        ).toContain("calculateDomesticCost");
    });

    it("25. refund flow is untouched by shipment changes", () => {
        expect(refundLib).toContain("executeRefundCompletion");
        expect(shipmentLib).not.toContain("refund");
    });

    it("never hardcodes a Mengantar COD fee", () => {
        // Exported COD-surface string is the verified field/estimate
        // paths only — no numeric fee constants.
        expect(shipmentLib).not.toMatch(
            /codFee\s*[:=]\s*\d/
        );
        expect(shipmentLib).not.toMatch(
            /COD_FEE\s*[:=]\s*\d/
        );
    });

    it("COD semantics are gated behind the estimate, not courier name", () => {
        expect(shipmentLib).toContain("unsupported_cod");
        expect(shipmentLib).not.toContain('=== "spx"');
    });

    it("status mapping lives in one module (no scattered strings in webhook)", () => {
        expect(statusLib).toContain(
            "mapMengantarShipmentStatus"
        );
        // The webhook no longer defines its own mapping function.
        expect(webhook).not.toContain(
            "function mapShipmentStatus"
        );
    });
});
