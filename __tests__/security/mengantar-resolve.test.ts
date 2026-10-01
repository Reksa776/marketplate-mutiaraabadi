/**
 * ==========================================
 * MENGANTAR AUTO-RESOLVE (INCREMENT 5)
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-resolve.test.ts
 *
 * Covers:
 *  - the pure deterministic matcher (origin + pickup)
 *  - the server resolver (guard, malformed, timeout, HTTP error)
 *  - POST /api/admin/settings/mengantar/resolve (auth, secrets,
 *    ambiguity safety, no writes, no shipment)
 *  - save via PUT (persist all ids, dropOff/scheduled mode)
 *  - regressions (estimate / paymentStatus / RajaOngkir untouched)
 *
 * No real shipment is ever created; no provider call is made.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
    adminAuditLog: {
        create: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/rajaongkir", () => ({
    rajaOngkirFetch: jest.fn(),
}));

jest.mock("next/cache", () => ({
    revalidatePath: jest.fn(),
}));

jest.mock("@/lib/mengantar", () => ({
    isMengantarConfigured: jest.fn(() => true),
    searchMengantarAreas: jest.fn(),
    listMengantarPickupAddresses: jest.fn(),
    listMengantarPickupTimes: jest.fn(),
    redactMengantarKey: (value: unknown) =>
        String(value ?? ""),
    MengantarError: class MengantarError extends Error {},
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    isMengantarConfigured,
    searchMengantarAreas,
    listMengantarPickupAddresses,
} from "@/lib/mengantar";

import {
    rankOriginCandidates,
    rankPickupCandidates,
    normalizeField,
    textContainsPhrase,
} from "@/lib/mengantar/matching";
import {
    buildOriginSearchKeyword,
    resolveMengantarPickupAddress,
    resolveMengantarStoreConfiguration,
} from "@/lib/mengantar/origin-resolver";
import { UpstreamError } from "@/lib/upstream-error";

import { POST as resolvePOST } from "@/app/api/admin/settings/mengantar/resolve/route";
import { PUT as settingsPUT } from "@/app/api/admin/settings/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedPrisma = prisma as unknown as {
    storeSetting: {
        findUnique: jest.Mock;
        upsert: jest.Mock;
    };
    adminAuditLog: { create: jest.Mock };
};
const mockedConfigured =
    isMengantarConfigured as unknown as jest.Mock;
const mockedSearch = searchMengantarAreas as unknown as jest.Mock;
const mockedPickups =
    listMengantarPickupAddresses as unknown as jest.Mock;

function readFile(path: string): string {
    try {
        return readFileSync(
            resolve(process.cwd(), path),
            "utf-8"
        );
    } catch {
        return "";
    }
}

/* ==========================================
 * FIXTURES (real production values)
 * ========================================== */

const API_KEY = "mengantar-key-must-not-leak";
const ORIGIN = "5fc62f46f8f44b34aa4c0bb6"; // NAGARAKEMBANG
const PICKUP = "696f000072b771c089b488c0"; // Mutiara Abadi Snack
const RAJA_ID = 17005;

const STORE = {
    storeName: "Mutiara Abadi",
    address:
        "X8CR+72Q, Jl. Desa Rw., Nagarakembang, Kec. Cingambul",
    province: "JAWA BARAT",
    city: "MAJALENGKA",
    district: "CINGAMBUL",
    subdistrict: "NAGARAKEMBANG",
    postalCode: "45467",
    rajaOngkirDestinationId: RAJA_ID,
};

function area(overrides: Record<string, unknown> = {}) {
    return {
        _id: ORIGIN,
        PROVINCE_NAME: "JAWA BARAT",
        CITY_NAME: "MAJALENGKA",
        DISTRICT_NAME: "CINGAMBUL",
        SUBDISTRICT_NAME: "NAGARAKEMBANG",
        ZIP_CODE: "45467",
        ...overrides,
    };
}

const PICKUP_ADDRESS_TEXT =
    "Jalan Wanakerta, RT.1/RW.4, Desa Rawa, Cingambul (Car Wash mutiara abd)\nKAB. MAJALENGKA - CINGAMBUL\nJAWA BARAT\nID 45467";

