/**
 * ==========================================
 * MENGANTAR CREATE-ORDER ENVELOPE REGRESSION
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-create-envelope.test.ts
 *
 * ROOT-CAUSE REGRESSION.
 *
 * The documented POST /order response is:
 *
 *   { success: true,
 *     data: [ { ORDER_ID, batch_id, cnote_no, isPaid,
 *               queueStatus, error: null, ... } ],
 *     batch_id: "...", errors: [] }
 *
 * `data` IS THE ITEM ARRAY and `batch_id` is a TOP-LEVEL SIBLING of
 * `data`. `mengantarRequest` already unwraps the envelope, so the
 * payload handed to `createMengantarOrder` is the array itself.
 * Reading `payload.data` on an array yields `undefined`, which made
 * the caller treat every successfully-created shipment as a provider
 * rejection ("Mengantar menolak pembuatan shipment") — while the
 * shipment really existed in the Mengantar dashboard.
 *
 * These tests mock only the transport, so the real `mengantarRequest`
 * unwrapping and the real `createMengantarOrder` mapping are both
 * exercised. NO request ever reaches Mengantar.
 */

jest.mock("@/lib/fetchWithRetry", () => ({
    fetchWithRetry: jest.fn(),
}));

type CreateMengantarOrder = (
    args: Parameters<
        typeof import("@/lib/mengantar").createMengantarOrder
    >[0]
) => ReturnType<typeof import("@/lib/mengantar").createMengantarOrder>;

let createMengantarOrder: CreateMengantarOrder;
let mockedFetch: jest.Mock;

beforeAll(async () => {
    // `lib/mengantar.ts` reads the key/base URL at module load and the
    // key lives in the URL path — set both before the fresh import.
    process.env.MENGANTAR_API_KEY = "TEST_API_KEY";
    process.env.MENGANTAR_BASE_URL = "https://api.example.test";

    jest.resetModules();

    mockedFetch = (
        await import("@/lib/fetchWithRetry")
    ).fetchWithRetry as unknown as jest.Mock;

    createMengantarOrder = (await import("@/lib/mengantar"))
        .createMengantarOrder;
});

beforeEach(() => {
    mockedFetch.mockReset();
});

function respondWith(json: unknown) {
    mockedFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
    } as unknown as Response);
}

const ORDER_ARGS = {
    courier: "JNE",
    pickup: {
        type: "dropOff",
        address_id: "PICKUP-ADDR",
    },
    orders: [
        {
            goodsValue: 100000,
            customerAddressDataId: "DEST-AREA",
            customerAddress: "Jl. Contoh No. 1",
            customerName: "Budi",
            customerPhone: "081234567890",
            parcelContent: "Kaos",
            weight: 1,
            quantity: 1,
        },
    ],
} as unknown as Parameters<CreateMengantarOrder>[0];

const DOCUMENTED_ITEM = {
    COD_AMOUNT: 0,
    isPaid: true,
    queueStatus: "COMPLETED",
    _id: "697c58034fa61abe7c700da9",
    batch_id: "697c58034fa61abe7c700da6",
    ORDER_ID: "260130OVBBOO",
    cnote_no: "11000009548385",
    error: null,
    status: "active",
    statusCategory: "active",
};

describe("createMengantarOrder — documented POST /order envelope", () => {
    it("reads the item array from `data` (the contract that was misread)", async () => {
        respondWith({
            success: true,
            data: [DOCUMENTED_ITEM],
            batch: "26013014BBQFMM",
            batch_id: "697c58034fa61abe7c700da6",
            courier: "JNE",
            errors: [],
        });

        const result = await createMengantarOrder(ORDER_ARGS);

        // THE BUG: this was `[]` because `array.data` is undefined.
        expect(result.data).toHaveLength(1);
        expect(result.data[0].ORDER_ID).toBe("260130OVBBOO");
        expect(result.data[0].cnote_no).toBe("11000009548385");
        expect(result.data[0].isPaid).toBe(true);
        expect(result.batch_id).toBe(
            "697c58034fa61abe7c700da6"
        );
    });

    it("does NOT discard a created order when cnote_no is null (unpaid)", async () => {
        respondWith({
            success: true,
            data: [
                {
                    ORDER_ID: "260130OVBBOO",
                    batch_id: "BATCH-2",
                    cnote_no: null,
                    isPaid: false,
                    queueStatus: "PENDING",
                    error: null,
                },
            ],
            batch_id: "BATCH-2",
            errors: [],
        });

        const result = await createMengantarOrder(ORDER_ARGS);

        expect(result.data).toHaveLength(1);
        expect(result.data[0].ORDER_ID).toBe("260130OVBBOO");
        expect(result.data[0].cnote_no).toBeNull();
    });

    it("recovers batch_id from the item when the sibling is absent", async () => {
        respondWith({
            success: true,
            data: [
                {
                    ORDER_ID: "ORD-1",
                    batch_id: "BATCH-FROM-ITEM",
                    cnote_no: "CN-1",
                    isPaid: true,
                },
            ],
            errors: [],
        });

        const result = await createMengantarOrder(ORDER_ARGS);

        expect(result.batch_id).toBe("BATCH-FROM-ITEM");
    });

    it("still tolerates a legacy nested { data: [...] } envelope", async () => {
        respondWith({
            success: true,
            data: {
                data: [
                    {
                        ORDER_ID: "ORD-9",
                        batch_id: "BATCH-9",
                        cnote_no: "CN-9",
                        isPaid: true,
                    },
                ],
                batch_id: "BATCH-9",
            },
        });

        const result = await createMengantarOrder(ORDER_ARGS);

        expect(result.data).toHaveLength(1);
        expect(result.data[0].ORDER_ID).toBe("ORD-9");
        expect(result.batch_id).toBe("BATCH-9");
    });

    it("returns an empty list (never throws) for an empty data array", async () => {
        respondWith({
            success: true,
            data: [],
            batch_id: "",
            errors: [],
        });

        const result = await createMengantarOrder(ORDER_ARGS);

        expect(result.data).toEqual([]);
        expect(result.batch_id).toBe("");
    });
});
