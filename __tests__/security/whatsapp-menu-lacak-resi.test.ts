/**
 * ==========================================================
 * WHATSAPP MENU — "1. LACAK RESI" → TRACKING PAGE HAND-OFF
 * ==========================================================
 *
 * Pins the changed behaviour of menu key 1, and the keys around it:
 *
 *   1. Key "1" sends the SAME instruction + official tracking page link
 *      in EVERY state — bound order, no order, typed tracking word — and
 *      discloses nothing about any order:
 *        · no order number is asked for, no order number is printed,
 *        · no resi is collected, no provider call is made,
 *        · no order is matched, so the key cannot become an oracle.
 *   2. Keys 0, 2 and 3 (and the post-delivery sub-menu) behave EXACTLY
 *      as before, including the ownership guard on key 2 and on a bare
 *      order number typed by the customer.
 *   3. The link always points at the official tracker: a hostile or
 *      absent NEXT_PUBLIC_APP_URL falls back to the canonical
 *      production page instead of shipping a wrong link.
 *   4. Nothing in this flow writes: no order update, no ShipmentJob, no
 *      shipment, no pickup, no provider call.
 *
 * No WhatsApp connection is used: `send` and the tracking reader are
 * injected, and prisma is an in-memory fake.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "whatsapp-menu-resi-test-secret";

/* Pin the origin fallback: with no env value the canonical production
 * page must be used (asserted below). */
delete process.env.NEXT_PUBLIC_APP_URL;

/* ==========================================
 * IN-MEMORY PRISMA FAKE
 * ========================================== */

type Row = Record<string, unknown>;

type OrderRowFixture = Row & {
    id: number;
    orderNumber: string;
    phone: string | null;
};

const mockDb: {
    orders: OrderRowFixture[];
    chatStates: Map<string, Row>;
    inbound: Map<string, Row>;
    reset: () => void;
} = {
    orders: [],
    chatStates: new Map(),
    inbound: new Map(),
    reset() {
        mockDb.orders = [];
        mockDb.chatStates.clear();
        mockDb.inbound.clear();
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: {
            findFirst: jest.fn(
                async ({
                    where,
                    select,
                }: {
                    where: { id?: number; orderNumber?: string };
                    select?: Record<string, boolean>;
                }) => {
                    const row = mockDb.orders.find((order) =>
                        where.id !== undefined
                            ? order.id === where.id
                            : order.orderNumber === where.orderNumber
                    );

                    if (!row) {
                        return null;
                    }

                    if (!select) {
                        return { ...row };
                    }

                    const projected: Row = {};

                    for (const key of Object.keys(select)) {
                        if (select[key]) {
                            projected[key] = row[key];
                        }
                    }

                    return projected;
                }
            ),
            update: jest.fn(async () => ({})),
            updateMany: jest.fn(async () => ({ count: 0 })),
            create: jest.fn(async () => ({})),
        },
        shipmentJob: {
            create: jest.fn(async () => ({})),
            upsert: jest.fn(async () => ({})),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        orderShipment: {
            create: jest.fn(async () => ({})),
        },
        whatsAppChatState: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            findUnique: jest.fn(
                async ({ where }: { where: { chatId: string } }) =>
                    mockDb.chatStates.get(where.chatId) ?? null
            ),
            upsert: jest.fn(
                async ({
                    where,
                    create,
                    update,
                }: {
                    where: { chatId: string };
                    create: Row;
                    update: Row;
                }) => {
                    const existing = mockDb.chatStates.get(
                        where.chatId
                    );

                    const row: Row = existing
                        ? { ...existing, ...update }
                        : { id: mockDb.chatStates.size + 1, ...create };

                    row.updatedAt = new Date();
                    mockDb.chatStates.set(where.chatId, row);

                    return row;
                }
            ),
        },
        whatsAppInboundMessage: {
            create: jest.fn(
                async ({ data }: { data: { messageId: string } }) => {
                    if (mockDb.inbound.has(data.messageId)) {
                        const error = new Error(
                            "unique constraint"
                        ) as Error & { code?: string };

                        error.code = "P2002";

                        throw error;
                    }

                    const row: Row = {
                        id: mockDb.inbound.size + 1,
                        status: "PROCESSING",
                        attempts: 1,
                        lastError: null,
                        receivedAt: new Date(),
                        updatedAt: new Date(),
                        processedAt: null,
                        ...data,
                    };

                    mockDb.inbound.set(data.messageId, row);

                    return row;
                }
            ),
            findUnique: jest.fn(
                async ({ where }: { where: { messageId: string } }) =>
                    mockDb.inbound.get(where.messageId) ?? null
            ),
            updateMany: jest.fn(async () => ({ count: 1 })),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
    },
}));

