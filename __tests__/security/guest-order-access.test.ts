/**
 * ==========================================
 * GUEST ORDER ACCESS — REGRESSION TESTS
 * ==========================================
 *
 * An order id is a sequential integer, so NOTHING may be readable just
 * by knowing it. These tests pin the ownership model:
 *
 *   - a valid guest access token (httpOnly cookie) grants access,
 *   - the session owner keeps access (legacy orders),
 *   - a missing/invalid token is answered as NOT FOUND (never 403),
 *   - the token is stored ONLY as a SHA-256 hash WITH a 30-day
 *     server-side window (see guest-token-expiry.test.ts),
 *   - recovery needs the order number PLUS the checkout contact, and
 *     that pair ALONE never rotates the token: it only triggers a
 *     one-time code (see guest-recovery-otp.test.ts),
 *   - no raw contact value or identity hash is ever serialized.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-order-access-test-secret";

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

const mockChallenge = {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        guestRecoveryChallenge: mockChallenge,
        $transaction: jest.fn(
            async (
                fn: (tx: unknown) => Promise<unknown>
            ) =>
                fn({
                    guestRecoveryChallenge:
                        mockChallenge,
                })
        ),
    },
}));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockSendRawNotificationNow = jest.fn();

jest.mock("@/lib/notification/order-status-handler", () => ({
    sendRawNotificationNow: (input: unknown) =>
        mockSendRawNotificationNow(input),
}));

import { readFileSync } from "fs";
import { resolve } from "path";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

import {
    authorizeOrderRequest,
    findOrderBySecondFactor,
    issueGuestOrderAccessCookie,
    listGuestAccessibleOrderIds,
    readGuestOrderTokenFromCookies,
    resolveOrderAccess,
    tokenMatchesHash,
} from "@/lib/guest-order-access";
import {
    GUEST_ORDER_COOKIE_PREFIX,
    generateGuestAccessToken,
    guestAccessTokenExpiry,
    hashGuestAccessToken,
    normalizePhone,
    normalizeEmail,
    buildGuestIdentityKey,
} from "@/lib/guest-identity";
import { POST as recoverPOST } from "@/app/api/orders/recover/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
};

const RAW_TOKEN = "raw-token-value-abc123";
const EMAIL = "buyer@example.com";
const PHONE = "08123456789";

beforeEach(() => {
    jest.clearAllMocks();
    mockCookieJar.values = {};
    mockCookieJar.throwOnRead = false;
    mockedAuth.mockResolvedValue(null);
    mockedOrder.update.mockResolvedValue({});
    mockChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockSendRawNotificationNow.mockResolvedValue({
        success: true,
        notificationId: 7,
    });
});

/* ==========================================
 * TOKEN ISSUANCE / PARSING
 * ========================================== */

describe("Guest access token", () => {
    test("is 256 bits of CSPRNG output and never reused", () => {
        const a = generateGuestAccessToken();
        const b = generateGuestAccessToken();

        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(40);
        expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test("is stored as a hash, never the raw token", () => {
        const hash = hashGuestAccessToken(RAW_TOKEN);

        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hash).not.toContain(RAW_TOKEN);
        expect(hashGuestAccessToken(RAW_TOKEN)).toBe(hash);
    });

    test("the cookie is httpOnly, SameSite=Lax and order-scoped", () => {
        const captured: {
            name?: string;
            value?: string;
            options?: Record<string, unknown>;
        } = {};

        const fakeResponse = {
            cookies: {
                set(
                    name: string,
                    value: string,
                    options: Record<string, unknown>
                ) {
                    captured.name = name;
                    captured.value = value;
                    captured.options = options;
                },
            },
        };

        const issued = issueGuestOrderAccessCookie(
            fakeResponse as never,
            42,
            RAW_TOKEN
        );

        expect(issued).toBe(RAW_TOKEN);
        expect(captured.name).toBe(
            `${GUEST_ORDER_COOKIE_PREFIX}42`
        );
        expect(captured.value).toBe(`42.${RAW_TOKEN}`);
        expect(captured.options).toMatchObject({
            httpOnly: true,
            sameSite: "lax",
            path: "/",
        });
    });

    test("a token for one order is not valid for another", () => {
        expect(
            tokenMatchesHash(
                RAW_TOKEN,
                hashGuestAccessToken(RAW_TOKEN)
            )
        ).toBe(true);

        expect(
            tokenMatchesHash(
                "other-token",
                hashGuestAccessToken(RAW_TOKEN)
            )
        ).toBe(false);

        expect(tokenMatchesHash(RAW_TOKEN, null)).toBe(false);
    });

    test("reading the cookie fails closed when there is no request scope", async () => {
        mockCookieJar.throwOnRead = true;

        await expect(
            readGuestOrderTokenFromCookies(42)
        ).resolves.toBeNull();

        await expect(
            listGuestAccessibleOrderIds()
        ).resolves.toEqual([]);
    });
});

/* ==========================================
 * OWNERSHIP RESOLUTION
 * ========================================== */

describe("resolveOrderAccess", () => {
    test("the session owner keeps access (legacy orders)", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: "user-1",
            guestAccessTokenHash: null,
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                sessionUserId: "user-1",
            })
        ).resolves.toEqual({ ok: true, via: "SESSION" });
    });

    test("a valid guest token grants access", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt:
                guestAccessTokenExpiry(),
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                rawToken: RAW_TOKEN,
            })
        ).resolves.toEqual({ ok: true, via: "TOKEN" });
    });

    test("a genuine but EXPIRED token is refused (server-side window)", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt: new Date(
                Date.now() - 1000
            ),
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                rawToken: RAW_TOKEN,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXPIRED",
        });
    });

    test("a token with NO recorded window fails closed", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt: null,
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                rawToken: RAW_TOKEN,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "EXPIRED",
        });
    });

    test("a wrong token is NOT FOUND, never FORBIDDEN", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt:
                guestAccessTokenExpiry(),
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                rawToken: "not-the-token",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });
    });

    test("an unknown order id is NOT FOUND", async () => {
        mockedOrder.findUnique.mockResolvedValue(null);

        await expect(
            resolveOrderAccess({ orderId: 999 })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });
    });

    test("another buyer's session does not open the order", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: "user-1",
            guestAccessTokenHash: null,
        });

        await expect(
            resolveOrderAccess({
                orderId: 42,
                sessionUserId: "someone-else",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });
    });
});

