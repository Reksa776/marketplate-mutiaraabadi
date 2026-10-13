/**
 * ==========================================
 * AFFILIATE PAYOUT SETTLEMENT — TRANSACTION REGRESSION
 * ==========================================
 *
 * REGRESSION (P2028): the APPROVE / STATUS / CONFIRM_PAID paths lock the
 * payout row FOR UPDATE and then settle its commissions. Settlement used
 * to open a SECOND transaction from inside that one, so it blocked on
 * the lock it already held and died when the outer transaction expired:
 *
 *   PrismaClientKnownRequestError P2028
 *   "Transaction already closed: A commit cannot be executed on an
 *    expired transaction. The timeout for this transaction was 5000 ms"
 *
 * The admin saw a 500 and NO settlement ran. This suite encodes the
 * invariant that fixes it:
 *
 *   1. NO NESTED TRANSACTION. `prisma.$transaction` is instrumented so a
 *      re-entrant call THROWS. Every action must complete with exactly
 *      the transactions it legitimately needs.
 *   2. SETTLEMENT PARTICIPATES IN THE CALLER'S TRANSACTION. The real
 *      `settleCommissionsForPayout` runs against the caller's `tx`, so
 *      the PAID transition and the FIFO consumption are one commit.
 *   3. LOCKING + IDEMPOTENCY UNCHANGED. The PENDING → PROCESSING step is
 *      still a `SELECT ... FOR UPDATE`, and the PAID step is still a
 *      conditional CAS `WHERE status = 'PROCESSING'`: a loser settles
 *      nothing, and a repeat action cannot settle twice.
 *
 * Only prisma, auth, the audit log and the disbursement provider are
 * mocked. No database, no network, no real transfer.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "affiliate-payout-tx-test-secret";

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

jest.mock("@/lib/affiliate/payout-provider", () => ({
    createDisbursement: jest.fn(async () => ({
        success: true,
        providerTransactionId: "DEV-TX-1",
        providerReference: "affiliate-payout-ref",
        status: "SUCCESS",
        message: "Development mode: simulated successful transfer",
    })),
    getDisbursementStatus: jest.fn(async () => ({
        success: true,
        status: "SUCCESS",
        message: "SUCCESS",
    })),
}));

/** Transaction bookkeeping the prisma mock reads/writes. */
const mockState = {
    inTransaction: 0,
    opens: 0,
    maxConcurrent: 0,
};

const mockTx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    affiliatePayout: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    affiliateConversion: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        affiliatePayout: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        affiliateProfile: {
            findUnique: jest.fn(),
        },
        $transaction: jest.fn(
            async (fn: (tx: unknown) => Promise<unknown>) => {
                /*
                 * RE-ENTRANCY GUARD. A nested interactive transaction is
                 * exactly the defect: it cannot see the lock its parent
                 * holds, so it blocks until the parent times out.
                 */
                if (mockState.inTransaction > 0) {
                    throw new Error(
                        "NESTED TRANSACTION — settlement must reuse the caller's tx"
                    );
                }

                mockState.inTransaction += 1;
                mockState.opens += 1;
                mockState.maxConcurrent = Math.max(
                    mockState.maxConcurrent,
                    mockState.inTransaction
                );

                try {
                    return await fn(mockTx);
                } finally {
                    mockState.inTransaction -= 1;
                }
            }
        ),
    },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import {
    createDisbursement,
    getDisbursementStatus,
} from "@/lib/affiliate/payout-provider";

import { PATCH as payoutPATCH } from "@/app/api/admin/affiliate/payouts/[id]/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedPayout = prisma.affiliatePayout as unknown as {
    findUnique: jest.Mock;
    update: jest.Mock;
};
const mockedProfile = prisma.affiliateProfile as unknown as {
    findUnique: jest.Mock;
};
const mockedAudit = createAuditLog as unknown as jest.Mock;
const mockedCreateDisbursement =
    createDisbursement as unknown as jest.Mock;
const mockedDisbursementStatus =
    getDisbursementStatus as unknown as jest.Mock;

const PAYOUT_ID = 4242;

type SqlArgs = [unknown, ...unknown[]];

function sqlOf(args: SqlArgs): string {
    const strings = args[0];

    return Array.isArray(strings)
        ? (strings as string[]).join("")
        : String(strings);
}

function payoutRequest(
    action: string,
    extra: Record<string, unknown> = {}
) {
    return new Request(
        `http://test/api/admin/affiliate/payouts/${PAYOUT_ID}`,
        {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, ...extra }),
        }
    );
}

