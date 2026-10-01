/**
 * ==========================================
 * SHARED UPSTREAM FETCH — TIMEOUT / RETRY
 * ==========================================
 *
 * Run: npx jest __tests__/security/upstream-fetch.test.ts
 *
 * Pins the behaviour that fixes the production `AbortError` incidents:
 *  - a timeout abort is normalized to UPSTREAM_TIMEOUT (never a raw
 *    "This operation was aborted")
 *  - read-only GET/HEAD retry at most once; POST is NEVER retried
 *  - RajaOngkir keeps sending its `key` header and its endpoint
 *  - Mengantar keeps calling /api/public/{API_KEY}/address and never
 *    leaks the key in a thrown error
 *
 * No real network call is made.
 */

import { fetchWithRetry } from "@/lib/fetchWithRetry";
import {
    UpstreamError,
    buildUpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

const RAJA_KEY = "rajaongkir-test-key-0000";
const MENGANTAR_KEY = "mengantar-test-key-0000";

let raja: typeof import("@/lib/rajaongkir");
let mengantar: typeof import("@/lib/mengantar");

beforeAll(async () => {
    process.env.RAJAONGKIR_API_KEY = RAJA_KEY;
    process.env.MENGANTAR_API_KEY = MENGANTAR_KEY;

    jest.resetModules();

    raja = await import("@/lib/rajaongkir");
    mengantar = await import("@/lib/mengantar");
});

afterEach(() => {
    jest.useRealTimers();
});

/* ==========================================
 * HELPERS
 * ========================================== */

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () =>
            typeof body === "string"
                ? body
                : JSON.stringify(body),
    } as unknown as Response;
}

/** A fetch that never resolves, but rejects when its signal aborts. */
function hangingFetch() {
    return jest.fn(
        (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
                const signal = init?.signal as
                    | AbortSignal
                    | undefined;

                signal?.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            })
    );
}

async function captureRejection(
    promise: Promise<unknown>
): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (error) => error
    );
}

/* ==========================================
 * buildUpstreamError (pure)
 * ========================================== */

describe("buildUpstreamError", () => {
    test("classifies an AbortError as UPSTREAM_TIMEOUT", () => {
        const abort = new Error("aborted");
        abort.name = "AbortError";

        const result = buildUpstreamError(abort, false);

        expect(result).toBeInstanceOf(UpstreamError);
        expect(result.category).toBe("UPSTREAM_TIMEOUT");
        expect(isUpstreamTimeout(result)).toBe(true);
    });

    test("classifies our own timer abort as UPSTREAM_TIMEOUT", () => {
        const result = buildUpstreamError(
            new Error("whatever"),
            true
        );

        expect(result.category).toBe("UPSTREAM_TIMEOUT");
    });

    test("classifies a TypeError as UPSTREAM_NETWORK_ERROR", () => {
        const result = buildUpstreamError(
            new TypeError("fetch failed"),
            false
        );

        expect(result.category).toBe("UPSTREAM_NETWORK_ERROR");
    });

    test("classifies a cause code as UPSTREAM_NETWORK_ERROR", () => {
        const error = new Error("boom");
        (error as { cause?: unknown }).cause = {
            code: "ECONNRESET",
        };

        expect(
            buildUpstreamError(error, false).category
        ).toBe("UPSTREAM_NETWORK_ERROR");
    });
});

/* ==========================================
 * fetchWithRetry
 * ========================================== */

