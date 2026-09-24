/**
 * ==========================================
 * TIKTOK PIXEL ACCESS TOKEN + EVENTS API
 * ==========================================
 *
 * Covers:
 *   A. Admin Access Token (GET/PUT semantics)
 *   B. Security (never exposed, sanitizer, audit)
 *   C. TikTok Events API service (mocked HTTP)
 *   D. Event deduplication (browser === server event_id)
 *   E. CompletePayment is authoritative (webhook settlement)
 *
 * No test ever talks to TikTok production.
 */

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
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

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import { auth } from "@/auth";

import {
    MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH,
    last4OfTikTokAccessToken,
    maskTikTokAccessToken,
    normalizeTikTokPixelAccessToken,
} from "@/lib/analytics/tiktok-access-token";

import {
    buildTikTokEventId,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";

import {
    buildTikTokPixelAuditMetadata,
    hasTikTokPixelChanges,
} from "@/lib/analytics/tiktok-pixel-audit";

import { createAuditLog } from "@/lib/admin/audit-log";

import {
    TIKTOK_EVENTS_API_TIMEOUT_MS,
    TIKTOK_EVENTS_API_URL,
    sendTikTokEvent,
    trackTikTokServerCompletePayment,
} from "@/lib/analytics/tiktok-events-api";

import { GET, PUT } from "@/app/api/admin/settings/route";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TOKEN = "act.example-access-token-0000wxyz";

function storeSettingRow(
    overrides: Record<string, unknown> = {}
) {
    return {
        storeName: "Toko",
        phone: null,
        email: null,
        logo: null,
        address: "Jl. Contoh",
        tiktokPixelEnabled: true,
        tiktokPixelId: PIXEL_ID,
        tiktokPixelName: "Web",
        tiktokPixelCode: `ttq.load("${PIXEL_ID}"); ttq.page();`,
        tiktokPixelAccessToken: TOKEN,
        provinceId: null,
        province: null,
        cityId: null,
        city: null,
        districtId: null,
        district: null,
        subdistrictId: null,
        subdistrict: null,
        postalCode: null,
        rajaOngkirDestinationId: null,
        latitude: null,
        longitude: null,
        ...overrides,
    };
}

function jsonResponse(
    body: unknown,
    status = 200
): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    (auth as jest.Mock).mockResolvedValue(null);
});

/* ==========================================
 * A. ADMIN ACCESS TOKEN — API SEMANTICS
 * ========================================== */