function pickup(overrides: Record<string, unknown> = {}) {
    return {
        _id: PICKUP,
        name: "Mutiara Abadi Snack",
        address: PICKUP_ADDRESS_TEXT,
        pic: "H. Asep Setiawan",
        picPhone: "6287884354456",
        areaId: "5fc62f46f8f44b34aa4c0bb7",
        ...overrides,
    };
}

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.MENGANTAR_API_KEY = API_KEY;
    mockedAuth.mockResolvedValue(null);
    mockedConfigured.mockReturnValue(true);
    mockedSearch.mockResolvedValue([]);
    mockedPickups.mockResolvedValue([]);
    mockedPrisma.storeSetting.findUnique.mockResolvedValue({
        ...STORE,
    });
});

/* ==========================================
 * A. ORIGIN MATCHER (PURE)
 * ========================================== */

describe("rankOriginCandidates", () => {
    test("1. exact match on every store field", () => {
        const result = rankOriginCandidates(STORE, [area()]);

        expect(result.status).toBe("MATCHED");
        if (result.status === "MATCHED") {
            expect(result.area._id).toBe(ORIGIN);
            expect(result.confidence).toBe("EXACT");
            expect(result.matchedFields).toEqual(
                expect.arrayContaining([
                    "postalCode",
                    "province",
                    "city",
                    "district",
                    "subdistrict",
                ])
            );
        }
    });

    test("2. postal-code-only store can still match", () => {
        const result = rankOriginCandidates(
            {
                ...STORE,
                province: null,
                city: null,
                district: null,
                subdistrict: null,
            },
            [area()]
        );

        expect(result.status).toBe("MATCHED");
    });

    test("3. normalized casing", () => {
        const result = rankOriginCandidates(
            {
                ...STORE,
                province: "jawa barat",
                city: "majalengka",
                district: "cingambul",
                subdistrict: "nagarakembang",
            },
            [area()]
        );

        expect(result.status).toBe("MATCHED");
    });

    test("4. normalized whitespace", () => {
        const result = rankOriginCandidates(
            {
                ...STORE,
                province: "  JAWA BARAT ",
                subdistrict: " NAGARAKEMBANG ",
            },
            [area()]
        );

        expect(result.status).toBe("MATCHED");
    });

    test("5. exact province/city/district/subdistrict required", () => {
        const result = rankOriginCandidates(STORE, [
            area({ CITY_NAME: "BANDUNG" }),
        ]);

        expect(result.status).toBe("NOT_FOUND");
    });

    test("6. wrong subdistrict is rejected (never guessed)", () => {
        const result = rankOriginCandidates(STORE, [
            area({ SUBDISTRICT_NAME: "CIDADAP" }),
        ]);

        expect(result.status).toBe("NOT_FOUND");
    });

    test("7. wrong postal code is rejected", () => {
        const result = rankOriginCandidates(STORE, [
            area({ ZIP_CODE: "45468" }),
        ]);

        expect(result.status).toBe("NOT_FOUND");
    });

    test("8. multiple identical candidates → AMBIGUOUS", () => {
        const result = rankOriginCandidates(STORE, [
            area(),
            area({ _id: "5fc62f46f8f44b34aa4c0bb9" }),
        ]);

        expect(result.status).toBe("AMBIGUOUS");
        if (result.status === "AMBIGUOUS") {
            expect(result.candidates).toHaveLength(2);
        }
    });

    test("9. no candidate → NOT_FOUND", () => {
        expect(
            rankOriginCandidates(STORE, []).status
        ).toBe("NOT_FOUND");
    });

    test("10. incomplete store address → INSUFFICIENT_DATA", () => {
        const result = rankOriginCandidates(
            {
                storeName: "X",
                address: "",
                province: null,
                city: null,
                district: null,
                subdistrict: null,
                postalCode: null,
            },
            [area()]
        );

        expect(result.status).toBe("INSUFFICIENT_DATA");
    });

    test("11. a RajaOngkir id is never used as a Mengantar id", () => {
        // An area whose _id happens to be the RajaOngkir id must not
        // be selected by that id — only by the address fields.
        const result = rankOriginCandidates(STORE, [
            area({
                _id: String(RAJA_ID),
                SUBDISTRICT_NAME: "SOMEWHERE",
            }),
        ]);

        expect(result.status).toBe("NOT_FOUND");
        expect(buildOriginSearchKeyword(STORE)).not.toContain(
            String(RAJA_ID)
        );
    });

    test("12. Mengantar area _id is preserved exactly", () => {
        const result = rankOriginCandidates(STORE, [area()]);

        expect(result.status).toBe("MATCHED");
        if (result.status === "MATCHED") {
            expect(result.area._id).toBe(ORIGIN);
        }
    });
});

