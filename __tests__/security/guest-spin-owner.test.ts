/**
 * ==========================================
 * SPIN WHEEL — GUEST OWNER SCOPE
 * ==========================================
 *
 * Spin eligibility is EARNED BY SPENDING, so a guest's spins must be
 * scoped to the SAME hashed identity their PAID orders carry — and the
 * scope must come from an order the browser can PROVE it owns (verified
 * access-token cookie), never from a self-declared email/phone.
 *
 * A visitor with no provable order history gets an EMPTY scope, which
 * the routes translate into "nothing earned yet" (README: no login
 * wall).
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-spin-owner-test-secret";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockOrder = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
};

const mockedSpinRows = jest.fn(async () => [] as unknown[]);

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        spinWheelSpin: {
            findMany: (...args: unknown[]) =>
                mockedSpinRows(...(args as [])),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
    },
}));

jest.mock("@/lib/guest-order-access", () => ({
    listGuestAccessibleOrderIds: jest.fn(async () => []),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listGuestAccessibleOrderIds } from "@/lib/guest-order-access";
import { resolveSpinScope } from "@/lib/spin-owner";
import { buildGuestIdentityKey } from "@/lib/guest-identity";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findFirst: jest.Mock;
    findMany: jest.Mock;
};
const mockedAccessible = listGuestAccessibleOrderIds as unknown as jest.Mock;

import { GET as myRewardsGET } from "@/app/api/spin-wheel/my-rewards/route";

const GUEST_IDENTITY = buildGuestIdentityKey({
    email: "buyer@example.com",
    phone: "08123456789",
})!;

beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue(null);
    mockedAccessible.mockResolvedValue([]);
});

describe("resolveSpinScope", () => {
    test("a signed-in actor keeps the historical user scope", async () => {
        mockedAuth.mockResolvedValue({
            user: { id: "aff-1", role: "AFFILIATOR" },
        });

        const scope = await resolveSpinScope();

        expect(scope).toEqual({
            userId: "aff-1",
            guestIdentityKey: null,
            ownerKey: "user:aff-1",
            anonymous: false,
        });
    });

    test("a guest with no provable order has an empty scope (no login wall)", async () => {
        mockedAccessible.mockResolvedValue([]);

        const scope = await resolveSpinScope();

        expect(scope.ownerKey).toBeNull();
        expect(scope.anonymous).toBe(true);
        // No order lookup is attempted without a verified token.
        expect(mockedOrder.findFirst).not.toHaveBeenCalled();
    });

    test("a guest scope is derived from the verified orders only", async () => {
        mockedAccessible.mockResolvedValue([42, 43]);
        mockedOrder.findFirst.mockResolvedValue({
            guestIdentityKey: GUEST_IDENTITY,
        });

        const scope = await resolveSpinScope();

        expect(mockedOrder.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { in: [42, 43] },
                    guestIdentityKey: { not: null },
                }),
            })
        );

        expect(scope.userId).toBeNull();
        expect(scope.guestIdentityKey).toBe(GUEST_IDENTITY);
        expect(scope.ownerKey).toBe(
            `guest:${GUEST_IDENTITY}`
        );
        expect(scope.anonymous).toBe(false);
    });

    test("the newest identity wins when a browser holds several orders", async () => {
        mockedAccessible.mockResolvedValue([42, 43]);
        mockedOrder.findFirst.mockResolvedValue({
            guestIdentityKey: GUEST_IDENTITY,
        });

        await resolveSpinScope();

        expect(
            mockedOrder.findFirst.mock.calls[0][0].orderBy
        ).toEqual({ createdAt: "desc" });
    });

    test("legacy guest orders without an identity grant nothing", async () => {
        mockedAccessible.mockResolvedValue([42]);
        mockedOrder.findFirst.mockResolvedValue(null);

        const scope = await resolveSpinScope();

        expect(scope.ownerKey).toBeNull();
        expect(scope.anonymous).toBe(true);
    });

    test("the scope is a hash, never the raw contact", async () => {
        mockedAccessible.mockResolvedValue([42]);
        mockedOrder.findFirst.mockResolvedValue({
            guestIdentityKey: GUEST_IDENTITY,
        });

        const scope = await resolveSpinScope();

        expect(scope.ownerKey).not.toContain(
            "buyer@example.com"
        );
        expect(scope.ownerKey).not.toContain("628123456789");
    });
});

describe("spin routes are guest-capable without exposing the scope", () => {
    test.each([
        "app/api/spin-wheel/route.ts",
        "app/api/spin-wheel/spin/route.ts",
        "app/api/spin-wheel/my-rewards/route.ts",
    ])("%s resolves the scope instead of requiring a session", (file) => {
        const code = require("fs").readFileSync(
            require("path").resolve(process.cwd(), file),
            "utf-8"
        );

        expect(code).toContain("resolveSpinScope");

        // The old hard login wall is gone.
        expect(code).not.toContain(
            '"Silakan login terlebih dahulu."'
        );

        // The scope object is never spread into a payload.
        expect(code).not.toContain("...scope");
    });

    test("spin redemption at checkout is an atomic single-use CAS", () => {
        /*
         * A plain `update` would let two concurrent checkouts redeem
         * the same reward (double discount). The redemption must
         * therefore be a conditional updateMany that only flips
         * AVAILABLE → USED for the owning scope, and reject the loser.
         */
        const code = require("fs").readFileSync(
            require("path").resolve(
                process.cwd(),
                "lib/checkout.ts"
            ),
            "utf-8"
        );

        expect(code).toMatch(
            /spinWheelSpin\.updateMany\(\{[\s\S]{0,400}?status:\s*"AVAILABLE"[\s\S]{0,600}?redeemed\.count === 0/
        );
    });

    test("my-rewards is keyed by owner scope, not userId", () => {
        const code = require("fs").readFileSync(
            require("path").resolve(
                process.cwd(),
                "app/api/spin-wheel/my-rewards/route.ts"
            ),
            "utf-8"
        );

        expect(code).toMatch(/ownerKey:\s*scope\.ownerKey/);
        expect(code).not.toMatch(
            /where:\s*\{\s*userId:\s*session/
        );
    });

    test("the my-rewards payload omits the stored owner key", async () => {
        mockedAccessible.mockResolvedValue([42]);
        mockedOrder.findFirst.mockResolvedValue({
            guestIdentityKey: GUEST_IDENTITY,
        });

        /*
         * The stored row carries the scope; the response must not.
         */
        mockedSpinRows.mockResolvedValue([
            {
                id: 1,
                ownerKey: `guest:${GUEST_IDENTITY}`,
                userId: null,
                status: "AVAILABLE",
                createdAt: new Date(),
                expiresAt: null,
                usedAt: null,
                orderId: null,
                reward: {
                    id: 3,
                    name: "Diskon 10%",
                    type: "PERCENTAGE",
                    value: 10,
                    maxDiscount: null,
                },
                campaign: { name: "Spin Oktober" },
            },
        ]);

        const body = await (
            await myRewardsGET()
        ).json();
        const serialized = JSON.stringify(body);

        expect(body.data).toHaveLength(1);
        expect(serialized).not.toContain("ownerKey");
        expect(serialized).not.toContain(GUEST_IDENTITY);
        expect(serialized).not.toContain("guest:");
    });
});