describe("TikTok Access Token — admin API", () => {
    test("GET: unauthenticated is 401", async () => {
        (auth as jest.Mock).mockResolvedValue(null);

        const response = (await GET()) as Response;
        expect(response.status).toBe(401);
    });

    test("GET: non-admin is 401", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "u1", role: "CUSTOMER" },
        });

        const response = (await GET()) as Response;
        expect(response.status).toBe(401);
    });

    test("GET: admin response never contains the raw token", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );

        const response = (await GET()) as Response;
        const body = await response.json();

        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(serialized).not.toContain(TOKEN);
        expect(body.data.tiktokPixelAccessToken).toBeUndefined();
        expect(
            body.data.tiktokPixelAccessTokenConfigured
        ).toBe(true);
        expect(
            body.data.tiktokPixelAccessTokenLast4
        ).toBe(TOKEN.slice(-4));
    });

    test("GET: configured flag is false when no token is stored", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: null,
            })
        );

        const response = (await GET()) as Response;
        const body = await response.json();

        expect(
            body.data.tiktokPixelAccessTokenConfigured
        ).toBe(false);
        expect(
            body.data.tiktokPixelAccessTokenLast4
        ).toBeNull();
    });

    test("PUT: new token is persisted and never echoed", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: null,
            })
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: TOKEN,
            })
        );

        const response = (await PUT(
            new Request("http://test/api", {
                method: "PUT",
                body: JSON.stringify({
                    storeName: "Toko",
                    address: "Jl. Contoh",
                    tiktokPixelEnabled: true,
                    tiktokPixelId: PIXEL_ID,
                    tiktokPixelCode: `ttq.load("${PIXEL_ID}");`,
                    tiktokPixelAccessToken: TOKEN,
                }),
            })
        )) as Response;

        const upsertArg =
            mockPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(
            upsertArg.update.tiktokPixelAccessToken
        ).toBe(TOKEN);

        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain(TOKEN);
        expect(
            body.data.tiktokPixelAccessTokenConfigured
        ).toBe(true);
    });

    test("PUT: blank token without clear KEEPS the existing token", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: TOKEN,
            })
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: TOKEN,
            })
        );

        await PUT(
            new Request("http://test/api", {
                method: "PUT",
                body: JSON.stringify({
                    storeName: "Toko",
                    address: "Jl. Contoh",
                    tiktokPixelId: PIXEL_ID,
                    tiktokPixelAccessToken: "   ",
                }),
            })
        );

        const upsertArg =
            mockPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(
            upsertArg.update.tiktokPixelAccessToken
        ).toBe(TOKEN);
    });

    test("PUT: explicit clear removes the stored token", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: TOKEN,
            })
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: null,
            })
        );

        const response = (await PUT(
            new Request("http://test/api", {
                method: "PUT",
                body: JSON.stringify({
                    storeName: "Toko",
                    address: "Jl. Contoh",
                    tiktokPixelId: PIXEL_ID,
                    tiktokPixelAccessToken: "",
                    clearTiktokPixelAccessToken: true,
                }),
            })
        )) as Response;

        const upsertArg =
            mockPrisma.storeSetting.upsert.mock.calls[0][0];

        expect(
            upsertArg.update.tiktokPixelAccessToken
        ).toBeNull();

        const body = await response.json();
        expect(
            body.data.tiktokPixelAccessTokenConfigured
        ).toBe(false);
    });

    test("PUT: invalid token is rejected with 400", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow()
        );

        const response = (await PUT(
            new Request("http://test/api", {
                method: "PUT",
                body: JSON.stringify({
                    storeName: "Toko",
                    address: "Jl. Contoh",
                    tiktokPixelId: PIXEL_ID,
                    tiktokPixelAccessToken: "has space inside",
                }),
            })
        )) as Response;

        expect(response.status).toBe(400);
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });

    test("PUT: token is written to the audit log as metadata only", async () => {
        (auth as jest.Mock).mockResolvedValue({
            user: { id: "a1", role: "ADMIN" },
        });
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: null,
            })
        );
        mockPrisma.storeSetting.upsert.mockResolvedValue(
            storeSettingRow({
                tiktokPixelAccessToken: TOKEN,
            })
        );

        await PUT(
            new Request("http://test/api", {
                method: "PUT",
                body: JSON.stringify({
                    storeName: "Toko",
                    address: "Jl. Contoh",
                    tiktokPixelEnabled: true,
                    tiktokPixelId: PIXEL_ID,
                    tiktokPixelCode: `ttq.load("${PIXEL_ID}");`,
                    tiktokPixelAccessToken: TOKEN,
                }),
            })
        );

        expect(
            mockPrisma.adminAuditLog.create
        ).toHaveBeenCalled();

        const auditArg =
            mockPrisma.adminAuditLog.create.mock.calls[0][0];

        expect(
            JSON.stringify(auditArg.data)
        ).not.toContain(TOKEN);
    });
});

/* ==========================================
 * A2. TOKEN HELPERS
 * ========================================== */

describe("TikTok Access Token — helpers", () => {
    test("normalizes a token", () => {
        expect(
            normalizeTikTokPixelAccessToken("  abc123  ")
        ).toBe("abc123");
    });

    test("rejects empty / non-string / oversized / whitespace", () => {
        expect(normalizeTikTokPixelAccessToken("")).toBeNull();
        expect(normalizeTikTokPixelAccessToken("   ")).toBeNull();
        expect(normalizeTikTokPixelAccessToken(123)).toBeNull();
        expect(normalizeTikTokPixelAccessToken(null)).toBeNull();
        expect(normalizeTikTokPixelAccessToken("a b")).toBeNull();
        expect(
            normalizeTikTokPixelAccessToken(
                "x".repeat(
                    MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH + 1
                )
            )
        ).toBeNull();
    });

    test("last4 and mask never expose the whole token", () => {
        expect(last4OfTikTokAccessToken(TOKEN)).toBe(
            TOKEN.slice(-4)
        );
        expect(maskTikTokAccessToken(TOKEN)).toBe(
            `••••${TOKEN.slice(-4)}`
        );
        expect(maskTikTokAccessToken(null)).toBeNull();
        expect(maskTikTokAccessToken("ab")).toBeNull();
    });
});

