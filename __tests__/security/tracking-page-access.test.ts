/**
 * ==========================================================
 * PUBLIC TRACKING PAGE (/lacak) — ACCESS & READ-ONLY TESTS
 * ==========================================================
 *
 * The page behind the WhatsApp tracking link serves shipment facts and
 * nothing else, and it must never become a way to read somebody else's
 * order. These tests pin that:
 *
 *   - `?pesanan=` is a PREFILL HINT: it is only ever looked up INSIDE
 *     the list `GET /api/orders` returned, which is scoped to the
 *     guest access token cookie (or the session). No cookie → nothing.
 *   - a token for order A does not open order B.
 *   - an EXPIRED token is answered by the OTP recovery path, not by a
 *     blank page and not by leaked data.
 *   - a provider failure degrades to the stored status with an honest
 *     note (never a raw error), and a delivered/completed order stays
 *     readable.
 *   - the components fetch ONLY authorized GET endpoints, render no
 *     address/phone/e-mail/item/total/payment/token field, and never
 *     poll.
 *
 * The ownership assertions drive the REAL `authorizeOrderRequest` /
 * `listGuestAccessibleOrderIds` with a mocked prisma and cookie jar.
 * The rendering assertions are STRUCTURAL (source-level) on purpose:
 * this project has no DOM test harness, so instead of pretending a
 * component rendered, they pin the invariants that are checkable without
 * one, and the behaviour they depend on is covered by the pure helpers
 * tested above them.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "tracking-page-access-test-secret";

/* Distinct client IP per test: the limiters below are real and shared. */
process.env.TRUSTED_PROXY = "1";

const mockCookieJar = {
    values: {} as Record<string, string>,
    throwOnRead: false,
};

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => {
        if (mockCookieJar.throwOnRead) {
            throw new Error("no request scope");
        }

        return {
            get: (name: string) =>
                mockCookieJar.values[name] === undefined
                    ? undefined
                    : {
                          name,
                          value: mockCookieJar.values[name],
                      },
            getAll: () =>
                Object.entries(mockCookieJar.values).map(
                    ([name, value]) => ({ name, value })
                ),
        };
    }),
}));

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
    },
}));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { auth } from "@/auth";
import {
    authorizeOrderRequest,
    listGuestAccessibleOrderIds,
    readGuestOrderTokenFromCookies,
} from "@/lib/guest-order-access";
import {
    buildGuestOrderCookieValue,
    generateGuestAccessToken,
    guestAccessTokenExpiry,
    guestOrderCookieName,
    hashGuestAccessToken,
} from "@/lib/guest-identity";
import {
    SHIPMENT_STAGE_LABELS,
    TRACKING_UPDATE_UNAVAILABLE_NOTE,
    findAccessibleOrder,
    matchesOrderNumber,
    parseTrackingPayload,
    resolveProviderRead,
    resolveShipmentStage,
    sanitizeOrderNumberParam,
    shipmentStageHint,
    shouldReadProvider,
} from "@/lib/tracking/tracking-page";

const mockedAuth = auth as unknown as jest.Mock;

const ORDER_A = {
    id: 101,
    orderNumber: "ORD-1700000000000-aaaaaaaa",
};

const ORDER_B = {
    id: 202,
    orderNumber: "ORD-1700000000000-bbbbbbbb",
};

const TOKEN_A = generateGuestAccessToken();

function orderRow(input: {
    id: number;
    userId?: string | null;
    token?: string | null;
    expiresAt?: Date | null;
}) {
    return {
        id: input.id,
        userId: input.userId ?? null,
        guestAccessTokenHash: input.token
            ? hashGuestAccessToken(input.token)
            : null,
        guestAccessTokenExpiresAt: input.expiresAt ?? null,
    };
}

function requestFor(orderId: number, ip: string): Request {
    return new Request(
        `https://mutiaraabadisnack.com/api/orders/${orderId}`,
        { headers: { "x-forwarded-for": ip } }
    );
}

let ipCounter = 0;

