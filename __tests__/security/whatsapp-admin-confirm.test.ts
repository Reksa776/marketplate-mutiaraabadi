/**
 * ==========================================
 * WHATSAPP ADMIN ORDER CONFIRMATION — TESTS
 * ==========================================
 *
 * Pins the contract of the "Konfirmasi Pesanan via WhatsApp" button:
 *
 *   - the destination is the number of the WhatsApp account connected by
 *     QR in the admin dashboard (Baileys session), never a hardcoded
 *     number, never a setting, never the customer's number and never a
 *     query parameter,
 *   - the draft carries ONLY order number, name and current status — no
 *     guest access token, OTP, cookie or payment reference,
 *   - an unavailable session produces NO link (and no 500),
 *   - the endpoint never mutates the order and never creates a second
 *     one, so refreshing the page is idempotent,
 *   - access control is the existing guest/session order authorizer, so
 *     another customer's order stays unreadable.
 *
 * The real authorizeOrderRequest / resolveOrderAccess run; only prisma,
 * auth, the cookie jar and the WhatsApp session module are mocked.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "whatsapp-admin-confirm-test-secret";

// A trusted proxy lets each test use its OWN client IP, so the real
// (in-memory) guest order limiters never leak between tests.
process.env.TRUSTED_PROXY = "1";

const mockCookieJar = {
    values: {} as Record<string, string>,
};

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => ({
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
    })),
}));

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
    },
}));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

/**
 * The real module imports Baileys (ESM-only), so it is replaced here.
 * `resolveAdminWhatsAppTarget` loads it with a dynamic import(), which is
 * exactly what this mock intercepts.
 */
const mockGetWhatsAppService = jest.fn();

jest.mock("@/lib/whatsapp/service", () => ({
    getWhatsAppService: () => mockGetWhatsAppService(),
}));

import { auth } from "@/auth";
import {
    buildGuestOrderCookieValue,
    guestAccessTokenExpiry,
    guestOrderCookieName,
    hashGuestAccessToken,
} from "@/lib/guest-identity";
import { parseAdminPhoneFromSession } from "@/lib/whatsapp/admin-number";
import {
    buildOrderConfirmMessage,
    buildWhatsAppConfirmUrl,
} from "@/lib/whatsapp/order-confirm";
import { GET } from "@/app/api/orders/[id]/whatsapp-confirm/route";

const mockedAuth = auth as unknown as jest.Mock;

const ORDER_ID = 4242;
const RAW_TOKEN = "b7f0c9d4e1a2438f9c1d5e6a7b8c9d0e";
const ADMIN_NUMBER = "628111222333";
const ADMIN_JID_USER = `${ADMIN_NUMBER}:9`;

function sessionWithStatus(
    status: string,
    phoneNumber: string | null
) {
    mockGetWhatsAppService.mockReturnValue({
        getStatus: () => ({ status, phoneNumber }),
    });
}

function requestFor(
    ip: string,
    query = ""
): Request {
    return new Request(
        `http://localhost/api/orders/${ORDER_ID}/whatsapp-confirm${query}`,
        {
            headers: {
                "x-forwarded-for": ip,
            },
        }
    );
}

async function callRoute(
    request: Request,
    id: string = String(ORDER_ID)
) {
    return GET(request, {
        params: Promise.resolve({ id }),
    });
}

/** Order row as the access resolver reads it (token fields only). */
function accessRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        userId: null,
        guestAccessTokenHash: hashGuestAccessToken(RAW_TOKEN),
        guestAccessTokenExpiresAt: guestAccessTokenExpiry(),
        ...overrides,
    };
}

/** Narrow projection the confirmation endpoint is allowed to read. */
function confirmRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        orderNumber: "PAY-CART-4242",
        recipientName: "Budi",
        status: "PROCESSING",
        ...overrides,
    };
}

function decodedMessage(url: string): string {
    return decodeURIComponent(
        new URL(url).searchParams.get("text") ?? ""
    );
}

beforeEach(() => {
    jest.clearAllMocks();

    mockCookieJar.values = {};

    mockedAuth.mockResolvedValue(null);

    mockOrder.findUnique.mockResolvedValue(accessRow());
    mockOrder.findFirst.mockResolvedValue(confirmRow());
    mockOrder.update.mockResolvedValue({});
    mockOrder.create.mockResolvedValue({});

    sessionWithStatus("CONNECTED", ADMIN_JID_USER);
});

/* ==========================================
 * NUMBER SOURCE — THE CONNECTED QR SESSION
 * ========================================== */