/* ==========================================
 * B. SECURITY
 * ========================================== */

describe("TikTok Access Token — security", () => {
    test("GET uses an explicit select, not a blind full row", () => {
        const api = readFile(
            "app/api/admin/settings/route.ts"
        );

        expect(api).not.toContain("data: setting,");
        expect(api).toContain("SETTINGS_SELECT");
        expect(api).toContain("toSettingsResponse");
    });

    test("storefront pixel config never references the token", () => {
        for (const file of [
            "lib/analytics/tiktok-config.ts",
            "components/analytics/AnalyticsProvider.tsx",
            "components/analytics/TikTokPixel.tsx",
            "components/analytics/PurchaseTracker.tsx",
        ]) {
            expect(readFile(file)).not.toContain(
                "AccessToken"
            );
        }
    });

    test("the events config module is server-only", () => {
        expect(
            readFile("lib/analytics/tiktok-events-config.ts")
        ).toMatch(/^\s*import\s+"server-only";/m);
        expect(
            readFile("lib/analytics/tiktok-events-api.ts")
        ).toMatch(/^\s*import\s+"server-only";/m);
    });

    test("only the ADMIN settings route exposes the pixel fields", () => {
        function listFiles(dir: string): string[] {
            const out: string[] = [];
            for (const entry of readdirSync(
                resolve(process.cwd(), dir),
                { withFileTypes: true }
            )) {
                const rel = `${dir}/${entry.name}`;
                if (entry.isDirectory()) {
                    out.push(...listFiles(rel));
                } else if (/\.(ts|tsx)$/.test(entry.name)) {
                    out.push(rel);
                }
            }
            return out;
        }

        const allowed = "app/api/admin/settings/route.ts";
        const exposing = listFiles("app/api").filter(
            (file) => file !== allowed && readFile(file).includes("tiktokPixel")
        );

        expect(exposing).toEqual([]);
    });
});

/* ==========================================
 * B2. AUDIT SANITIZER
 * ========================================== */

describe("Audit sanitizer — token keys", () => {
    test("strips accessToken / access_token / ACCESS_TOKEN / authorization", async () => {
        await createAuditLog({
            adminId: "a1",
            action: "TIKTOK_PIXEL_UPDATED",
            entityType: "StoreSetting",
            entityId: 1,
            description: "test",
            metadata: {
                accessToken: "raw-1",
                access_token: "raw-2",
                ACCESS_TOKEN: "raw-3",
                authorization: "Bearer raw-4",
                Authorization: "Bearer raw-5",
                safe: "keep-me",
            },
        });

        const stored =
            mockPrisma.adminAuditLog.create.mock.calls[0][0]
                .data.metadata;

        expect(stored).not.toHaveProperty("accessToken");
        expect(stored).not.toHaveProperty("access_token");
        expect(stored).not.toHaveProperty("ACCESS_TOKEN");
        expect(stored).not.toHaveProperty("authorization");
        expect(stored).not.toHaveProperty("Authorization");
        expect(stored.safe).toBe("keep-me");
        expect(JSON.stringify(stored)).not.toContain(
            "raw-"
        );
    });
});

/* ==========================================
 * B3. AUDIT METADATA — NO RAW TOKEN
 * ========================================== */

