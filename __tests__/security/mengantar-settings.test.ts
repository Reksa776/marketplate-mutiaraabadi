/**
 * ==========================================
 * MENGANTAR PICKUP SETTINGS — ADMIN CONFIG
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-settings.test.ts
 *
 * Covers:
 *  - GET /api/admin/settings never leaks MENGANTAR_API_KEY /
 *    MENGANTAR_WEBHOOK_SECRET
 *  - PUT /api/admin/settings is ADMIN-only + validates the pickup ids
 *  - Pure validation: origin/pickup required, time optional, dropOff
 *    clears the time, scheduled requires a time, invalid ids rejected
 *  - Successful save persists all 3 fields + writes an audit log
 *  - /api/mengantar/estimate no longer 503s once pickup is configured
 *  - RajaOngkir address flow, paymentStatus and the shipment state
 *    machine remain untouched
 *
 * No real shipment is ever created and no Mengantar HTTP call is made.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
    userAddress: {
        findFirst: jest.fn(),
    },
    adminAuditLog: {
        create: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

jest.mock("@/lib/rajaongkir", () => ({
    rajaOngkirFetch: jest.fn(),
}));

jest.mock("next/cache", () => ({
    revalidatePath: jest.fn(),
}));

jest.mock("@/lib/mengantar", () => ({
    isMengantarConfigured: jest.fn(() => true),
    listMengantarPickupAddresses: jest.fn(),
    listMengantarPickupTimes: jest.fn(),
    searchMengantarAreas: jest.fn(),
    redactMengantarKey: (value: unknown) =>
        String(value ?? ""),
}));

jest.mock("@/lib/mengantar/shipping", () => ({
    getMengantarOriginConfig: jest.fn(),
    buildMengantarShippingOptions: jest.fn(),
    resolveMengantarDestinationAreaId: jest.fn(),
    verifyMengantarShippingCost: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
    rateLimiters: {
        shippingCost: jest.fn(() => ({
            allowed: true,
            retryAfterMs: 0,
        })),
    },
    getClientIp: jest.fn(() => "127.0.0.1"),
}));

import { auth } from "@/auth";
import {
    isMengantarConfigured,
    listMengantarPickupAddresses,
    listMengantarPickupTimes,
} from "@/lib/mengantar";
import { getMengantarOriginConfig } from "@/lib/mengantar/shipping";

import {
    isValidMengantarId,
    resolveMengantarSettingsInput,
    buildMengantarSettingsView,
} from "@/lib/mengantar/settings";

import { GET, PUT } from "@/app/api/admin/settings/route";
import { GET as mengantarLookupGET } from "@/app/api/admin/settings/mengantar/route";
import { POST as estimatePOST } from "@/app/api/mengantar/estimate/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedIsConfigured =
    isMengantarConfigured as unknown as jest.Mock;
const mockedPickupAddresses =
    listMengantarPickupAddresses as unknown as jest.Mock;
const mockedPickupTimes =
    listMengantarPickupTimes as unknown as jest.Mock;
const mockedOriginConfig =
    getMengantarOriginConfig as unknown as jest.Mock;

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

// Values that MUST never appear in an API response / log.
const API_KEY = "mengantar-live-key-DO-NOT-LEAK";
const WEBHOOK_SECRET =
    "mengantar-webhook-secret-DO-NOT-LEAK";

// Verified-style Mengantar ids (24 hex).
const ORIGIN = "5fc62f46f8f44b34aa4c0bb6";
const PICKUP = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TIME = "bbbbbbbbbbbbbbbbbbbbbbbb";
const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";

function storeSettingRow(
    overrides: Record<string, unknown> = {}
) {
    return {
        storeName: "Mutiara Abadi",
        phone: null,
        email: null,
        logo: null,
        faviconUrl: null,
        address: "X8CR+72Q, Jl. Desa Rw.",
        tiktokPixelEnabled: true,
        tiktokPixelId: PIXEL_ID,
        tiktokPixelName: "Web",
        tiktokPixelCode: `ttq.load("${PIXEL_ID}"); ttq.page();`,
        tiktokPixelAccessToken: null,
        provinceId: null,
        province: "JAWA BARAT",
        cityId: null,
        city: "MAJALENGKA",
        districtId: null,
        district: "CINGAMBUL",
        subdistrictId: null,
        subdistrict: "NAGARAKEMBANG",
        postalCode: "45467",
        rajaOngkirDestinationId: 17005,
        mengantarOriginAreaId: null,
        mengantarPickupAddressId: null,
        mengantarPickupTimeId: null,
        latitude: null,
        longitude: null,
        ...overrides,
    };
}

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
}

function putRequest(body: Record<string, unknown>): Request {
    return new Request("http://test/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

function basePutBody(
    overrides: Record<string, unknown> = {}
) {
    return {
        storeName: "Mutiara Abadi",
        address: "X8CR+72Q, Jl. Desa Rw.",
        tiktokPixelEnabled: true,
        tiktokPixelId: PIXEL_ID,
        tiktokPixelCode: `ttq.load("${PIXEL_ID}"); ttq.page();`,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    process.env.MENGANTAR_API_KEY = API_KEY;
    process.env.MENGANTAR_WEBHOOK_SECRET = WEBHOOK_SECRET;

    mockedAuth.mockResolvedValue(null);
    mockedIsConfigured.mockReturnValue(true);
    mockedPickupAddresses.mockResolvedValue([]);
    mockedPickupTimes.mockResolvedValue([]);
});

/* ==========================================
 * 1 + 2. GET DOES NOT LEAK SECRETS
 * ========================================== */

