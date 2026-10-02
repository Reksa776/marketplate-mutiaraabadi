/**
 * ==========================================
 * MENGANTAR WEBHOOK — BEHAVIOUR TESTS
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-webhook.test.ts
 *
 * Exercises the REAL route handler with a MOCKED prisma + notification
 * pipeline. NO request ever reaches Mengantar.
 *
 * Proves:
 *   - fail-closed HMAC signature (401 on missing/invalid)
 *   - PICKED UP → PICKED_UP + resi auto-persisted
 *   - duplicate webhook → one notification (no second CAS write)
 *   - out-of-order / backwards → never rolls back a newer status
 *   - DELIVERED / RETURNED / CANCELLED mapping
 *   - unknown shipment → 200, zero DB writes
 *   - ORDER_ID authoritative; stale resi never retargets another order
 *   - existing trackingNumber / provider ids are NEVER overwritten
 *   - paymentStatus is never touched
 *   - courier is stored in the internal code space
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findFirst: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn().mockResolvedValue(undefined),
}));

import crypto from "crypto";
import { NextRequest } from "next/server";

const WEBHOOK_SECRET = "testsecret";

type RouteModule = typeof import("@/app/api/mengantar/webhook/route");

let route: RouteModule;
let prisma: {
    order: {
        findFirst: jest.Mock;
        updateMany: jest.Mock;
    };
};
let onShipmentStatusChanged: jest.Mock;

beforeAll(async () => {
    // The route + lib/mengantar capture the secret at module load, so
    // it must be set before the fresh import.
    process.env.MENGANTAR_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.MENGANTAR_API_KEY = "TEST_API_KEY";
    process.env.MENGANTAR_BASE_URL = "https://api.example.test";

    jest.resetModules();

    route = await import(
        "@/app/api/mengantar/webhook/route"
    );

    prisma = (require("@/lib/prisma") as { prisma: typeof prisma })
        .prisma;

    onShipmentStatusChanged = (
        require("@/lib/notification/order-status-handler") as {
            onShipmentStatusChanged: jest.Mock;
        }
    ).onShipmentStatusChanged;
});

beforeEach(() => {
    jest.clearAllMocks();
    onShipmentStatusChanged.mockResolvedValue(undefined);
    // Default: CAS applies.
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
});

function sign(rawBody: string): Record<string, string> {
    const timestamp = "1787548800000";
    const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");

    return {
        "content-type": "application/json",
        "x-timestamp": timestamp,
        "x-signature": signature,
    };
}

function send(
    payload: Record<string, unknown>,
    headerOverride?: Record<string, string>
): Promise<Response> {
    const rawBody = JSON.stringify(payload);
    const headers = headerOverride ?? sign(rawBody);

    const request = new NextRequest(
        "https://shop.example.com/api/mengantar/webhook",
        { method: "POST", headers, body: rawBody }
    );

    return route.POST(request);
}

function orderRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 10,
        orderNumber: "ORD-10",
        shipmentStatus: "CREATED",
        trackingNumber: null,
        shippingCourier: null,
        providerShipmentId: "ORDER-1",
        providerBatchId: "BATCH-1",
        ...overrides,
    };
}

describe("signature verification (fail-closed)", () => {
    it("rejects a missing signature with 401 and does nothing", async () => {
        const res = await send(
            { order_id: "ORDER-1", status_category: "PICKED UP" },
            { "content-type": "application/json" }
        );

        expect(res.status).toBe(401);
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a tampered/invalid signature with 401", async () => {
        const res = await send(
            { order_id: "ORDER-1", status_category: "PICKED UP" },
            {
                "content-type": "application/json",
                "x-timestamp": "1787548800000",
                "x-signature": "deadbeef",
            }
        );

        expect(res.status).toBe(401);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a valid signature over a DIFFERENT body (replay)", async () => {
        const rawBody = JSON.stringify({
            order_id: "ORDER-1",
            status_category: "DELIVERED",
        });
        const headers = sign(rawBody);

        const request = new NextRequest(
            "https://shop.example.com/api/mengantar/webhook",
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    order_id: "ORDER-1",
                    status_category: "PICKED UP",
                }),
            }
        );

        const res = await route.POST(request);
        expect(res.status).toBe(401);
    });

    it("returns 400 for a valid signature but malformed JSON body", async () => {
        const rawBody = "{not json";
        const headers = sign(rawBody);

        const request = new NextRequest(
            "https://shop.example.com/api/mengantar/webhook",
            { method: "POST", headers, body: rawBody }
        );

        const res = await route.POST(request);
        expect(res.status).toBe(400);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
});

describe("PICKED UP — status + automatic resi", () => {
    it("moves CREATED → PICKED_UP and persists cnote_no as trackingNumber", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "CREATED" })
        );

        const res = await send({
            order_id: "ORDER-1",
            cnote_no: "CN-777",
            courier: "JNE",
            status_category: "PICKED UP",
        });

        expect(res.status).toBe(200);

        expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
        const call = prisma.order.updateMany.mock.calls[0][0];

        expect(call.where).toEqual(
            expect.objectContaining({
                id: 10,
                shipmentStatus: "CREATED",
            })
        );
        expect(call.data.shipmentStatus).toBe("PICKED_UP");
        expect(call.data.trackingNumber).toBe("CN-777");

        // One WhatsApp notification for the transition.
        expect(onShipmentStatusChanged).toHaveBeenCalledTimes(1);
        expect(onShipmentStatusChanged).toHaveBeenCalledWith(
            10,
            "CREATED",
            "PICKED_UP"
        );
    });

    it("stores the courier in the internal code space", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shippingCourier: null })
        );

        await send({
            order_id: "ORDER-1",
            cnote_no: "CN-1",
            courier: "JT",
            status_category: "PICKED UP",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        expect(data.shippingCourier).toBe("jnt");
    });

    it("never clears an existing resi when the webhook omits cnote_no", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                shipmentStatus: "CREATED",
                trackingNumber: "OLD-CN",
            })
        );

        await send({
            order_id: "ORDER-1",
            status_category: "PICKED UP",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        expect(data.shipmentStatus).toBe("PICKED_UP");
        expect(data).not.toHaveProperty("trackingNumber");
    });

    it("never overwrites an existing resi with a different cnote_no", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                shipmentStatus: "CREATED",
                trackingNumber: "OLD-CN",
            })
        );

        await send({
            order_id: "ORDER-1",
            cnote_no: "NEW-CN",
            status_category: "PICKED UP",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        expect(data).not.toHaveProperty("trackingNumber");
    });

    it("keeps providerShipmentId and never replaces it", async () => {
        await send({
            order_id: "ORDER-1",
            cnote_no: "CN-1",
            status_category: "PICKED UP",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        expect(data).not.toHaveProperty("providerShipmentId");
    });
});

describe("idempotency + out-of-order safety", () => {
    it("acknowledges a duplicate PICKED UP without a second write/notification", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({
                shipmentStatus: "PICKED_UP",
                trackingNumber: "CN-777",
            })
        );

        const res = await send({
            order_id: "ORDER-1",
            cnote_no: "CN-777",
            status_category: "PICKED UP",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(onShipmentStatusChanged).not.toHaveBeenCalled();
    });

    it("never rolls back IN_TRANSIT to PICKED_UP (out-of-order)", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "IN_TRANSIT" })
        );

        const res = await send({
            order_id: "ORDER-1",
            status_category: "PICKED UP",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(onShipmentStatusChanged).not.toHaveBeenCalled();
    });

    it("never rolls back DELIVERED (terminal)", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "DELIVERED" })
        );

        const res = await send({
            order_id: "ORDER-1",
            status_category: "PENDING PICKUP",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("loses the CAS race without a second notification", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "CREATED" })
        );
        prisma.order.updateMany.mockResolvedValue({ count: 0 });

        const res = await send({
            order_id: "ORDER-1",
            status_category: "PICKED UP",
        });

        expect(res.status).toBe(200);
        expect(onShipmentStatusChanged).not.toHaveBeenCalled();
    });
});

describe("later statuses", () => {
    it("applies DELIVERED and notifies", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "IN_TRANSIT" })
        );

        await send({
            order_id: "ORDER-1",
            cnote_no: "CN-1",
            status_category: "DELIVERED",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        expect(data.shipmentStatus).toBe("DELIVERED");
        expect(onShipmentStatusChanged).toHaveBeenCalledWith(
            10,
            "IN_TRANSIT",
            "DELIVERED"
        );
    });

    it("maps RTS → RETURNED", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "UNDELIVERED" })
        );

        await send({
            order_id: "ORDER-1",
            status_category: "RTS",
        });

        expect(
            prisma.order.updateMany.mock.calls[0][0].data
                .shipmentStatus
        ).toBe("RETURNED");
    });

    it("maps CANCELED → CANCELLED before pickup", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "CREATED" })
        );

        await send({
            order_id: "ORDER-1",
            status_category: "CANCELED",
        });

        expect(
            prisma.order.updateMany.mock.calls[0][0].data
                .shipmentStatus
        ).toBe("CANCELLED");
    });

    it("ignores an unknown provider status without touching state", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ shipmentStatus: "CREATED" })
        );

        const res = await send({
            order_id: "ORDER-1",
            status_category: "SOMETHING NEW",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
});

describe("order lookup — authoritative ORDER_ID + collision guard", () => {
    it("finds by providerShipmentId (ORDER_ID) first", async () => {
        prisma.order.findFirst.mockResolvedValue(orderRow());

        await send({
            order_id: "ORDER-1",
            status_category: "PICKED UP",
        });

        expect(prisma.order.findFirst).toHaveBeenCalledTimes(1);
        expect(
            prisma.order.findFirst.mock.calls[0][0].where
                .providerShipmentId
        ).toBe("ORDER-1");
    });

    it("falls back to resi when ORDER_ID matches nothing", async () => {
        prisma.order.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                orderRow({
                    providerShipmentId: null,
                    trackingNumber: "CN-1",
                })
            );

        await send({
            order_id: "ORDER-MISSING",
            cnote_no: "CN-1",
            status_category: "PICKED UP",
        });

        const data =
            prisma.order.updateMany.mock.calls[0][0].data;
        // The provider ORDER_ID is backfilled (it was missing locally).
        expect(data.providerShipmentId).toBe("ORDER-MISSING");
    });

    it("ignores a stale resi that disagrees with the ORDER_ID (no retarget)", async () => {
        prisma.order.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                orderRow({
                    providerShipmentId: "OTHER-ORDER",
                    trackingNumber: "CN-1",
                })
            );

        const res = await send({
            order_id: "ORDER-MISSING",
            cnote_no: "CN-1",
            status_category: "DELIVERED",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(onShipmentStatusChanged).not.toHaveBeenCalled();
    });

    it("acknowledges a completely unknown shipment with zero writes", async () => {
        prisma.order.findFirst.mockResolvedValue(null);

        const res = await send({
            order_id: "GHOST",
            cnote_no: "GHOST-CN",
            status_category: "DELIVERED",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(onShipmentStatusChanged).not.toHaveBeenCalled();
    });

    it("ignores a payload with no identifiers at all", async () => {
        const res = await send({
            status_category: "DELIVERED",
        });

        expect(res.status).toBe(200);
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("backfills batch_id when the provider supplies it and none is stored", async () => {
        prisma.order.findFirst.mockResolvedValue(
            orderRow({ providerBatchId: null })
        );

        await send({
            order_id: "ORDER-1",
            batch_id: "BATCH-9",
            status_category: "PICKED UP",
        });

        expect(
            prisma.order.updateMany.mock.calls[0][0].data
                .providerBatchId
        ).toBe("BATCH-9");
    });
});

describe("payment separation", () => {
    it("never writes paymentStatus from a shipment webhook", async () => {
        prisma.order.findFirst.mockResolvedValue(orderRow());

        await send({
            order_id: "ORDER-1",
            status_category: "DELIVERED",
        });

        for (const call of prisma.order.updateMany.mock.calls) {
            expect(call[0].data).not.toHaveProperty(
                "paymentStatus"
            );
            expect(call[0].data).not.toHaveProperty("status");
        }
    });
});