function nextIp(): string {
    ipCounter += 1;

    return `203.0.113.${ipCounter}`;
}

beforeEach(() => {
    jest.clearAllMocks();

    mockCookieJar.values = {};
    mockCookieJar.throwOnRead = false;

    mockedAuth.mockResolvedValue(null);
    mockOrder.update.mockResolvedValue({});
});

/* ==========================================
 * 1. OWNERSHIP INVARIANTS
 * ========================================== */

describe("no cookie, no session, nothing readable", () => {
    test("an order id alone is answered as not found", async () => {
        mockOrder.findUnique.mockResolvedValue(
            orderRow({ id: ORDER_A.id, token: TOKEN_A, expiresAt: guestAccessTokenExpiry() })
        );

        const access = await authorizeOrderRequest(
            requestFor(ORDER_A.id, nextIp()),
            ORDER_A.id
        );

        expect(access.ok).toBe(false);

        if (!access.ok) {
            expect(access.status).toBe(404);
            expect(access.message).toBe("Pesanan tidak ditemukan.");
        }
    });

    test("no cookie means the page has no order to show at all", async () => {
        mockOrder.findMany.mockResolvedValue([]);

        /* Exactly what the page's first fetch would see. */
        const orders = await listGuestAccessibleOrderIds();

        expect(orders).toEqual([]);
        expect(
            findAccessibleOrder(
                [],
                ORDER_A.orderNumber
            )
        ).toBeNull();
    });

    test("an unreadable cookie store fails closed", async () => {
        mockCookieJar.throwOnRead = true;

        expect(await readGuestOrderTokenFromCookies(ORDER_A.id)).toBeNull();
    });
});

describe("order A's token does not open order B", () => {
    test("presenting another order's token is a 404", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_B.id)] =
            buildGuestOrderCookieValue(ORDER_B.id, TOKEN_A);

        mockOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_B.id,
                /* Different secret stored for B. */
                token: generateGuestAccessToken(),
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const access = await authorizeOrderRequest(
            requestFor(ORDER_B.id, nextIp()),
            ORDER_B.id
        );

        expect(access.ok).toBe(false);

        if (!access.ok) {
            expect(access.status).toBe(404);
        }
    });

    test("the page only ever matches inside the accessible list", () => {
        /* Browser may see A only… */
        expect(
            findAccessibleOrder([ORDER_A], ORDER_B.orderNumber)
        ).toBeNull();

        /* …and asking for A still works, case-insensitively. */
        expect(
            findAccessibleOrder(
                [ORDER_A],
                ORDER_A.orderNumber.toLowerCase()
            )
        ).toEqual(ORDER_A);
    });

    test("a valid token does open its own order", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_A.id)] =
            buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: TOKEN_A,
                expiresAt: guestAccessTokenExpiry(),
            })
        );

        const access = await authorizeOrderRequest(
            requestFor(ORDER_A.id, nextIp()),
            ORDER_A.id
        );

        expect(access.ok).toBe(true);

        if (access.ok) {
            expect(access.via).toBe("TOKEN");
        }
    });
});

describe("an expired token is routed to the OTP recovery path", () => {
    test("the genuine-but-expired token is a 401 that names recovery", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_A.id)] =
            buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockOrder.findUnique.mockResolvedValue(
            orderRow({
                id: ORDER_A.id,
                token: TOKEN_A,
                expiresAt: new Date(Date.now() - 60_000),
            })
        );

        const access = await authorizeOrderRequest(
            requestFor(ORDER_A.id, nextIp()),
            ORDER_A.id
        );

        expect(access.ok).toBe(false);

        if (!access.ok) {
            expect(access.status).toBe(401);
            expect(access.message).toMatch(/kedaluwarsa/i);
            expect(access.message).toMatch(/kode verifikasi/i);
        }
    });

    test("an expired order is not listed as accessible", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_A.id)] =
            buildGuestOrderCookieValue(ORDER_A.id, TOKEN_A);

        mockOrder.findMany.mockResolvedValue([
            orderRow({
                id: ORDER_A.id,
                token: TOKEN_A,
                expiresAt: new Date(Date.now() - 60_000),
            }),
        ]);

        expect(await listGuestAccessibleOrderIds()).toEqual([]);
    });
});

