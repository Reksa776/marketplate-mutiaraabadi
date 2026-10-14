/**
 * ==========================================
 * COD PROTECTION — REGRESSION TESTS
 * ==========================================
 *
 * Covers the COD abuse controls added for guest checkout:
 *
 *   1. RATE LIMITING  — IP/device + normalized guest identity (via the
 *                       guest identity hash), enforced in
 *                       POST /api/orders.
 *   2. IDEMPOTENCY    — a double submission or a concurrent duplicate
 *                       with the same key never creates a second order.
 *   3. REVIEW GATE    — a high-risk COD order is FLAGGED, gets NO
 *                       ShipmentJob, and waits for an authorized admin.
 *                       Approve releases the shipment; REJECT is a
 *                       REJECT & CANCEL that runs the existing safe
 *                       cancellation lifecycle (release reservations,
 *                       stop shipment jobs, notify the buyer) in the
 *                       SAME transaction as the review decision.
 *
 * No real Mengantar call, no database and no payment provider is
 * touched: prisma, auth, the shipment worker, the notification handler
 * and the audit log are all mocked.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "cod-protection-test-secret";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockOrder = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
};

const mockShipmentJob = {
    deleteMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
};

/**
 * The transaction client the COD REJECT & CANCEL path is handed. Every
 * release step of the existing cancellation lifecycle is observable
 * through it, so a rejection can be asserted resource by resource.
 */
const mockTx = {
    // Tagged-template call: (strings, ...values).
    $executeRaw: jest.fn(
        async (_strings: unknown, ..._rest: unknown[]) => 1
    ),
    order: {
        findUnique: jest.fn(),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
    },
    shipmentJob: {
        updateMany: jest.fn(async () => ({ count: 1 })),
    },
    productVariant: {
        update: jest.fn(async () => ({})),
    },
    flashSale: {
        findFirst: jest.fn(async () => null),
    },
    flashSalePurchase: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    voucher: {
        updateMany: jest.fn(async () => ({ count: 0 })),
    },
    voucherUserUsage: {
        findUnique: jest.fn(async () => null),
    },
    spinWheelSpin: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
    },
    affiliateConversion: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        shipmentJob: mockShipmentJob,
        $transaction: jest.fn(
            async (
                fn: (tx: unknown) => Promise<unknown>
            ) => fn(mockTx)
        ),
    },
}));

jest.mock("@/auth", () => ({ auth: jest.fn() }));

const mockOnOrderStatusChanged = jest.fn(
    async (..._args: unknown[]) => undefined
);

jest.mock("@/lib/notification/order-status-handler", () => ({
    onOrderStatusChanged: (
        ...args: unknown[]
    ) => mockOnOrderStatusChanged(...args),
}));

jest.mock("@/lib/mengantar/shipment-worker", () => ({
    enqueueShipmentJob: jest.fn(async () => undefined),
    enqueueShipmentJobTx: jest.fn(async () => undefined),
    scheduleShipmentProcessing: jest.fn(async () => undefined),
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => undefined),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { enqueueShipmentJob } from "@/lib/mengantar/shipment-worker";
import { createAuditLog } from "@/lib/admin/audit-log";

import {
    assessCodRisk,
    COD_ACTIVE_STATUSES,
    COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
    countActiveGuestCodOrders,
} from "@/lib/cod-policy";
import {
    readIdempotencyKey,
    scopeIdempotencyKey,
} from "@/lib/checkout-idempotency";
import { POST as codReviewPOST } from "@/app/api/admin/orders/[id]/cod-review/route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
};
const mockedShipmentJob = prisma.shipmentJob as unknown as {
    deleteMany: jest.Mock;
    updateMany: jest.Mock;
};
const mockedEnqueue =
    enqueueShipmentJob as unknown as jest.Mock;
const mockedAudit = createAuditLog as unknown as jest.Mock;

/** One reserved COD order item + a shipment job waiting to be stopped. */
function armCancellation(options: { casApplies?: boolean } = {}) {
    const casApplies = options.casApplies ?? true;

    mockTx.$executeRaw.mockImplementation(
        async (strings: unknown) => {
            const sql = Array.isArray(strings)
                ? (strings as string[]).join("")
                : String(strings);

            // The CAS transition is the cancellation's idempotency guard.
            if (sql.includes("SET status = 'CANCELLED'")) {
                return casApplies ? 1 : 0;
            }

            return 1;
        }
    );

    mockTx.order.findUnique.mockResolvedValue({
        id: 77,
        userId: null,
        guestIdentityKey: null,
        paymentMethod: "COD",
        voucherId: null,
        items: [
            { productId: 9, variantId: 5, quantity: 2 },
        ],
    });
}

function adminSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
    });
}

