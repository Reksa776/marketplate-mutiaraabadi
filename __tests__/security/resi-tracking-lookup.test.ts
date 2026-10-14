/**
 * ==========================================================
 * PUBLIC RESI TRACKING — ENDPOINT, PURE LOGIC & STRUCTURE
 * ==========================================================
 *
 * Pins the server side of the public "Lacak Resi" box on `/lacak`:
 *
 *   - a resi is normalized and validated before anything is queried,
 *   - an UNKNOWN resi gets ONE uniform answer that discloses nothing,
 *   - a known resi returns shipment facts only: no name, phone, e-mail,
 *     address, item, total, COD amount, order number, order id, token,
 *     payment reference or API key can even be selected,
 *   - a provider failure is disclosed and NEVER becomes a status,
 *   - the route is READ-ONLY (no create/update/delete, no transaction,
 *     no ShipmentJob, no shipment, no pickup),
 *   - the response is `no-store` and rate limited per client AND per resi,
 *   - the page/component layer only ever calls this one GET endpoint.
 *
 * Provider and database are mocked; no network, no courier API.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "public-resi-tracking-test-secret";

/* Trusted proxy so the per-client bucket keys on a real IP literal. */
process.env.TRUSTED_PROXY = "1";

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findFirst: jest.fn(),
            findMany: jest.fn(async () => []),
            update: jest.fn(async () => ({})),
            updateMany: jest.fn(async () => ({ count: 0 })),
            create: jest.fn(async () => ({})),
        },
        shipmentJob: {
            create: jest.fn(async () => ({})),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    getMengantarOrderByTracking: jest.fn(),
}));

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

import { prisma } from "@/lib/prisma";
import { getMengantarOrderByTracking } from "@/lib/mengantar";
import { GET } from "@/app/api/tracking/resi/route";
import {
    RESI_INVALID_MESSAGE,
    RESI_MAX_TIMELINE_ENTRIES,
    RESI_NOT_FOUND_MESSAGE,
    RESI_PROVIDER_GONE_NOTE,
    RESI_PROVIDER_UNAVAILABLE_MESSAGE,
    RESI_STORED_ONLY_NOTE,
    buildResiTrackingView,
    isValidResi,
    normalizeResi,
    resolveResiStatus,
} from "@/lib/tracking/resi-lookup";

const mockedOrder = prisma.order as unknown as {
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
};

const mockedJob = prisma.shipmentJob as unknown as {
    create: jest.Mock;
    updateMany: jest.Mock;
};

const mockedTracking =
    getMengantarOrderByTracking as unknown as jest.Mock;

/* ==========================================
 * FIXTURES
 * ========================================== */

const RESI = "JT1234567890";
const RESI_LOWER = "jt1234567890";

const ORDER = {
    shippingProvider: "MENGANTAR",
    providerCourier: "JT",
    shippingCourier: "JT",
    shippingService: "REG",
    trackingNumber: RESI,
    shipmentStatus: "IN_TRANSIT",
};

const PROVIDER_HIT = {
    orderId: "PROVIDER-ORDER-ID",
    trackingNumber: RESI,
    status: "ON DELIVERY",
    statusCategory: "ON DELIVERY",
    isDeleted: false,
    history: [
        { date: "2026-10-13 08:00", desc: "Paket diterima di hub Jakarta" },
        { date: "2026-10-14 09:30", desc: "Paket sedang diantar" },
    ],
};

function request(
    resi: string | null,
    ip = "203.0.113.10"
): Request {
    const query = resi === null ? "" : `?resi=${encodeURIComponent(resi)}`;

    return new Request(
        `https://mutiaraabadisnack.com/api/tracking/resi${query}`,
        { headers: { "x-forwarded-for": ip } }
    );
}

async function body(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
    mockedOrder.findFirst.mockReset();
    mockedOrder.findFirst.mockResolvedValue(null);
    mockedOrder.update.mockClear();
    mockedOrder.updateMany.mockClear();
    mockedOrder.create.mockClear();
    mockedJob.create.mockClear();
    mockedJob.updateMany.mockClear();
    mockedTracking.mockReset();
    mockedTracking.mockResolvedValue(null);
});

/* ==========================================
 * 1. PURE INPUT RULES
 * ========================================== */