/* ==========================================
 * 2. PREFILL HINT HANDLING
 * ========================================== */

describe("the prefill parameter", () => {
    test("a normal order number is accepted", () => {
        expect(sanitizeOrderNumberParam(ORDER_A.orderNumber)).toBe(
            ORDER_A.orderNumber
        );

        expect(sanitizeOrderNumberParam(`  ${ORDER_A.orderNumber}  `)).toBe(
            ORDER_A.orderNumber
        );
    });

    test("anything that is not an order-number-shaped value is dropped", () => {
        for (const value of [
            undefined,
            null,
            123,
            {},
            [],
            "",
            "   ",
            "<script>alert(1)</script>",
            "ORD-1-a;DROP",
            "ORD 1700 abcd",
            "a".repeat(41),
        ]) {
            expect(sanitizeOrderNumberParam(value)).toBeNull();
        }
    });

    test("order numbers compare without case", () => {
        expect(
            matchesOrderNumber("ord-1-a", "ORD-1-A")
        ).toBe(true);

        expect(matchesOrderNumber("ORD-1-a", null)).toBe(false);
        expect(matchesOrderNumber("", "ORD-1-a")).toBe(false);
    });
});

/* ==========================================
 * 3. SHIPMENT STAGE (stored state)
 * ========================================== */

describe("stored state maps to one honest stage", () => {
    test("delivered and completed stay readable", () => {
        expect(
            resolveShipmentStage({
                status: "COMPLETED",
                shippingProvider: "MENGANTAR",
                trackingNumber: "JT1",
                shipmentStatus: "DELIVERED",
            })
        ).toBe("DELIVERED");

        expect(
            resolveShipmentStage({
                status: "COMPLETED",
                shippingProvider: "MENGANTAR",
                trackingNumber: null,
                shipmentStatus: null,
            })
        ).toBe("COMPLETED");

        expect(SHIPMENT_STAGE_LABELS.DELIVERED).toBe("Terkirim");
        expect(SHIPMENT_STAGE_LABELS.COMPLETED).toBe("Selesai");
        expect(shipmentStageHint("DELIVERED")).toBeNull();
    });

    test("each stored status maps to its own stage", () => {
        const cases: Array<[string, string]> = [
            ["PICKED_UP", "IN_TRANSIT"],
            ["IN_TRANSIT", "IN_TRANSIT"],
            ["CREATED", "AWAITING_PICKUP"],
            ["SHIPPING_PAID", "AWAITING_PICKUP"],
            ["WAITING_SHIPPING_PAYMENT", "AWAITING_HANDOVER"],
            ["PAYING", "AWAITING_HANDOVER"],
            ["RETURNED", "RETURNED"],
            ["UNDELIVERED", "UNDELIVERED"],
            ["CANCELLED", "CANCELLED"],
            ["DELETED", "DELETED"],
        ];

        for (const [shipmentStatus, expected] of cases) {
            expect(
                resolveShipmentStage({
                    status: "SHIPPED",
                    shippingProvider: "RAJAONGKIR",
                    trackingNumber: "X",
                    shipmentStatus,
                })
            ).toBe(expected);
        }
    });

    test("an unpaid, unshipped order says exactly that", () => {
        expect(
            resolveShipmentStage({
                status: "PENDING",
                paymentStatus: "PENDING",
                shippingProvider: null,
                trackingNumber: null,
                shipmentStatus: null,
            })
        ).toBe("AWAITING_PAYMENT");

        expect(
            resolveShipmentStage({
                status: "PAID",
                paymentStatus: "PAID",
                shippingProvider: null,
                trackingNumber: null,
                shipmentStatus: null,
            })
        ).toBe("PREPARING");

        expect(shipmentStageHint("AWAITING_PAYMENT")).toMatch(
            /belum dibayar/i
        );

        expect(shipmentStageHint("AWAITING_HANDOVER")).toMatch(
            /belum diserahkan/i
        );
    });

    test("a provider read is skipped when there is nothing to ask", () => {
        expect(
            shouldReadProvider({
                shippingProvider: null,
                trackingNumber: null,
            })
        ).toBe(false);

        expect(
            shouldReadProvider({
                shippingProvider: "mengantar",
                trackingNumber: null,
            })
        ).toBe(true);

        expect(
            shouldReadProvider({
                shippingProvider: "RAJAONGKIR",
                trackingNumber: "JNE1",
            })
        ).toBe(true);
    });
});