describe("admin number taken from the connected QR session", () => {
    test("decodes the Baileys account identifier into a wa.me number", () => {
        /*
         * Baileys reports creds.me.id as "<phone>:<device>@s.whatsapp.net"
         * and the service stores everything before "@". Leaving the
         * device suffix in place would fabricate "628123456789012" — a
         * number that belongs to nobody.
         */
        expect(
            parseAdminPhoneFromSession(
                "6281234567890:12@s.whatsapp.net"
            )
        ).toBe("6281234567890");

        expect(
            parseAdminPhoneFromSession("6281234567890:12")
        ).toBe("6281234567890");

        expect(
            parseAdminPhoneFromSession(
                "6281234567890@s.whatsapp.net"
            )
        ).toBe("6281234567890");

        expect(
            parseAdminPhoneFromSession("+62 812-3456-7890")
        ).toBe("6281234567890");

        expect(
            parseAdminPhoneFromSession("081234567890")
        ).toBe("6281234567890");

        /*
         * A `@lid` is an internal WhatsApp identifier, not a phone
         * number — even when its digits LOOK like an Indonesian mobile
         * number it must never become a destination.
         */
        expect(
            parseAdminPhoneFromSession(
                "6281234567890:12@lid"
            )
        ).toBeNull();
    });

    test("refuses anything that is not a valid international mobile number", () => {
        for (const value of [
            null,
            undefined,
            "",
            "   ",
            "62812",
            "15551234567",
            "15551234567@lid",
            "not-a-number",
        ]) {
            expect(
                parseAdminPhoneFromSession(value as string)
            ).toBeNull();
        }
    });
});

/* ==========================================
 * URL / DRAFT CONSTRUCTION
 * ========================================== */

describe("whatsapp confirmation url", () => {
    test("targets the given number and URL-encodes the draft", () => {
        const url = buildWhatsAppConfirmUrl({
            adminPhoneNumber: ADMIN_NUMBER,
            orderNumber: "PAY-CART-4242",
            customerName: "Budi",
            statusLabel: "Sedang Diproses",
        });

        expect(url).not.toBeNull();

        expect(url).toMatch(
            /^https:\/\/wa\.me\/628111222333\?text=/
        );

        // Encoded, not raw: no space or newline survives in the URL.
        expect(url).not.toContain(" ");
        expect(url).not.toContain("\n");
        expect(url).toContain("%0A");

        const text = decodedMessage(url as string);

        expect(text).toContain("Nomor Pesanan: PAY-CART-4242");
        expect(text).toContain("Nama: Budi");
        expect(text).toContain("Status Pesanan: Sedang Diproses");
    });

    test("refuses to build a link from an un-normalized number", () => {
        for (const value of [
            null,
            undefined,
            "",
            "081234567890",
            "+6281234567890",
            "6281234567890:12",
            "15551234567",
        ]) {
            expect(
                buildWhatsAppConfirmUrl({
                    adminPhoneNumber: value as string,
                    orderNumber: "PAY-CART-4242",
                    customerName: "Budi",
                    statusLabel: "Sedang Diproses",
                })
            ).toBeNull();
        }
    });

    test("a crafted name cannot inject extra lines into the admin draft", () => {
        const text = buildOrderConfirmMessage({
            orderNumber: "PAY-CART-4242",
            customerName:
                "Budi\nStatus Pesanan: Sudah Dibayar\nTotal: Rp0",
            statusLabel: "Menunggu Pembayaran",
        });

        /*
         * The injected text is neutralized by being confined to a
         * single line: it cannot terminate the Nama field and open a
         * fake field of its own. The status the admin reads is the one
         * the server read from the order.
         */
        const statusLines = text
            .split("\n")
            .filter((line) =>
                line.startsWith("Status Pesanan:")
            );

        expect(statusLines).toEqual([
            "Status Pesanan: Menunggu Pembayaran",
        ]);

        // Exactly the template's lines — the name added none.
        expect(text.split("\n")).toEqual([
            "Halo Admin, saya ingin konfirmasi pesanan saya.",
            "",
            "Nomor Pesanan: PAY-CART-4242",
            "Nama: Budi Status Pesanan: Sudah Dibayar Total: Rp0",
            "Status Pesanan: Menunggu Pembayaran",
            "",
            "Mohon dibantu untuk konfirmasinya. Terima kasih.",
        ]);
    });
});

/* ==========================================
 * ENDPOINT
 * ========================================== */