jest.mock("@/lib/mengantar", () => ({
    getMengantarOrderByTracking: jest.fn(),
}));

jest.mock("@/lib/admin/audit-log", () => ({
    createAuditLog: jest.fn(async () => {}),
}));

import { prisma } from "@/lib/prisma";
import { getMengantarOrderByTracking } from "@/lib/mengantar";
import {
    handleIncomingMessage,
    resetInfraErrorThrottle,
    type BotDeps,
} from "@/lib/whatsapp/inbound/handler";
import {
    MAIN_MENU_TEXT,
    askOrderNumber,
    handoffNotice,
    trackingInstruction,
} from "@/lib/whatsapp/inbound/menu";
import {
    CHAT_STATE,
    REPLY_COOLDOWN_MS,
} from "@/lib/whatsapp/inbound/state";
import {
    OFFICIAL_TRACKING_PAGE_URL,
    TRACKING_PAGE_PATH,
} from "@/lib/whatsapp/inbound/tracking-url";
import type { TrackingView } from "@/lib/whatsapp/inbound/tracking";

const mockedMengantar =
    getMengantarOrderByTracking as unknown as jest.Mock;

/* ==========================================
 * FIXTURES
 * ========================================== */

const ORDER_ID = 8801;
const ORDER_NUMBER = "ORD-1759000000002-aa11bb22";
const RESI = "JNE1234567890";

const SENDER_PHONE_LOCAL = "08123456789";
const SENDER_PHONE_NORMALIZED = "628123456789";
const SENDER_JID = `${SENDER_PHONE_NORMALIZED}@s.whatsapp.net`;

let mockNow = new Date("2026-10-14T03:00:00.000Z");

function orderRow(overrides: Row = {}): OrderRowFixture {
    return {
        id: ORDER_ID,
        orderNumber: ORDER_NUMBER,
        status: "PROCESSING",
        paymentStatus: "PAID",
        createdAt: new Date("2026-10-10T03:00:00.000Z"),
        shippingProvider: "MENGANTAR",
        providerCourier: "JNE",
        shippingCourier: "JNE",
        shippingService: "REG",
        trackingNumber: RESI,
        trackingUrl: null,
        shipmentStatus: "IN_TRANSIT",
        shippingPaymentStatus: "PAID",
        phone: SENDER_PHONE_LOCAL,
        address: "Jl. Rahasia No. 123",
        customerEmail: "rahasia@example.com",
        guestAccessTokenHash: "deadbeefhash",
        paymentReference: "PAY-REF-999",
        ...overrides,
    };
}

function seedState(overrides: Row = {}): void {
    mockDb.chatStates.set(SENDER_JID, {
        id: 1,
        chatId: SENDER_JID,
        state: CHAT_STATE.MENU,
        verifiedOrderId: null,
        verifiedAt: null,
        pendingIntent: null,
        pauseUntil: null,
        blockedUntil: null,
        failedBindAttempts: 0,
        replyCount: 0,
        windowStartedAt: null,
        lastActivityAt: mockNow,
        lastReplyAt: null,
        createdAt: mockNow,
        updatedAt: mockNow,
        ...overrides,
    });
}

function stateRow(): Row | undefined {
    return mockDb.chatStates.get(SENDER_JID);
}

function waMessage(
    overrides: {
        id?: string;
        jid?: string;
        text?: string | null;
    } = {}
) {
    const { id = "MSG-1", jid = SENDER_JID, text = "1" } = overrides;

    return {
        key: { id, remoteJid: jid, fromMe: false },
        message:
            text === null
                ? { imageMessage: { url: "https://example.test/x" } }
                : { conversation: text },
        messageTimestamp: Math.floor(mockNow.getTime() / 1000),
    };
}

function makeDeps(overrides: Partial<BotDeps> = {}): {
    deps: BotDeps;
    sent: Array<{ jid: string; text: string }>;
} {
    const sent: Array<{ jid: string; text: string }> = [];

    const deps: BotDeps = {
        send: jest.fn(async (jid: string, text: string) => {
            sent.push({ jid, text });
            return { success: true };
        }),
        now: () => mockNow,
        loadTracking: jest.fn(
            async (): Promise<TrackingView> => ({
                source: "MENGANTAR",
                providerRead: true,
                available: true,
                courier: "JNE",
                trackingNumber: RESI,
                providerStatus: "IN_TRANSIT",
                history: [
                    { date: "14/10/2026 09:00", description: "Di hub" },
                ],
                note: null,
            })
        ),
        audit: jest.fn(async () => {}),
        ...overrides,
    };

    return { deps, sent };
}

