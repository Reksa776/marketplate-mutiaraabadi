/**
 * ==========================================
 * MENGANTAR AUTO-SHIPMENT TESTS
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-auto-shipment.test.ts
 *
 * Covers:
 *  - Pure pickup-schedule math (90-min rule, WIB, mm-dd-yyyy)
 *  - Durable outbox worker: claim / done / waiting-balance / retry /
 *    permanent failure / refund-cancel / non-Mengantar guard / COD
 *  - Wiring: settlement enqueue, non-blocking process, admin retry
 *  - Source guarantees: no secret exposure, paymentStatus untouched,
 *    schedule never reused
 */

import { readFileSync } from "fs";

function readFile(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

/* ==========================================================
 * PURE PICKUP SCHEDULE MATH
 * ========================================================== */

import {
    computeNextMengantarPickupSlot,
    parseMengantarPickupSlot,
    MENGANTAR_MIN_LEAD_MINUTES,
} from "@/lib/mengantar/pickup-schedule";

describe("computeNextMengantarPickupSlot (WIB, 90-min rule)", () => {
    it("picks the next hourly slot at least 90 minutes ahead", () => {
        // 07:00 WIB → +90m = 08:30 WIB → next slot 9:00.
        const slot = computeNextMengantarPickupSlot(
            new Date("2026-10-01T00:00:00.000Z")
        );
        expect(slot.date).toBe("10-01-2026");
        expect(slot.time).toBe("09:00");
    });

    it("respects the exact 90-minute boundary", () => {
        // 07:30 WIB → +90m = 09:00 WIB exactly → 9:00 is allowed.
        const slot = computeNextMengantarPickupSlot(
            new Date("2026-10-01T00:30:00.000Z")
        );
        expect(slot.time).toBe("09:00");
    });

    it("rolls to the next day when today's slots are exhausted", () => {
        // 17:30 WIB → +90m = 19:00 WIB → no slot left today → 9:00 next day.
        const slot = computeNextMengantarPickupSlot(
            new Date("2026-10-01T10:30:00.000Z")
        );
        expect(slot.date).toBe("10-02-2026");
        expect(slot.time).toBe("09:00");
    });

    it("uses the documented 90-minute lead", () => {
        expect(MENGANTAR_MIN_LEAD_MINUTES).toBe(90);
    });
});

describe("parseMengantarPickupSlot", () => {
    it("parses a valid mm-dd-yyyy / HH:mm slot", () => {
        const ms = parseMengantarPickupSlot("11-27-2026", "13:00");
        expect(typeof ms).toBe("number");
        // 13:00 WIB === 06:00 UTC.
        expect(new Date(ms as number).toISOString()).toBe(
            "2026-11-27T06:00:00.000Z"
        );
    });

    it("rejects malformed slots", () => {
        expect(parseMengantarPickupSlot("2026-11-27", "13:00")).toBeNull();
        expect(parseMengantarPickupSlot("11-27-2026", "25:00")).toBeNull();
        expect(parseMengantarPickupSlot("", "")).toBeNull();
    });
});

/* ==========================================================
 * WORKER (mocked provider + prisma)
 * ========================================================== */

jest.mock("@/lib/prisma", () => ({
    prisma: {
        shipmentJob: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            updateMany: jest.fn(),
            upsert: jest.fn(),
            create: jest.fn(),
            createMany: jest.fn(),
        },
        order: {
            findUnique: jest.fn(),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    // Mimics the real redaction contract: the provider key is stripped.
    redactMengantarKey: (v: unknown) =>
        String(v ?? "").replace(/SECRET123/g, "[REDACTED]"),
}));

jest.mock("@/lib/mengantar/shipment", () => ({
    createShipmentForOrder: jest.fn(),
    payUnpaidShipmentForOrder: jest.fn(),
}));

jest.mock("@/lib/notification/order-status-handler", () => ({
    onShipmentStatusChanged: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import {
    createShipmentForOrder,
    payUnpaidShipmentForOrder,
} from "@/lib/mengantar/shipment";
import { processShipmentJobs } from "@/lib/mengantar/shipment-worker";

const mockPrisma = prisma as unknown as {
    shipmentJob: {
        findMany: jest.Mock;
        findUnique: jest.Mock;
        updateMany: jest.Mock;
        upsert: jest.Mock;
        create: jest.Mock;
        createMany: jest.Mock;
    };
    order: { findUnique: jest.Mock };
};

const mockedCreate = createShipmentForOrder as unknown as jest.Mock;
const mockedPay = payUnpaidShipmentForOrder as unknown as jest.Mock;

function job(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        orderId: 10,
        status: "PROCESSING",
        stage: "CREATE",
        attempts: 1,
        maxAttempts: 6,
        lastError: null,
        ...overrides,
    };
}

function order(overrides: Record<string, unknown> = {}) {
    return {
        id: 10,
        status: "PAID",
        paymentStatus: "PAID",
        paymentMethod: "BANK_TRANSFER",
        shippingProvider: "MENGANTAR",
        shipmentStatus: "SHIPMENT_PENDING",
        shippingPaymentStatus: "UNPAID",
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    // Reclaim pass + claim both succeed.
    mockPrisma.shipmentJob.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.shipmentJob.findMany.mockResolvedValue([
        { id: 1, orderId: 10 },
    ]);
    mockPrisma.shipmentJob.findUnique.mockResolvedValue(job());
    mockPrisma.order.findUnique.mockResolvedValue(order());
});

describe("processShipmentJobs — outbox worker", () => {
    it("processes exactly one job and marks it DONE on CREATED", async () => {
        mockedCreate.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "PAID",
            trackingNumber: "CN-1",
        });

        const result = await processShipmentJobs();

        expect(result.processed).toBe(1);
        expect(mockedCreate).toHaveBeenCalledTimes(1);
        expect(mockedCreate).toHaveBeenCalledWith(10);
        // Finalize write sets DONE.
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "DONE" }),
            })
        );
    });

    it("skips a job another worker already claimed (CAS count = 0)", async () => {
        // Reclaim pass count 0, then claim count 0.
        mockPrisma.shipmentJob.updateMany
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 0 });

        const result = await processShipmentJobs();

        expect(result.processed).toBe(0);
        expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("moves to the PAY stage on insufficient balance", async () => {
        mockedCreate.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "WAITING_SHIPPING_PAYMENT",
            shippingPaymentStatus: "UNPAID",
            trackingNumber: null,
            pickupSchedule: { date: "10-02-2026", time: "9:00" },
        });

        await processShipmentJobs();

        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    stage: "PAY",
                    status: "PENDING",
                    pickupDate: "10-02-2026",
                    pickupTime: "9:00",
                }),
            })
        );
    });

    it("retries pay-unpaid when the balance is still short", async () => {
        mockPrisma.shipmentJob.findUnique.mockResolvedValue(
            job({ stage: "PAY" })
        );
        mockedPay.mockResolvedValue({
            ok: false,
            reason: "Saldo kurang.",
        });

        await processShipmentJobs();

        expect(mockedPay).toHaveBeenCalledWith(10);
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "PENDING",
                    lastError: "Saldo kurang.",
                }),
            })
        );
    });

    it("marks DONE when pay-unpaid finally creates the shipment", async () => {
        mockPrisma.shipmentJob.findUnique.mockResolvedValue(
            job({ stage: "PAY" })
        );
        mockedPay.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "PAID",
            trackingNumber: "CN-9",
        });

        await processShipmentJobs();

        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "DONE" }),
            })
        );
    });

    it("cancels the job for a refunded/cancelled order (refund race)", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            order({ status: "CANCELLED", paymentStatus: "REFUNDED" })
        );

        await processShipmentJobs();

        expect(mockedCreate).not.toHaveBeenCalled();
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "CANCELLED" }),
            })
        );
    });

    it("cancels the job when only paymentStatus is REFUNDED", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            order({ status: "PAID", paymentStatus: "REFUNDED" })
        );

        await processShipmentJobs();

        expect(mockedCreate).not.toHaveBeenCalled();
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "CANCELLED" }),
            })
        );
    });

    it("cancels the job when only status is CANCELLED", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            order({ status: "CANCELLED", paymentStatus: "PAID" })
        );

        await processShipmentJobs();

        expect(mockedCreate).not.toHaveBeenCalled();
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "CANCELLED" }),
            })
        );
    });

    it("processes a COD + Mengantar job instead of cancelling it", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            order({ paymentMethod: "COD" })
        );
        mockedCreate.mockResolvedValue({
            ok: true,
            changed: true,
            shipmentStatus: "CREATED",
            shippingPaymentStatus: "NOT_APPLICABLE",
            trackingNumber: "CN-COD",
        });

        await processShipmentJobs();

        // COD reaches the existing create path...
        expect(mockedCreate).toHaveBeenCalledWith(10);
        // ...and is NEVER cancelled because of its payment method.
        const cancelled =
            mockPrisma.shipmentJob.updateMany.mock.calls.find(
                (c) => c[0]?.data?.status === "CANCELLED"
            );
        expect(cancelled).toBeFalsy();
    });

    it("still cancels a job whose provider is not Mengantar", async () => {
        mockPrisma.order.findUnique.mockResolvedValue(
            order({ shippingProvider: "RAJAONGKIR" })
        );

        await processShipmentJobs();

        expect(mockedCreate).not.toHaveBeenCalled();
        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "CANCELLED" }),
            })
        );
    });

    it("retries a thrown provider API failure with a redacted error", async () => {
        mockedCreate.mockRejectedValue(
            new Error("upstream boom key=SECRET123")
        );

        await processShipmentJobs();

        const retryCall =
            mockPrisma.shipmentJob.updateMany.mock.calls.find(
                (c) =>
                    c[0]?.data?.status === "PENDING" &&
                    c[0]?.data?.lastError
            );
        expect(retryCall).toBeTruthy();
        expect(retryCall![0].data.lastError).not.toContain(
            "SECRET123"
        );
        expect(retryCall![0].data.lastError).toContain(
            "[REDACTED]"
        );
    });

    it("permanently fails a job after the attempt budget is spent", async () => {
        mockPrisma.shipmentJob.findUnique.mockResolvedValue(
            job({ attempts: 6, maxAttempts: 6 })
        );
        mockedCreate.mockRejectedValue(new Error("timeout"));

        await processShipmentJobs();

        expect(mockPrisma.shipmentJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "FAILED" }),
            })
        );
    });
});

