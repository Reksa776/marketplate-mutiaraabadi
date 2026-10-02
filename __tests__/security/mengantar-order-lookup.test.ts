/**
 * ==========================================
 * MENGANTAR GET /order LOOKUP CONTRACT
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-order-lookup.test.ts
 *
 * The official GET /order documents BOTH `order_id` and `tracking_id`
 * as lookup filters and returns an array of matches plus an
 * `isDeleted` soft-delete flag. Reconciliation must distinguish:
 *
 *   exists    → a row is returned and isDeleted is not true
 *   missing   → empty array, or isDeleted:true
 *   uncertain → HTTP/network/malformed error (never a reset)
 *
 * `providerShipmentId` (ORDER_ID) is the authoritative lookup; a resi
 * can go stale. Only the transport is mocked — the real
 * `mengantarRequest` unwrapping is exercised. No request reaches
 * Mengantar.
 */

// Make this file a module so its top-level helpers cannot collide
// with other script-style test files in the same program.
export {};

jest.mock("@/lib/fetchWithRetry", () => ({
    fetchWithRetry: jest.fn(),
}));

let getMengantarOrderByOrderId: typeof import("@/lib/mengantar").getMengantarOrderByOrderId;
let getMengantarOrderByTracking: typeof import("@/lib/mengantar").getMengantarOrderByTracking;
let mockedFetch: jest.Mock;

beforeAll(async () => {
    process.env.MENGANTAR_API_KEY = "TEST_API_KEY";
    process.env.MENGANTAR_BASE_URL = "https://api.example.test";

    jest.resetModules();

    mockedFetch = (
        await import("@/lib/fetchWithRetry")
    ).fetchWithRetry as unknown as jest.Mock;

    const mod = await import("@/lib/mengantar");
    getMengantarOrderByOrderId =
        mod.getMengantarOrderByOrderId;
    getMengantarOrderByTracking =
        mod.getMengantarOrderByTracking;
});

beforeEach(() => {
    mockedFetch.mockReset();
});

function respondWith(
    json: unknown,
    { ok = true, status = 200 } = {}
) {
    mockedFetch.mockResolvedValue({
        ok,
        status,
        text: async () => JSON.stringify(json),
    } as unknown as Response);
}

function calledUrl(): string {
    return String(mockedFetch.mock.calls[0][0]);
}

function calledMethod(): string {
    return String(
        (mockedFetch.mock.calls[0][1] as RequestInit)
            ?.method
    );
}

describe("getMengantarOrderByOrderId", () => {
    it("is a GET using the documented order_id filter", async () => {
        respondWith({ success: true, data: [] });

        await getMengantarOrderByOrderId("2610025RMRQZ");

        expect(calledMethod()).toBe("GET");
        expect(calledUrl()).toContain("order_id=2610025RMRQZ");
        expect(calledUrl()).not.toContain("tracking_id=");
    });

    it("returns null (documented no-match) for an empty array", async () => {
        respondWith({ success: true, data: [] });

        await expect(
            getMengantarOrderByOrderId("2610025RMRQZ")
        ).resolves.toBeNull();
    });

    it("maps a found order", async () => {
        respondWith({
            success: true,
            data: [
                {
                    ORDER_ID: "2610025RMRQZ",
                    cnote_no: "JO0328436240",
                    status: "active",
                    statusCategory: "PICKED UP",
                    isDeleted: false,
                    history: [
                        { date: "02-10-2026 10:00", desc: "Dijemput" },
                    ],
                },
            ],
        });

        const result = await getMengantarOrderByOrderId(
            "2610025RMRQZ"
        );

        expect(result).toEqual({
            orderId: "2610025RMRQZ",
            trackingNumber: "JO0328436240",
            status: "active",
            statusCategory: "PICKED UP",
            isDeleted: false,
            history: [
                { date: "02-10-2026 10:00", desc: "Dijemput" },
            ],
        });
    });

    it("surfaces the isDeleted soft-delete flag", async () => {
        respondWith({
            success: true,
            data: [
                {
                    ORDER_ID: "2610025RMRQZ",
                    cnote_no: "JO0328436240",
                    isDeleted: true,
                },
            ],
        });

        const result = await getMengantarOrderByOrderId(
            "2610025RMRQZ"
        );

        expect(result?.isDeleted).toBe(true);
    });

    it("does nothing for an empty identifier", async () => {
        await expect(
            getMengantarOrderByOrderId("")
        ).resolves.toBeNull();
        expect(mockedFetch).not.toHaveBeenCalled();
    });
});

describe("getMengantarOrderByTracking", () => {
    it("is a GET using the documented tracking_id filter", async () => {
        respondWith({ success: true, data: [] });

        await getMengantarOrderByTracking("JO0328436240");

        expect(calledMethod()).toBe("GET");
        expect(calledUrl()).toContain(
            "tracking_id=JO0328436240"
        );
    });
});

describe("provider error status is preserved (→ uncertain)", () => {
    it("throws with the upstream 500 status", async () => {
        respondWith(
            { success: false, message: "boom" },
            { ok: false, status: 500 }
        );

        await expect(
            getMengantarOrderByOrderId("X")
        ).rejects.toMatchObject({ status: 500 });
    });

    it("throws with the upstream 401 / 429 status", async () => {
        for (const status of [401, 429]) {
            mockedFetch.mockReset();
            respondWith(
                { success: false, message: "nope" },
                { ok: false, status }
            );

            await expect(
                getMengantarOrderByOrderId("X")
            ).rejects.toMatchObject({ status });
        }
    });

    it("throws with the upstream 404 status", async () => {
        respondWith(
            { success: false, message: "Order not found" },
            { ok: false, status: 404 }
        );

        await expect(
            getMengantarOrderByOrderId("X")
        ).rejects.toMatchObject({ status: 404 });
    });
});
