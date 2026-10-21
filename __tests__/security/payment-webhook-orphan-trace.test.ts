/**
 * ==========================================
 * POST-CLEANUP CONSISTENCY — REGRESSION
 * ==========================================
 *
 * 1. A payment webhook that arrives for an order deleted by the approved
 *    cleanup must leave a PERMANENT trace in AdminAuditLog (a preserved
 *    table). It must never look like a fake payment confirmation.
 * 2. Deleting AffiliateConversion rows must not make an affiliate's
 *    available balance wrong: with conversions gone the balance clamps
 *    to 0 and the preserved payout ledger is untouched.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: {},
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

import { readFileSync } from "fs";
import { resolve } from "path";
import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/admin/audit-log";
import { recordUnmatchedPaymentWebhook } from "@/lib/payment/webhook-trace";
import { getAvailableBalance } from "@/lib/affiliate/commission";

const mockedAudit = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

function readFile(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

beforeEach(() => {
    mockedAudit.mockClear();
});

describe("Unmatched payment webhook trace", () => {
    test("records an audit row instead of silently losing the payment", async () => {
        await recordUnmatchedPaymentWebhook({
            provider: "ipaymu",
            orderNumber: "ORDER-DELETED-1",
            transactionStatus: "0",
            amount: "150000",
            providerReference: "trx-999",
            paymentType: "qris",
        });

        expect(mockedAudit).toHaveBeenCalledTimes(1);
        const arg = mockedAudit.mock.calls[0][0];
        expect(arg.action).toBe("PAYMENT_WEBHOOK_ORPHAN");
        expect(arg.entityType).toBe("System");
        expect(arg.adminId).toBe("SYSTEM");
        expect(arg.metadata?.orderNumber).toBe("ORDER-DELETED-1");
    });

    test("never stores PII or payment secrets in the trace", async () => {
        await recordUnmatchedPaymentWebhook({
            provider: "midtrans",
            orderNumber: "ORDER-DELETED-2",
            amount: "50000",
        });

        const arg = mockedAudit.mock.calls[0][0];
        const metadataKeys = Object.keys(arg.metadata ?? {});
        for (const forbidden of [
            "name",
            "phone",
            "email",
            "address",
            "bankAccountNumber",
            "token",
            "secret",
            "signature",
        ]) {
            expect(metadataKeys).not.toContain(forbidden);
        }
    });

    test("both payment webhook routes call the trace helper", () => {
        const ipaymu = readFile(
            "app/api/payment/ipaymu/notification/route.ts"
        );
        const midtrans = readFile(
            "app/api/payment/midtrans/notification/route.ts"
        );
        expect(ipaymu).toContain("recordUnmatchedPaymentWebhook");
        expect(midtrans).toContain("recordUnmatchedPaymentWebhook");
        // The provider must still get HTTP 200 for an unknown order.
        expect(ipaymu).toContain("Order tidak ditemukan.");
        expect(midtrans).toContain("Order tidak ditemukan.");
    });
});

describe("Affiliate balance after conversion deletion", () => {
    test("clamps to 0 and never reports phantom withdrawable funds", async () => {
        const fakeClient = {
            affiliateConversion: {
                aggregate: jest.fn(async () => ({
                    _sum: { commissionAmount: null },
                })),
            },
            affiliatePayout: {
                aggregate: jest.fn(async () => ({
                    _sum: { amount: new Prisma.Decimal(148450) },
                })),
            },
        };

        const available = await getAvailableBalance(
            1,
            fakeClient as never
        );

        expect(available.toNumber()).toBe(0);
        // Payout ledger is only READ, never mutated by the balance query.
        expect(fakeClient.affiliatePayout.aggregate).toHaveBeenCalledTimes(1);
    });

    test("subtracts reserved payouts from earned commission", async () => {
        const fakeClient = {
            affiliateConversion: {
                aggregate: jest.fn(async () => ({
                    _sum: { commissionAmount: new Prisma.Decimal(200000) },
                })),
            },
            affiliatePayout: {
                aggregate: jest.fn(async () => ({
                    _sum: { amount: new Prisma.Decimal(52000) },
                })),
            },
        };

        const available = await getAvailableBalance(
            1,
            fakeClient as never
        );

        expect(available.toNumber()).toBe(148000);
    });
});
