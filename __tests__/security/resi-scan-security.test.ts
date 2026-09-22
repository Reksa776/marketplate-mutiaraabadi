/* ==========================================
 * RESI SCAN — SECURITY REGRESSION TESTS
 * ==========================================
 *
 * Adversarial apply-path tests: a client can
 * forge orderId / trackingNumber / confidence —
 * the server must re-derive + re-validate
 * everything against the database and never trust
 * the client. Concurrent-conflict safety relies
 * on MySQL advisory locks inside the apply
 * transaction.
 *
 * These are runtime behavior tests with a mocked
 * Prisma transaction client, plus source-integrity
 * assertions for the route authorization guards.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => {}),
}));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import { applyScanResi } from "@/lib/resi-scan/apply";
import { isPlausibleTrackingNumber } from "@/lib/resi-scan/extract";
import type { ApplyScanItem } from "@/lib/resi-scan/types";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

interface OrderFixture {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    trackingNumber: string | null;
}

const ELIGIBLE: OrderFixture = {
    id: 10,
    orderNumber: "ORD-1234567890-ABCDEF12",
    status: "PAID",
    paymentStatus: "PAID",
    trackingNumber: null,
};

const VALID_TRACKING = "JNE1234567890";

function makeItem(
    overrides: Partial<ApplyScanItem>
): ApplyScanItem {
    return {
        orderId: 0,
        orderNumber: null,
        reference: null,
        trackingNumber: "",
        courier: null,
        source: "ocr",
        confidence: 0,
        fileName: null,
        ...overrides,
    };
}

interface TxOptions {
    order?: OrderFixture | null;
    duplicate?: { id: number } | null;
    lockBusy?: boolean;
    updateThrows?: boolean;
}

function makeFakeTx(opts: TxOptions) {
    const tx = {
        order: {
            findUnique: jest.fn(async () =>
                opts.order ?? null
            ),
            findFirst: jest.fn(async () =>
                opts.duplicate ?? null
            ),
            update: jest.fn(async () => {
                if (opts.updateThrows) {
                    throw new Error("db boom");
                }
                return { id: opts.order?.id ?? 0 };
            }),
        },
        $queryRaw: jest.fn(async (strings: {
            join: (sep: string) => string;
        }) => {
            const sql = strings.join("");
            if (sql.includes("GET_LOCK")) {
                return opts.lockBusy
                    ? [{ ok: 0 }]
                    : [{ ok: 1 }];
            }
            // RELEASE_LOCK
            return [{ ok: 1 }];
        }),
    };
    return tx;
}

let txMock: ReturnType<typeof makeFakeTx>;
const txPromiseMock = jest.fn(
    async (cb: (tx: unknown) => unknown) => cb(txMock)
);

describe("RESI SCAN — apply security (server must re-validate)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        txMock = makeFakeTx({ order: ELIGIBLE });
        (prisma as unknown as {
            $transaction: jest.Mock;
        }).$transaction = txPromiseMock;
        (createAuditLog as unknown as jest.Mock)
            .mockResolvedValue(undefined);
    });

    test("fixture tracking is plausible (sanity)", () => {
        expect(
            isPlausibleTrackingNumber(VALID_TRACKING)
        ).toBe(true);
        expect(
            isPlausibleTrackingNumber("RESI-LAIN!!")
        ).toBe(false);
        expect(
            isPlausibleTrackingNumber("RESILAIN!!!XYZ")
        ).toBe(false);
    });

    test("forged orderId (0) → INVALID, no DB access, no audit", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: 0,
                trackingNumber: VALID_TRACKING,
                confidence: 1,
            }),
            "admin-1"
        );
        expect(result.status).toBe("INVALID");
        expect(txPromiseMock).not.toHaveBeenCalled();
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    test("forged orderId (NaN) → INVALID", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: NaN,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("INVALID");
        expect(txPromiseMock).not.toHaveBeenCalled();
    });

    test("forged trackingNumber → INVALID before DB (stray punctuation rejected)", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: 10,
                trackingNumber: "RESI-LAIN!!",
            }),
            "admin-1"
        );
        expect(result.status).toBe("INVALID");
        expect(txPromiseMock).not.toHaveBeenCalled();
    });

    test("short numeric tracking rejected (anti-phone/date)", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: 10,
                trackingNumber: "12345",
            }),
            "admin-1"
        );
        expect(result.status).toBe("INVALID");
    });

    test("valid tracking + eligible order → APPLIED, uppercased, audited", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: "jne1234567890",
                confidence: 0.9,
                source: "pdf-text",
            }),
            "admin-1"
        );
        expect(result.status).toBe("APPLIED");
        expect(txMock.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ELIGIBLE.id },
                data: expect.objectContaining({
                    trackingNumber: VALID_TRACKING,
                }),
            })
        );
        expect(createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "ORDER_TRACKING_ASSIGNED",
                entityId: ELIGIBLE.id,
            })
        );
    });

    test("forged confidence (99 / -3) never gates and is clamped in audit", async () => {
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
                confidence: 99,
            }),
            "admin-1"
        );
        expect(result.status).toBe("APPLIED");
        const auditArgs =
            (createAuditLog as unknown as jest.Mock)
                .mock.calls[0][0];
        expect(auditArgs.metadata.confidence).toBe(1);

        await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
                confidence: -3,
            }),
            "admin-1"
        );
        const secondAudit =
            (createAuditLog as unknown as jest.Mock)
                .mock.calls[1][0];
        expect(secondAudit.metadata.confidence).toBe(0);
    });

    test("existing different resi is NEVER overwritten", async () => {
        txMock = makeFakeTx({
            order: {
                ...ELIGIBLE,
                trackingNumber: "JNE9999999999",
            },
        });
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("CONFLICT");
        expect(txMock.order.update).not.toHaveBeenCalled();
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    test("resi already used by another order → CONFLICT, no reuse", async () => {
        txMock = makeFakeTx({
            order: ELIGIBLE,
            duplicate: { id: 42 },
        });
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("CONFLICT");
        expect(result.message).toContain("sudah digunakan");
        expect(txMock.order.update).not.toHaveBeenCalled();
    });

    test("blocked order status (CANCELLED / REFUNDED) → CONFLICT", async () => {
        txMock = makeFakeTx({
            order: {
                ...ELIGIBLE,
                status: "CANCELLED",
            },
        });
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("CONFLICT");
        expect(txMock.order.update).not.toHaveBeenCalled();
    });

    test("advisory lock busy → CONFLICT (concurrent admin already applying)", async () => {
        txMock = makeFakeTx({
            order: ELIGIBLE,
            lockBusy: true,
        });
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("CONFLICT");
        expect(txMock.order.update).not.toHaveBeenCalled();
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    test("database error during apply → INVALID, locks still released, no audit", async () => {
        txMock = makeFakeTx({
            order: ELIGIBLE,
            updateThrows: true,
        });
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
            }),
            "admin-1"
        );
        expect(result.status).toBe("INVALID");
        expect(createAuditLog).not.toHaveBeenCalled();
        const releaseCalls = txMock.$queryRaw.mock.calls.filter(
            (c: unknown[]) =>
                (c[0] as { join: (sep: string) => string })
                    .join("")
                    .includes("RELEASE_LOCK")
        );
        expect(releaseCalls.length).toBeGreaterThan(0);
    });

    test("audit fileName sanitized (control chars stripped, capped at 255)", async () => {
        const dirty = `ok\x00\x1fbad${"x".repeat(300)}.pdf`;
        const result = await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
                fileName: dirty,
                courier: "\x00evil",
            }),
            "admin-1"
        );
        expect(result.status).toBe("APPLIED");
        const auditArgs =
            (createAuditLog as unknown as jest.Mock)
                .mock.calls[0][0];
        expect(auditArgs.metadata.fileName).toBeDefined();
        expect(
            auditArgs.metadata.fileName.length
        ).toBeLessThanOrEqual(255);
        expect(
            auditArgs.metadata.fileName
        ).not.toMatch(/[\u0000-\u001F]/);
        expect(auditArgs.metadata.courier).not.toMatch(
            /[\u0000-\u001F]/
        );
    });

    test("audit source normalized to pdf-text/ocr", async () => {
        await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
                source: "ocr",
            }),
            "admin-1"
        );
        await applyScanResi(
            makeItem({
                orderId: ELIGIBLE.id,
                trackingNumber: VALID_TRACKING,
                source: "pdf-text",
            }),
            "admin-1"
        );
        const auditArgs =
            (createAuditLog as unknown as jest.Mock)
                .mock.calls;
        expect(auditArgs[0][0].metadata.source).toBe("ocr");
        expect(auditArgs[1][0].metadata.source).toBe(
            "pdf-text"
        );
    });
});

/* ==========================================
 * ROUTE-LEVEL SOURCE INTEGRITY
 * ========================================== */