describe("TikTok access token — audit metadata", () => {
    test("never contains the raw token", () => {
        const metadata = buildTikTokPixelAuditMetadata(
            null,
            {
                enabled: true,
                pixelId: PIXEL_ID,
                pixelName: "Web",
                code: "ttq.page();",
                accessToken: TOKEN,
            }
        );

        const serialized = JSON.stringify(metadata);

        expect(serialized).not.toContain(TOKEN);
        expect(metadata.accessTokenConfigured).toBe(true);
        expect(metadata.accessTokenLength).toBe(
            TOKEN.length
        );
        expect(metadata.accessTokenLast4).toBe(
            TOKEN.slice(-4)
        );
        expect(metadata.accessTokenHash).toHaveLength(16);
    });

    test("change detection covers the token", () => {
        const base = {
            enabled: true,
            pixelId: PIXEL_ID,
            pixelName: "Web",
            code: "ttq.page();",
            accessToken: TOKEN,
        };

        expect(
            hasTikTokPixelChanges(base, { ...base })
        ).toBe(false);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
                accessToken: "another-token",
            })
        ).toBe(true);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
                accessToken: null,
            })
        ).toBe(true);
    });
});

/* ==========================================
 * C. EVENTS API SERVICE
 * ========================================== */

describe("TikTok Events API — service", () => {
    function configured() {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });
    }

    test("disabled pixel → no request", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: false,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });

        const result = await sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe("pixel_disabled");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("missing Pixel ID → no request", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: null,
            tiktokPixelAccessToken: TOKEN,
        });

        const result = await sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe("missing_pixel_id");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("missing Access Token → no request", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: null,
        });

        const result = await sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe("missing_access_token");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("valid config → correct endpoint, header and body", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const result = await sendTikTokEvent({
            event: "CompletePayment",
            eventId: buildTikTokEventId(
                "CompletePayment",
                "PAY-1"
            ),
            value: 125000,
            currency: "IDR",
            orderId: "PAY-1",
            contents: [
                {
                    content_id: "42",
                    quantity: 2,
                    price: 62500,
                },
            ],
        });

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(TIKTOK_EVENTS_API_URL);
        expect(init.method).toBe("POST");
        expect(init.headers["Access-Token"]).toBe(TOKEN);

        const payload = JSON.parse(init.body);
        expect(payload.event_source).toBe("web");
        expect(payload.event_source_id).toBe(PIXEL_ID);
        expect(payload.data[0].event).toBe(
            "CompletePayment"
        );
        expect(payload.data[0].event_id).toBe(
            "ttq:completepayment:PAY-1"
        );
        expect(
            typeof payload.data[0].event_time
        ).toBe("number");
        expect(payload.data[0].properties.value).toBe(
            125000
        );
        expect(
            payload.data[0].properties.contents[0]
                .content_id
        ).toBe("42");
    });

    test("HTTP 400/401/500 are handled without throwing", async () => {
        configured();

        for (const status of [400, 401, 500]) {
            fetchMock.mockResolvedValue(
                jsonResponse(
                    { code: 40001, message: "error" },
                    status
                )
            );

            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e1",
            });

            expect(result.ok).toBe(false);
            expect(result.status).toBe(status);
        }
    });

    test("a non-zero TikTok code is treated as failure", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 40002, message: "bad" })
        );

        const result = await sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe(40002);
    });

    test("timeout aborts and never throws", async () => {
        configured();

        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    const signal = init.signal as AbortSignal;
                    signal.addEventListener(
                        "abort",
                        () => {
                            const err = new Error(
                                "aborted"
                            );
                            err.name = "AbortError";
                            reject(err);
                        }
                    );
                })
        );

        jest.useFakeTimers();

        const pending = sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        await jest.advanceTimersByTimeAsync(
            TIKTOK_EVENTS_API_TIMEOUT_MS + 50
        );

        const result = await pending;

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("request_failed");

        jest.useRealTimers();
    });

    test("a rejected network request resolves instead of throwing", async () => {
        configured();
        fetchMock.mockRejectedValue(
            new Error("network down")
        );

        await expect(
            sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e1",
            })
        ).resolves.toMatchObject({ ok: false });
    });

    test("never logs the Access Token", async () => {
        configured();
        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});

        fetchMock.mockResolvedValue(
            jsonResponse({ code: 40001, message: "bad" }, 401)
        );

        await sendTikTokEvent({
            event: "CompletePayment",
            eventId: "e1",
        });

        const logged = [
            ...errorSpy.mock.calls,
            ...logSpy.mock.calls,
        ]
            .map((args) => JSON.stringify(args))
            .join("\n");

        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain("Access-Token");

        errorSpy.mockRestore();
        logSpy.mockRestore();
    });
});

