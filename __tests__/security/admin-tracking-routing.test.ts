/**
 * ==========================================
 * PROVIDER-AWARE TRACKING ROUTING
 * ==========================================
 *
 * Run: npx jest __tests__/security/admin-tracking-routing.test.ts
 *
 * Root cause under test (production order
 * PAY-BN-1790905123684-b78d73ca / id 963):
 *   MENGANTAR order, providerCourier "JT", resi JO0328436240 —
 *   the admin tracking route ignored `shippingProvider` and sent
 *   courier "jt" to RajaOngkir:
 *
 *     ADMIN RAJAONGKIR TRACKING REQUEST: awb: ... courier: jt
 *     ADMIN RAJAONGKIR ERROR: the valid courier is jne, jnt, ...
 *
 * Fix: `Order.shippingProvider` is the source of truth.
 *   - MENGANTAR → Mengantar `GET /order?tracking_id=` (via
 *     getMengantarOrderByTracking). RajaOngkir is NEVER called.
 *     No RajaOngkir fallback on Mengantar failure.
 *   - anything else / NULL → legacy RajaOngkir waybill tracking.
 *
 * No real provider HTTP call is made (Mengantar client + global
 * fetch are mocked). No production data is touched.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: { order: mockOrder },
}));

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

jest.mock("@/lib/mengantar", () => ({
    getMengantarOrderByTracking: jest.fn(),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getMengantarOrderByTracking } from "@/lib/mengantar";

import { GET as adminTrackingGET } from "@/app/api/admin/orders/[id]/tracking/route";
import { GET as customerTrackingGET } from "@/app/api/orders/[id]/tracking/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
};
const mockedMengantarTracking =
    getMengantarOrderByTracking as unknown as jest.Mock;

const RAJAONGKIR_API_KEY = "rajaongkir-key-DO-NOT-LEAK";
const MENGANTAR_API_KEY = "mengantar-key-DO-NOT-LEAK";

const fetchMock = jest.fn();

function readFile(relativePath: string): string {
    try {
        return readFileSync(
            resolve(process.cwd(), relativePath),
            "utf-8"
        );
    } catch {
        return "";
    }
}

/* ==========================================
 * FIXTURES
 * ========================================== */

/**
 * The exact production order shape that triggered the bug.
 */
const PRODUCTION_ORDER = {
    id: 963,
    orderNumber: "PAY-BN-1790905123684-b78d73ca",
    phone: "081234567890",
    shippingCourier: "JT",
    shippingService: "REG",
    trackingNumber: "JO0328436240",

    shippingProvider: "MENGANTAR",
    providerCourier: "JT",
    providerShipmentId: "2610025RMRQZ",
    providerBatchId: "6abf5b65715c4e7a1536017d",
    shipmentStatus: "CREATED",
    shippingPaymentStatus: "PAID",
    codAmount: null,
};

const RAJAONGKIR_ORDER = {
    id: 500,
    orderNumber: "PAY-RAJAONGKIR-1",
    phone: "081234567890",
    shippingCourier: "JNT",
    shippingService: "EZ",
    trackingNumber: "JP1234567890",

    shippingProvider: "RAJAONGKIR",
    providerCourier: null,
    providerShipmentId: null,
    providerBatchId: null,
    shipmentStatus: null,
    shippingPaymentStatus: null,
    codAmount: null,
};

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
}

function customerSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "user-1", role: "CUSTOMER" },
    });
}

function routeContext(id: string) {
    return {
        params: Promise.resolve({ id }),
    } as never;
}

function rajaOngkirOkResponse() {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            meta: { status: "success", code: 200 },
            data: {
                summary: {
                    status: "ON DELIVERY",
                    courier_code: "jnt",
                    courier_name: "J&T Express",
                    waybill_number: "JP1234567890",
                    service_code: "EZ",
                    origin: "Bandung",
                    destination: "Jakarta",
                    waybill_date: "2026-10-01",
                },
                manifest: [
                    {
                        manifest_code: "M01",
                        manifest_description:
                            "Paket dibawa kurir",
                        manifest_date: "2026-10-01",
                        manifest_time: "10:00",
                        city_name: "Bandung",
                        title: "",
                    },
                ],
                delivery_status: null,
                delivered: false,
            },
        }),
    };
}

function rajaOngkirErrorResponse() {
    return {
        ok: false,
        status: 400,
        json: async () => ({
            meta: {
                status: "error",
                message:
                    "the valid courier is jne, jnt, ninja, tiki, pos, anteraja, sap, lion, wahana, first, spx",
            },
        }),
    };
}