describe("RESI SCAN — route guards (source integrity)", () => {
    test("apply is ADMIN-only", () => {
        const route = readFile(
            "app/api/admin/resi-scan/apply/route.ts"
        );
        expect(route).toContain('role !== "ADMIN"');
        expect(route).toContain("Akses ditolak. Hanya admin.");
    });

    test("apply never trusts the client orderId/tracking shape", () => {
        const route = readFile(
            "app/api/admin/resi-scan/apply/route.ts"
        );
        // orderId is coerced through Number() — a
        // forged "ORDER-LAIN" collapses to 0 → INVALID.
        expect(route).toMatch(/Number\(raw\.orderId\) \|\| 0/);
        expect(route).toContain("isPlausibleTrackingNumber");
        expect(route).toContain("MAX_ITEMS");
    });

    test("apply uses MySQL advisory locks to prevent duplicate/concurrent assignment", () => {
        const apply = readFile(
            "lib/resi-scan/apply.ts"
        );
        expect(apply).toContain("GET_LOCK");
        expect(apply).toContain("RELEASE_LOCK");
        expect(apply).toContain("scanapply:");
    });

    test("scan route is read-only (no writes, no transaction)", () => {
        const scan = readFile(
            "app/api/admin/resi-scan/route.ts"
        );
        expect(scan).toContain('role !== "ADMIN"');
        expect(scan).not.toContain("$transaction");
        expect(scan).not.toMatch(/\.update\(/);
    });
});