/* ==========================================================
 * WIRING / SOURCE GUARANTEES
 * ========================================================== */

const ipaymuWebhook = readFile(
    "app/api/payment/ipaymu/notification/route.ts"
);
const midtransWebhook = readFile(
    "app/api/payment/midtrans/notification/route.ts"
);
const worker = readFile("lib/mengantar/shipment-worker.ts");
const scheduleResolver = readFile(
    "lib/mengantar/pickup-schedule.ts"
);
const shipmentLib = readFile("lib/mengantar/shipment.ts");
const adminPage = readFile("app/admin/orders/[id]/page.tsx");
const retryRoute = readFile(
    "app/api/admin/orders/[id]/shipment/retry/route.ts"
);
const sweepRoute = readFile(
    "app/api/admin/shipments/process/route.ts"
);
const migration = readFile(
    "prisma/migrations/20261002000000_add_shipment_job/migration.sql"
);
const schema = readFile("prisma/schema.prisma");
const checkoutLib = readFile("lib/checkout.ts");
const orderPaymentLib = readFile("lib/payment/order-payment.ts");

describe("Settlement trigger (authoritative PAID)", () => {
    it("enqueues the outbox atomically with the settlement CAS", () => {
        for (const webhook of [ipaymuWebhook, midtransWebhook]) {
            expect(webhook).toContain("enqueueShipmentJobTx");
            expect(webhook).toContain("scheduleShipmentProcessing");
            // Enqueue runs inside the CAS transaction (uses tx).
            expect(webhook).toContain("enqueueShipmentJobTx(");
            expect(webhook).toContain("tx,");
        }
    });

    it("only enqueues for non-COD Mengantar orders (settlement path)", () => {
        for (const webhook of [ipaymuWebhook, midtransWebhook]) {
            expect(webhook).toContain(
                'existingOrder.shippingProvider ==='
            );
            expect(webhook).toContain(
                'existingOrder.paymentMethod !== "COD"'
            );
        }
    });

    it("never blocks the webhook on a Mengantar call", () => {
        // scheduleShipmentProcessing uses after() (post-response).
        expect(worker).toContain("next/server");
        expect(worker).toContain("after(");
        // Enqueue uses skipDuplicates so a replay cannot throw.
        expect(worker).toContain("skipDuplicates: true");
    });
});

