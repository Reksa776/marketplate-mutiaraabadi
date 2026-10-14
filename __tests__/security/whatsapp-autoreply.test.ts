/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY BOT — FOCUSED TESTS
 * ==========================================================
 *
 * Pins the contract of the inbound pipeline that answers customers on
 * the EXISTING Baileys session:
 *
 *   - only genuine 1:1 customer messages are processed: our own
 *     messages (`fromMe` — which is also how a manual admin reply
 *     arrives), groups, status broadcasts, newsletters, replayed
 *     history and duplicate deliveries are all dropped,
 *   - an order number is a LOOKUP HINT. Nothing is released unless the
 *     SENDER'S WhatsApp number matches that order's checkout phone, and
 *     "no such order" and "not your order" are indistinguishable,
 *   - a message that fails to be delivered stays re-claimable, so a
 *     customer can never lose a message just because its id was
 *     recorded,
 *   - status is re-read from the database on every request (an old
 *     message never returns an old status),
 *   - a handoff to a human admin survives a restart because it lives in
 *     the database, and the bot then stays silent,
 *   - tracking never writes an order, and a failed provider read is
 *     disclosed instead of hidden.
 *
 * No WhatsApp connection is used anywhere: `send` and the tracking
 * reader are injected, and prisma is an in-memory fake that HONOURS the
 * `select` projection (so a forgotten field breaks binding here rather
 * than silently leaking in production).
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "whatsapp-autoreply-test-secret";

/*
 * PIN THE LINK FALLBACK.
 *
 * Several assertions below compare a reply against a `menu.*` builder
 * called with NO url, which is exactly the documented behaviour when no
 * storefront origin is configured. Jest does not reset `process.env`
 * between test FILES in the same worker, so a suite that sets
 * NEXT_PUBLIC_APP_URL could otherwise leak in here and make these
 * assertions fail for a reason that has nothing to do with the code
 * under test. Deleting it here pins the fallback (text only) on
 * purpose — the linked wording is covered by
 * whatsapp-tracking-link.test.ts.
 */
delete process.env.NEXT_PUBLIC_APP_URL;

/* ==========================================
 * IN-MEMORY PRISMA FAKE
 * ========================================== */

/** Loose row shape for the in-memory fakes (never `any`). */
type Row = Record<string, unknown>;

type OrderRowFixture = Row & {
    id: number;
    orderNumber: string;
    phone: string | null;
};

type InboundRowFixture = Row & {
    messageId: string;
    status: string;
    attempts: number;
};

const mockDb: {
    orders: OrderRowFixture[];
    chatStates: Map<string, Row>;
    inbound: Map<string, InboundRowFixture>;
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
                    where: {
                        id?: number;
                        orderNumber?: string;
                    };
                    select?: Record<string, boolean>;
                }) => {
                    const row = mockDb.orders.find((order) =>
                        where.id !== undefined
                            ? order.id === where.id
                            : order.orderNumber ===
                              where.orderNumber
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
            create: jest.fn(async () => ({})),
        },
        whatsAppChatState: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            findUnique: jest.fn(
                async ({
                    where,
                }: {
                    where: { chatId: string };
                }) =>
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
                        : {
                              id: mockDb.chatStates.size + 1,
                              ...create,
                          };

                    row.updatedAt = new Date();
                    mockDb.chatStates.set(where.chatId, row);

                    return row;
                }
            ),
        },
        whatsAppInboundMessage: {
            create: jest.fn(
                async ({
                    data,
                }: {
                    data: {
                        messageId: string;
                        chatId: string;
                    };
                }) => {
                if (mockDb.inbound.has(data.messageId)) {
                    // Shaped exactly like a Prisma unique violation.
                    const error = new Error(
                        "unique constraint"
                    ) as Error & { code?: string };

                    error.code = "P2002";

                    throw error;
                }

                const row: InboundRowFixture = {
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
            }),
            findUnique: jest.fn(
                async ({
                    where,
                }: {
                    where: { messageId: string };
                }) =>
                    mockDb.inbound.get(where.messageId) ?? null
            ),
            updateMany: jest.fn(
                async ({
                    where,
                    data,
                }: {
                    where: {
                        messageId: string;
                        status?: string;
                        attempts?: number;
                    };
                    data: Row;
                }) => {
                const row = mockDb.inbound.get(where.messageId);

                if (!row) {
                    return { count: 0 };
                }

                if (
                    where.status !== undefined &&
                    row.status !== where.status
                ) {
                    return { count: 0 };
                }

                if (
                    where.attempts !== undefined &&
                    row.attempts !== where.attempts
                ) {
                    return { count: 0 };
                }

                const next: Row = { ...row };

                for (const [key, value] of Object.entries(data)) {
                    if (
                        value &&
                        typeof value === "object" &&
                        "increment" in value
                    ) {
                        const increment = (
                            value as { increment: number }
                        ).increment;

                        next[key] =
                            Number(next[key] ?? 0) + increment;
                    } else {
                        next[key] = value;
                    }
                }

                next.updatedAt = new Date();
                mockDb.inbound.set(
                    where.messageId,
                    next as InboundRowFixture
                );

                return { count: 1 };
            }),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
    },
}));

/**
 * The real module talks to the Mengantar API over the network.
 */