function affiliateSession() {
    mockedAuth.mockResolvedValue({
        user: { id: "aff-1", role: "AFFILIATOR" },
    });
}

function pendingCodOrder(
    overrides: Record<string, unknown> = {}
) {
    return {
        id: 77,
        orderNumber: "PAY-CART-77",
        status: "PENDING",
        paymentMethod: "COD",
        paymentStatus: "UNPAID",
        shippingProvider: "MENGANTAR",
        total: "2500000.00",
        requiresCodReview: true,
        codReviewStatus: "PENDING",
        shipmentJob: null,
        ...overrides,
    };
}

function reviewRequest(body: unknown) {
    return new Request(
        "http://test/api/admin/orders/77/cod-review",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }
    );
}

const CONTEXT = {
    params: Promise.resolve({ id: "77" }),
} as never;

beforeEach(() => {
    jest.clearAllMocks();
    mockedOrder.updateMany.mockResolvedValue({ count: 1 });
    mockedShipmentJob.deleteMany.mockResolvedValue({
        count: 0,
    });

    mockTx.shipmentJob.updateMany.mockResolvedValue({
        count: 1,
    });
    mockTx.productVariant.update.mockResolvedValue({});
    mockTx.flashSale.findFirst.mockResolvedValue(null);
    mockTx.spinWheelSpin.findUnique.mockResolvedValue(null);
    mockTx.affiliateConversion.findUnique.mockResolvedValue(
        null
    );
    armCancellation();
});

/* ==========================================
 * 1. RISK ASSESSMENT (pure)
 * ========================================== */

describe("COD risk assessment", () => {
    test("a low-value order from a buyer with few open COD orders is clean", () => {
        const risk = assessCodRisk({
            total: 150_000,
            activeCodOrders: 0,
            isGuest: true,
        });

        expect(risk.requiresReview).toBe(false);
        expect(risk.reasons).toEqual([]);
    });

    test("a high-value order requires review", () => {
        const risk = assessCodRisk({
            total: 2_500_000,
            activeCodOrders: 0,
            isGuest: true,
        });

        expect(risk.requiresReview).toBe(true);
        expect(risk.reasons).toContain("HIGH_VALUE");
    });

    test("a guest over the open-COD cap requires review", () => {
        const risk = assessCodRisk({
            total: 100_000,
            activeCodOrders: 3,
            isGuest: true,
        });

        expect(risk.requiresReview).toBe(true);
        expect(risk.reasons).toContain("TOO_MANY_OPEN_COD");
    });

    test("the open-COD cap is not applied to a signed-in buyer (unchanged behaviour)", () => {
        const risk = assessCodRisk({
            total: 100_000,
            activeCodOrders: 99,
            isGuest: false,
        });

        expect(risk.requiresReview).toBe(false);
    });

    test("the active-order count only counts open COD orders for the identity", async () => {
        const client = {
            order: {
                count: jest.fn(async () => 2),
            },
        };

        const count = await countActiveGuestCodOrders(
            client as never,
            "g1:abc:def"
        );

        expect(count).toBe(2);
        expect(client.order.count).toHaveBeenCalledWith({
            where: {
                guestIdentityKey: "g1:abc:def",
                paymentMethod: "COD",
                status: { in: COD_ACTIVE_STATUSES },
                /*
                 * A CONFIRMED DELIVERED parcel releases its slot, and
                 * the filter is NULL-safe: legacy rows have no
                 * shipmentStatus and must keep counting (a bare
                 * `notIn` would silently drop them).
                 */
                OR: [
                    { shipmentStatus: null },
                    {
                        shipmentStatus: {
                            notIn: [
                                ...COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
                            ],
                        },
                    },
                ],
            },
        });
        expect(COD_ACTIVE_STATUSES).not.toContain(
            "CANCELLED" as never
        );
        expect([
            ...COD_QUOTA_RELEASED_SHIPMENT_STATUSES,
        ]).toEqual(["DELIVERED"]);
    });
});