const CONTEXT = {
    params: Promise.resolve({ id: String(PAYOUT_ID) }),
} as never;

function payoutFixture(status: string) {
    return {
        id: PAYOUT_ID,
        status,
        affiliateId: 7,
        amount: "50000",
        bankName: "BCA",
        bankAccountName: "P0 TESTER",
        bankAccountNumber: "1234567890",
        providerTransactionId:
            status === "PROCESSING" ? "DEV-TX-1" : null,
        providerReference:
            status === "PROCESSING"
                ? "affiliate-payout-ref"
                : null,
        idempotencyKey: null,
        paidAt: null,
        failedAt: null,
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    mockState.inTransaction = 0;
    mockState.opens = 0;
    mockState.maxConcurrent = 0;

    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });

    mockedProfile.findUnique.mockResolvedValue({
        id: 7,
        status: "APPROVED",
    });

    mockedPayout.update.mockResolvedValue({});

    // The PENDING row-lock SELECT.
    mockTx.$queryRaw.mockImplementation(
        async (...args: SqlArgs) => {
            const sql = sqlOf(args);

            if (sql.includes("'PENDING'")) {
                return [{ id: PAYOUT_ID, status: "PENDING" }];
            }

            // The settlement's PAID row-lock SELECT.
            return [{ id: PAYOUT_ID, affiliateId: 7 }];
        }
    );

    // The PAID CAS.
    mockTx.$executeRaw.mockImplementation(
        async (...args: SqlArgs) => {
            const sql = sqlOf(args);

            return sql.includes("status = 'PAID'") ||
                sql.includes("SET status = 'PAID'")
                ? 1
                : 1;
        }
    );

    mockTx.affiliatePayout.update.mockResolvedValue({});
    mockTx.affiliatePayout.findUnique.mockResolvedValue({
        amount: "50000",
    });
    mockTx.affiliateConversion.findMany.mockResolvedValue([
        { id: 900, commissionAmount: "50000" },
    ]);
    mockTx.affiliateConversion.updateMany.mockResolvedValue({
        count: 1,
    });
});

/* ==========================================
 * APPROVE — the path that returned P2028
 * ========================================== */

describe("APPROVE never opens a nested transaction", () => {
    test("settlement runs on the caller's tx and commits with the PAID transition", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PENDING")
        );

        const response = await payoutPATCH(
            payoutRequest("APPROVE"),
            CONTEXT
        );

        expect(response.status).toBe(200);

        // Two transactions, and never two at once:
        //   1. PENDING → PROCESSING (row lock + update)
        //   2. PROCESSING → PAID (CAS) + FIFO settlement
        expect(mockState.opens).toBe(2);
        expect(mockState.maxConcurrent).toBe(1);

        // The settlement consumed the eligible commission…
        expect(
            mockTx.affiliateConversion.updateMany
        ).toHaveBeenCalledWith({
            where: { id: { in: [900] } },
            data: { status: "PAID" },
        });

        // …inside the transaction that flipped the payout to PAID.
        const casSql = mockTx.$executeRaw.mock.calls.map(
            (call) => sqlOf(call as SqlArgs)
        );

        expect(
            casSql.some((sql) => sql.includes("status = 'PAID'"))
        ).toBe(true);
    });

    test("the PENDING lock is a real conditional row lock", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PENDING")
        );

        await payoutPATCH(payoutRequest("APPROVE"), CONTEXT);

        const lockSql = mockTx.$queryRaw.mock.calls
            .map((call) => sqlOf(call as SqlArgs))
            .find((sql) => sql.includes("'PENDING'"));

        expect(lockSql).toContain("FOR UPDATE");
        expect(lockSql).toContain("status = 'PENDING'");
    });
});

