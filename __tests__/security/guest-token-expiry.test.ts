/**
 * ==========================================
 * GUEST ACCESS TOKEN EXPIRY — UNIT TESTS
 * ==========================================
 *
 * A guest order is reachable through a 256-bit access token in an
 * httpOnly cookie. That token must not be a permanent credential:
 * `Order.guestAccessTokenExpiresAt` gives it a SERVER-SIDE 30-day
 * window, enforced in resolveOrderAccess().
 *
 * The cookie's `maxAge` is only a browser hint — a browser may keep or
 * resurrect a cookie, and the cookie is attacker-controlled anyway — so
 * these tests pin that the SERVER is the authority:
 *
 *   1. an expired token is refused even when the browser still sends it,
 *   2. a token whose window is MISSING fails closed (never indefinite),
 *   3. the hash and its window are always written TOGETHER, on every
 *      issuance path (creation and OTP recovery),
 *   4. expiry never leaks existence: only a caller that already
 *      presented the real token learns the token expired,
 *   5. the buyer is not locked out — the order is preserved and the OTP
 *      recovery flow issues a fresh token.
 *
 * Prisma is mocked; no database is touched.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-token-expiry-test-secret";

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

jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

const mockOrder = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
};

jest.mock("@/lib/prisma", () => ({
    prisma: { order: mockOrder },
}));

import { readFileSync } from "fs";
import { resolve } from "path";

import { prisma } from "@/lib/prisma";

import {
    listGuestAccessibleOrderIds,
    persistGuestAccessToken,
    resolveOrderAccess,
} from "@/lib/guest-order-access";
import {
    GUEST_ACCESS_TOKEN_TTL_MS,
    GUEST_ORDER_COOKIE_MAX_AGE_S,
    GUEST_ORDER_COOKIE_PREFIX,
    guestAccessTokenExpiry,
    hashGuestAccessToken,
    isGuestTokenValid,
} from "@/lib/guest-identity";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
};

const RAW_TOKEN = "guest-token-abcdefghijklmnopqrstuvwxyz0123456789";

function readFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCookieJar.values = {};
    mockedOrder.update.mockResolvedValue({});
});

/* ==========================================
 * WINDOW MATH
 * ========================================== */

describe("guest access token window", () => {
    test("is 30 days, and the cookie hint matches the server window", () => {
        expect(GUEST_ACCESS_TOKEN_TTL_MS).toBe(
            30 * 24 * 60 * 60 * 1000
        );

        // The cookie maxAge is a hint for the SAME window: a cookie that
        // outlives its server-side window buys the buyer nothing.
        expect(GUEST_ORDER_COOKIE_MAX_AGE_S * 1000).toBe(
            GUEST_ACCESS_TOKEN_TTL_MS
        );
    });

    test("expiry is computed from the issuance instant", () => {
        const from = new Date("2026-01-01T00:00:00.000Z");

        expect(
            guestAccessTokenExpiry(from).getTime() -
                from.getTime()
        ).toBe(GUEST_ACCESS_TOKEN_TTL_MS);
    });

    test("isGuestTokenValid fails closed on a missing or past window", () => {
        const now = new Date("2026-06-01T00:00:00.000Z");

        expect(
            isGuestTokenValid(
                new Date(now.getTime() + 1000),
                now
            )
        ).toBe(true);

        expect(
            isGuestTokenValid(
                new Date(now.getTime() - 1),
                now
            )
        ).toBe(false);

        // Exactly at the boundary the token is no longer valid.
        expect(isGuestTokenValid(now, now)).toBe(false);

        // Un-backfilled / legacy rows must never grant indefinite access.
        expect(isGuestTokenValid(null, now)).toBe(false);
        expect(isGuestTokenValid(undefined, now)).toBe(false);
    });
});

/* ==========================================
 * ISSUANCE
 * ========================================== */