describe("GET /api/admin/settings — secret safety", () => {
    test("never leaks MENGANTAR_API_KEY or MENGANTAR_WEBHOOK_SECRET", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );

        const response = (await GET()) as Response;
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain(WEBHOOK_SECRET);
        expect(serialized.toLowerCase()).not.toContain(
            "apikey"
        );
        expect(serialized.toLowerCase()).not.toContain(
            "webhooksecret"
        );
        // Only the safe status flags + ids are exposed.
        expect(body.data.mengantarApiConfigured).toBe(true);
        expect(body.data.mengantarPickupConfigured).toBe(
            false
        );
        expect(body.data.mengantarOriginAreaId).toBeNull();
    });

    test("is 401 for an unauthenticated request", async () => {
        mockedAuth.mockResolvedValue(null);

        const response = (await GET()) as Response;
        expect(response.status).toBe(401);
    });

    test("buildMengantarSettingsView has no credential surface", () => {
        const view = buildMengantarSettingsView({
            apiConfigured: true,
            originAreaId: ORIGIN,
            pickupAddressId: PICKUP,
            pickupTimeId: TIME,
        });

        expect(Object.keys(view).sort()).toEqual(
            [
                "mengantarApiConfigured",
                "mengantarOriginAreaId",
                "mengantarPickupAddressId",
                "mengantarPickupConfigured",
                "mengantarPickupTimeId",
            ].sort()
        );
    });

    test("the settings routes never reference the secret env vars", () => {
        for (const file of [
            "app/api/admin/settings/route.ts",
            "app/api/admin/settings/mengantar/route.ts",
        ]) {
            const code = readFile(file);

            expect(code).not.toContain("MENGANTAR_API_KEY");
            expect(code).not.toContain(
                "MENGANTAR_WEBHOOK_SECRET"
            );
        }
    });
});

/* ==========================================
 * 3. PUT IS ADMIN ONLY
 * ========================================== */