describe("resi normalization", () => {
    test("accepts the shapes couriers issue", () => {
        expect(normalizeResi("JT1234567890")).toBe("JT1234567890");
        expect(normalizeResi(" jt1234567890 ")).toBe("JT1234567890");
        expect(normalizeResi("JT 1234 5678")).toBe("JT12345678");
        expect(normalizeResi("JO-0123456789")).toBe("JO-0123456789");

        /* Six characters is the shortest accepted shape. */
        expect(normalizeResi("JT1234")).toBe("JT1234");
    });

    test("rejects anything that cannot be a resi", () => {
        for (const value of [
            "",
            "   ",
            "JT12",
            "JT123",
            "a".repeat(41),
            "JT1234567890#frag",
            "JT1234567890&x=1",
            "resi<script>",
            "١٢٣٤٥٦٧٨٩",
            "------",
            null,
            undefined,
            42,
            {},
        ]) {
            expect(normalizeResi(value)).toBeNull();
            expect(isValidResi(value)).toBe(false);
        }
    });
});

describe("status mapping never invents a state", () => {
    test("a provider category wins, then the stored status", () => {
        expect(
            resolveResiStatus({
                providerStatus: "PICKED UP",
                storedStatus: "CREATED",
            })
        ).toEqual({ code: "PICKED_UP", label: "Paket sudah diambil kurir" });

        expect(
            resolveResiStatus({ providerStatus: null, storedStatus: "DELIVERED" })
        ).toEqual({ code: "DELIVERED", label: "Paket sudah diterima" });
    });

    test("an informational provider category is ignored, not guessed", () => {
        expect(
            resolveResiStatus({
                providerStatus: "ACTIVE/WAITING NEXT PROCESS",
                storedStatus: "IN_TRANSIT",
            })
        ).toEqual({ code: "IN_TRANSIT", label: "Paket dalam perjalanan" });
    });

    test("with nothing known the status says so", () => {
        expect(resolveResiStatus({})).toEqual({
            code: null,
            label: "Status belum tersedia",
        });
    });
});

/* ==========================================
 * 2. VALIDATION / NOT FOUND / UNIFORMITY
 * ========================================== */

describe("the endpoint validates before it queries", () => {
    test("an invalid resi is a 400 and touches nothing", async () => {
        for (const value of ["", "ab", "JT1234567890#x", "<script>"]) {
            const response = await GET(
                request(value, "203.0.113.11")
            );

            expect(response.status).toBe(400);
            expect((await body(response)).message).toBe(
                RESI_INVALID_MESSAGE
            );
            expect(response.headers.get("cache-control")).toContain(
                "no-store"
            );
        }

        expect(mockedOrder.findFirst).not.toHaveBeenCalled();
        expect(mockedTracking).not.toHaveBeenCalled();
    });

    test("a missing parameter is a 400, not a query", async () => {
        const response = await GET(request(null, "203.0.113.12"));

        expect(response.status).toBe(400);
        expect(mockedOrder.findFirst).not.toHaveBeenCalled();
    });

    test("the resi is normalized BEFORE the database sees it", async () => {
        await GET(request(RESI_LOWER, "203.0.113.13"));

        expect(mockedOrder.findFirst).toHaveBeenCalledTimes(1);

        const args = mockedOrder.findFirst.mock.calls[0][0];

        expect(args.where).toEqual({ trackingNumber: RESI });
    });
});