/* ==========================================
 * 2. IDEMPOTENCY KEY HANDLING
 * ========================================== */

describe("Checkout idempotency keys", () => {
    test("accepts an opaque key from the header", () => {
        const request = new Request("http://test", {
            headers: { "idempotency-key": "ck_abc12345" },
        });

        expect(readIdempotencyKey(request)).toBe(
            "ck_abc12345"
        );
    });

    test("accepts an opaque key from the body", () => {
        expect(
            readIdempotencyKey(new Request("http://test"), {
                idempotencyKey: "body_key_123456",
            })
        ).toBe("body_key_123456");
    });

    test("rejects keys that are not opaque tokens", () => {
        const request = new Request("http://test", {
            headers: { "idempotency-key": "short" },
        });

        expect(readIdempotencyKey(request)).toBeNull();
    });

    test("namespaces the key by buyer scope so keys are not global", () => {
        const scoped = scopeIdempotencyKey(
            "g:g1:abc:-",
            "ck_abc12345"
        );

        expect(scoped).toBe("g:g1:abc:-:ck_abc12345");
        expect(
            scopeIdempotencyKey("g:g1:other:-", "ck_abc12345")
        ).not.toBe(scoped);
    });
});

/* ==========================================
 * 3. ADMIN REVIEW — APPROVAL / REJECTION
 * ========================================== */

describe("Admin COD review — authorization", () => {
    test("unauthenticated → 401", async () => {
        mockedAuth.mockResolvedValue(null);

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(response.status).toBe(401);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });

    test("non-admin (affiliate) → 403 and nothing is enqueued", async () => {
        affiliateSession();

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(response.status).toBe(403);
        expect(mockedEnqueue).not.toHaveBeenCalled();
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });
});

describe("Admin COD review — approval", () => {
    test("approving a flagged order enqueues exactly one shipment job", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder()
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.codReviewStatus).toBe("APPROVED");
        expect(body.data.shipmentEnqueued).toBe(true);

        // Atomic conditional transition: only a PENDING review moves.
        expect(mockedOrder.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 77,
                    requiresCodReview: true,
                    codReviewStatus: "PENDING",
                }),
                data: expect.objectContaining({
                    codReviewStatus: "APPROVED",
                    codReviewedBy: "admin-1",
                }),
            })
        );

        // The COD payment lifecycle is untouched.
        const updateData =
            mockedOrder.updateMany.mock.calls[0][0].data;
        expect(updateData).not.toHaveProperty(
            "paymentStatus"
        );
        expect(updateData).not.toHaveProperty("status");

        expect(mockedEnqueue).toHaveBeenCalledTimes(1);
        expect(mockedEnqueue).toHaveBeenCalledWith(77);

        expect(mockedAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "COD_REVIEW_APPROVED",
                entityId: 77,
                adminId: "admin-1",
            })
        );
    });

    test("a duplicate approval is idempotent — no second shipment job", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "APPROVED",
                shipmentJob: { status: "DONE" },
            })
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.changed).toBe(false);
        expect(body.data.alreadyReviewed).toBe(true);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
        expect(mockedEnqueue).not.toHaveBeenCalled();
    });

    test("approving RESETS a job the worker cancelled at the review gate", async () => {
        adminSession();

        /*
         * The worker cancels a job for a not-yet-approved COD order.
         * Approving must therefore revive that job — otherwise the
         * order would never ship even though it was approved.
         */
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "APPROVED",
                shipmentJob: { status: "CANCELLED" },
            })
        );
        mockedShipmentJob.updateMany.mockResolvedValue({
            count: 1,
        });

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.shipmentEnqueued).toBe(true);

        expect(
            mockedShipmentJob.updateMany
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { orderId: 77, status: { in: ["CANCELLED", "FAILED"] } },
                data: expect.objectContaining({
                    status: "PENDING",
                    attempts: 0,
                }),
            })
        );
    });

    test("an in-flight (PROCESSING) job is not clobbered by an approval", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "APPROVED",
                shipmentJob: { status: "PROCESSING" },
            })
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.shipmentEnqueued).toBe(false);
        expect(
            mockedShipmentJob.updateMany
        ).not.toHaveBeenCalled();
    });

    test("re-approving after a crash re-enqueues the missing job", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "APPROVED",
                shipmentJob: null,
            })
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.alreadyReviewed).toBe(true);
        expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    });

    test("a non-COD order is never sent to the shipment worker", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({ paymentMethod: "QRIS" })
        );

        await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(mockedEnqueue).not.toHaveBeenCalled();
    });
});