describe("PUT /api/admin/settings — authorization", () => {
    test("401 when unauthenticated", async () => {
        mockedAuth.mockResolvedValue(null);

        const response = (await PUT(
            putRequest(basePutBody())
        )) as Response;

        expect(response.status).toBe(401);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("401 for a non-admin session", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await PUT(
            putRequest(basePutBody())
        )) as Response;

        expect(response.status).toBe(401);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 4 - 11. PURE VALIDATION
 * ========================================== */

describe("resolveMengantarSettingsInput", () => {
    test("4. origin area is required when pickup is provided", () => {
        const result = resolveMengantarSettingsInput({
            mengantarPickupAddressId: PICKUP,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarOriginAreaId"
            );
            expect(result.message).toMatch(/Origin area/);
        }
    });

    test("5. pickup address is required when origin is provided", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarPickupAddressId"
            );
        }
    });

    test("6. pickup time is optional (dropOff default)", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: PICKUP,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.originAreaId).toBe(ORIGIN);
            expect(result.value.pickupAddressId).toBe(PICKUP);
            expect(result.value.pickupTimeId).toBeNull();
            expect(result.value.mode).toBe("dropoff");
        }
    });

    test("7. dropOff forces pickupTimeId to NULL", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: PICKUP,
            mengantarPickupTimeId: TIME,
            mengantarPickupMode: "dropoff",
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.pickupTimeId).toBeNull();
        }
    });

    test("8. scheduled pickup requires a pickup time", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: PICKUP,
            mengantarPickupMode: "scheduled",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarPickupTimeId"
            );
        }
    });

    test("9. invalid origin is rejected", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: "not a valid id!",
            mengantarPickupAddressId: PICKUP,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarOriginAreaId"
            );
        }
    });

    test("10. invalid pickup address is rejected", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: "x",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarPickupAddressId"
            );
        }
    });

    test("11. invalid pickup time is rejected", () => {
        const result = resolveMengantarSettingsInput({
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: PICKUP,
            mengantarPickupTimeId: "bad time!!",
            mengantarPickupMode: "scheduled",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.field).toBe(
                "mengantarPickupTimeId"
            );
        }
    });

    test("an all-empty submission clears the config (valid)", () => {
        const result = resolveMengantarSettingsInput({});

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({
                originAreaId: null,
                pickupAddressId: null,
                pickupTimeId: null,
                mode: "dropoff",
            });
        }
    });

    test("isValidMengantarId accepts the verified origin id", () => {
        expect(isValidMengantarId(ORIGIN)).toBe(true);
        expect(isValidMengantarId("")).toBe(false);
        expect(isValidMengantarId(null)).toBe(false);
        expect(isValidMengantarId("has space")).toBe(false);
    });
});

/* ==========================================
 * ROUTE-LEVEL VALIDATION (wiring)
 * ========================================== */

describe("PUT /api/admin/settings — Mengantar validation", () => {
    test("4r. rejects a partial config (origin required)", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarPickupAddressId: PICKUP,
                })
            )
        )) as Response;

        expect(response.status).toBe(400);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("10r. rejects a malformed pickup id", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: "bad id!",
                })
            )
        )) as Response;

        expect(response.status).toBe(400);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 12. SUCCESSFUL SAVE PERSISTS ALL 3 FIELDS
 * ========================================== */

describe("PUT /api/admin/settings — save", () => {
    test("persists origin + pickup + time and audits without secrets", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
                mengantarPickupTimeId: TIME,
            })
        );

        // Live verification: the pickup + time must be on the account.
        mockedPickupAddresses.mockResolvedValue([
            { _id: PICKUP },
        ]);
        mockedPickupTimes.mockResolvedValue([{ _id: TIME }]);

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: PICKUP,
                    mengantarPickupTimeId: TIME,
                    mengantarPickupMode: "scheduled",
                })
            )
        )) as Response;

        expect(response.status).toBe(200);

        const upsertArg =
            mockPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(upsertArg.update.mengantarOriginAreaId).toBe(
            ORIGIN
        );
        expect(
            upsertArg.update.mengantarPickupAddressId
        ).toBe(PICKUP);
        expect(upsertArg.update.mengantarPickupTimeId).toBe(
            TIME
        );

        const auditCall =
            mockPrisma.adminAuditLog.create.mock.calls.find(
                (call: unknown[]) =>
                    (
                        call[0] as {
                            data?: { action?: string };
                        }
                    ).data?.action ===
                    "MENGANTAR_SETTINGS_UPDATED"
            );

        expect(auditCall).toBeTruthy();

        const auditData = (
            auditCall as unknown[]
        )[0] as { data: { metadata: unknown } };

        const serialized = JSON.stringify(auditData.data);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain(WEBHOOK_SECRET);
    });

    test("dropOff persists pickupTimeId as NULL", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
            })
        );
        mockedPickupAddresses.mockResolvedValue([
            { _id: PICKUP },
        ]);

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: PICKUP,
                    mengantarPickupTimeId: TIME,
                    mengantarPickupMode: "dropoff",
                })
            )
        )) as Response;

        expect(response.status).toBe(200);

        const upsertArg =
            mockPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(upsertArg.update.mengantarPickupTimeId).toBeNull();
    });

    test("live verification rejects an unknown pickup id (400)", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );
        mockedPickupAddresses.mockResolvedValue([
            { _id: "cccccccccccccccccccccccc" },
        ]);

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: PICKUP,
                })
            )
        )) as Response;

        expect(response.status).toBe(400);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("an upstream verification failure is fail-closed (502)", async () => {
        adminSession();
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );
        mockedPickupAddresses.mockRejectedValue(
            new Error("mengantar down")
        );

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: PICKUP,
                })
            )
        )) as Response;

        expect(response.status).toBe(502);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("skips live verification when Mengantar is not configured", async () => {
        adminSession();
        mockedIsConfigured.mockReturnValue(false);
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
            })
        );

        const response = (await PUT(
            putRequest(
                basePutBody({
                    mengantarOriginAreaId: ORIGIN,
                    mengantarPickupAddressId: PICKUP,
                })
            )
        )) as Response;

        expect(response.status).toBe(200);
        expect(mockedPickupAddresses).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * ADMIN LOOKUP ROUTE
 * ========================================== */