describe("authorizeOrderRequest", () => {
    test("a guest with no token gets 404 (no existence oracle)", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash: null,
        });

        const result = await authorizeOrderRequest(
            new Request("http://test"),
            42
        );

        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ status: 404 });
    });

    test("a guest holding the token is authorized with a null userId", async () => {
        mockCookieJar.values[`${GUEST_ORDER_COOKIE_PREFIX}42`] =
            `42.${RAW_TOKEN}`;

        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt:
                guestAccessTokenExpiry(),
        });

        const result = await authorizeOrderRequest(
            new Request("http://test"),
            42
        );

        expect(result).toEqual({
            ok: true,
            userId: null,
            via: "TOKEN",
        });
    });

    test("an expired token is answered 401 and names the recovery path", async () => {
        mockCookieJar.values[`${GUEST_ORDER_COOKIE_PREFIX}42`] =
            `42.${RAW_TOKEN}`;

        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt: new Date(
                Date.now() - 1000
            ),
        });

        const result = await authorizeOrderRequest(
            new Request("http://test"),
            42
        );

        expect(result).toMatchObject({ ok: false, status: 401 });
        expect(
            (result as { message: string }).message
        ).toContain("kode verifikasi");
    });
});

describe("Idempotent replay must not clobber the access cookie", () => {
    test.each([
        "app/api/orders/route.ts",
        "app/api/buy-now/route.ts",
        "app/api/buy-now/ipaymu/route.ts",
        "app/api/payment/ipaymu/route.ts",
    ])("%s only issues the cookie for a NEW order", (file) => {
        const code = readFileSync(
            resolve(process.cwd(), file),
            "utf-8"
        );

        /*
         * A duplicate submission returns the ORIGINAL order, whose
         * stored hash belongs to the original token. Re-issuing a fresh
         * cookie would overwrite the buyer's valid token with one that
         * no longer matches, locking them out of their own order.
         */
        expect(code).toMatch(
            /if \(guestToken && !result\.duplicate\)/
        );
    });
});

/* ==========================================
 * IDENTITY NORMALIZATION (limit scopes)
 * ========================================== */

describe("Guest identity normalization", () => {
    test("email is lowercased and trimmed", () => {
        expect(normalizeEmail("  Buyer@Example.COM ")).toBe(
            "buyer@example.com"
        );
        expect(normalizeEmail("not-an-email")).toBeNull();
        expect(normalizeEmail(null)).toBeNull();
    });

    test("Indonesian phone formats collapse to one identity", () => {
        const forms = [
            "08123456789",
            "+62 812-3456-789",
            "628123456789",
            "8123456789",
        ].map(normalizePhone);

        expect(new Set(forms).size).toBe(1);
        expect(forms[0]).toBe("628123456789");
    });

    test("the identity key is keyed-hashed, never the raw contact", () => {
        const key = buildGuestIdentityKey({
            email: EMAIL,
            phone: PHONE,
        });

        expect(key).toMatch(/^g1:[a-f0-9]{64}:[a-f0-9]{64}$/);
        expect(key).not.toContain(EMAIL);
        expect(key).not.toContain(PHONE);
        expect(key).not.toContain("628123456789");
    });
});