describe("Admin COD review — concurrent approvals", () => {
    test("the loser of a concurrent race gets 409 and enqueues nothing", async () => {
        adminSession();

        /*
         * Both reviewers read PENDING; the first one wins the
         * conditional updateMany, so this request updates 0 rows.
         */
        mockedOrder.findUnique
            .mockResolvedValueOnce(pendingCodOrder())
            .mockResolvedValueOnce({
                codReviewStatus: "APPROVED",
            });
        mockedOrder.updateMany.mockResolvedValue({ count: 0 });

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.message).toContain("APPROVED");
        expect(mockedEnqueue).not.toHaveBeenCalled();
        expect(mockedAudit).not.toHaveBeenCalled();
    });

    test("two parallel approvals produce exactly one transition + one enqueue", async () => {
        adminSession();
        mockedOrder.findUnique.mockImplementation(
            async () => pendingCodOrder()
        );

        let transitions = 0;
        mockedOrder.updateMany.mockImplementation(
            async () => {
                transitions += 1;

                // Only the first call finds a PENDING row.
                return {
                    count: transitions === 1 ? 1 : 0,
                };
            }
        );

        const [first, second] = await Promise.all([
            codReviewPOST(
                reviewRequest({ action: "APPROVE" }),
                CONTEXT
            ),
            codReviewPOST(
                reviewRequest({ action: "APPROVE" }),
                CONTEXT
            ),
        ]);

        const statuses = [first.status, second.status].sort();

        expect(statuses).toEqual([200, 409]);
        expect(mockedEnqueue).toHaveBeenCalledTimes(1);
        expect(mockedAudit).toHaveBeenCalledTimes(1);
    });
});