describe("an unknown resi discloses nothing", () => {
    test("a 404 with one uniform message and no data payload", async () => {
        const first = await GET(request("JO0000000001"));
        const second = await GET(request("JO0000000002"));

        expect(first.status).toBe(404);
        expect(second.status).toBe(404);

        const firstBody = await body(first);
        const secondBody = await body(second);

        expect(firstBody).toEqual({
            success: false,
            message: RESI_NOT_FOUND_MESSAGE,
        });
        // Identical answer → the route cannot confirm a resi exists.
        expect(firstBody).toEqual(secondBody);
        expect(firstBody).not.toHaveProperty("data");

        expect(mockedTracking).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 3. A KNOWN RESI
 * ========================================== */

describe("a known resi returns shipment facts only", () => {
    test("the provider read becomes the status, timeline and last update", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockResolvedValue(PROVIDER_HIT);

        const response = await GET(request(RESI));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain(
            "no-store"
        );

        const payload = await body(response);
        const data = payload.data as Record<string, unknown>;

        expect(payload.success).toBe(true);
        expect(data.waybill).toBe(RESI);
        expect(data.courier).toBe("JT");
        expect(data.service).toBe("REG");
        expect(data.status).toEqual({
            code: "IN_TRANSIT",
            label: "Paket dalam perjalanan",
        });
        expect(data.delivered).toBe(false);
        expect(data.source).toBe("PROVIDER");
        expect(data.notes).toEqual([]);

        const timeline = data.timeline as { date: string; description: string }[];

        // NEWEST FIRST, and the newest scan is the "last update".
        expect(timeline.map((entry) => entry.description)).toEqual([
            "Paket sedang diantar",
            "Paket diterima di hub Jakarta",
        ]);
        expect(data.lastUpdate).toBe("2026-10-14 09:30");

        // The provider lookup is the documented read-only integration.
        expect(mockedTracking).toHaveBeenCalledWith(RESI);
    });

    test("only shipment columns are selected, and no PII is serialized", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockResolvedValue(PROVIDER_HIT);

        const response = await GET(request(RESI));

        const args = mockedOrder.findFirst.mock.calls[0][0];

        expect(Object.keys(args.select).sort()).toEqual(
            [
                "providerCourier",
                "shippingCourier",
                "shippingProvider",
                "shippingService",
                "shipmentStatus",
                "trackingNumber",
            ].sort()
        );

        const payload = await body(response);
        const wire = JSON.stringify(payload);

        for (const secret of [
            "08123456789",
            "628123456789",
            "rahasia@example.com",
            "Jl. Rahasia",
            "ORD-1759000000000-ab12cd34",
            "PAY-REF-999",
            "deadbeefhash",
            "codAmount",
            "customerEmail",
            "recipientName",
            "providerShipmentId",
            "providerBatchId",
            "MENGANTAR_API_KEY",
            "gos_",
            "guestAccessToken",
        ]) {
            expect(wire).not.toContain(secret);
        }

        // The view has exactly these keys — nothing can be added by accident.
        expect(Object.keys(payload.data as object).sort()).toEqual([
            "courier",
            "delivered",
            "lastUpdate",
            "notes",
            "service",
            "source",
            "status",
            "timeline",
            "waybill",
        ]);
    });

    test("the public response never exceeds the entry cap", () => {
        const view = buildResiTrackingView({
            waybill: RESI,
            order: ORDER,
            fetched: {
                status: "ON DELIVERY",
                statusCategory: "ON DELIVERY",
                trackingNumber: RESI,
                history: Array.from({ length: 120 }, (_, index) => ({
                    date: `2026-10-${String((index % 28) + 1).padStart(2, "0")} 10:00`,
                    desc: `Scan ${index}`,
                })),
            },
        });

        expect(view.timeline.length).toBe(RESI_MAX_TIMELINE_ENTRIES);
    });

    test("a legacy (non-Mengantar) shipment shows the stored state with a note", async () => {
        mockedOrder.findFirst.mockResolvedValue({
            ...ORDER,
            shippingProvider: "RAJAONGKIR",
            shipmentStatus: "PICKED_UP",
        });

        const response = await GET(request(RESI));

        const data = (await body(response)).data as Record<string, unknown>;

        expect(data.status).toEqual({
            code: "PICKED_UP",
            label: "Paket sudah diambil kurir",
        });
        expect(data.notes).toEqual([RESI_STORED_ONLY_NOTE]);
        expect(data.source).toBe("STORED");
        expect(data.timeline).toEqual([]);

        // No un-integrated provider endpoint is ever called.
        expect(mockedTracking).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 4. PROVIDER FAILURE / DELETION
 * ========================================== */

describe("a provider failure never becomes a status", () => {
    test("a thrown provider read keeps the stored state and discloses the gap", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockRejectedValue(
            new Error("mengantar unavailable")
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = await GET(request(RESI));

        errorSpy.mockRestore();

        const data = (await body(response)).data as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(data.status).toEqual({
            code: "IN_TRANSIT",
            label: "Paket dalam perjalanan",
        });
        expect(data.notes).toEqual([
            RESI_PROVIDER_UNAVAILABLE_MESSAGE,
        ]);
        expect(data.source).toBe("STORED");
        expect(data.delivered).toBe(false);
    });

    test("a provider MISS does not invent history", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockResolvedValue(null);

        const response = await GET(request(RESI));

        const data = (await body(response)).data as Record<string, unknown>;

        expect(data.status).toEqual({
            code: "IN_TRANSIT",
            label: "Paket dalam perjalanan",
        });
        expect(data.timeline).toEqual([]);
        expect(data.notes).toEqual([]);
        expect(data.lastUpdate).toBeNull();
    });

    test("a provider-deleted shipment is disclosed as a fact", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockResolvedValue({
            ...PROVIDER_HIT,
            isDeleted: true,
        });

        const response = await GET(request(RESI));

        const data = (await body(response)).data as Record<string, unknown>;

        expect(data.notes).toEqual([RESI_PROVIDER_GONE_NOTE]);
    });

    test("a database failure is a 503, never a fabricated status", async () => {
        mockedOrder.findFirst.mockRejectedValue(
            new Error("db down")
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = await GET(request(RESI));

        errorSpy.mockRestore();

        expect(response.status).toBe(503);
        expect((await body(response)).success).toBe(false);
    });
});

/* ==========================================
 * 5. READ-ONLY + RATE LIMITING
 * ========================================== */

describe("the lookup never writes and never floods", () => {
    test("no shipment, job or order is created or updated", async () => {
        mockedOrder.findFirst.mockResolvedValue(ORDER);
        mockedTracking.mockResolvedValue(PROVIDER_HIT);

        await GET(request(RESI));

        expect(mockedOrder.update).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedOrder.create).not.toHaveBeenCalled();
        expect(mockedJob.create).not.toHaveBeenCalled();
        expect(mockedJob.updateMany).not.toHaveBeenCalled();
    });

    test("one client cannot hammer the endpoint", async () => {
        const ip = "203.0.113.77";

        let last: Response | null = null;

        for (let index = 0; index < 25; index++) {
            last = await GET(request(`JO000000010${index}`, ip));
        }

        expect(last?.status).toBe(429);
        expect(last?.headers.get("retry-after")).toBeTruthy();
        expect(last?.headers.get("cache-control")).toContain("no-store");
        expect((await body(last as Response)).success).toBe(false);
    });

    test("a single resi cannot be probed endlessly", async () => {
        const resi = "JO9999999999";

        let statuses: number[] = [];

        for (let index = 0; index < 40; index++) {
            const response = await GET(
                request(resi, `198.51.100.${index}`)
            );

            statuses.push(response.status);
        }

        expect(statuses).toContain(429);
        expect(statuses[statuses.length - 1]).toBe(429);
    });
});

/* ==========================================
 * 6. STRUCTURAL GUARDS (no DOM harness)
 * ========================================== */

function readSource(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

describe("the endpoint and the page stay minimal", () => {
    const route = readSource("app/api/tracking/resi/route.ts");
    const component = readSource("components/orders/ResiLookup.tsx");
    const page = readSource("app/lacak/page.tsx");

    test("the route performs no write of any kind", () => {
        const code = stripComments(route);

        for (const forbidden of [
            ".update(",
            ".updateMany(",
            ".create(",
            ".upsert(",
            ".delete(",
            "$executeRaw",
            "$transaction",
            "processShipmentJobs",
            "createShipmentForOrder",
        ]) {
            expect(code).not.toContain(forbidden);
        }
    });

    test("the route keeps the province of the Mengantar key on the server", () => {
        const code = stripComments(route);

        expect(code).not.toContain("MENGANTAR_API_KEY");
        expect(code).not.toContain("apiKey");
        expect(route).toContain("NO_STORE_HEADERS");
        expect(route).toContain("publicResiLookup");
        expect(route).toContain("publicResiLookupIdentity");
    });

    test("the component only ever calls the public resi endpoint", () => {
        const code = stripComments(component);

        expect(code).toContain("`/api/tracking/resi?resi=");
        expect(code).toContain("cache: \"no-store\"");

        expect(code).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
        expect(code).not.toContain("prisma");
        expect(code).not.toContain("/api/orders");
        expect(code).not.toContain("setInterval");
        expect(code).not.toContain("setTimeout");

        for (const field of [
            "address",
            "recipientName",
            "customerEmail",
            "phone",
            "codAmount",
            "orderNumber",
            "guestAccessToken",
        ]) {
            expect(code).not.toContain(field);
        }
    });

    test("the page renders BOTH ways in, and keeps the old one", () => {
        expect(page).toContain("ResiLookup");
        expect(page).toContain("TrackingLookup");
        expect(page).toContain("noindex: true");
        expect(page).toContain("sanitizeOrderNumberParam");
        expect(page).not.toContain("fetch(");
        expect(page).not.toContain("prisma");
    });

    test("the stale tracking timeline component stays gone", () => {
        expect(
            existsSync(
                resolve(process.cwd(), "components/orders/TrackingTimeline.tsx")
            )
        ).toBe(false);
    });
});