/** Last URL the tracked global fetch was called with. */
function lastFetchUrl(): URL | null {
    if (fetchMock.mock.calls.length === 0) return null;
    const arg = fetchMock.mock.calls[0][0];
    return new URL(String(arg));
}

beforeEach(() => {
    jest.clearAllMocks();

    process.env.RAJAONGKIR_API_KEY = RAJAONGKIR_API_KEY;
    process.env.MENGANTAR_API_KEY = MENGANTAR_API_KEY;

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(rajaOngkirOkResponse());
    (global as unknown as { fetch: jest.Mock }).fetch =
        fetchMock;

    mockedAuth.mockResolvedValue(null);
    mockedMengantarTracking.mockResolvedValue(null);
});

/* ==========================================
 * 1 + 7. MENGANTAR NEVER HITS RAJAONGKIR
 * ========================================== */

describe("MENGANTAR tracking routing", () => {
    test("1. MENGANTAR + courier JT never calls RajaOngkir", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            PRODUCTION_ORDER
        );

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const body = await response.json();

        // The bug: courier "jt" was POSTed to RajaOngkir.
        expect(fetchMock).not.toHaveBeenCalled();

        // Mengantar's own polling read API is used instead.
        expect(mockedMengantarTracking).toHaveBeenCalledWith(
            "JO0328436240"
        );

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.source).toBe("MENGANTAR");
        expect(body.data.shipment.providerCourier).toBe("JT");
        expect(body.data.shipment.providerShipmentId).toBe(
            "2610025RMRQZ"
        );
        expect(body.data.shipment.providerBatchId).toBe(
            "6abf5b65715c4e7a1536017d"
        );
    });

    test("7. the example production order produces no RajaOngkir request", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            PRODUCTION_ORDER
        );

        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});
        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        );

        // Neither the request nor the error log may appear.
        const logged = [
            ...logSpy.mock.calls,
            ...errorSpy.mock.calls,
        ]
            .map((call) => JSON.stringify(call))
            .join("\n");

        expect(logged).not.toContain(
            "ADMIN RAJAONGKIR TRACKING REQUEST"
        );
        expect(logged).not.toContain(
            "ADMIN RAJAONGKIR ERROR"
        );
        expect(logged).not.toContain("the valid courier is");
        expect(fetchMock).not.toHaveBeenCalled();

        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test("2. MENGANTAR uses the available provider data/status", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            PRODUCTION_ORDER
        );
        mockedMengantarTracking.mockResolvedValue({
            orderId: "2610025RMRQZ",
            status: "active",
            statusCategory: "PICKED UP",
            trackingNumber: "JO0328436240",
            history: [
                {
                    date: "2026-10-02 08:00",
                    desc: "Paket diterima di gudang",
                },
                {
                    date: "2026-10-02 10:00",
                    desc: "Paket dibawa kurir",
                },
            ],
        });

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const body = await response.json();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(body.data.source).toBe("MENGANTAR");
        expect(body.data.trackingAvailable).toBe(true);
        expect(body.data.shipment.shipmentStatus).toBe(
            "CREATED"
        );
        expect(body.data.shipment.shippingPaymentStatus).toBe(
            "PAID"
        );
        expect(body.data.manifest).toHaveLength(2);
        expect(
            body.data.manifest[1].manifest_description
        ).toBe("Paket dibawa kurir");
        expect(body.data.message).toBe(
            "Status tracking diperbarui melalui Mengantar."
        );
    });

    test("MENGANTAR without a resi still returns a clear state (no RajaOngkir)", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue({
            ...PRODUCTION_ORDER,
            trackingNumber: null,
        });

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const body = await response.json();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockedMengantarTracking).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(body.data.source).toBe("MENGANTAR");
        expect(body.data.message).toContain("Mengantar");
    });

    test("MENGANTAR provider failure never falls back to RajaOngkir", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            PRODUCTION_ORDER
        );
        mockedMengantarTracking.mockRejectedValue(
            new Error("mengantar upstream down")
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const body = await response.json();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.source).toBe("MENGANTAR");
        expect(body.data.shipment.shipmentStatus).toBe(
            "CREATED"
        );
        expect(body.data.message).toContain("Mengantar");

        errorSpy.mockRestore();
    });

    test("customer MENGANTAR tracking also avoids RajaOngkir", async () => {
        customerSession();
        mockedOrder.findFirst.mockResolvedValue(
            PRODUCTION_ORDER
        );

        const response = (await customerTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const body = await response.json();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockedMengantarTracking).toHaveBeenCalled();
        expect(body.data.source).toBe("MENGANTAR");
    });
});