describe("GET /api/admin/settings/mengantar", () => {
    function lookupRequest(query: string): {
        url: string;
    } {
        return {
            url: `http://test/api/admin/settings/mengantar?${query}`,
        };
    }

    test("is 401 for a non-admin", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await mengantarLookupGET(
            lookupRequest(
                "resource=pickup-addresses"
            ) as never
        )) as Response;

        expect(response.status).toBe(401);
    });

    test("reports configured:false (200, empty) without a key", async () => {
        adminSession();
        mockedIsConfigured.mockReturnValue(false);

        const response = (await mengantarLookupGET(
            lookupRequest(
                "resource=pickup-addresses"
            ) as never
        )) as Response;

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.configured).toBe(false);
        expect(body.data).toEqual([]);
    });

    test("returns normalized pickup addresses", async () => {
        adminSession();
        mockedPickupAddresses.mockResolvedValue([
            {
                _id: PICKUP,
                name: "Gudang",
                address: "Jl. Desa Rw.",
                pic: "Budi",
                picPhone: "0812",
                areaId: ORIGIN,
            },
        ]);

        const response = (await mengantarLookupGET(
            lookupRequest(
                "resource=pickup-addresses"
            ) as never
        )) as Response;

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.configured).toBe(true);
        expect(body.data[0]._id).toBe(PICKUP);
    });

    test("never leaks secrets in the lookup response", async () => {
        adminSession();
        mockedPickupAddresses.mockResolvedValue([
            { _id: PICKUP },
        ]);

        const response = (await mengantarLookupGET(
            lookupRequest(
                "resource=pickup-addresses"
            ) as never
        )) as Response;

        const serialized = JSON.stringify(
            await response.json()
        );

        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain(WEBHOOK_SECRET);
    });
});

/* ==========================================
 * 13. ESTIMATE NO LONGER 503s ONCE CONFIGURED
 * ========================================== */

describe("POST /api/mengantar/estimate", () => {
    function estimateRequest(): Request {
        return new Request(
            "http://test/api/mengantar/estimate",
            {
                method: "POST",
                body: JSON.stringify({
                    addressId: "addr-1",
                    weight: 1000,
                }),
            }
        );
    }

    test("returns options once origin + pickup are configured", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });
        mockedIsConfigured.mockReturnValue(true);
        mockPrisma.userAddress.findFirst.mockResolvedValue({
            id: "addr-1",
            userId: "u1",
            postalCode: "45467",
        });
        mockedOriginConfig.mockResolvedValue({
            originAreaId: ORIGIN,
            pickupAddressId: PICKUP,
            pickupTimeId: null,
        });

        const { buildMengantarShippingOptions } =
            require("@/lib/mengantar/shipping") as {
                buildMengantarShippingOptions: jest.Mock;
            };
        buildMengantarShippingOptions.mockResolvedValue([
            {
                provider: "MENGANTAR",
                courier: "JNE",
                cost: 15000,
            },
        ]);

        const response = (await estimatePOST(
            estimateRequest()
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toHaveLength(1);
    });

    test("still 503s when the pickup config is missing", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });
        mockedIsConfigured.mockReturnValue(true);
        mockPrisma.userAddress.findFirst.mockResolvedValue({
            id: "addr-1",
            userId: "u1",
        });
        mockedOriginConfig.mockResolvedValue(null);

        const response = (await estimatePOST(
            estimateRequest()
        )) as Response;
        const body = await response.json();

        expect(response.status).toBe(503);
        expect(body.message).toContain(
            "Konfigurasi pickup Mengantar"
        );
    });
});