describe("Worker invariants", () => {
    it("claims jobs with an atomic CAS and reclaims stale locks", () => {
        expect(worker).toContain("STALE_JOB_LOCK_MS");
        expect(worker).toContain('status: "PENDING"');
        expect(worker).toContain('status: "PROCESSING"');
        expect(worker).toContain("attempts: { increment: 1 }");
    });

    it("never writes paymentStatus", () => {
        expect(worker).not.toContain('paymentStatus: "');
        expect(shipmentLib).not.toContain('paymentStatus: "');
    });

    it("redacts provider errors", () => {
        expect(worker).toContain("redactMengantarKey");
    });

    it("guards shipments for cancelled/refunded orders", () => {
        expect(shipmentLib).toContain('order.status === "CANCELLED"');
        expect(shipmentLib).toContain(
            'order.paymentStatus === "REFUNDED"'
        );
    });

    it("does not expose the API key / webhook secret", () => {
        for (const file of [
            worker,
            scheduleResolver,
            retryRoute,
            sweepRoute,
            adminPage,
        ]) {
            expect(file).not.toContain("MENGANTAR_API_KEY");
            expect(file).not.toContain("MENGANTAR_WEBHOOK_SECRET");
        }
    });
});

describe("Pickup schedule policy", () => {
    it("creates a FRESH slot per shipment — never reuses a time_id", () => {
        expect(scheduleResolver).toContain(
            "createMengantarPickupTime"
        );
        // No reuse: the resolver never lists/reuses existing slots.
        expect(scheduleResolver).not.toContain(
            "listMengantarPickupTimes"
        );
    });

    it("persists the validated WIB slot, never the provider ISO echo", () => {
        // POST /time echoes an ISO `date`; storing it raw would corrupt
        // the display-persisted pickupDate (Phase 3 audit fix).
        expect(scheduleResolver).toContain("date: slot.date");
        expect(scheduleResolver).toContain("time: slot.time");
    });

    it("uses the documented mm-dd-yyyy format and 90-min lead", () => {
        expect(scheduleResolver).toContain("mm-dd-yyyy");
        expect(scheduleResolver).toContain(
            "MENGANTAR_MIN_LEAD_MINUTES = 90"
        );
    });
});