function deliver(message: unknown, deps: BotDeps) {
    return handleIncomingMessage(message, deps);
}

const shift = (ms: number) => {
    mockNow = new Date(mockNow.getTime() + ms);
};

beforeEach(() => {
    mockDb.reset();
    mockedMengantar.mockReset();
    resetInfraErrorThrottle();
    mockNow = new Date("2026-10-14T03:00:00.000Z");
});

/* ==========================================
 * 1. MENU KEY "1"
 * ========================================== */

describe("menu key 1 hands the customer the tracking page", () => {
    test("\"1\" without any order sends the instruction and the official link", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(waMessage({ text: "1" }), deps);

        expect(result).toBe("REPLIED");
        expect(sent).toHaveLength(1);

        const text = sent[0].text;

        expect(text).toBe(
            trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
        );
        expect(text).toContain("LACAK PENGIRIMAN");
        expect(text).toContain(OFFICIAL_TRACKING_PAGE_URL);
        expect(text).toContain(`${TRACKING_PAGE_PATH}`);
        expect(text).toContain("Masukkan nomor resi pengiriman");
        expect(text).toContain("Ketik *0* untuk kembali ke Menu Utama.");

        // No order was looked up at all.
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
        // …and the customer was not asked for an order number.
        expect(text).not.toContain(askOrderNumber().split("\n")[0]);

        const row = stateRow();

        expect(row?.state).toBe(CHAT_STATE.MENU);
        expect(row?.pendingIntent).toBeNull();
    });

    test("a bound order gets the same reply — nothing about it is disclosed", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedState({
            state: CHAT_STATE.VERIFIED_TRACKING,
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
        });

        const result = await deliver(waMessage({ text: "1" }), deps);

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(
            trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
        );

        for (const secret of [
            ORDER_NUMBER,
            RESI,
            "Jl. Rahasia No. 123",
            "rahasia@example.com",
            "PAY-REF-999",
            "deadbeefhash",
            SENDER_PHONE_LOCAL,
            SENDER_PHONE_NORMALIZED,
        ]) {
            expect(sent[0].text).not.toContain(secret);
        }

        // The binding is kept, and no provider read happens on this key.
        expect(stateRow()?.verifiedOrderId).toBe(ORDER_ID);
        expect(deps.loadTracking).not.toHaveBeenCalled();
        expect(mockedMengantar).not.toHaveBeenCalled();
    });

    test("typed tracking words reach the same hand-off", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedState({
            state: CHAT_STATE.VERIFIED_TRACKING,
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
        });

        for (const [index, word] of [
            "resi",
            "lacak",
            "lacak resi",
            "cek resi",
            "tracking",
        ].entries()) {
            shift(REPLY_COOLDOWN_MS + 1000);

            await deliver(
                waMessage({ id: `WORD-${index}`, text: word }),
                deps
            );
        }

        expect(sent).toHaveLength(5);

        for (const item of sent) {
            expect(item.text).toBe(
                trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
            );
        }

        expect(mockedMengantar).not.toHaveBeenCalled();
    });

    test("with no resolvable origin the canonical page is used, never a linkless message", async () => {
        const { deps, sent } = makeDeps({
            trackingUrl: () => null,
        });

        await deliver(waMessage({ text: "1" }), deps);

        expect(sent[0].text).toBe(
            trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
        );

        /* The fail-safe IS the official storefront. */
        expect(OFFICIAL_TRACKING_PAGE_URL).toBe(
            "https://mutiaraabadisnack.com/lacak"
        );
        expect(sent[0].text).toContain("https://");

        /* Never a downgraded or empty link line. */
        expect(sent[0].text).not.toContain("🌐 \n");
        expect(sent[0].text).not.toContain("http://");
    });

    test("nothing is written and no shipment is created", async () => {
        const { deps } = makeDeps();

        mockDb.orders.push(orderRow());
        seedState({
            state: CHAT_STATE.VERIFIED_TRACKING,
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
        });

        await deliver(waMessage({ text: "1" }), deps);

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(prisma.order.create).not.toHaveBeenCalled();
        expect(prisma.shipmentJob.create).not.toHaveBeenCalled();
        expect(prisma.shipmentJob.upsert).not.toHaveBeenCalled();
        expect(prisma.shipmentJob.updateMany).not.toHaveBeenCalled();
        expect(mockedMengantar).not.toHaveBeenCalled();
    });

    test("the same message id is still answered only once", async () => {
        const { deps, sent } = makeDeps();

        const message = waMessage({ id: "ONE-ONLY", text: "1" });

        expect(await deliver(message, deps)).toBe("REPLIED");
        expect(await deliver(message, deps)).toBe("DUPLICATE");
        expect(sent).toHaveLength(1);
    });

    test("the per-chat cooldown still applies to the hand-off", async () => {
        const { deps, sent } = makeDeps();

        await deliver(waMessage({ id: "COOL-A", text: "1" }), deps);

        shift(2000);

        expect(
            await deliver(waMessage({ id: "COOL-B", text: "1" }), deps)
        ).toBe("SUPPRESSED");
        expect(sent).toHaveLength(1);

        shift(REPLY_COOLDOWN_MS + 1000);

        await deliver(waMessage({ id: "COOL-C", text: "1" }), deps);

        expect(sent).toHaveLength(2);
        expect(sent[1].text).toBe(
            trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
        );
    });
});