describe("fetchWithRetry", () => {
    test("returns the response on success", async () => {
        const response = jsonResponse({ ok: true });
        const fetchMock = jest
            .fn()
            .mockResolvedValue(response);
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(
            fetchWithRetry("http://upstream.test/x")
        ).resolves.toBe(response);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("retries a timed-out GET exactly once, then throws UPSTREAM_TIMEOUT", async () => {
        const fetchMock = hangingFetch();
        global.fetch = fetchMock as unknown as typeof fetch;

        const error = await captureRejection(
            fetchWithRetry(
                "http://upstream.test/x",
                {},
                { retries: 1, timeoutMs: 15, delayMs: 1 }
            )
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_TIMEOUT"
        );
        expect(String((error as Error).message)).not.toMatch(
            /abort/i
        );
        // 1 initial attempt + 1 retry
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("NEVER retries a timed-out POST", async () => {
        const fetchMock = hangingFetch();
        global.fetch = fetchMock as unknown as typeof fetch;

        const error = await captureRejection(
            fetchWithRetry(
                "http://upstream.test/order",
                { method: "POST" },
                { retries: 1, timeoutMs: 15, delayMs: 1 }
            )
        );

        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_TIMEOUT"
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("retries a network error on a GET", async () => {
        const fetchMock = jest
            .fn()
            .mockRejectedValue(new TypeError("fetch failed"));
        global.fetch = fetchMock as unknown as typeof fetch;

        const error = await captureRejection(
            fetchWithRetry(
                "http://upstream.test/x",
                {},
                { retries: 1, timeoutMs: 50, delayMs: 1 }
            )
        );

        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_NETWORK_ERROR"
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("NEVER retries a POST network error", async () => {
        const fetchMock = jest
            .fn()
            .mockRejectedValue(new TypeError("fetch failed"));
        global.fetch = fetchMock as unknown as typeof fetch;

        const error = await captureRejection(
            fetchWithRetry(
                "http://upstream.test/order/pay-unpaid",
                { method: "POST" },
                { retries: 1, timeoutMs: 50, delayMs: 1 }
            )
        );

        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_NETWORK_ERROR"
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("retries a POST only when explicitly marked idempotent", async () => {
        const fetchMock = jest
            .fn()
            .mockRejectedValue(new TypeError("fetch failed"));
        global.fetch = fetchMock as unknown as typeof fetch;

        const error = await captureRejection(
            fetchWithRetry(
                "http://upstream.test/calculate/domestic-cost",
                { method: "POST" },
                {
                    retries: 1,
                    timeoutMs: 50,
                    delayMs: 1,
                    idempotent: true,
                }
            )
        );

        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_NETWORK_ERROR"
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

/* ==========================================
 * RajaOngkir integration
 * ========================================== */

describe("rajaOngkirFetch", () => {
    test("sends the key header and returns data", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                meta: { code: 200, status: "success" },
                data: [{ id: 5, name: "JAWA BARAT" }],
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const data = await raja.rajaOngkirFetch(
            "/destination/province"
        );

        expect(data).toEqual([
            { id: 5, name: "JAWA BARAT" },
        ]);

        const [url, init] = fetchMock.mock.calls[0];

        expect(String(url)).toBe(
            `${raja.RAJAONGKIR_BASE_URL}/destination/province`
        );
        expect(
            (init.headers as Record<string, string>).key
        ).toBe(RAJA_KEY);
    });

    test("city lookup hits /destination/city/5", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                meta: { code: 200 },
                data: [{ id: 5, name: "KOTA" }],
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        await raja.rajaOngkirFetch("/destination/city/5");

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            `${raja.RAJAONGKIR_BASE_URL}/destination/city/5`
        );
    });

    test("a timeout is normalized, not leaked as AbortError", async () => {
        jest.useFakeTimers();
        global.fetch = hangingFetch() as unknown as typeof fetch;

        const pending = captureRejection(
            raja.rajaOngkirFetch("/destination/city/5")
        );

        await jest.advanceTimersByTimeAsync(30000);

        const error = await pending;

        // NOTE: `raja` was imported after jest.resetModules(), so its
        // UpstreamError class is a different identity than the static
        // import above — assert by name + category instead.
        expect((error as { name?: string }).name).toBe(
            "UpstreamError"
        );
        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_TIMEOUT"
        );
        expect(String((error as Error).message)).not.toMatch(
            /abort/i
        );
    });

    test("a non-JSON response throws a clear error", async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                jsonResponse("<html>gateway</html>", 200)
            ) as unknown as typeof fetch;

        await expect(
            raja.rajaOngkirFetch("/destination/city/5")
        ).rejects.toThrow(/bukan JSON/);
    });

    test("an HTTP error surfaces the provider message", async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                jsonResponse(
                    { meta: { code: 401, message: "Unauthorized" } },
                    401
                )
            ) as unknown as typeof fetch;

        await expect(
            raja.rajaOngkirFetch("/destination/city/5")
        ).rejects.toThrow(/Unauthorized/);
    });
});

/* ==========================================
 * Mengantar /address integration
 * ========================================== */

describe("listMengantarPickupAddresses", () => {
    test("calls /api/public/{KEY}/address and normalizes", async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            jsonResponse({
                success: true,
                data: [
                    {
                        _id: "pickup-1",
                        PICKUP_NAME: "Gudang",
                        PICKUP_ADDRESS: "Jl. Desa Rw.",
                        PICKUP_PIC: "Budi",
                        PICKUP_PIC_PHONE: "0812",
                        PICKUP_AUTOFILL: "area-1",
                    },
                ],
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        const list =
            await mengantar.listMengantarPickupAddresses();

        const [url, init] = fetchMock.mock.calls[0];

        expect(String(url)).toBe(
            `${mengantar.MENGANTAR_BASE_URL}/api/public/${MENGANTAR_KEY}/address`
        );
        expect(
            (init.headers as Record<string, string>).Accept
        ).toBe("application/json");
        expect(list).toEqual([
            {
                _id: "pickup-1",
                name: "Gudang",
                address: "Jl. Desa Rw.",
                pic: "Budi",
                picPhone: "0812",
                areaId: "area-1",
            },
        ]);
    });

    test("a timeout is normalized to UPSTREAM_TIMEOUT without the key", async () => {
        jest.useFakeTimers();
        global.fetch = hangingFetch() as unknown as typeof fetch;

        const pending = captureRejection(
            mengantar.listMengantarPickupAddresses()
        );

        await jest.advanceTimersByTimeAsync(30000);

        const error = await pending;

        expect((error as { name?: string }).name).toBe(
            "UpstreamError"
        );
        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_TIMEOUT"
        );
        expect(String((error as Error).message)).not.toContain(
            MENGANTAR_KEY
        );
        expect(String((error as Error).message)).not.toMatch(
            /abort/i
        );
    });

    test("a network failure is normalized to UPSTREAM_NETWORK_ERROR", async () => {
        global.fetch = jest
            .fn()
            .mockRejectedValue(
                new TypeError("fetch failed")
            ) as unknown as typeof fetch;

        const error = await captureRejection(
            mengantar.listMengantarPickupAddresses()
        );

        expect((error as UpstreamError).category).toBe(
            "UPSTREAM_NETWORK_ERROR"
        );
        expect(String((error as Error).message)).not.toContain(
            MENGANTAR_KEY
        );
    });

    test("an HTTP error becomes a MengantarError without the key", async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                jsonResponse(
                    { success: false, message: "boom" },
                    500
                )
            ) as unknown as typeof fetch;

        const error = await captureRejection(
            mengantar.listMengantarPickupAddresses()
        );

        expect(error).toBeInstanceOf(
            mengantar.MengantarError
        );
        expect(String((error as Error).message)).not.toContain(
            MENGANTAR_KEY
        );
    });

    test("a non-JSON response becomes a clear MengantarError", async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                jsonResponse("<html>nope</html>", 200)
            ) as unknown as typeof fetch;

        await expect(
            mengantar.listMengantarPickupAddresses()
        ).rejects.toThrow(/bukan JSON/);
    });
});