/* ==========================================
 * 4. PROVIDER DEGRADATION
 * ========================================== */

describe("a failed provider read degrades instead of erroring", () => {
    test("a malformed or empty payload never throws", () => {
        for (const payload of [
            null,
            undefined,
            {},
            { manifest: "nope" },
            { manifest: [null, 1, {}] },
            { summary: 5, deliveryStatus: "x" },
        ]) {
            const view = parseTrackingPayload(payload);

            expect(Array.isArray(view.entries)).toBe(true);
            expect(view.delivered).toBe(false);
        }
    });

    test("both provider shapes normalize to newest-first entries", () => {
        const view = parseTrackingPayload({
            summary: { status: "ON PROCESS" },
            manifest: [
                {
                    manifest_date: "2026-10-01",
                    manifest_time: "08:00",
                    manifest_description: "Paket diterima",
                    city_name: "JAKARTA",
                },
                {
                    manifest_date: "2026-10-02",
                    manifest_time: "10:00",
                    manifest_description: "Paket dikirim",
                    city_name: "",
                },
            ],
        });

        expect(view.entries).toHaveLength(2);
        expect(view.entries[0].description).toBe("Paket dikirim");
        expect(view.entries[0].date).toBe("2026-10-02 10:00");
        expect(view.entries[0].location).toBeNull();
        expect(view.entries[1].location).toBe("JAKARTA");
    });

    test("a 400/500 body degrades to the STORED status, never a raw error", () => {
        for (const response of [
            {
                ok: false,
                body: {
                    success: false,
                    message: "Gagal mengambil tracking paket.",
                },
            },
            { ok: false, body: { success: false } },
            { ok: false, body: null },
            { ok: true, body: { success: false } },
            { ok: true, body: null },
            { ok: true, body: "bukan json" },
            null,
        ]) {
            const result = resolveProviderRead(response);

            expect(result.view).toBeNull();
            expect(result.note).toBe(true);
        }
    });

    test("the note is additive: the stored stage is still what is shown", () => {
        const stage = resolveShipmentStage({
            status: "SHIPPED",
            shippingProvider: "MENGANTAR",
            trackingNumber: "JT1",
            shipmentStatus: "IN_TRANSIT",
        });

        expect(SHIPMENT_STAGE_LABELS[stage]).toBe(
            "Dalam Perjalanan"
        );
        expect(
            resolveProviderRead({ ok: false, body: null }).view
        ).toBeNull();
        expect(TRACKING_UPDATE_UNAVAILABLE_NOTE).not.toBe("");
    });

    test("a successful read is used and raises no note", () => {
        const result = resolveProviderRead({
            ok: true,
            body: {
                success: true,
                data: {
                    manifest: [
                        {
                            manifest_date: "2026-10-02",
                            manifest_time: "10:00",
                            manifest_description: "Paket dikirim",
                        },
                    ],
                },
            },
        });

        expect(result.note).toBe(false);
        expect(result.view?.entries).toHaveLength(1);
        expect(result.view?.entries[0].description).toBe(
            "Paket dikirim"
        );

        /* An empty manifest is not a failure either. */
        const empty = resolveProviderRead({
            ok: true,
            body: { success: true, data: { manifest: [] } },
        });

        expect(empty.note).toBe(false);
        expect(empty.view?.entries).toEqual([]);
    });

    test("a delivered pod is surfaced", () => {
        const view = parseTrackingPayload({
            deliveryStatus: {
                status: "DELIVERED",
                pod_receiver: "Budi",
                pod_date: "2026-10-03",
                pod_time: "14:20",
            },
        });

        expect(view.delivered).toBe(true);
        expect(view.deliveredReceiver).toBe("Budi");
        expect(view.deliveredAt).toBe("2026-10-03 14:20");
    });
});