describe("Admin recovery + UI", () => {
    it("adds ADMIN-only retry and sweeper routes", () => {
        expect(retryRoute).toContain('session.user.role !== "ADMIN"');
        expect(sweepRoute).toContain('session.user.role !== "ADMIN"');
        expect(retryRoute).toContain("runShipmentJobForOrder");
        expect(sweepRoute).toContain("processShipmentJobs");
    });

    it("shows automatic status, pickup schedule and a recovery action", () => {
        expect(adminPage).toContain("SHIPMENT_PENDING");
        expect(adminPage).toContain("Jadwal pickup");
        expect(adminPage).toContain("/shipment/retry");
        expect(adminPage).toContain("Proses Ulang Otomatis");
        // Existing manual labels are retained as recovery.
        expect(adminPage).toContain("Buat Shipment");
        expect(adminPage).toContain("Bayar Ongkir");
    });
});

describe("Database migration", () => {
    it("creates the shipmentjob outbox table additively", () => {
        expect(migration).toContain("CREATE TABLE `shipmentjob`");
        expect(migration).toContain(
            "UNIQUE INDEX `shipmentjob_orderId_key`"
        );
        // Additive only — never drops/alters an existing table.
        expect(migration).not.toContain("DROP TABLE");
        expect(migration).not.toContain("ALTER TABLE `order`");
    });

    it("declares the ShipmentJob model with a unique orderId", () => {
        expect(schema).toContain("model ShipmentJob {");
        expect(schema).toContain("orderId         Int      @unique");
    });

    it("adds SHIPMENT_PENDING to the status machine", () => {
        const status = readFile("lib/mengantar/status.ts");
        expect(status).toContain('"SHIPMENT_PENDING"');
    });
});