describe("Admin COD review — REJECT & CANCEL", () => {
    test("rejecting cancels the order through the safe release lifecycle and stops the shipment job", async () => {
        adminSession();

        mockedOrder.findUnique
            // route read
            .mockResolvedValueOnce(pendingCodOrder())
            // service read
            .mockResolvedValueOnce(pendingCodOrder())
            // authoritative state after the commit
            .mockResolvedValueOnce({
                orderNumber: "PAY-CART-77",
                status: "CANCELLED",
                paymentStatus: "FAILED",
                codReviewStatus: "REJECTED",
            });

        const response = await codReviewPOST(
            reviewRequest({
                action: "REJECT",
                note: "Alamat tidak jelas",
            }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.codReviewStatus).toBe("REJECTED");
        expect(body.data.shipmentEnqueued).toBe(false);
        expect(body.data.orderCancelled).toBe(true);
        expect(body.data.paymentStatus).toBe("FAILED");

        // No shipment may be created for a rejected COD order.
        expect(mockedEnqueue).not.toHaveBeenCalled();

        // The review transition is the atomic PENDING gate, and it runs
        // on the SAME transaction client as the release below.
        expect(
            mockTx.order.updateMany
        ).toHaveBeenCalledWith({
            where: {
                id: 77,
                requiresCodReview: true,
                codReviewStatus: "PENDING",
            },
            data: expect.objectContaining({
                codReviewStatus: "REJECTED",
                codReviewedBy: "admin-1",
            }),
        });

        // The existing cancellation CAS ran inside the same transaction
        // and did NOT rely on a read-then-write check.
        const casCalls = mockTx.$executeRaw.mock.calls.filter(
            (call) =>
                Array.isArray(call[0]) &&
                (call[0] as string[]).join("").includes(
                    "SET status = 'CANCELLED'"
                )
        );

        expect(casCalls).toHaveLength(1);

        // Stock for the reserved item was restored.
        expect(mockTx.productVariant.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 5 },
                data: {
                    stock: { increment: 2 },
                },
            })
        );

        // Shipment jobs are STOPPED (kept for the record, never deleted)
        // and reset out of any lock.
        expect(
            mockTx.shipmentJob.updateMany
        ).toHaveBeenCalledWith({
            where: {
                orderId: 77,
                status: { in: ["PENDING", "PROCESSING"] },
            },
            data: expect.objectContaining({
                status: "CANCELLED",
                lockedAt: null,
            }),
        });

        // History is preserved: the order row is soft-cancelled.
        expect(mockTx.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 77 },
                data: {
                    status: "CANCELLED",
                    paymentStatus: "FAILED",
                },
            })
        );

        // The buyer is told the order was cancelled.
        expect(
            mockOnOrderStatusChanged
        ).toHaveBeenCalledWith(77, "PENDING", "CANCELLED");

        expect(mockedAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "COD_REVIEW_REJECTED",
                entityId: 77,
                adminId: "admin-1",
                metadata: expect.objectContaining({
                    orderCancelled: true,
                    shipmentJobsStopped: 1,
                    note: "Alamat tidak jelas",
                }),
            })
        );
    });

    test("a repeated rejection converges without releasing anything twice", async () => {
        adminSession();

        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "REJECTED",
            })
        );

        // The cancellation CAS finds nothing left to cancel.
        armCancellation({ casApplies: false });

        const response = await codReviewPOST(
            reviewRequest({ action: "REJECT" }),
            CONTEXT
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.changed).toBe(false);
        expect(body.data.orderCancelled).toBe(false);

        // No second transition…
        expect(
            mockTx.order.updateMany
        ).not.toHaveBeenCalled();

        // …and no second release: the CAS guard returns before any
        // stock/voucher/commission step runs.
        expect(
            mockTx.productVariant.update
        ).not.toHaveBeenCalled();
        expect(mockTx.order.update).not.toHaveBeenCalled();

        // A no-op replay stays silent — no duplicate buyer message.
        expect(
            mockOnOrderStatusChanged
        ).not.toHaveBeenCalled();
    });

    test("two concurrent rejections produce exactly one transition + one release", async () => {
        adminSession();

        mockedOrder.findUnique.mockImplementation(
            async () => pendingCodOrder()
        );

        let transitions = 0;
        mockTx.order.updateMany.mockImplementation(
            async () => {
                transitions += 1;

                return {
                    count: transitions === 1 ? 1 : 0,
                };
            }
        );

        let releases = 0;
        mockTx.$executeRaw.mockImplementation(
            async (strings: unknown) => {
                const sql = Array.isArray(strings)
                    ? (strings as string[]).join("")
                    : String(strings);

                if (sql.includes("SET status = 'CANCELLED'")) {
                    releases += 1;
                    return 1;
                }

                return 1;
            }
        );

        const [first, second] = await Promise.all([
            codReviewPOST(
                reviewRequest({ action: "REJECT" }),
                CONTEXT
            ),
            codReviewPOST(
                reviewRequest({ action: "REJECT" }),
                CONTEXT
            ),
        ]);

        const statuses = [first.status, second.status].sort();

        // The loser is told the review was already decided.
        expect(statuses).toEqual([200, 409]);
        expect(releases).toBe(1);
    });

    test("a rejected order cannot be flip-flopped without a new review", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                codReviewStatus: "REJECTED",
            })
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(response.status).toBe(409);
        expect(mockedEnqueue).not.toHaveBeenCalled();
    });
});

describe("Admin COD review — input validation", () => {
    test("an unknown action is rejected", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder()
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "DELETE" }),
            CONTEXT
        );

        expect(response.status).toBe(400);
    });

    test("a missing order → 404 and no write", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(null);

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(response.status).toBe(404);
        expect(mockedOrder.updateMany).not.toHaveBeenCalled();
    });

    test("an order that does not need review → 409", async () => {
        adminSession();
        mockedOrder.findUnique.mockResolvedValue(
            pendingCodOrder({
                requiresCodReview: false,
                codReviewStatus: null,
            })
        );

        const response = await codReviewPOST(
            reviewRequest({ action: "APPROVE" }),
            CONTEXT
        );

        expect(response.status).toBe(409);
        expect(mockedEnqueue).not.toHaveBeenCalled();
    });
});