/* ==========================================
 * 5. STRUCTURAL GUARDS (no DOM harness)
 * ========================================== */

function readSource(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * Strip comments before asserting on what the CODE touches.
 *
 * A doc comment is allowed to NAME the fields the component refuses to
 * read (that is the point of it); only real code must never mention
 * them.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

describe("the page and its components stay read-only and minimal", () => {
    const panel = readSource(
        "components/orders/ShipmentTrackingPanel.tsx"
    );

    const lookup = readSource(
        "components/orders/TrackingLookup.tsx"
    );

    const page = readSource("app/lacak/page.tsx");

    test("the page is noindex and performs no data access of its own", () => {
        expect(page).toContain("noindex: true");
        expect(page).toContain("sanitizeOrderNumberParam");
        expect(page).not.toContain("fetch(");
        expect(page).not.toContain("prisma");
    });

    test("only authorized GET endpoints are used, and nothing is mutated", () => {
        for (const source of [panel, lookup]) {
            expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
            expect(source).not.toContain("prisma");
        }

        /* The lookup may only list what the browser already owns. */
        expect(lookup).toContain('fetch("/api/orders"');

        /* The panel reads the two ownership-guarded endpoints. */
        expect(panel).toContain("`/api/orders/${orderId}`");
        expect(panel).toContain(
            "`/api/orders/${orderId}/tracking`"
        );
    });

    test("no sensitive order field is ever read or rendered", () => {
        const panelCode = stripComments(panel);
        const lookupCode = stripComments(lookup);

        for (const field of [
            "address",
            "recipientName",
            "customerEmail",
            "paymentNo",
            "qrString",
            "guestAccessToken",
            "total",
            "paidAt",
        ]) {
            expect(panelCode).not.toContain(field);
            expect(lookupCode).not.toContain(field);
        }

        /*
         * The projection is an explicit allowlist, so a new field in the
         * order response cannot leak in by itself.
         */
        expect(panel).toContain("const TRACKED_FIELDS = [");
        expect(panel).toContain('"shipmentStatus"');
        expect(panel).not.toContain('"address"');
    });

    test("nothing polls the provider", () => {
        for (const source of [panel, lookup, page]) {
            expect(source).not.toContain("setInterval");
            expect(source).not.toContain("setTimeout");
        }
    });

    test("the help hand-off asks the server for the admin number", () => {
        expect(panel).toContain(
            "`/api/orders/${orderId}/whatsapp-confirm?intent=problem`"
        );

        /* The number itself can never come from here. */
        expect(panel).not.toMatch(/wa\.me\/\+?\d/);
        expect(panel).not.toContain("wa.me/");

        /*
         * The failure wording comes from the shared pure module (whose
         * value is asserted here so a rename can never make the panel
         * silently reference nothing).
         */
        expect(panel).toContain("TRACKING_UPDATE_UNAVAILABLE_NOTE");
        expect(TRACKING_UPDATE_UNAVAILABLE_NOTE).toMatch(
            /belum tersedia saat ini/i
        );

        /* The degradation decision itself is the tested pure helper. */
        expect(panel).toContain("resolveProviderRead(");
    });

    test("the stale duplicate timeline is gone", () => {
        expect(
            existsSync(
                resolve(
                    process.cwd(),
                    "components/orders/TrackingTimeline.tsx"
                )
            )
        ).toBe(false);
    });

    test("the recovery fallback is the existing OTP component, pre-filled", () => {
        expect(lookup).toContain("OrderRecovery");
        expect(lookup).toContain("defaultOrderNumber");
        expect(lookup).not.toContain("/api/orders/recover");
    });
});