describe("persistGuestAccessToken", () => {
    test("writes the hash AND the 30-day window in ONE update", async () => {
        const before = Date.now();

        const expiresAt = await persistGuestAccessToken(
            42,
            RAW_TOKEN
        );

        // The window starts at the instant INSIDE the call, which lies
        // between `before` and `after`.
        const after = Date.now();

        expect(mockedOrder.update).toHaveBeenCalledTimes(1);

        const call = mockedOrder.update.mock.calls[0][0];

        expect(call.where).toEqual({ id: 42 });
        expect(call.data.guestAccessTokenHash).toBe(
            hashGuestAccessToken(RAW_TOKEN)
        );
        expect(
            call.data.guestAccessTokenExpiresAt.getTime()
        ).toBe(expiresAt.getTime());
        expect(
            expiresAt.getTime() - before
        ).toBeGreaterThanOrEqual(
            GUEST_ACCESS_TOKEN_TTL_MS
        );
        expect(
            expiresAt.getTime() - before
        ).toBeLessThanOrEqual(
            GUEST_ACCESS_TOKEN_TTL_MS +
                (after - before) +
                1000
        );

        // The raw token is never persisted.
        expect(JSON.stringify(call)).not.toContain(RAW_TOKEN);
    });

    test("every write of a guest token hash also writes its window", () => {
        /*
         * The only two places that persist a guest access token are
         * order creation and the recovery hand-off. A third path (or a
         * lone hash write) would create a row that resolveOrderAccess
         * refuses — locking a buyer out of an order they just placed.
         */
        const sources = [
            "lib/checkout.ts",
            "lib/guest-order-access.ts",
        ].map((path) => ({ path, code: readFile(path) }));

        for (const { path, code } of sources) {
            expect(code).toContain(
                "guestAccessTokenHash"
            );
            expect(code).toContain(
                "guestAccessTokenExpiresAt"
            );

            /*
             * Every WRITE of the hash (the `prop:` form, as opposed to a
             * `prop: true,` select) is followed within a few lines by
             * the window it is issued with — so no code path can create
             * an order that carries a token with no expiry.
             */
            const lines = code.split("\n");
            const writes: number[] = [];

            lines.forEach((line, index) => {
                if (
                    /guestAccessTokenHash:\s*$/.test(line)
                ) {
                    writes.push(index);
                }
            });

            expect(writes.length).toBeGreaterThan(0);

            for (const index of writes) {
                const window = lines
                    .slice(index, index + 30)
                    .join("\n");

                expect(window).toContain(
                    "guestAccessTokenExpiresAt"
                );
            }
        }

        // No OTHER module writes the hash directly.
        const routeCode = readFile(
            "app/api/orders/recover/route.ts"
        );
        const confirmCode = readFile(
            "app/api/orders/recover/confirm/route.ts"
        );

        expect(routeCode).not.toContain(
            "guestAccessTokenHash"
        );
        expect(confirmCode).not.toContain(
            "guestAccessTokenHash"
        );
        expect(confirmCode).toContain(
            "issueGuestOrderAccessCookie"
        );
    });
});

/* ==========================================
 * ENFORCEMENT
 * ========================================== */