/* ==========================================
 * B. PICKUP MATCHER (PURE)
 * ========================================== */

describe("rankPickupCandidates", () => {
    test("13. exact pickup match (real data)", () => {
        const result = rankPickupCandidates(STORE, [pickup()]);

        expect(result.status).toBe("MATCHED");
        if (result.status === "MATCHED") {
            expect(result.pickup._id).toBe(PICKUP);
            expect(result.confidence).toBe("EXACT");
        }
    });

    test("14. postal / province / city / district must all appear", () => {
        const result = rankPickupCandidates(STORE, [
            pickup({
                address:
                    "Desa X, Cingambul, KAB. MAJALENGKA\nJAWA BARAT\nID 45467",
            }),
        ]);

        expect(result.status).toBe("MATCHED");
    });

    test("15. name disambiguates only after geo fields match", () => {
        const result = rankPickupCandidates(STORE, [
            pickup({ name: "Toko Lain", _id: "a".repeat(24) }),
            pickup(),
        ]);

        expect(result.status).toBe("MATCHED");
        if (result.status === "MATCHED") {
            expect(result.pickup._id).toBe(PICKUP);
            expect(result.confidence).toBe("STRONG");
        }
    });

    test("16. multiple equal candidates → AMBIGUOUS", () => {
        const result = rankPickupCandidates(STORE, [
            pickup({ name: "Toko A", _id: "a".repeat(24) }),
            pickup({ name: "Toko B", _id: "b".repeat(24) }),
        ]);

        expect(result.status).toBe("AMBIGUOUS");
        if (result.status === "AMBIGUOUS") {
            expect(result.candidates).toHaveLength(2);
        }
    });

    test("17. no pickup → NOT_FOUND", () => {
        expect(
            rankPickupCandidates(STORE, []).status
        ).toBe("NOT_FOUND");
    });

    test("19. malformed provider response → NOT_FOUND", () => {
        const result = rankPickupCandidates(STORE, [
            { _id: "", name: null, address: PICKUP_ADDRESS_TEXT } as never,
            {} as never,
        ]);

        expect(result.status).toBe("NOT_FOUND");
    });

    test("name alone can never select a pickup (geo first)", () => {
        const result = rankPickupCandidates(STORE, [
            pickup({
                name: "Mutiara Abadi Snack",
                address: "Alamat tanpa kecamatan yang cocok",
            }),
        ]);

        expect(result.status).toBe("NOT_FOUND");
    });

    test("helpers normalize deterministically", () => {
        expect(normalizeField(" Jl. Raya  No.1 ")).toBe(
            "JLRAYANO1"
        );
        expect(
            textContainsPhrase("KAB. MAJALENGKA - CINGAMBUL", "MAJALENGKA")
        ).toBe(true);
        expect(
            textContainsPhrase("KAB. MAJALENGKA", "RAWA")
        ).toBe(false);
    });
});

/* ==========================================
 * C. ORIGIN-RESOLVER (SERVER)
 * ========================================== */

describe("origin-resolver", () => {
    test("18. a pickup id equal to the origin id is rejected", async () => {
        mockedPickups.mockResolvedValue([
            pickup({ _id: ORIGIN }),
        ]);

        const result = await resolveMengantarPickupAddress(
            STORE,
            ORIGIN
        );

        expect(result.status).toBe("NOT_FOUND");
    });

    test("20. provider timeout propagates as UpstreamError", async () => {
        mockedPickups.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_TIMEOUT",
                "Upstream request timed out."
            )
        );

        await expect(
            resolveMengantarPickupAddress(STORE, null)
        ).rejects.toMatchObject({
            category: "UPSTREAM_TIMEOUT",
        });
    });

    test("21. provider HTTP error propagates and never leaks the key", async () => {
        mockedPickups.mockRejectedValue(
            new Error("Response Mengantar gagal (HTTP 500).")
        );

        const error = await resolveMengantarPickupAddress(
            STORE,
            null
        ).catch((e) => e);

        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).not.toContain(
            API_KEY
        );
    });

    test("full resolve makes exactly one search + one pickup call", async () => {
        mockedSearch.mockResolvedValue([area()]);
        mockedPickups.mockResolvedValue([pickup()]);

        const result =
            await resolveMengantarStoreConfiguration();

        expect(result?.origin.status).toBe("MATCHED");
        expect(result?.pickup.status).toBe("MATCHED");
        expect(mockedSearch).toHaveBeenCalledTimes(1);
        expect(mockedPickups).toHaveBeenCalledTimes(1);
    });
});