describe("APPROVE idempotency and concurrency", () => {
    test("losing the PENDING lock is a 409 and settles NOTHING", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PENDING")
        );

        // Another admin already moved the payout on.
        mockTx.$queryRaw.mockImplementation(async () => []);

        const response = await payoutPATCH(
            payoutRequest("APPROVE"),
            CONTEXT
        );

        expect(response.status).toBe(409);

        expect(
            mockTx.affiliateConversion.updateMany
        ).not.toHaveBeenCalled();
        expect(mockedCreateDisbursement).not.toHaveBeenCalled();

        // The failed attempt leaves no audit entry behind.
        expect(mockedAudit).not.toHaveBeenCalled();
    });

    test("an already-PROCESSING payout is refused before any transaction", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PROCESSING")
        );

        const response = await payoutPATCH(
            payoutRequest("APPROVE"),
            CONTEXT
        );

        expect(response.status).toBe(400);
        expect(mockState.opens).toBe(0);
        expect(
            mockTx.affiliateConversion.updateMany
        ).not.toHaveBeenCalled();
    });

    test("a CAS that matches no row skips settlement", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PENDING")
        );

        // The PAID CAS finds nothing (someone else already finalised).
        mockTx.$executeRaw.mockResolvedValue(0);

        const response = await payoutPATCH(
            payoutRequest("APPROVE"),
            CONTEXT
        );

        expect(response.status).toBe(200);
        expect(
            mockTx.affiliateConversion.updateMany
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * STATUS + CONFIRM_PAID — the other two settle sites
 * ========================================== */

describe("STATUS and CONFIRM_PAID settle in the same transaction", () => {
    test("STATUS → SUCCESS finalises PAID and settles without nesting", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PROCESSING")
        );
        mockedDisbursementStatus.mockResolvedValue({
            success: true,
            status: "SUCCESS",
            message: "SUCCESS",
        });

        const response = await payoutPATCH(
            payoutRequest("STATUS"),
            CONTEXT
        );

        expect(response.status).toBe(200);

        // ONE transaction for this action (the CAS + settlement); the
        // settlement must not open a second one.
        expect(mockState.opens).toBe(1);
        expect(mockState.maxConcurrent).toBe(1);
        expect(
            mockTx.affiliateConversion.updateMany
        ).toHaveBeenCalledTimes(1);
    });

    test("CONFIRM_PAID finalises PAID and settles without nesting", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PROCESSING")
        );

        const response = await payoutPATCH(
            payoutRequest("CONFIRM_PAID", {
                proofFilePath: "storage/uploads/p.pdf",
            }),
            CONTEXT
        );

        expect(response.status).toBe(200);
        expect(mockState.opens).toBe(1);
        expect(mockState.maxConcurrent).toBe(1);
        expect(
            mockTx.affiliateConversion.updateMany
        ).toHaveBeenCalledTimes(1);
    });

    test("CONFIRM_PAID on an already-PAID payout is a conflict", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PAID")
        );

        const response = await payoutPATCH(
            payoutRequest("CONFIRM_PAID", {
                proofFilePath: "storage/uploads/p.pdf",
            }),
            CONTEXT
        );

        expect(response.status).toBe(400);
        expect(mockState.opens).toBe(0);
        expect(
            mockTx.affiliateConversion.updateMany
        ).not.toHaveBeenCalled();
    });

    test("a lost CAS in CONFIRM_PAID settles nothing", async () => {
        mockedPayout.findUnique.mockResolvedValue(
            payoutFixture("PROCESSING")
        );
        mockTx.$executeRaw.mockResolvedValue(0);

        const response = await payoutPATCH(
            payoutRequest("CONFIRM_PAID", {
                proofFilePath: "storage/uploads/p.pdf",
            }),
            CONTEXT
        );

        expect(response.status).toBe(409);
        expect(
            mockTx.affiliateConversion.updateMany
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * SOURCE GUARD — no settle-without-tx may come back
 * ========================================== */

describe("every settle call inside a transaction passes that tx", () => {
    const sources = [
        "app/api/admin/affiliate/payouts/[id]/route.ts",
        "app/api/admin/affiliate/payouts/route.ts",
        "app/api/payment/payout/webhook/route.ts",
    ];

    test.each(sources)(
        "%s never settles from inside a transaction without a tx",
        (path) => {
            const code = require("fs").readFileSync(
                require("path").resolve(process.cwd(), path),
                "utf-8"
            );

            /*
             * Every occurrence of settleCommissionsForPayout must either
             * pass a second argument (a tx) or sit at a call site that
             * owns no transaction (the SETTLE retry action, handled by
             * the helper's own transaction).
             */
            const calls = code.match(
                /settleCommissionsForPayout\(([^)]*)\)/g
            );

            expect(calls).not.toBeNull();

            for (const call of calls!) {
                const hasTxArg = call.includes(",");

                if (!hasTxArg) {
                    // Only the standalone retry action may do this.
                    expect(code).toContain('action === "SETTLE"');
                    expect(call).toContain("settleCommissionsForPayout(payoutId)");
                }
            }
        }
    );
});