/* ==========================================
 * SECOND-FACTOR RECOVERY
 * ========================================== */

describe("findOrderBySecondFactor", () => {
    const storedOrder = {
        id: 42,
        userId: null,
        orderNumber: "PAY-CART-42",
        customerEmail: EMAIL,
        phone: PHONE,
        guestAccessTokenHash: hashGuestAccessToken(RAW_TOKEN),
    };

    test("matches on the email", async () => {
        mockedOrder.findUnique.mockResolvedValue(storedOrder);

        await expect(
            findOrderBySecondFactor({
                orderNumber: "PAY-CART-42",
                email: " BUYER@example.com ",
            })
        ).resolves.toBe(storedOrder);
    });

    test("matches on a differently formatted phone", async () => {
        mockedOrder.findUnique.mockResolvedValue(storedOrder);

        await expect(
            findOrderBySecondFactor({
                orderNumber: "PAY-CART-42",
                phone: "+62 812 3456 789",
            })
        ).resolves.toBe(storedOrder);
    });

    test("a wrong contact matches nothing", async () => {
        mockedOrder.findUnique.mockResolvedValue(storedOrder);

        await expect(
            findOrderBySecondFactor({
                orderNumber: "PAY-CART-42",
                email: "attacker@example.com",
            })
        ).resolves.toBeNull();
    });

    test("no contact detail matches nothing", async () => {
        mockedOrder.findUnique.mockResolvedValue(storedOrder);

        await expect(
            findOrderBySecondFactor({
                orderNumber: "PAY-CART-42",
            })
        ).resolves.toBeNull();
    });
});

describe("POST /api/orders/recover", () => {
    function recoverRequest(body: unknown) {
        return new Request("http://test/api/orders/recover", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    test("a matching second factor requests a code and rotates NOTHING", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            orderNumber: "PAY-CART-42",
            customerEmail: EMAIL,
            phone: PHONE,
            guestAccessTokenHash: "old-hash",
        });

        const response = await recoverPOST(
            recoverRequest({
                orderNumber: "PAY-CART-42",
                email: EMAIL,
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.challengeId).toEqual(
            expect.any(String)
        );

        /*
         * Order number + checkout contact is KNOWLEDGE, not proof of
         * ownership, so this phase must not touch the access token and
         * must not hand out a cookie. Only a verified OTP does that
         * (see guest-recovery-otp.test.ts).
         */
        expect(mockedOrder.update).not.toHaveBeenCalled();
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(JSON.stringify(body)).not.toContain(
            "old-hash"
        );

        // The code goes to the phone recorded on the order.
        expect(
            mockSendRawNotificationNow
        ).toHaveBeenCalledTimes(1);
        expect(
            mockSendRawNotificationNow.mock.calls[0][0]
                .recipient
        ).toBe("628123456789");
    });

    test("never echoes the raw contact or the identity hash", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            orderNumber: "PAY-CART-42",
            customerEmail: EMAIL,
            phone: PHONE,
            guestAccessTokenHash: "old-hash",
        });

        const response = await recoverPOST(
            recoverRequest({
                orderNumber: "PAY-CART-42",
                phone: PHONE,
            })
        );
        const serialized = JSON.stringify(
            await response.json()
        );

        expect(serialized).not.toContain(EMAIL);
        expect(serialized).not.toContain(PHONE);
        expect(serialized).not.toContain("g1:");
        expect(serialized).not.toContain("guestIdentityKey");
    });

    test("a mismatch is a uniform 404 with no token rotation", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            orderNumber: "PAY-CART-42",
            customerEmail: EMAIL,
            phone: PHONE,
            guestAccessTokenHash: "old-hash",
        });

        const response = await recoverPOST(
            recoverRequest({
                orderNumber: "PAY-CART-42",
                email: "attacker@example.com",
            })
        );

        expect(response.status).toBe(404);
        expect(mockedOrder.update).not.toHaveBeenCalled();
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("a missing contact detail is rejected without touching the DB", async () => {
        const response = await recoverPOST(
            recoverRequest({ orderNumber: "PAY-CART-42" })
        );

        expect(response.status).toBe(400);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
    });

    test("recovery is rate limited per IP", async () => {
        const { rateLimiters } = require("@/lib/rate-limit");
        const spy = jest
            .spyOn(rateLimiters, "guestRecoveryRequest")
            .mockReturnValue({
                allowed: false,
                remaining: 0,
            } as never);

        const response = await recoverPOST(
            recoverRequest({
                orderNumber: "PAY-CART-42",
                email: EMAIL,
            })
        );

        expect(response.status).toBe(429);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();

        spy.mockRestore();
    });
});