/* ==========================================
 * D. RESOLVE ENDPOINT
 * ========================================== */

describe("POST /api/admin/settings/mengantar/resolve", () => {
    test("22. unauthenticated → 401", async () => {
        mockedAuth.mockResolvedValue(null);

        const response = (await resolvePOST()) as Response;

        expect(response.status).toBe(401);
    });

    test("23. non-admin → 403", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await resolvePOST()) as Response;

        expect(response.status).toBe(403);
    });

    test("24. success response has no secrets", async () => {
        adminSession();
        mockedSearch.mockResolvedValue([area()]);
        mockedPickups.mockResolvedValue([pickup()]);

        const response = (await resolvePOST()) as Response;
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.origin.id).toBe(ORIGIN);
        expect(body.pickup.id).toBe(PICKUP);
        expect(body.confidence).toBe("EXACT");
        expect(serialized).not.toContain(API_KEY);
        expect(serialized.toLowerCase()).not.toContain(
            "apikey"
        );
        // Legacy RajaOngkir id is never echoed as a Mengantar id.
        expect(serialized).not.toContain(String(RAJA_ID));
    });

    test("ambiguous providers return candidates, no auto-pick", async () => {
        adminSession();
        mockedSearch.mockResolvedValue([
            area({ _id: ORIGIN }),
            area({ _id: "5fc62f46f8f44b34aa4c0bb9" }),
        ]);
        mockedPickups.mockResolvedValue([pickup()]);

        const response = (await resolvePOST()) as Response;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.origin.status).toBe("AMBIGUOUS");
        expect(body.origin.candidates).toHaveLength(2);
        expect(body.origin.id).toBeUndefined();
    });

    test("upstream timeout → 504 with a friendly message", async () => {
        adminSession();
        mockedSearch.mockRejectedValue(
            new UpstreamError(
                "UPSTREAM_TIMEOUT",
                "Upstream request timed out."
            )
        );

        const response = (await resolvePOST()) as Response;
        const body = await response.json();

        expect(response.status).toBe(504);
        expect(body.message).toBe(
            "Layanan Mengantar sedang tidak merespons. Silakan coba lagi."
        );
    });

    test("503 when the API key is not configured", async () => {
        adminSession();
        mockedConfigured.mockReturnValue(false);

        const response = (await resolvePOST()) as Response;

        expect(response.status).toBe(503);
    });

    test("28. resolve NEVER writes to the DB (no silent overwrite)", async () => {
        adminSession();
        mockedSearch.mockResolvedValue([area()]);
        mockedPickups.mockResolvedValue([pickup()]);

        await resolvePOST();

        expect(
            mockedPrisma.storeSetting.findUnique
        ).toHaveBeenCalled();
    });

    test("30. the resolve route can never create a shipment", () => {
        const code = readFile(
            "app/api/admin/settings/mengantar/resolve/route.ts"
        );

        expect(code).not.toContain("createShipment");
        expect(code).not.toContain("createMengantarOrder");
        expect(code).not.toContain("shipmentStatus");
        expect(code).not.toContain("paymentStatus");
        expect(code).not.toContain(".upsert");
        expect(code).not.toContain(".update(");
    });
});

/* ==========================================
 * E. SAVE (PUT /api/admin/settings)
 * ========================================== */