/* ==========================================
 * 2. NO REGRESSION ON THE OTHER KEYS
 * ========================================== */

describe("the other menu keys are untouched", () => {
    test("\"0\" still opens the main menu", async () => {
        const { deps, sent } = makeDeps();

        seedState({ state: CHAT_STATE.MENU });

        const result = await deliver(waMessage({ text: "0" }), deps);

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(MAIN_MENU_TEXT);
        expect(stateRow()?.state).toBe(CHAT_STATE.MENU);
    });

    test("\"2\" without a bound order still asks for the order number", async () => {
        const { deps, sent } = makeDeps();

        await deliver(waMessage({ text: "2" }), deps);

        expect(sent[0].text).toBe(askOrderNumber());
        expect(stateRow()?.state).toBe(CHAT_STATE.AWAITING_ORDER);
        expect(stateRow()?.pendingIntent).toBe("STATUS");
    });

    test("\"2\" with a bound order still answers with the owner's status", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedState({
            state: CHAT_STATE.VERIFIED_TRACKING,
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
        });

        await deliver(waMessage({ text: "2" }), deps);

        expect(sent[0].text).toContain("STATUS PESANAN");
        expect(sent[0].text).toContain(ORDER_NUMBER);
        expect(sent[0].text).toContain(RESI);
        expect(sent[0].text).not.toContain("LACAK PENGIRIMAN —");
    });

    test("\"3\" still hands the chat to a human admin", async () => {
        const { deps, sent } = makeDeps();

        await deliver(waMessage({ text: "3" }), deps);

        expect(sent[0].text).toBe(handoffNotice());
        expect(stateRow()?.state).toBe(CHAT_STATE.HANDOFF);
    });

    test("a bare order number still goes through the ownership guard", async () => {
        const { deps, sent } = makeDeps();

        /* Someone else's order: the number matches, the phone does not. */
        mockDb.orders.push(
            orderRow({ phone: "089999999999" })
        );

        await deliver(
            waMessage({ id: "GUARD-1", text: ORDER_NUMBER }),
            deps
        );

        expect(sent[0].text).not.toContain(RESI);
        expect(sent[0].text).not.toContain("LACAK PENGIRIMAN —");

        shift(5 * 1000);

        /* …and the customer's own order still resolves. */
        mockDb.orders[0] = orderRow();
        mockDb.orders.push(orderRow({ id: 9999 }));

        await deliver(
            waMessage({ id: "GUARD-2", text: ORDER_NUMBER }),
            deps
        );

        expect(sent[1].text).toContain(`Nomor Resi: ${RESI}`);
    });

    test("the post-delivery sub-menu keeps its own meaning for \"1\"", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({ shipmentStatus: "DELIVERED" })
        );
        seedState({
            state: CHAT_STATE.VERIFIED_DELIVERED,
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
        });

        await deliver(waMessage({ text: "1" }), deps);

        expect(sent[0].text).toContain("RIWAYAT PENGIRIMAN");
        expect(sent[0].text).not.toContain("LACAK PENGIRIMAN —");
    });
});