jest.mock("@/lib/mengantar", () => ({
    getMengantarOrderByTracking: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getMengantarOrderByTracking } from "@/lib/mengantar";
import {
    handleIncomingMessage,
    handleIncomingMessages,
    resetInfraErrorThrottle,
    type BotDeps,
} from "@/lib/whatsapp/inbound/handler";
import * as menu from "@/lib/whatsapp/inbound/menu";
import {
    buildOrderConfirmMessage,
} from "@/lib/whatsapp/order-confirm";
import {
    extractSenderPhones,
    inboundJidCandidates,
    isCustomerChatJid,
    maskChatJid,
    maskPhoneNumber,
    orderPhoneMatches,
} from "@/lib/whatsapp/inbound/identity";
import {
    CHAT_STATE,
    CHAT_STATE_RETENTION_MS,
    HANDOFF_PAUSE_MS,
    MAX_FAILED_BINDS,
    MAX_INBOUND_ATTEMPTS,
    REPLY_COOLDOWN_MS,
    MAX_REPLIES_PER_WINDOW,
} from "@/lib/whatsapp/inbound/state";
import {
    loadTrackingView,
    resetTrackingCache,
    TRACKING_UPDATE_UNAVAILABLE_NOTE,
    type TrackingView,
} from "@/lib/whatsapp/inbound/tracking";
import {
    OFFICIAL_TRACKING_PAGE_URL,
    resetTrackingUrlWarningThrottle,
} from "@/lib/whatsapp/inbound/tracking-url";

const mockedMengantar =
    getMengantarOrderByTracking as unknown as jest.Mock;

/* ==========================================
 * FIXTURES
 * ========================================== */

const ORDER_ID = 5151;
const ORDER_NUMBER = "ORD-1759000000000-ab12cd34";

/** The number the customer ordered with (stored in local form). */
const SENDER_PHONE_LOCAL = "08123456789";
const SENDER_PHONE_NORMALIZED = "628123456789";
const SENDER_JID = `${SENDER_PHONE_NORMALIZED}@s.whatsapp.net`;

/** A different customer. */
const OTHER_JID = "628999888777@s.whatsapp.net";

/** Secrets that must NEVER appear in a bot reply. */
const ORDER_ADDRESS = "Jl. Rahasia No. 123";
const ORDER_EMAIL = "rahasia@example.com";
const ORDER_TOKEN_HASH = "deadbeefhash";

let mockNow = new Date("2026-10-13T03:00:00.000Z");

function orderRow(
    overrides: Row = {}
): OrderRowFixture {
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
        trackingNumber: "JNE1234567890",
        trackingUrl: null,
        shipmentStatus: "IN_TRANSIT",
        shippingPaymentStatus: "PAID",
        // Only ever used for ownership matching / RajaOngkir. Never printed.
        phone: SENDER_PHONE_LOCAL,
        // Must never reach a reply.
        address: ORDER_ADDRESS,
        customerEmail: ORDER_EMAIL,
        guestAccessTokenHash: ORDER_TOKEN_HASH,
        paymentReference: "PAY-REF-999",
        ...overrides,
    };
}

function chatStateRow(overrides: Row = {}): Row {
    return {
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
    };
}

/** Pre-verify the chat (as if binding had already succeeded). */
function seedVerifiedState(overrides: Row = {}): void {
    mockDb.chatStates.set(
        SENDER_JID,
        chatStateRow({
            verifiedOrderId: ORDER_ID,
            verifiedAt: mockNow,
            ...overrides,
        })
    );
}

function stateRow(jid: string = SENDER_JID): Row | undefined {
    return mockDb.chatStates.get(jid);
}

function sentTexts(
    sent: Array<{ jid: string; text: string }>
): string {
    return sent.map((item) => item.text).join("\n-----\n");
}

function waMessage(
    overrides: {
        id?: string;
        jid?: string;
        remoteJidAlt?: string;
        text?: string | null;
        fromMe?: boolean;
        ageMs?: number;
        timestamp?: number | null;
    } = {}
) {
    const {
        id = "MSG-1",
        jid = SENDER_JID,
        remoteJidAlt,
        text = "menu",
        fromMe = false,
        ageMs = 0,
        timestamp,
    } = overrides;

    return {
        key: {
            id,
            remoteJid: jid,
            fromMe,
            ...(remoteJidAlt ? { remoteJidAlt } : {}),
        },
        message:
            text === null
                ? { imageMessage: { url: "https://example.test/x" } }
                : { conversation: text },
        messageTimestamp:
            timestamp === undefined
                ? Math.floor(
                      (mockNow.getTime() - ageMs) / 1000
                  )
                : timestamp,
    };
}

function makeDeps(
    overrides: Partial<BotDeps> = {}
): {
    deps: BotDeps;
    sent: Array<{ jid: string; text: string }>;
} {
    const sent: Array<{ jid: string; text: string }> = [];

    const deps: BotDeps = {
        send: jest.fn(
            async (jid: string, text: string) => {
                sent.push({ jid, text });
                return { success: true };
            }
        ),
        now: () => mockNow,
        loadTracking: jest.fn(
            async (): Promise<TrackingView> => ({
                source: "MENGANTAR",
                providerRead: true,
                available: false,
                courier: null,
                trackingNumber: null,
                providerStatus: null,
                history: [],
                note: null,
            })
        ),
        audit: jest.fn(async () => {}),
        ...overrides,
    };

    return { deps, sent };
}

function deliver(
    message: unknown,
    deps: BotDeps
) {
    return handleIncomingMessage(message, deps);
}

beforeEach(() => {
    mockDb.reset();
    mockedMengantar.mockReset();
    resetTrackingCache();
    resetInfraErrorThrottle();
    mockNow = new Date("2026-10-13T03:00:00.000Z");
});

/* ==========================================
 * 1. WHAT MUST NEVER TRIGGER A REPLY
 * ========================================== */

describe("messages that must never be answered", () => {
    test("a message from our own account is ignored (this is also a manual admin reply)", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(
            waMessage({ fromMe: true, text: "Halo, ini admin" }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(sent).toHaveLength(0);

        // Nothing was even recorded for it.
        expect(mockDb.inbound.size).toBe(0);
        expect(stateRow()).toBeUndefined();
    });

    test("group messages are ignored", async () => {
        const { deps, sent } = makeDeps();

        for (const jid of [
            "120363001122334455@g.us",
            "628111222333-1630000000@g.us",
        ]) {
            const result = await deliver(
                waMessage({ id: `G-${jid}`, jid, text: "1" }),
                deps
            );

            expect(result).toBe("IGNORED");
        }

        expect(sent).toHaveLength(0);
    });

    test("status broadcasts and newsletter channels are ignored", async () => {
        const { deps, sent } = makeDeps();

        for (const jid of [
            "status@broadcast",
            "120363001122334455@broadcast",
            "120363001122334455@newsletter",
        ]) {
            const result = await deliver(
                waMessage({ id: `B-${jid}`, jid, text: "halo" }),
                deps
            );

            expect(result).toBe("IGNORED");
        }

        expect(sent).toHaveLength(0);
        expect(mockDb.inbound.size).toBe(0);
    });

    test("a message that is missing an id or a chat JID is ignored", async () => {
        const { deps, sent } = makeDeps();

        expect(
            await deliver({ key: { remoteJid: SENDER_JID } }, deps)
        ).toBe("IGNORED");

        expect(
            await deliver({ key: { id: "NO-JID" } }, deps)
        ).toBe("IGNORED");

        expect(sent).toHaveLength(0);
    });

    test("replayed history is ignored (a reconnect must not spam old chats)", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(
            waMessage({
                id: "OLD-1",
                text: "1",
                ageMs: 3 * 24 * 60 * 60 * 1000,
            }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(sent).toHaveLength(0);
    });

    test("a message that arrived while the session was down is still answered", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState();
        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({
                id: "QUEUED-1",
                text: "1",
                ageMs: 2 * 60 * 1000,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent).toHaveLength(1);
    });
});

/* ==========================================
 * 2. DEDUPLICATION (TWO-PHASE, RESTART SAFE)
 * ========================================== */

describe("duplicate deliveries", () => {
    test("the same message id is only ever answered once", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        const first = await deliver(
            waMessage({ id: "DUP-1", text: "1" }),
            deps
        );
        const second = await deliver(
            waMessage({ id: "DUP-1", text: "1" }),
            deps
        );

        expect(first).toBe("REPLIED");
        expect(second).toBe("DUPLICATE");
        expect(sent).toHaveLength(1);
    });

    test("a batch containing the same message twice replies once", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        await handleIncomingMessages(
            [
                waMessage({ id: "BATCH-1", text: "1" }),
                waMessage({ id: "BATCH-1", text: "1" }),
            ],
            deps
        );

        expect(sent).toHaveLength(1);
    });

    test("a reply that FAILED is retried on redelivery — the message is not lost", async () => {
        const failing = makeDeps({
            send: jest.fn(async () => ({
                success: false,
                errorCode: "NOT_CONNECTED",
            })),
        });

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        const failed = await deliver(
            waMessage({ id: "RETRY-1", text: "1" }),
            failing.deps
        );

        expect(failed).toBe("FAILED");
        expect(failing.sent).toHaveLength(0);

        const claim = mockDb.inbound.get("RETRY-1");
        expect(claim?.status).toBe("FAILED");

        // The provider is back: the re-delivered id must be processed.
        const ok = makeDeps();

        const retried = await deliver(
            waMessage({ id: "RETRY-1", text: "1" }),
            ok.deps
        );

        expect(retried).toBe("REPLIED");
        expect(ok.sent).toHaveLength(1);
        expect(mockDb.inbound.get("RETRY-1")?.status).toBe("DONE");
    });

    test("a failed reply does not advance the conversation state", async () => {
        const failing = makeDeps({
            send: jest.fn(async () => ({
                success: false,
                errorCode: "SEND_FAILED",
            })),
        });

        mockDb.orders.push(orderRow());
        seedVerifiedState({ state: CHAT_STATE.MENU });

        await deliver(
            waMessage({ id: "STATE-1", text: "1" }),
            failing.deps
        );

        // The customer never saw the reply, so the menu is still open.
        expect(stateRow()?.state).toBe(CHAT_STATE.MENU);
    });

    test("a state-write failure after a DELIVERED reply never causes a second reply", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        /*
         * The reply lands, then the conversation-state write blows up.
         * Failing the message here would make the re-delivery answer
         * again — the customer must not receive it twice.
         */
        (
            prisma.whatsAppChatState.upsert as unknown as jest.Mock
        ).mockRejectedValueOnce(new Error("state write failed"));

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const first = await deliver(
            waMessage({ id: "STATE-FAIL-1", text: "1" }),
            deps
        );

        const second = await deliver(
            waMessage({ id: "STATE-FAIL-1", text: "1" }),
            deps
        );

        errorSpy.mockRestore();

        expect(first).toBe("REPLIED");
        expect(second).toBe("DUPLICATE");
        expect(sent).toHaveLength(1);
        expect(mockDb.inbound.get("STATE-FAIL-1")?.status).toBe(
            "DONE"
        );
    });

    test("a permanently failing message stops retrying after the attempt cap", async () => {
        const { deps, sent } = makeDeps();

        mockDb.inbound.set("CAP-1", {
            id: 9,
            messageId: "CAP-1",
            chatId: SENDER_JID,
            status: "FAILED",
            attempts: MAX_INBOUND_ATTEMPTS,
            lastError: "SEND_FAILED",
            receivedAt: mockNow,
            updatedAt: mockNow,
            processedAt: null,
        });

        const result = await deliver(
            waMessage({ id: "CAP-1", text: "1" }),
            deps
        );

        expect(result).toBe("EXHAUSTED");
        expect(sent).toHaveLength(0);
        expect(mockDb.inbound.get("CAP-1")?.status).toBe("DONE");
    });

    test("a concurrent delivery of the same message is skipped", async () => {
        const { deps, sent } = makeDeps();

        mockDb.inbound.set("LIVE-1", {
            id: 10,
            messageId: "LIVE-1",
            chatId: SENDER_JID,
            status: "PROCESSING",
            attempts: 1,
            lastError: null,
            receivedAt: mockNow,
            updatedAt: mockNow,
            processedAt: null,
        });

        const result = await deliver(
            waMessage({ id: "LIVE-1", text: "1" }),
            deps
        );

        expect(result).toBe("DUPLICATE");
        expect(sent).toHaveLength(0);
    });

    test("a claim left behind by a crash is taken over", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        mockDb.inbound.set("STALE-1", {
            id: 11,
            messageId: "STALE-1",
            chatId: SENDER_JID,
            status: "PROCESSING",
            attempts: 1,
            lastError: null,
            receivedAt: mockNow,
            updatedAt: new Date(mockNow.getTime() - 3 * 60 * 1000),
            processedAt: null,
        });

        const result = await deliver(
            waMessage({ id: "STALE-1", text: "1" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent).toHaveLength(1);
    });
});

/* ==========================================
 * 3. RECOGNIZING THE WEBSITE CONFIRMATION DRAFT
 * ========================================== */

describe("website confirmation draft", () => {
    test("the draft builder's own text is recognized and answered with the menu", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        // Built by the SAME function the order page uses, so this can
        // never drift from the button.
        const draft = buildOrderConfirmMessage({
            orderNumber: ORDER_NUMBER,
            customerName: "Budi",
            statusLabel: "Sedang Diproses",
        });

        const result = await deliver(
            waMessage({ id: "DRAFT-1", text: draft }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent).toHaveLength(1);
        expect(sent[0].text).toBe(menu.MAIN_MENU_TEXT);
        expect(sent[0].jid).toBe(SENDER_JID);

        // The draft's order is verified for the next step...
        expect(stateRow()?.verifiedOrderId).toBe(ORDER_ID);
        // ...and the STALE status inside the draft was not used.
        expect(sent[0].text).not.toContain("Sedang Diproses");
    });

    test("repeated failed drafts hit the SAME lockout as manual order numbers", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const draft = buildOrderConfirmMessage({
            orderNumber: ORDER_NUMBER,
            customerName: "Budi",
            statusLabel: "Sedang Diproses",
        });

        // A number that is not on the order, sending the draft repeatedly.
        for (let attempt = 0; attempt < MAX_FAILED_BINDS; attempt++) {
            mockNow = new Date(mockNow.getTime() + 5 * 1000);

            await deliver(
                waMessage({
                    id: `DRAFT-LOCK-${attempt}`,
                    jid: OTHER_JID,
                    text: draft,
                }),
                deps
            );
        }

        expect(
            stateRow(OTHER_JID)?.blockedUntil
        ).toBeInstanceOf(Date);

        const before = sent.length;
        mockNow = new Date(mockNow.getTime() + 5 * 1000);

        const result = await deliver(
            waMessage({
                id: "DRAFT-LOCK-AFTER",
                jid: OTHER_JID,
                text: draft,
            }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(sent).toHaveLength(before);
    });

    test("a draft opened from a different number binds nothing and discloses nothing", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const draft = buildOrderConfirmMessage({
            orderNumber: ORDER_NUMBER,
            customerName: "Budi",
            statusLabel: "Sedang Diproses",
        });

        const result = await deliver(
            waMessage({
                id: "DRAFT-2",
                jid: OTHER_JID,
                text: draft,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.MAIN_MENU_TEXT);
        expect(sentTexts(sent)).not.toContain(ORDER_ADDRESS);

        // No binding for that chat, and the attempt was counted.
        expect(stateRow(OTHER_JID)?.verifiedOrderId ?? null).toBeNull();
        expect(
            stateRow(OTHER_JID)?.failedBindAttempts
        ).toBe(1);
    });
});

/* ==========================================
 * 4. OWNERSHIP BINDING
 * ========================================== */

describe("ownership verification", () => {
    test("the sender's own order number unlocks its shipment info", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({ id: "BIND-1", text: ORDER_NUMBER }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain(
            `Nomor Pesanan: ${ORDER_NUMBER}`
        );
        expect(sent[0].text).toContain("JNE1234567890");
        expect(stateRow()?.verifiedOrderId).toBe(ORDER_ID);
    });

    test("a normalized stored phone still matches", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({ phone: SENDER_PHONE_NORMALIZED })
        );

        const result = await deliver(
            waMessage({ id: "BIND-2", text: ORDER_NUMBER }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain(ORDER_NUMBER);
    });

    test("an unknown order number is answered uniformly and unlocks nothing", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(
            waMessage({
                id: "FAKE-1",
                text: "ORD-1759000000000-ffffffff",
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.orderNotFound());
        expect(stateRow()?.verifiedOrderId ?? null).toBeNull();
        expect(stateRow()?.failedBindAttempts).toBe(1);
    });

    test("another customer's order is indistinguishable from a missing one", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        // The order exists, but it belongs to a DIFFERENT number.
        const result = await deliver(
            waMessage({
                id: "CROSS-1",
                jid: OTHER_JID,
                text: ORDER_NUMBER,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.orderNotFound());
        expect(sentTexts(sent)).not.toContain("JNE1234567890");
        expect(stateRow(OTHER_JID)?.verifiedOrderId ?? null).toBeNull();
    });

    test("a bound chat cannot read an order that is not bound to its number", async () => {
        const { deps, sent } = makeDeps();

        const SECOND_ORDER = 6161;
        mockDb.orders.push(
            orderRow(),
            orderRow({
                id: SECOND_ORDER,
                orderNumber: "ORD-1759000000001-bb22cc44",
                phone: "628777666555",
            })
        );

        // Bound to its own order…
        seedVerifiedState();

        // …then it asks for someone else's.
        const result = await deliver(
            waMessage({
                id: "CROSS-2",
                text: "ORD-1759000000001-bb22cc44",
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.orderNotFound());
        expect(stateRow()?.verifiedOrderId).toBe(ORDER_ID);
    });

    test("only a fresh database read may answer — no snapshot is cached in a message", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow({ shipmentStatus: "CREATED" }));
        seedVerifiedState();

        /*
         * A bare order number is the remaining owner-bound tracking
         * path (menu key "1" is now a website hand-off). It goes through
         * the same `bindOrder` + `trackingDecision` code the customer's
         * own order always used.
         */
        await deliver(
            waMessage({ id: "LIVE-9", text: ORDER_NUMBER }),
            deps
        );

        expect(sent[0].text).toContain(
            "Paket Dibuat, Belum Diambil Kurir"
        );

        // The parcel moves; the customer asks again from the OLD message.
        mockDb.orders[0] = orderRow({
            shipmentStatus: "IN_TRANSIT",
        });
        mockNow = new Date(mockNow.getTime() + 10 * 1000);

        await deliver(
            waMessage({ id: "LIVE-10", text: ORDER_NUMBER }),
            deps
        );

        expect(sent[1].text).toContain("Paket Dalam Perjalanan");
        expect(sent[1].text).not.toContain("Belum Diambil Kurir");
    });

    test("an expired binding falls back to asking for the order number", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState({
            verifiedAt: new Date(
                mockNow.getTime() - 31 * 60 * 1000
            ),
            lastActivityAt: new Date(
                mockNow.getTime() - 31 * 60 * 1000
            ),
        });

        const result = await deliver(
            waMessage({ id: "EXP-1", text: "2" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.askOrderNumber());
        expect(stateRow()?.state).toBe(CHAT_STATE.AWAITING_ORDER);
    });

    test("a LID chat fails closed and is pointed at the website", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({
                id: "LID-1",
                jid: "123456789012345@lid",
                text: ORDER_NUMBER,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.unverifiableSender());
        expect(sentTexts(sent)).not.toContain("JNE1234567890");
        expect(stateRow("123456789012345@lid")?.verifiedOrderId ?? null).toBeNull();

        // Not the customer's fault → no attempt burned.
        expect(
            stateRow("123456789012345@lid")?.failedBindAttempts ?? 0
        ).toBe(0);
    });

    test("a LID chat whose message carries the phone-number JID is verified normally", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({
                id: "LID-2",
                jid: "123456789012345@lid",
                remoteJidAlt: SENDER_JID,
                text: ORDER_NUMBER,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain("JNE1234567890");
    });

    test("repeated failed lookups lead to a timeout, then silence", async () => {
        const { deps, sent } = makeDeps();

        for (let attempt = 0; attempt < MAX_FAILED_BINDS; attempt++) {
            mockNow = new Date(mockNow.getTime() + 5 * 1000);

            await deliver(
                waMessage({
                    id: `LOCK-${attempt}`,
                    text: "ORD-1759000000000-ffffffff",
                }),
                deps
            );
        }

        expect(sent.at(-1)?.text).toBe(menu.tooManyAttempts());
        expect(stateRow()?.blockedUntil).toBeInstanceOf(Date);

        // While locked out: no reply at all.
        const before = sent.length;
        mockNow = new Date(mockNow.getTime() + 5 * 1000);

        const result = await deliver(
            waMessage({ id: "LOCK-AFTER", text: "1" }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(sent).toHaveLength(before);
    });
});

/* ==========================================
 * 5. MENU BEHAVIOUR
 * ========================================== */

describe("menu", () => {
    test("a greeting opens the main menu", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(
            waMessage({ id: "HI-1", text: "halo" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.MAIN_MENU_TEXT);
        expect(stateRow()?.state).toBe(CHAT_STATE.MENU);
    });

    test("'1' hands over the tracking page, '2' asks for the order number", async () => {
        const { deps, sent } = makeDeps();

        /*
         * Menu key "1" no longer collects anything: it points the
         * customer at the official tracking page, in every state, so no
         * order number is ever asked for (or disclosed) on this key.
         */
        await deliver(waMessage({ id: "ASK-1", text: "1" }), deps);

        expect(sent[0].text).toBe(
            menu.trackingInstruction(OFFICIAL_TRACKING_PAGE_URL)
        );
        expect(stateRow()?.state).toBe(CHAT_STATE.MENU);
        expect(stateRow()?.pendingIntent).toBeNull();

        mockNow = new Date(mockNow.getTime() + 5 * 1000);

        /* The order-number path is unchanged on menu key "2". */
        await deliver(waMessage({ id: "ASK-2", text: "2" }), deps);

        expect(sent[1].text).toBe(menu.askOrderNumber());
        expect(stateRow()?.state).toBe(CHAT_STATE.AWAITING_ORDER);
        expect(stateRow()?.pendingIntent).toBe("STATUS");
    });

    test("an unknown message while a menu is open returns the key list", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState();

        await deliver(
            waMessage({ id: "UNK-1", text: "kapan paketnya sampai ya" }),
            deps
        );

        expect(sent[0].text).toBe(menu.unknownCommand());
    });

    test("a message that only LOOKS negative does not pause the bot", async () => {
        const { deps, sent } = makeDeps();

        // "tidak masalah" means the opposite of a complaint.
        const result = await deliver(
            waMessage({ id: "FINE-1", text: "tidak masalah, terima kasih" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).not.toBe(menu.handoffNotice());
        expect(stateRow()?.state).not.toBe(CHAT_STATE.HANDOFF);
    });

    test("a message with no readable text gets a hint, not a guess", async () => {
        const { deps, sent } = makeDeps();

        await deliver(
            waMessage({ id: "MEDIA-1", text: null }),
            deps
        );

        expect(sent[0].text).toBe(menu.nonTextHint());
    });

    test("the same chat cannot flood the conversation", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState();
        mockDb.orders.push(orderRow());

        await deliver(waMessage({ id: "COOL-1", text: "1" }), deps);
        expect(sent).toHaveLength(1);

        // 2 seconds later: inside the cooldown → the SEND is suppressed.
        mockNow = new Date(mockNow.getTime() + 2000);

        const suppressed = await deliver(
            waMessage({ id: "COOL-2", text: "1" }),
            deps
        );

        expect(suppressed).toBe("SUPPRESSED");
        expect(sent).toHaveLength(1);

        // Past the cooldown: answered again.
        mockNow = new Date(
            mockNow.getTime() + REPLY_COOLDOWN_MS + 1000
        );

        await deliver(waMessage({ id: "COOL-3", text: "1" }), deps);

        expect(sent).toHaveLength(2);
    });

    test("the hourly reply budget is enforced per chat", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState({
            replyCount: MAX_REPLIES_PER_WINDOW,
            windowStartedAt: new Date(mockNow.getTime() - 60 * 1000),
        });
        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({ id: "BUDGET-1", text: "1" }),
            deps
        );

        expect(result).toBe("SUPPRESSED");
        expect(sent).toHaveLength(0);
    });
});

/* ==========================================
 * 6. HANDOFF TO A HUMAN ADMIN
 * ========================================== */

describe("handoff", () => {
    test("'3' hands the chat to an admin and records it once", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        const result = await deliver(
            waMessage({ id: "HAND-1", text: "3" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.handoffNotice());

        const row = stateRow();
        expect(row?.state).toBe(CHAT_STATE.HANDOFF);
        expect(
            (row?.pauseUntil as Date).getTime()
        ).toBeGreaterThan(mockNow.getTime());

        expect(deps.audit).toHaveBeenCalledTimes(1);

        const auditArgs = (deps.audit as jest.Mock).mock
            .calls[0][0];

        expect(auditArgs.action).toBe("WHATSAPP_HANDOFF");
        expect(auditArgs.entityType).toBe("Order");
        expect(auditArgs.entityId).toBe(ORDER_ID);
        expect(auditArgs.description).toContain("admin");

        // Only a MASKED chat label is stored.
        expect(auditArgs.metadata.chat).toBe("62******6789");
        expect(auditArgs.metadata.chat).not.toContain(
            SENDER_PHONE_NORMALIZED
        );
    });

    test("while an admin owns the chat the bot stays completely silent", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState({
            state: CHAT_STATE.HANDOFF,
            pauseUntil: new Date(mockNow.getTime() + 60 * 60 * 1000),
        });

        for (const text of ["halo", "1", "2", "paket saya belum sampai"]) {
            const result = await deliver(
                waMessage({ id: `SILENT-${text}`, text }),
                deps
            );

            expect(result).toBe("IGNORED");
        }

        expect(sent).toHaveLength(0);
    });

    test("state retention can never expire a window that is still in force", () => {
        /*
         * Cleanup deletes IDLE chat rows. If the retention window were
         * ever shrunk below the handoff pause, a deploy could silently
         * un-pause a conversation a human admin is handling.
         */
        expect(CHAT_STATE_RETENTION_MS).toBeGreaterThan(
            HANDOFF_PAUSE_MS * 24
        );
    });

    test("a handoff survives a restart because it lives in the database", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState({
            state: CHAT_STATE.HANDOFF,
            pauseUntil: new Date(mockNow.getTime() + 60 * 60 * 1000),
        });

        /*
         * Simulate a process restart: every in-memory helper the module
         * keeps is cleared. The pause is NOT in memory, so it must still
         * hold — this is what stops a deploy from re-enabling the bot in
         * the middle of a human conversation.
         */
        resetInfraErrorThrottle();
        resetTrackingCache();
        mockNow = new Date(mockNow.getTime() + 5 * 60 * 1000);

        const result = await deliver(
            waMessage({ id: "RESTART-1", text: "1" }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(sent).toHaveLength(0);
        expect(stateRow()?.state).toBe(CHAT_STATE.HANDOFF);
    });

    test("the customer can always return to the menu after a handoff", async () => {
        const { deps, sent } = makeDeps();

        seedVerifiedState({
            state: CHAT_STATE.HANDOFF,
            pauseUntil: new Date(mockNow.getTime() + 60 * 60 * 1000),
        });

        const result = await deliver(
            waMessage({ id: "RESUME-1", text: "menu" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.MAIN_MENU_TEXT);
        expect(stateRow()?.state).toBe(CHAT_STATE.MENU);
        expect(stateRow()?.pauseUntil).toBeNull();
    });

    test("an expired handoff window resumes serving", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState({
            state: CHAT_STATE.HANDOFF,
            pauseUntil: new Date(mockNow.getTime() - 1000),
        });

        const result = await deliver(
            waMessage({ id: "RESUME-2", text: "1" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent).toHaveLength(1);
    });

    test("a problem report is routed to a human without deciding the case", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({ shipmentStatus: "DELIVERED" })
        );
        seedVerifiedState();

        const result = await deliver(
            waMessage({
                id: "CMP-1",
                text: "paket belum saya terima",
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain(
            "ekspedisi telah menandai pesanan Anda sebagai terkirim"
        );
        expect(sent[0].text).toContain("Silakan tuliskan kendala");
        expect(stateRow()?.state).toBe(CHAT_STATE.HANDOFF);

        // The order itself was never touched.
        expect(prisma.order.update).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 7. STATUS / TRACKING BRANCHES
 * ========================================== */

describe("tracking and status", () => {
    async function askTracking(
        rows: OrderRowFixture[],
        overrides: Partial<BotDeps> = {}
    ) {
        const { deps, sent } = makeDeps(overrides);

        mockDb.orders.push(...rows);
        seedVerifiedState();

        const result = await deliver(
            waMessage({
                id: `TRACK-${rows[0].id}`,
                text: ORDER_NUMBER,
            }),
            deps
        );

        return { result, sent, deps };
    }

    test("a new order reports that no resi exists yet", async () => {
        const { sent } = await askTracking([
            orderRow({
                status: "PENDING",
                paymentStatus: "UNPAID",
                shipmentStatus: "NOT_CREATED",
                trackingNumber: null,
            }),
        ]);

        expect(sent[0].text).toContain("Resi belum tersedia");
        expect(sent[0].text).toContain("belum dibayar");
    });

    test("an order being prepared says so", async () => {
        const { sent } = await askTracking([
            orderRow({
                status: "PROCESSING",
                shipmentStatus: "SHIPMENT_PENDING",
                trackingNumber: null,
            }),
        ]);

        expect(sent[0].text).toContain("sedang disiapkan");
    });

    test("a parcel not yet handed to the courier says so", async () => {
        const { sent } = await askTracking([
            orderRow({
                shipmentStatus: "WAITING_SHIPPING_PAYMENT",
                trackingNumber: null,
            }),
        ]);

        expect(sent[0].text).toContain(
            "Paket belum diserahkan ke ekspedisi"
        );
    });

    test("a parcel in transit shows the resi and the provider history", async () => {
        const { sent, deps } = await askTracking(
            [orderRow({ shipmentStatus: "IN_TRANSIT" })],
            {
                loadTracking: jest.fn(
                    async (): Promise<TrackingView> => ({
                        source: "MENGANTAR",
                        providerRead: true,
                        available: true,
                        courier: "JNE",
                        trackingNumber: "JNE1234567890",
                        providerStatus: "ON DELIVERY",
                        history: [
                            {
                                date: "12/10/2026 14:20",
                                description:
                                    "Paket tiba di hub Jakarta",
                            },
                        ],
                        note: null,
                    })
                ),
            }
        );

        expect(sent[0].text).toContain("Paket Dalam Perjalanan");
        expect(sent[0].text).toContain("Nomor Resi: JNE1234567890");
        expect(sent[0].text).toContain(
            "Paket tiba di hub Jakarta"
        );

        // Non-terminal states still refresh from the provider.
        expect(deps.loadTracking).toHaveBeenCalledWith(
            expect.objectContaining({ id: ORDER_ID }),
            { useCache: true }
        );
    });

    test("a delivered parcel is reported plus the post-delivery menu, with NO provider call", async () => {
        const { sent, deps } = await askTracking([
            orderRow({ shipmentStatus: "DELIVERED" }),
        ]);

        expect(sent[0].text).toContain("PAKET TELAH DITERIMA");
        expect(sent[0].text).toContain("Status: Terkirim");
        expect(sent[0].text).toContain(
            "Lihat Riwayat Pengiriman"
        );
        expect(sent[0].text).toContain(
            "Ada Masalah dengan Pesanan"
        );

        // A finished shipment must not cost a courier API call.
        expect(deps.loadTracking).not.toHaveBeenCalled();
        expect(stateRow()?.state).toBe(
            CHAT_STATE.VERIFIED_DELIVERED
        );
    });

    test("a completed order stays trackable", async () => {
        const { sent, deps } = await askTracking([
            orderRow({
                status: "COMPLETED",
                shipmentStatus: "DELIVERED",
            }),
        ]);

        expect(sent[0].text).toContain("PAKET TELAH DITERIMA");
        expect(sent[0].text).toContain("Terima kasih");
        expect(deps.loadTracking).not.toHaveBeenCalled();
    });

    test("the delivery history is only fetched when explicitly asked for", async () => {
        const loadTracking = jest.fn(
            async (): Promise<TrackingView> => ({
                source: "MENGANTAR",
                providerRead: true,
                available: true,
                courier: "JNE",
                trackingNumber: "JNE1234567890",
                providerStatus: "DELIVERED",
                history: [
                    {
                        date: "13/10/2026 09:00",
                        description: "Paket diterima Budi",
                    },
                ],
                note: null,
            })
        );

        const { deps, sent } = makeDeps({ loadTracking });

        mockDb.orders.push(
            orderRow({ shipmentStatus: "DELIVERED" })
        );
        seedVerifiedState({
            state: CHAT_STATE.VERIFIED_DELIVERED,
        });

        const result = await deliver(
            waMessage({ id: "HIST-1", text: "1" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain("RIWAYAT PENGIRIMAN");
        expect(sent[0].text).toContain("Paket diterima Budi");

        // Explicit request → a FRESH read, not the cached one.
        expect(loadTracking).toHaveBeenCalledWith(
            expect.objectContaining({ id: ORDER_ID }),
            { useCache: false }
        );
    });

    test("'2' in the post-delivery menu opens a problem report, not a status dump", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({ shipmentStatus: "DELIVERED" })
        );
        seedVerifiedState({
            state: CHAT_STATE.VERIFIED_DELIVERED,
        });

        await deliver(waMessage({ id: "POST-2", text: "2" }), deps);

        expect(sent[0].text).toContain("Silakan tuliskan kendala");
        expect(stateRow()?.state).toBe(CHAT_STATE.HANDOFF);
    });

    test("a cancelled order reports no active shipment", async () => {
        const { sent } = await askTracking([
            orderRow({
                status: "CANCELLED",
                shipmentStatus: "CANCELLED",
            }),
        ]);

        expect(sent[0].text).toContain("Dibatalkan");
        expect(sent[0].text).not.toContain("PAKET TELAH DITERIMA");
    });

    test("a returned parcel is reported without claiming delivery", async () => {
        const { sent } = await askTracking([
            orderRow({ shipmentStatus: "RETURNED" }),
        ]);

        expect(sent[0].text).toContain(
            "Dikembalikan ke Pengirim"
        );
        expect(sent[0].text).not.toContain("PAKET TELAH DITERIMA");
    });

    test("a provider failure shows the stored state and discloses the gap", async () => {
        const { sent } = await askTracking(
            [orderRow({ shipmentStatus: "IN_TRANSIT" })],
            {
                loadTracking: jest.fn(
                    async (): Promise<TrackingView> => ({
                        source: "MENGANTAR",
                        providerRead: true,
                        available: false,
                        courier: "JNE",
                        trackingNumber: "JNE1234567890",
                        providerStatus: "IN_TRANSIT",
                        history: [],
                        note: TRACKING_UPDATE_UNAVAILABLE_NOTE,
                    })
                ),
            }
        );

        expect(sent[0].text).toContain(
            TRACKING_UPDATE_UNAVAILABLE_NOTE
        );
        expect(sent[0].text).toContain("Nomor Resi: JNE1234567890");
        expect(sent[0].text).not.toContain("PAKET TELAH DITERIMA");
    });

    test("status answers keep order, payment and shipment apart", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({
                status: "PROCESSING",
                paymentStatus: "PAID",
                shipmentStatus: "NOT_CREATED",
                trackingNumber: null,
            })
        );
        seedVerifiedState({ pendingIntent: "STATUS" });

        const result = await deliver(
            waMessage({ id: "STATUS-1", text: "2" }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain(
            "Status Pesanan: Sedang Diproses"
        );
        expect(sent[0].text).toContain(
            "Status Pembayaran: Pembayaran Diterima"
        );
        expect(sent[0].text).toContain(
            "Status Pengiriman: Pengiriman Belum Dibuat"
        );
        // A paid order is NOT described as shipped.
        expect(sent[0].text).not.toContain("Sedang Dikirim");
    });

    test("tracking requests never modify an order or a shipment", async () => {
        const { deps } = makeDeps();

        mockDb.orders.push(orderRow());

        for (const [index, text] of [
            "1",
            "2",
            "0",
            ORDER_NUMBER,
        ].entries()) {
            mockNow = new Date(mockNow.getTime() + 5000);

            await deliver(
                waMessage({ id: `NOWRITE-${index}`, text }),
                deps
            );
        }

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(prisma.order.create).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 8. NO SECRETS IN A REPLY
 * ========================================== */

describe("reply content", () => {
    test("no address, phone, email, token or payment reference is ever sent", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const conversations = [
            "halo",
            "1",
            "2",
            "3",
            ORDER_NUMBER,
            buildOrderConfirmMessage({
                orderNumber: ORDER_NUMBER,
                customerName: "Budi",
                statusLabel: "Sedang Diproses",
            }),
            "paket belum sampai",
        ];

        for (const [index, text] of conversations.entries()) {
            mockNow = new Date(mockNow.getTime() + 5000);

            await deliver(
                waMessage({ id: `LEAK-${index}`, text }),
                deps
            );
        }

        const replies = sentTexts(sent);

        expect(replies).not.toContain(ORDER_ADDRESS);
        expect(replies).not.toContain(ORDER_EMAIL);
        expect(replies).not.toContain(ORDER_TOKEN_HASH);
        expect(replies).not.toContain("PAY-REF-999");
        expect(replies).not.toContain(SENDER_PHONE_LOCAL);
        expect(replies).not.toMatch(/gos_|AUTH_SECRET|\/api\//);
        expect(replies).not.toContain("guestAccessToken");
    });

    test("only the fields the bot is allowed to read are selected", async () => {
        const { deps } = makeDeps();

        mockDb.orders.push(orderRow());

        await deliver(
            waMessage({ id: "SELECT-1", text: ORDER_NUMBER }),
            deps
        );

        const select = (
            prisma.order.findFirst as unknown as jest.Mock
        ).mock.calls[0][0].select;

        for (const forbidden of [
            "address",
            "customerEmail",
            "guestAccessTokenHash",
            "guestAccessTokenExpiresAt",
            "guestIdentityKey",
            "paymentNo",
            "paymentUrl",
            "qrString",
            "paymentReference",
            "userId",
            "note",
            "recipientName",
            "latitude",
            "longitude",
        ]) {
            expect(select).not.toHaveProperty(forbidden);
        }
    });
});

/* ==========================================
 * 9. SENDER IDENTITY (PURE) — FAIL CLOSED
 * ========================================== */

describe("sender identity", () => {
    test("only phone-number JIDs can identify a sender", () => {
        expect(
            extractSenderPhones({
                remoteJid: SENDER_JID,
            })
        ).toEqual([SENDER_PHONE_NORMALIZED]);

        // Multi-device suffix is stripped, never concatenated.
        expect(
            extractSenderPhones({
                remoteJid: `${SENDER_PHONE_NORMALIZED}:12@s.whatsapp.net`,
            })
        ).toEqual([SENDER_PHONE_NORMALIZED]);

        // A LID carries no identity, so it contributes nothing.
        expect(
            extractSenderPhones({
                remoteJid: "123456789012345@lid",
            })
        ).toEqual([]);

        // …unless the phone-number JID is provided alongside it.
        expect(
            extractSenderPhones({
                remoteJid: "123456789012345@lid",
                remoteJidAlt: SENDER_JID,
            })
        ).toEqual([SENDER_PHONE_NORMALIZED]);

        // Groups, broadcasts and newsletter channels never do either.
        for (const jid of [
            "120363001122334455@g.us",
            "status@broadcast",
            "120363001122334455@broadcast",
            "120363001122334455@newsletter",
        ]) {
            expect(
                extractSenderPhones({ remoteJid: jid })
            ).toEqual([]);
        }
    });

    test("the phone-number alternative is preferred over the LID", () => {
        expect(
            inboundJidCandidates({
                remoteJid: "123456789012345@lid",
                remoteJidAlt: SENDER_JID,
            })
        ).toEqual([SENDER_JID, "123456789012345@lid"]);
    });

    test("ownership matching tolerates every stored phone format", () => {
        for (const stored of [
            "08123456789",
            "+62 812-3456-789",
            "628123456789",
            "  628123456789 ",
        ]) {
            expect(
                orderPhoneMatches(
                    [SENDER_PHONE_NORMALIZED],
                    stored
                )
            ).toBe(true);
        }

        /*
         * A stored value that is not a phone number at all (e.g. a whole
         * JID with a device suffix) fails CLOSED: the seller's device id
         * is never concatenated into a number that would match by
         * accident.
         */
        expect(
            orderPhoneMatches(
                [SENDER_PHONE_NORMALIZED],
                "628123456789:12@s.whatsapp.net"
            )
        ).toBe(false);

        // No sender number, or no order phone → never a match.
        expect(
            orderPhoneMatches([], "08123456789")
        ).toBe(false);
        expect(
            orderPhoneMatches(
                [SENDER_PHONE_NORMALIZED],
                null
            )
        ).toBe(false);
        expect(
            orderPhoneMatches(
                [SENDER_PHONE_NORMALIZED],
                "628999888777"
            )
        ).toBe(false);
    });

    test("group, broadcast and newsletter chats are never customer chats", () => {
        for (const jid of [
            "120363001122334455@g.us",
            "status@broadcast",
            "broadcast",
            "120363001122334455@broadcast",
            "120363001122334455@newsletter",
            "",
        ]) {
            expect(isCustomerChatJid(jid)).toBe(false);
            expect(isCustomerChatJid(jid)).toBe(false);
        }

        for (const jid of [
            SENDER_JID,
            `${SENDER_PHONE_NORMALIZED}@c.us`,
            "123456789012345@lid",
        ]) {
            expect(isCustomerChatJid(jid)).toBe(true);
        }
    });

    test("admin labels never expose the raw identifier", () => {
        expect(maskChatJid(SENDER_JID)).toBe("62******6789");

        const lidLabel = maskChatJid(
            "123456789012345@lid"
        );
        expect(lidLabel).toMatch(/^chat-[0-9a-f]{8}$/);
        expect(lidLabel).not.toContain("123456789012345");

        // First two digits + last four: recognisable, not reusable.
        expect(maskPhoneNumber("6281234567890")).toBe(
            "62*******7890"
        );
        expect(maskPhoneNumber("6281234567890")).not.toContain(
            "81234567"
        );
        expect(maskPhoneNumber(null)).toBe("****");
    });
});

/* ==========================================
 * 10. MENGANTAR READER (REAL MAPPER)
 * ========================================== */

describe("mengantar tracking reader", () => {
    test("maps the provider history and caches repeated reads", async () => {
        mockedMengantar.mockResolvedValue({
            orderId: "MG-1",
            status: "ON DELIVERY",
            statusCategory: "ON DELIVERY",
            trackingNumber: "JNE1234567890",
            history: [
                {
                    date: "12/10/2026 14:20",
                    desc: "Paket tiba di hub Jakarta",
                },
            ],
        });

        const order = {
            id: ORDER_ID,
            shippingProvider: "MENGANTAR",
            providerCourier: "JNE",
            shippingCourier: "JNE",
            shippingService: "REG",
            trackingNumber: "JNE1234567890",
            shipmentStatus: "IN_TRANSIT",
        };

        const first = await loadTrackingView(order);
        const second = await loadTrackingView(order);

        expect(first.available).toBe(true);
        expect(first.courier).toBe("JNE");
        expect(first.history).toEqual([
            {
                date: "12/10/2026 14:20",
                description: "Paket tiba di hub Jakarta",
            },
        ]);
        expect(second.available).toBe(true);

        // Two taps must not become two provider calls.
        expect(mockedMengantar).toHaveBeenCalledTimes(1);
    });

    test("legacy RajaOngkir orders use the existing request shape", async () => {
        const previousKey = process.env.RAJAONGKIR_API_KEY;
        process.env.RAJAONGKIR_API_KEY = "test-rajaongkir-key";

        const fetchSpy = jest
            .spyOn(global, "fetch")
            .mockResolvedValue({
                ok: true,
                json: async () => ({
                    meta: { status: "success" },
                    data: {
                        delivery_status: "DELIVERED",
                        manifest: [
                            {
                                manifest_date: "12/10/2026",
                                manifest_time: "14:20",
                                manifest_description:
                                    "Paket diterima",
                            },
                        ],
                    },
                }),
            } as unknown as Response);

        try {
            const view = await loadTrackingView({
                id: 8888,
                // NULL provider = the legacy RajaOngkir flow.
                shippingProvider: null,
                providerCourier: null,
                shippingCourier: "JNE",
                shippingService: "REG",
                trackingNumber: "RJK123",
                shipmentStatus: "SHIPPED",
                phone: SENDER_PHONE_LOCAL,
            });

            expect(view.source).toBe("RAJAONGKIR");
            expect(view.available).toBe(true);
            expect(view.history).toEqual([
                {
                    date: "12/10/2026 14:20",
                    description: "Paket diterima",
                },
            ]);

            // The recipient phone is used ONLY as the courier's required
            // short validation code, never as a display value.
            const url = String(
                fetchSpy.mock.calls[0][0]
            );
            expect(url).toContain("awb=RJK123");
            expect(url).toContain("courier=jne");
            expect(url).toContain(
                `last_phone_number=${SENDER_PHONE_LOCAL.slice(-5)}`
            );
        } finally {
            fetchSpy.mockRestore();

            if (previousKey === undefined) {
                delete process.env.RAJAONGKIR_API_KEY;
            } else {
                process.env.RAJAONGKIR_API_KEY = previousKey;
            }
        }
    });

    test("a missing RajaOngkir key is disclosed and never guessed", async () => {
        const previousKey = process.env.RAJAONGKIR_API_KEY;
        delete process.env.RAJAONGKIR_API_KEY;

        const fetchSpy = jest.spyOn(global, "fetch");

        try {
            const view = await loadTrackingView({
                id: 8889,
                shippingProvider: null,
                providerCourier: null,
                shippingCourier: "JNE",
                shippingService: "REG",
                trackingNumber: "RJK999",
                shipmentStatus: "SHIPPED",
                phone: SENDER_PHONE_LOCAL,
            });

            expect(view.available).toBe(false);
            expect(view.note).toContain("belum dikonfigurasi");

            // No provider call at all without a key.
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();

            if (previousKey !== undefined) {
                process.env.RAJAONGKIR_API_KEY = previousKey;
            }
        }
    });

    test("a provider error is disclosed instead of invented", async () => {
        mockedMengantar.mockRejectedValue(
            new Error("mengantar unavailable")
        );

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const view = await loadTrackingView({
            id: 777,
            shippingProvider: "MENGANTAR",
            providerCourier: "JNE",
            shippingCourier: null,
            shippingService: null,
            trackingNumber: "JNE999",
            shipmentStatus: "IN_TRANSIT",
        });

        errorSpy.mockRestore();

        expect(view.available).toBe(false);
        expect(view.note).toBe(
            TRACKING_UPDATE_UNAVAILABLE_NOTE
        );
        expect(view.trackingNumber).toBe("JNE999");
        expect(view.history).toEqual([]);
    });
});

/* ==========================================
 * 10. OFFICIAL TRACKING PAGE LINK
 * ==========================================
 *
 * The bot's half of the WhatsApp → website hand-off. These are the only
 * tests in this suite that enable an origin, and they pin the rule that
 * decides whether a link may carry the order number.
 */

describe("the official tracking page link", () => {
    const ORIGIN = "https://mutiaraabadisnack.com";
    const BARE = `${ORIGIN}/lacak`;

    beforeEach(() => {
        process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
        resetTrackingUrlWarningThrottle();
    });

    afterEach(() => {
        /*
         * Never leak the origin into another suite: Jest shares
         * process.env between test files in a worker.
         */
        delete process.env.NEXT_PUBLIC_APP_URL;
        resetTrackingUrlWarningThrottle();
    });

    test("a phone-verified order gets a link prefilled with ITS number", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        const result = await deliver(
            waMessage({ id: "LINK-1", text: ORDER_NUMBER }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toContain(
            `${BARE}?pesanan=${ORDER_NUMBER}`
        );
    });

    test("an order the sender does NOT own never gets its number in a link", async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(
            orderRow({ phone: "089999999999" })
        );

        const result = await deliver(
            waMessage({ id: "LINK-2", text: ORDER_NUMBER }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(menu.orderNotFound(BARE));
        expect(sent[0].text).not.toContain("?pesanan=");
        expect(sentTexts(sent)).not.toContain(ORDER_NUMBER);
        expect(sentTexts(sent)).not.toContain("JNE1234567890");
    });

    test("a chat that cannot be phone-verified is pointed at the bare page", async () => {
        const { deps, sent } = makeDeps();

        const result = await deliver(
            waMessage({
                id: "LINK-3",
                jid: "123456789012345@lid",
                text: ORDER_NUMBER,
            }),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent[0].text).toBe(
            menu.unverifiableSender(BARE)
        );
        expect(sent[0].text).not.toContain("?pesanan=");
    });

    test('typing "resi" reaches the tracking page hand-off, not the order data', async () => {
        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());
        seedVerifiedState();

        const result = await deliver(
            waMessage({ id: "LINK-4", text: "resi" }),
            deps
        );

        expect(result).toBe("REPLIED");

        /*
         * A typed tracking word is menu key "1": the SAME instruction
         * reply, with the BARE page (nothing was proven for this chat),
         * and no order detail of any kind.
         */
        expect(sent[0].text).toBe(menu.trackingInstruction(BARE));
        expect(sent[0].text).not.toContain("?pesanan=");
        expect(sent[0].text).not.toContain(ORDER_NUMBER);
        expect(sent[0].text).not.toContain("JNE1234567890");
    });

    test("with no configured origin every reply stays text only", async () => {
        delete process.env.NEXT_PUBLIC_APP_URL;

        const { deps, sent } = makeDeps();

        mockDb.orders.push(orderRow());

        await deliver(
            waMessage({ id: "LINK-5", text: ORDER_NUMBER }),
            deps
        );

        expect(sent[0].text).not.toContain("http");
    });

    test("adding a link still never writes an order", async () => {
        const { deps } = makeDeps();

        mockDb.orders.push(orderRow());

        await deliver(
            waMessage({ id: "LINK-6", text: ORDER_NUMBER }),
            deps
        );

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(prisma.order.create).not.toHaveBeenCalled();
    });
});