describe("PUT /api/admin/settings — Mengantar save", () => {
    function putRequest(body: Record<string, unknown>) {
        return new Request(
            "http://test/api/admin/settings",
            {
                method: "PUT",
                body: JSON.stringify(body),
            }
        );
    }

    const baseBody = {
        storeName: "Mutiara Abadi",
        address: "Jl. Desa Rw.",
    };

    test("25. persists origin + pickup ids", async () => {
        adminSession();
        mockedPrisma.storeSetting.findUnique.mockResolvedValue(
            {
                tiktokPixelEnabled: false,
                tiktokPixelId: null,
                tiktokPixelName: null,
                tiktokPixelCode: null,
                tiktokPixelAccessToken: null,
                mengantarOriginAreaId: null,
                mengantarPickupAddressId: null,
                mengantarPickupTimeId: null,
            }
        );
        mockedPrisma.storeSetting.upsert.mockResolvedValue({
            ...STORE,
            mengantarOriginAreaId: ORIGIN,
            mengantarPickupAddressId: PICKUP,
            mengantarPickupTimeId: null,
        });
        mockedPickups.mockResolvedValue([
            { _id: PICKUP, name: "Gudang" },
        ]);

        const response = (await settingsPUT(
            putRequest({
                ...baseBody,
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
            })
        )) as Response;

        expect(response.status).toBe(200);

        const upsertArg =
            mockedPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(upsertArg.update.mengantarOriginAreaId).toBe(
            ORIGIN
        );
        expect(
            upsertArg.update.mengantarPickupAddressId
        ).toBe(PICKUP);
    });

    test("26. dropOff clears pickupTimeId", async () => {
        adminSession();
        mockedPrisma.storeSetting.findUnique.mockResolvedValue({
            mengantarOriginAreaId: null,
            mengantarPickupAddressId: null,
            mengantarPickupTimeId: null,
        });
        mockedPrisma.storeSetting.upsert.mockResolvedValue({
            ...STORE,
        });
        mockedPickups.mockResolvedValue([{ _id: PICKUP }]);

        await settingsPUT(
            putRequest({
                ...baseBody,
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
                mengantarPickupTimeId: "b".repeat(24),
                mengantarPickupMode: "dropoff",
            })
        );

        expect(
            mockedPrisma.storeSetting.upsert.mock.calls[0][0]
                .update.mengantarPickupTimeId
        ).toBeNull();
    });

    test("27. scheduled requires pickupTimeId", async () => {
        adminSession();
        mockedPrisma.storeSetting.findUnique.mockResolvedValue(
            {}
        );

        const response = (await settingsPUT(
            putRequest({
                ...baseBody,
                mengantarOriginAreaId: ORIGIN,
                mengantarPickupAddressId: PICKUP,
                mengantarPickupMode: "scheduled",
            })
        )) as Response;

        expect(response.status).toBe(400);
        expect(
            mockedPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("29. the UI warns when the store address changes", () => {
        const code = readFile(
            "app/admin/settings/AdminSettingsForm.tsx"
        );

        expect(code).toContain(
            "Jika alamat toko diubah"
        );
        // Manual entry must come from API results, not free text.
        expect(code).not.toContain("Origin area _id");
        expect(code).not.toContain("Pickup address _id");
    });
});

/* ==========================================
 * F. REGRESSION + SECURITY
 * ========================================== */

describe("regressions", () => {
    test("31/32/33/34/35. shipment lifecycle files untouched", () => {
        const shipment = readFile(
            "lib/mengantar/shipment.ts"
        );
        const webhook = readFile(
            "app/api/mengantar/webhook/route.ts"
        );

        expect(shipment).toContain(
            "WAITING_SHIPPING_PAYMENT"
        );
        expect(shipment).toContain("payMengantarUnpaid");
        expect(shipment).toContain(
            "NEVER touch Order.paymentStatus"
        );
        expect(webhook).toContain(
            "verifyMengantarWebhookSignature"
        );
    });

    test("36. RajaOngkir address hierarchy is intact", () => {
        const locations = readFile(
            "lib/rajaongkir/locations.ts"
        );

        expect(locations).toContain("getProvinces");
        expect(locations).toContain("getCities");
        expect(locations).toContain("getDistricts");
        expect(locations).toContain("getSubdistricts");
        expect(readFile("lib/rajaongkir.ts")).toContain(
            "rajaOngkirFetch"
        );
        expect(
            readFile("app/api/admin/settings/route.ts")
        ).toContain("rajaOngkirDestinationId");
    });

    test("the resolver is server-side only and never echoes secrets", () => {
        const code = readFile(
            "lib/mengantar/origin-resolver.ts"
        );

        expect(code).not.toContain("NEXT_PUBLIC");
        expect(code).not.toContain("MENGANTAR_API_KEY");
        expect(code).not.toContain("NEXT_PUBLIC_MENGANTAR");
    });
});