/* ==========================================
 * D. DEDUPLICATION
 * ========================================== */

describe("TikTok event deduplication", () => {
    test("browser pixel receives the shared event_id", () => {
        const track = jest.fn();

        (globalThis as { window?: unknown }).window = {
            ttq: { track },
        };

        const eventId = buildTikTokEventId(
            "CompletePayment",
            "PAY-CART-9"
        );

        trackTikTokEvent(
            "CompletePayment",
            { value: 1000, currency: "IDR" },
            { eventId }
        );

        expect(track).toHaveBeenCalledWith(
            "CompletePayment",
            { value: 1000, currency: "IDR" },
            { event_id: eventId }
        );

        delete (globalThis as { window?: unknown })
            .window;
    });

    test("browser and server use the SAME event_id for the same order", async () => {
        const track = jest.fn();
        (globalThis as { window?: unknown }).window = {
            ttq: { track },
        };

        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const orderNumber = "PAY-CART-777";

        trackTikTokEvent(
            "CompletePayment",
            { value: 5000 },
            {
                eventId: buildTikTokEventId(
                    "CompletePayment",
                    orderNumber
                ),
            }
        );

        await trackTikTokServerCompletePayment({
            orderNumber,
            total: 5000,
            items: [],
        });

        const browserEventId =
            track.mock.calls[0][2].event_id;
        const serverEventId = JSON.parse(
            fetchMock.mock.calls[0][1].body
        ).data[0].event_id;

        expect(browserEventId).toBe(serverEventId);

        delete (globalThis as { window?: unknown })
            .window;
    });
});

/* ==========================================
 * E. COMPLETEPAYMENT IS AUTHORITATIVE
 * ========================================== */

describe("CompletePayment — authoritative settlement", () => {
    test.each([
        "app/api/payment/ipaymu/notification/route.ts",
        "app/api/payment/midtrans/notification/route.ts",
    ])(
        "%s fires the server event only inside the settled branch",
        (file) => {
            const code = readFile(file);

            expect(code).toContain(
                "trackTikTokServerCompletePayment("
            );

            const settledIndex = code.indexOf("if (settled)");
            const callIndex = code.indexOf(
                "trackTikTokServerCompletePayment("
            );

            expect(settledIndex).toBeGreaterThan(-1);
            expect(callIndex).toBeGreaterThan(
                settledIndex
            );
        }
    );

    test("server CompletePayment uses the order-based event id", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        await trackTikTokServerCompletePayment({
            orderNumber: "PAY-CART-123",
            total: 250000,
            items: [
                {
                    productId: 7,
                    productName: "Kaos",
                    quantity: 1,
                    price: 250000,
                },
            ],
        });

        const payload = JSON.parse(
            fetchMock.mock.calls[0][1].body
        );

        expect(payload.data[0].event).toBe(
            "CompletePayment"
        );
        expect(payload.data[0].event_id).toBe(
            "ttq:completepayment:PAY-CART-123"
        );
        expect(
            payload.data[0].properties.order_id
        ).toBe("PAY-CART-123");
    });

    test("a TikTok failure still returns a result (never throws)", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue({
            tiktokPixelEnabled: true,
            tiktokPixelId: PIXEL_ID,
            tiktokPixelAccessToken: TOKEN,
        });
        fetchMock.mockRejectedValue(
            new Error("tiktok down")
        );

        await expect(
            trackTikTokServerCompletePayment({
                orderNumber: "PAY-CART-1",
                total: 1000,
                items: [],
            })
        ).resolves.toMatchObject({ ok: false });
    });
});