describe("server-side enforcement", () => {
    test("an expired token is refused while a live one is accepted", async () => {
        mockedOrder.findUnique.mockResolvedValue({
            id: 42,
            userId: null,
            guestAccessTokenHash:
                hashGuestAccessToken(RAW_TOKEN),
            guestAccessTokenExpiresAt: new Date(
                Date.now() - 60_000
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

    test("the expiry is only consulted AFTER the hash matches", () => {
        /*
         * Reporting EXPIRED to a caller that did NOT present the real
         * token would confirm that the order exists — so the expiry
         * branch must sit behind the hash comparison in the source.
         */
        const code = readFile(
            "lib/guest-order-access.ts"
        );

        const resolveIndex = code.indexOf(
            "export async function resolveOrderAccess"
        );
        const resolveBody = code.slice(resolveIndex);

        const hashCheck = resolveBody.indexOf(
            "tokenMatchesHash("
        );
        const expiryCheck = resolveBody.indexOf(
            "isGuestTokenValid("
        );

        expect(hashCheck).toBeGreaterThan(-1);
        expect(expiryCheck).toBeGreaterThan(hashCheck);

        // A missing hash is the uniform NOT_FOUND, never EXPIRED.
        expect(resolveBody).toContain(
            'return { ok: false, reason: "NOT_FOUND" }'
        );
    });

    test("the expired-token answer names the OTP recovery path", () => {
        const code = readFile(
            "lib/guest-order-access.ts"
        );

        expect(code).toContain(
            "EXPIRED_ACCESS_MESSAGE"
        );
        expect(code).toContain("kode verifikasi");
    });

    test("expiry resolves to 401, not a generic 404", () => {
        const code = readFile(
            "lib/guest-order-access.ts"
        );

        expect(code).toMatch(
            /decision\.reason === "EXPIRED"[\s\S]{0,200}status: 401/
        );
    });
});

/* ==========================================
 * LISTING (the cookie jar is the index)
 * ========================================== */

describe("listGuestAccessibleOrderIds", () => {
    test("ignores expired, tampered and unparseable cookies", async () => {
        mockCookieJar.values[
            `${GUEST_ORDER_COOKIE_PREFIX}1`
        ] = `1.${RAW_TOKEN}`;
        mockCookieJar.values[
            `${GUEST_ORDER_COOKIE_PREFIX}2`
        ] = `2.${RAW_TOKEN}`;
        mockCookieJar.values[
            `${GUEST_ORDER_COOKIE_PREFIX}3`
        ] = `3.attacker-supplied-token`;
        mockCookieJar.values[
            `${GUEST_ORDER_COOKIE_PREFIX}4`
        ] = "not-a-cookie-value";

        mockedOrder.findMany.mockResolvedValue([
            {
                id: 1,
                guestAccessTokenHash:
                    hashGuestAccessToken(RAW_TOKEN),
                guestAccessTokenExpiresAt:
                    guestAccessTokenExpiry(),
            },
            {
                // Genuine token, window passed.
                id: 2,
                guestAccessTokenHash:
                    hashGuestAccessToken(RAW_TOKEN),
                guestAccessTokenExpiresAt: new Date(
                    Date.now() - 60_000
                ),
            },
            {
                // Genuine token, no window recorded (fail closed).
                id: 3,
                guestAccessTokenHash:
                    hashGuestAccessToken(
                        "attacker-supplied-token"
                    ),
                guestAccessTokenExpiresAt: null,
            },
        ]);

        await expect(
            listGuestAccessibleOrderIds()
        ).resolves.toEqual([1]);
    });

    test("an empty cookie jar answers empty without a query", async () => {
        await expect(
            listGuestAccessibleOrderIds()
        ).resolves.toEqual([]);

        expect(mockedOrder.findMany).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * MIGRATION (historical orders preserved)
 * ========================================== */

describe("expiry migration", () => {
    const migration = readFile(
        "prisma/migrations/20261013100000_guest_recovery_otp_and_token_expiry/migration.sql"
    );

    test("is additive only — nothing is dropped or deleted", () => {
        expect(migration).toContain(
            "ADD COLUMN `guestAccessTokenExpiresAt` DATETIME(3) NULL"
        );

        expect(migration).not.toMatch(/DROP\s+TABLE/i);
        expect(migration).not.toMatch(/DROP\s+COLUMN/i);
        expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(migration).not.toMatch(/TRUNCATE/i);
    });

    test("backfills a fresh 30-day window for tokens that lack one", () => {
        expect(migration).toMatch(
            /UPDATE `order`\s+SET `guestAccessTokenExpiresAt` = DATE_ADD\(NOW\(3\), INTERVAL 30 DAY\)\s+WHERE `guestAccessTokenHash` IS NOT NULL\s+AND `guestAccessTokenExpiresAt` IS NULL/
        );
    });

    test("creates the OTP challenge table with the single-use columns", () => {
        expect(migration).toContain(
            "CREATE TABLE `guestrecoverychallenge`"
        );

        for (const column of [
            "`consumedAt`",
            "`expiresAt`",
            "`attempts`",
            "`maxAttempts`",
            "`codeHash`",
            "`contactHash`",
            "`deliveredAt`",
        ]) {
            expect(migration).toContain(column);
        }

        // Only hashes are stored — never a raw code or contact.
        expect(migration).not.toContain("`code`");
        expect(migration).not.toContain("`email`");
    });
});