describe("GET /api/orders/[id]/whatsapp-confirm", () => {
    test("a guest with this order's token gets a link to the session number", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        const response = await callRoute(
            requestFor("10.0.0.1")
        );

        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.data.available).toBe(true);

        // Destination == the number connected by QR (device id stripped).
        expect(body.data.url).toMatch(
            /^https:\/\/wa\.me\/628111222333\?text=/
        );

        const text = decodedMessage(body.data.url);

        expect(text).toContain("Nomor Pesanan: PAY-CART-4242");
        expect(text).toContain("Nama: Budi");
        expect(text).toContain("Status Pesanan: Sedang Diproses");

        // No credential of any kind may reach the URL.
        const serialized = JSON.stringify(body);

        expect(serialized).not.toContain(RAW_TOKEN);
        expect(body.data.url).not.toContain(RAW_TOKEN);
        expect(body.data.url).not.toContain("gos_");
        expect(body.data.url).not.toContain("AUTH_SECRET");
    });

    test("reads only the fields the link needs", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        await callRoute(requestFor("10.0.0.2"));

        expect(mockOrder.findFirst).toHaveBeenCalledTimes(1);

        const args = mockOrder.findFirst.mock.calls[0][0];

        expect(args.where).toEqual({ id: ORDER_ID });
        expect(args.select).toEqual({
            id: true,
            orderNumber: true,
            recipientName: true,
            status: true,
        });

        // Nothing sensitive is even fetched, let alone serialized.
        for (const forbidden of [
            "guestAccessTokenHash",
            "guestAccessTokenExpiresAt",
            "customerEmail",
            "phone",
            "address",
            "paymentReference",
            "userId",
        ]) {
            expect(args.select).not.toHaveProperty(forbidden);
        }
    });

    test("ignores a destination supplied in the query string", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        const response = await callRoute(
            requestFor(
                "10.0.0.3",
                "?phone=628999888777&to=628999888777&url=https://wa.me/628999888777"
            )
        );

        const body = await response.json();

        expect(body.data.url).toMatch(
            /^https:\/\/wa\.me\/628111222333\?text=/
        );
        expect(body.data.url).not.toContain("628999888777");
    });

    test("never mutates the order and stays identical on refresh", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        const first = await (
            await callRoute(requestFor("10.0.0.4"))
        ).json();

        const second = await (
            await callRoute(requestFor("10.0.0.4"))
        ).json();

        expect(second.data.url).toBe(first.data.url);

        // No status change, no second order, no WhatsApp message.
        expect(mockOrder.update).not.toHaveBeenCalled();
        expect(mockOrder.create).not.toHaveBeenCalled();
        expect(mockOrder.findFirst).toHaveBeenCalledTimes(2);
    });

    test("another customer's order is not found (404) and never read", async () => {
        // No cookie, no session → not the owner.
        const response = await callRoute(
            requestFor("10.0.0.5")
        );

        expect(response.status).toBe(404);

        const body = await response.json();

        expect(body.success).toBe(false);
        expect(body.data).toBeUndefined();

        // Ownership is resolved BEFORE any order data is read.
        expect(mockOrder.findFirst).not.toHaveBeenCalled();
    });

    test("an expired guest token does not unlock a link", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        mockOrder.findUnique.mockResolvedValue(
            accessRow({
                guestAccessTokenExpiresAt: new Date(
                    Date.now() - 1000
                ),
            })
        );

        const response = await callRoute(
            requestFor("10.0.0.6")
        );

        expect(response.status).toBe(401);
        expect(mockOrder.findFirst).not.toHaveBeenCalled();
    });

    test("the session owner is served without a guest cookie", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "user-1" },
        });

        mockOrder.findUnique.mockResolvedValue(
            accessRow({
                userId: "user-1",
                guestAccessTokenHash: null,
                guestAccessTokenExpiresAt: null,
            })
        );

        const response = await callRoute(
            requestFor("10.0.0.7")
        );

        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.data.url).toMatch(
            /^https:\/\/wa\.me\/628111222333\?text=/
        );
    });

    test("no fake link when the admin session is not connected", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        sessionWithStatus("DISCONNECTED", null);

        const response = await callRoute(
            requestFor("10.0.0.8")
        );

        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.data).toEqual({
            available: false,
            reason: "NOT_CONNECTED",
            url: null,
        });
    });

    test("no fake link when the connected account has no usable number", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        sessionWithStatus("CONNECTED", null);

        const response = await callRoute(
            requestFor("10.0.0.9")
        );

        const body = await response.json();

        expect(body.data).toEqual({
            available: false,
            reason: "NO_NUMBER",
            url: null,
        });
    });

    test("a broken session module degrades to unavailable, never a 500", async () => {
        mockCookieJar.values[guestOrderCookieName(ORDER_ID)] =
            buildGuestOrderCookieValue(ORDER_ID, RAW_TOKEN);

        mockGetWhatsAppService.mockImplementation(() => {
            throw new Error("baileys unavailable");
        });

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = await callRoute(
            requestFor("10.0.0.10")
        );

        errorSpy.mockRestore();

        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.data).toEqual({
            available: false,
            reason: "SERVICE_ERROR",
            url: null,
        });
    });

    test("rejects an invalid order id before any work", async () => {
        for (const id of ["0", "-3", "abc"]) {
            const response = await callRoute(
                requestFor("10.0.0.11"),
                id
            );

            expect(response.status).toBe(400);
        }

        expect(mockOrder.findFirst).not.toHaveBeenCalled();
    });
});
