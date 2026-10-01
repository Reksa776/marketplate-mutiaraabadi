/**
 * ==========================================
 * UPSTREAM TIMEOUT — ROUTE MAPPING
 * ==========================================
 *
 * Run: npx jest __tests__/security/upstream-routes.test.ts
 *
 * Pins the HTTP contract after the timeout-normalization fix:
 *   - an upstream TIMEOUT  → 504 + "sedang lambat"/"tidak merespons"
 *   - an upstream NETWORK  → 502 + same friendly message
 *   - an unknown failure   → 500 (unchanged)
 *   - the browser never receives a raw AbortError, a stack trace, or
 *     an API key
 *   - ADMIN-only stays enforced
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

jest.mock("@/lib/rajaongkir", () => ({
    rajaOngkirFetch: jest.fn(),
}));

jest.mock("@/lib/mengantar", () => ({
    isMengantarConfigured: jest.fn(() => true),
    listMengantarPickupAddresses: jest.fn(),
    listMengantarPickupTimes: jest.fn(),
    searchMengantarAreas: jest.fn(),
    redactMengantarKey: (value: unknown) =>
        String(value ?? ""),
}));

import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";
import {
    listMengantarPickupAddresses,
    isMengantarConfigured,
} from "@/lib/mengantar";
import { UpstreamError } from "@/lib/upstream-error";

import { GET as regionsGET } from "@/app/api/admin/settings/regions/route";
import { GET as mengantarGET } from "@/app/api/admin/settings/mengantar/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedRajaOngkir =
    rajaOngkirFetch as unknown as jest.Mock;
const mockedPickupAddresses =
    listMengantarPickupAddresses as unknown as jest.Mock;
const mockedConfigured =
    isMengantarConfigured as unknown as jest.Mock;

const API_KEY = "mengantar-key-must-not-leak";

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "a1", role: "ADMIN" },
    });
}

function regionsRequest(query: string): Request {
    return new Request(
        `http://test/api/admin/settings/regions?${query}`
    );
}

function lookupRequest(query: string): { url: string } {
    return {
        url: `http://test/api/admin/settings/mengantar?${query}`,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.MENGANTAR_API_KEY = API_KEY;
    mockedAuth.mockResolvedValue(null);
    mockedConfigured.mockReturnValue(true);
});

/* ==========================================
 * RAJAONGKIR REGIONS
 * ========================================== */

describe("GET /api/admin/settings/regions", () => {
    test("401 for a non-admin", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await regionsGET(
            regionsRequest("type=cities&id=5") as never
        )) as Response;

        expect(response.status).toBe(401);
    });

    test("200 with data on success", async () => {
        adminSession();
        mockedRajaOngkir.mockResolvedValue([
            { id: 5, name: "KOTA" },
        ]);

        const response = (await regionsGET(
            regionsRequest("type=cities&id=5") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toHaveLength(1);
        expect(mockedRajaOngkir).toHaveBeenCalledWith(
            "/destination/city/5"
        );
    });

    test("504 with a friendly message on upstream timeout", async () => {
        adminSession();
        mockedRajaOngkir.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_TIMEOUT",
                "Upstream request timed out."
            )
        );

        const response = (await regionsGET(
            regionsRequest("type=cities&id=5") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(504);
        expect(body.message).toContain(
            "Layanan wilayah sedang lambat"
        );
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toMatch(/abort/i);
        expect(serialized).not.toContain("stack");
    });

    test("502 with a friendly message on upstream network error", async () => {
        adminSession();
        mockedRajaOngkir.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_NETWORK_ERROR",
                "Upstream network error."
            )
        );

        const response = (await regionsGET(
            regionsRequest("type=cities&id=5") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.message).toContain(
            "Layanan wilayah sedang tidak merespons"
        );
    });

    test("500 for an unknown failure (unchanged)", async () => {
        adminSession();
        mockedRajaOngkir.mockRejectedValue(
            new Error("something else")
        );

        const response = (await regionsGET(
            regionsRequest("type=cities&id=5") as never
        )) as Response;

        expect(response.status).toBe(500);
    });

    test("400 for a non-numeric id (SSRF guard)", async () => {
        adminSession();

        const response = (await regionsGET(
            regionsRequest("type=cities&id=../../secret") as never
        )) as Response;

        expect(response.status).toBe(400);
        expect(mockedRajaOngkir).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * MENGANTAR LOOKUP
 * ========================================== */

describe("GET /api/admin/settings/mengantar", () => {
    test("401 for a non-admin", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;

        expect(response.status).toBe(401);
    });

    test("200 with the pickup list on success", async () => {
        adminSession();
        mockedPickupAddresses.mockResolvedValue([
            { _id: "p1", name: "Gudang" },
        ]);

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toHaveLength(1);
    });

    test("504 on upstream timeout with the Mengantar message", async () => {
        adminSession();
        mockedPickupAddresses.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_TIMEOUT",
                "Upstream request timed out."
            )
        );

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(504);
        expect(body.message).toBe(
            "Layanan Mengantar sedang tidak merespons. Silakan coba lagi."
        );
        expect(JSON.stringify(body)).not.toContain(API_KEY);
    });

    test("502 on upstream network error", async () => {
        adminSession();
        mockedPickupAddresses.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_NETWORK_ERROR",
                "Upstream network error."
            )
        );

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.message).toBe(
            "Layanan Mengantar sedang tidak merespons. Silakan coba lagi."
        );
    });

    test("configured:false returns 200 + empty without an upstream call", async () => {
        adminSession();
        mockedConfigured.mockReturnValue(false);

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.configured).toBe(false);
        expect(body.data).toEqual([]);
        expect(mockedPickupAddresses).not.toHaveBeenCalled();
    });

    test("never leaks the API key in any field", async () => {
        adminSession();
        mockedPickupAddresses.mockResolvedValue([
            { _id: "p1", name: "Gudang" },
        ]);

        const response = (await mengantarGET(
            lookupRequest("resource=pickup-addresses") as never
        )) as Response;

        expect(
            JSON.stringify(await response.json())
        ).not.toContain(API_KEY);
    });
});