/* ==========================================
 * 14. RAJAONGKIR ADDRESS FLOW UNTOUCHED
 * ========================================== */

describe("RajaOngkir regression", () => {
    test("the settings route still resolves the RajaOngkir destination", () => {
        const code = readFile(
            "app/api/admin/settings/route.ts"
        );

        expect(code).toContain("rajaOngkirFetch");
        expect(code).toContain(
            "resolveRajaOngkirDestination"
        );
        expect(code).toContain("rajaOngkirDestinationId");
    });

    test("Mengantar modules never import RajaOngkir", () => {
        for (const file of [
            "lib/mengantar.ts",
            "lib/mengantar/shipping.ts",
            "lib/mengantar/shipment.ts",
            "lib/mengantar/settings.ts",
            "app/api/admin/settings/mengantar/route.ts",
        ]) {
            expect(readFile(file)).not.toContain(
                "rajaongkir"
            );
        }
    });

    test("the RajaOngkir address provider still exists", () => {
        expect(
            readFile("lib/rajaongkir.ts").length
        ).toBeGreaterThan(0);
        expect(
            readFile("lib/rajaongkir/locations.ts").length
        ).toBeGreaterThan(0);
    });
});

/* ==========================================
 * 15. paymentStatus UNCHANGED
 * ========================================== */

describe("paymentStatus separation", () => {
    test("the settings + lookup routes never touch paymentStatus", () => {
        for (const file of [
            "app/api/admin/settings/route.ts",
            "app/api/admin/settings/mengantar/route.ts",
        ]) {
            expect(readFile(file)).not.toContain(
                "paymentStatus"
            );
        }
    });

    test("the shipment lifecycle still never writes paymentStatus", () => {
        const code = readFile("lib/mengantar/shipment.ts");

        // It only ever WRITES shippingPaymentStatus (a distinct
        // field); paymentStatus is read, never written.
        expect(code).toContain("shippingPaymentStatus");
        expect(code).toContain(
            "NEVER touch Order.paymentStatus"
        );
        expect(code).not.toContain(
            "data: {\n            paymentStatus"
        );
    });
});

/* ==========================================
 * 16. SHIPMENT STATE MACHINE UNCHANGED
 * ========================================== */

describe("shipment state machine regression", () => {
    test("the atomic claim guards are still present", () => {
        const code = readFile("lib/mengantar/shipment.ts");

        expect(code).toContain('"CREATING"');
        expect(code).toContain('"PAYING"');
        expect(code).toContain(
            "WAITING_SHIPPING_PAYMENT"
        );
        expect(code).toContain("STALE_CLAIM_MS");
    });

    test("dropOff uses address_id only; scheduled adds time_id", () => {
        const code = readFile("lib/mengantar/shipment.ts");

        expect(code).toContain('type: "dropOff"');
        expect(code).toContain('type: "scheduledPickup"');
        // The pickup payload is now built from the resolved schedule
        // (auto-shipping: a fresh slot per shipment).
        expect(code).toContain("resolveMengantarPickupSchedule");
        expect(code).toContain("time_id: schedule.time_id");
        expect(code).toContain("address_id: schedule.address_id");
    });

    test("the status module still maps + guards transitions", () => {
        const {
            mapMengantarShipmentStatus,
            decideMengantarShipmentTransition,
        } = require("@/lib/mengantar/status") as {
            mapMengantarShipmentStatus: (v: unknown) => string | null;
            decideMengantarShipmentTransition: (
                a: string,
                b: string
            ) => { allowed: boolean; nextStatus: string | null };
        };

        expect(mapMengantarShipmentStatus("DELIVERED")).toBe(
            "DELIVERED"
        );

        const d = decideMengantarShipmentTransition(
            "CREATED",
            "PICKED UP"
        );
        expect(d.allowed).toBe(true);
        expect(d.nextStatus).toBe("PICKED_UP");
    });
});