describe("COD enqueue at checkout (no settlement event)", () => {
    it("enqueues a ShipmentJob for COD + Mengantar inside the create tx", () => {
        expect(checkoutLib).toContain(
            "enqueueShipmentJobTx(tx, order.id)"
        );
        const idx = checkoutLib.indexOf(
            "enqueueShipmentJobTx(tx, order.id)"
        );
        expect(idx).toBeGreaterThan(-1);
        // The enqueue is explicitly guarded to COD + MENGANTAR.
        const guard = checkoutLib.slice(idx - 320, idx);
        expect(guard).toContain('shippingProvider === "MENGANTAR"');
        expect(guard).toContain('input.paymentMethod === "COD"');
    });

    it("has exactly one COD enqueue call site (no non-Mengantar enqueue)", () => {
        expect(
            checkoutLib
                .split("enqueueShipmentJobTx(tx, order.id)")
                .length - 1
        ).toBe(1);
    });

    it("enqueues idempotently (createMany + skipDuplicates + unique orderId)", () => {
        expect(worker).toContain("skipDuplicates: true");
        expect(schema).toContain(
            "orderId         Int      @unique"
        );
    });

    it("keeps the COD customer payment UNPAID at order creation", () => {
        const lf = checkoutLib.replace(/\r\n/g, "\n");
        expect(lf).toContain(
            'input.paymentMethod ===\n                            "COD"\n                                ? "UNPAID"'
        );
    });
});

describe("COD auto-processing (no settlement webhook)", () => {
    it("nudges the worker right after a COD + Mengantar checkout", () => {
        // Enqueue alone leaves the job PENDING forever: COD has no
        // settlement webhook, so the checkout itself must schedule the
        // post-response processing pass.
        const idx = checkoutLib.indexOf(
            "await scheduleShipmentProcessing()"
        );
        expect(idx).toBeGreaterThan(-1);
        // Guarded to COD + MENGANTAR only.
        const guard = checkoutLib.slice(idx - 220, idx);
        expect(guard).toContain('shippingProvider === "MENGANTAR"');
        expect(guard).toContain('input.paymentMethod === "COD"');
    });

    it("keeps exactly one COD schedule call site (webhooks own NON-COD)", () => {
        expect(
            checkoutLib
                .split("await scheduleShipmentProcessing()")
                .length - 1
        ).toBe(1);
        for (const webhook of [ipaymuWebhook, midtransWebhook]) {
            expect(webhook).toContain("scheduleShipmentProcessing");
        }
    });

    it("never nudges processing for a NON-Mengantar COD order", () => {
        const idx = checkoutLib.indexOf(
            "await scheduleShipmentProcessing()"
        );
        const guard = checkoutLib.slice(idx - 220, idx);
        expect(guard).toContain('shippingProvider === "MENGANTAR"');
    });
});

describe("COD survives the unpaid-order expiry/cleanup", () => {
    it("never expires/cancels a COD order through the online-payment lifecycle", () => {
        expect(orderPaymentLib).toContain('order.paymentMethod === "COD"');
        expect(orderPaymentLib).toContain('return "NOT_CANCELLABLE"');
    });

    it("keeps the automatic rollback COD-safe unless explicitly opted in", () => {
        expect(checkoutLib).toContain(
            "options?.allowCodCancellation ?? false"
        );
        // Raw CAS guard: automatic (0) rollback can never cancel COD.
        expect(checkoutLib).toContain("allowCodCancellation ? 1 : 0");
    });
});

describe("COD shipment status (never an unrecoverable state)", () => {
    it("maps a COD ORDER_ID to CREATED, not WAITING_SHIPPING_PAYMENT", () => {
        expect(shipmentLib).toContain("const shipmentStatus = isCod");
        expect(shipmentLib).toContain('? "CREATED"');
    });

    it("keeps COD seller shipping payment NOT_APPLICABLE", () => {
        expect(shipmentLib).toContain('isCod ? "NOT_APPLICABLE"');
    });

    it("keeps NON-COD insufficient balance → WAITING_SHIPPING_PAYMENT", () => {
        expect(shipmentLib).toContain(
            '"WAITING_SHIPPING_PAYMENT"'
        );
        // Still gated on `paid` for NON-COD.
        expect(shipmentLib).toContain(": paid");
    });

    it("persists the provider ORDER_ID as providerShipmentId", () => {
        expect(shipmentLib).toContain(
            "providerShipmentId: created.ORDER_ID"
        );
    });

    it("never writes the customer paymentStatus from the shipment flow", () => {
        expect(shipmentLib).not.toContain('paymentStatus: "PAID"');
        expect(worker).not.toContain('paymentStatus: "');
    });
});

describe("Unproven behaviour is documented as such", () => {
    it("marks time_id reuse as unproven / avoided", () => {
        expect(scheduleResolver).toContain("UNPROVEN");
    });
});