/* ==========================================
 * 3 + 4 + 5. NON-MENGANTAR KEEPS RAJAONGKIR
 * ========================================== */

describe("non-MENGANTAR tracking routing", () => {
    test("3. RajaOngkir + JNT still uses RajaOngkir", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            RAJAONGKIR_ORDER
        );

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("500")
        )) as Response;
        const body = await response.json();

        expect(mockedMengantarTracking).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastFetchUrl()?.searchParams.get("courier")).toBe(
            "jnt"
        );
        expect(lastFetchUrl()?.searchParams.get("awb")).toBe(
            "JP1234567890"
        );
        expect(body.data.source).toBeUndefined();
        expect(body.data.manifest).toHaveLength(1);
    });

    test("4. RajaOngkir + JNE still uses RajaOngkir", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue({
            ...RAJAONGKIR_ORDER,
            shippingCourier: "JNE",
        });

        await adminTrackingGET(
            new Request("http://test"),
            routeContext("500")
        );

        expect(mockedMengantarTracking).not.toHaveBeenCalled();
        expect(lastFetchUrl()?.searchParams.get("courier")).toBe(
            "jne"
        );
    });

    test("5. an unknown/legacy provider fails safely on the RajaOngkir path", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue({
            ...RAJAONGKIR_ORDER,
            shippingProvider: "LEGACY",
        });

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("500")
        )) as Response;

        // Never routed to Mengantar, never crashes, existing
        // RajaOngkir behaviour preserved.
        expect(mockedMengantarTracking).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
    });

    test("NULL shippingProvider (legacy order) keeps RajaOngkir", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue({
            ...RAJAONGKIR_ORDER,
            shippingProvider: null,
        });

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("500")
        )) as Response;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
    });

    test("a RajaOngkir error is still surfaced for non-Mengantar orders", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            RAJAONGKIR_ORDER
        );
        fetchMock.mockResolvedValue(
            rajaOngkirErrorResponse()
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("500")
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);

        errorSpy.mockRestore();
    });
});

/* ==========================================
 * 6. NO SECRET LEAK TO THE CLIENT
 * ========================================== */

describe("credential safety", () => {
    test("6. the MENGANTAR tracking response never leaks a key", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            PRODUCTION_ORDER
        );
        mockedMengantarTracking.mockResolvedValue({
            orderId: "2610025RMRQZ",
            status: "active",
            statusCategory: "PICKED UP",
            trackingNumber: "JO0328436240",
            history: [],
        });

        const response = (await adminTrackingGET(
            new Request("http://test"),
            routeContext("963")
        )) as Response;
        const serialized = JSON.stringify(
            await response.json()
        );

        expect(serialized).not.toContain(
            RAJAONGKIR_API_KEY
        );
        expect(serialized).not.toContain(MENGANTAR_API_KEY);
        expect(serialized.toLowerCase()).not.toContain(
            "apikey"
        );
        expect(serialized.toLowerCase()).not.toContain(
            "webhooksecret"
        );
    });

    test("the tracking routes and admin page never reference provider secrets", () => {
        for (const file of [
            "app/api/admin/orders/[id]/tracking/route.ts",
            "app/api/orders/[id]/tracking/route.ts",
            "lib/mengantar/tracking.ts",
        ]) {
            const code = readFile(file);

            expect(code).not.toContain(
                "MENGANTAR_API_KEY"
            );
            expect(code).not.toContain(
                "MENGANTAR_WEBHOOK_SECRET"
            );
        }

        // The admin order detail is a Client Component: no keys.
        const page = readFile(
            "app/admin/orders/[id]/page.tsx"
        );

        expect(page).not.toContain("MENGANTAR_API_KEY");
        expect(page).not.toContain(
            "MENGANTAR_WEBHOOK_SECRET"
        );
        expect(page).not.toContain("RAJAONGKIR_API_KEY");
    });

    test("the Mengantar tracking helper is pure (no prisma / no RajaOngkir)", () => {
        const code = readFile("lib/mengantar/tracking.ts");

        expect(code).not.toContain("@/lib/prisma");
        expect(code).not.toContain("rajaongkir");
        expect(code).not.toContain("fetchWithRetry");
    });

    test("the admin page renders the Mengantar tracking message state", () => {
        const page = readFile(
            "app/admin/orders/[id]/page.tsx"
        );

        expect(page).toContain(
            "Status tracking diperbarui melalui Mengantar."
        );
        expect(page).toContain("source");
    });
});
