/**
 * ==========================================================
 * WHATSAPP INTERACTIVE (NATIVE FLOW) BUTTONS — FOCUSED TESTS
 * ==========================================================
 *
 * Pins the OPT-IN interactive layer that sits on top of the numbered
 * text menu:
 *
 *   - OFF BY DEFAULT: with the flag unset, no interactive message is
 *     ever attempted and the bot behaves exactly as before,
 *   - the numbered text is ALWAYS carried: the interactive payload body
 *     is the complete menu, and any refusal/failure/absence of the
 *     interactive sender degrades to that text (never to silence),
 *   - a tap is mapped by its STABLE ID onto the same menu digit the
 *     customer could have typed, so clicks travel through the identical
 *     pipeline: ownership verification, dedupe, cooldown, rate limits,
 *     handoff,
 *   - the payload is a REAL protobuf interactive message (round-tripped
 *     through the encoder below).
 *
 * WHAT THESE TESTS DO NOT AND CANNOT PROVE
 *
 *   Sending succeeded is not evidence that a button was DISPLAYED.
 *   Rendering depends on the recipient's WhatsApp client and on
 *   WhatsApp's server-side handling of a non-official sender, so the
 *   only honest verification is a manual test on real Android and
 *   iPhone devices. No WhatsApp connection is used here, and no message
 *   is ever sent.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "whatsapp-interactive-test-secret";

/* ==========================================
 * IN-MEMORY PRISMA FAKE
 * ========================================== */

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
        },
        whatsAppChatState: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            findUnique: jest.fn(
                async ({
                    where,
                }: {
                    where: { chatId: string };
                }) => mockDb.chatStates.get(where.chatId) ?? null
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
                    data: { messageId: string; chatId: string };
                }) => {
                    if (mockDb.inbound.has(data.messageId)) {
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
                }
            ),
            findUnique: jest.fn(
                async ({
                    where,
                }: {
                    where: { messageId: string };
                }) => mockDb.inbound.get(where.messageId) ?? null
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
                            next[key] =
                                Number(next[key] ?? 0) +
                                (
                                    value as {
                                        increment: number;
                                    }
                                ).increment;
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
                }
            ),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
    },
}));

/** The real module talks to the Mengantar API over the network. */
jest.mock("@/lib/mengantar", () => ({
    getMengantarOrderByTracking: jest.fn(async () => null),
}));

import fs from "fs";
import path from "path";

import {
    handleIncomingMessage,
    resetInfraErrorThrottle,
    type BotDeps,
    type SendResult,
} from "@/lib/whatsapp/inbound/handler";
import * as interactive from "@/lib/whatsapp/inbound/interactive";
import {
    MAIN_MENU_TEXT,
    POST_DELIVERY_MENU_TEXT,
    askOrderNumber,
    handoffNotice,
    mainMenu,
    postDeliveryMenu,
} from "@/lib/whatsapp/inbound/menu";
import { parseInboundMessage } from "@/lib/whatsapp/inbound/parse";
import { buildTrackingReply } from "@/lib/whatsapp/inbound/replies";
import { CHAT_STATE } from "@/lib/whatsapp/inbound/state";

/* ==========================================
 * FIXTURES
 * ========================================== */

const ORDER_ID = 7001;
const ORDER_NUMBER = "ORD-1759000000001-ff00aa11";

const SENDER_PHONE_LOCAL = "08123456789";
const SENDER_PHONE_NORMALIZED = "628123456789";
const SENDER_JID = `${SENDER_PHONE_NORMALIZED}@s.whatsapp.net`;

/** A different customer — must never be served. */
const OTHER_PHONE_LOCAL = "081999888777";

/** Secrets that must NEVER appear in a reply or in a button payload. */
const ORDER_ADDRESS = "Jl. Rahasia No. 123";
const ORDER_EMAIL = "rahasia@example.com";
const ORDER_TOKEN_HASH = "deadbeefhash";
const ORDER_PAYMENT_REF = "PAY-REF-999";

const mockNow = new Date("2026-10-14T03:00:00.000Z");

const FLAG = interactive.INTERACTIVE_BUTTONS_ENV;

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
        trackingNumber: "JNE1234567890",
        trackingUrl: null,
        shipmentStatus: "IN_TRANSIT",
        shippingPaymentStatus: "PAID",
        phone: SENDER_PHONE_LOCAL,
        // Must NEVER reach a reply, on either transport.
        address: ORDER_ADDRESS,
        customerEmail: ORDER_EMAIL,
        guestAccessTokenHash: ORDER_TOKEN_HASH,
        paymentReference: ORDER_PAYMENT_REF,
        ...overrides,
    };
}

function seedVerifiedState(overrides: Row = {}): void {
    mockDb.chatStates.set(SENDER_JID, {
        id: 1,
        chatId: SENDER_JID,
        state: CHAT_STATE.MENU,
        verifiedOrderId: ORDER_ID,
        verifiedAt: mockNow,
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

/** A click on one of our own buttons, as WhatsApp/Baileys delivers it. */
function buttonTap(
    buttonId: string,
    overrides: {
        id?: string;
        jid?: string;
        displayText?: string | null;
    } = {}
) {
    const {
        id = "TAP-1",
        jid = SENDER_JID,
        displayText = null,
    } = overrides;

    return {
        key: { id, remoteJid: jid, fromMe: false },
        message: {
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    name: "quick_reply",
                    paramsJson: JSON.stringify({ id: buttonId }),
                    version: 3,
                },
                ...(displayText
                    ? { body: { text: displayText } }
                    : {}),
            },
        },
        messageTimestamp: Math.floor(mockNow.getTime() / 1000),
    };
}

function textMessage(
    text: string,
    overrides: { id?: string; jid?: string } = {}
) {
    const { id = "TXT-1", jid = SENDER_JID } = overrides;

    return {
        key: { id, remoteJid: jid, fromMe: false },
        message: { conversation: text },
        messageTimestamp: Math.floor(mockNow.getTime() / 1000),
    };
}

type SentRecord = {
    texts: Array<{ jid: string; text: string }>;
    interactives: Array<{
        jid: string;
        content: interactive.WhatsAppInteractiveContent;
    }>;
};

function makeDeps(
    overrides: Partial<BotDeps> = {}
): { deps: BotDeps; sent: SentRecord } {
    const sent: SentRecord = { texts: [], interactives: [] };

    const deps: BotDeps = {
        send: jest.fn(async (jid: string, text: string) => {
            sent.texts.push({ jid, text });
            return { success: true } satisfies SendResult;
        }),
        sendInteractive: jest.fn(
            async (
                jid: string,
                content: interactive.WhatsAppInteractiveContent
            ) => {
                sent.interactives.push({ jid, content });
                return { success: true } satisfies SendResult;
            }
        ),
        now: () => mockNow,
        loadTracking: jest.fn(async () => ({
            source: "MENGANTAR" as const,
            providerRead: true,
            available: false,
            courier: null,
            trackingNumber: null,
            providerStatus: null,
            history: [],
            note: null,
        })),
        audit: jest.fn(async () => {}),
        ...overrides,
    };

    return { deps, sent };
}

/** Everything the customer was shown, whichever transport was used. */
function deliveredBodies(sent: SentRecord): string[] {
    return [
        ...sent.texts.map((item) => item.text),
        ...sent.interactives.map(
            (item) => item.content.interactiveMessage.body.text
        ),
    ];
}

beforeEach(() => {
    mockDb.reset();
    resetInfraErrorThrottle();
    delete process.env[FLAG];
});

afterEach(() => {
    delete process.env[FLAG];
});

/* ==========================================
 * 1. FEATURE FLAG — OFF UNLESS EXPLICITLY ON
 * ========================================== */

describe("interactive feature flag", () => {
    test("is OFF by default (flag unset)", () => {
        expect(interactive.isInteractiveButtonsEnabled({})).toBe(false);
    });

    test("an empty or ambiguous value is NOT an opt-in", () => {
        for (const value of [
            "",
            " ",
            "0",
            "false",
            "no",
            "off",
            "tru",
            "enabled",
        ]) {
            expect(
                interactive.isInteractiveButtonsEnabled({ [FLAG]: value })
            ).toBe(false);
        }
    });

    test("an explicit opt-in enables it", () => {
        for (const value of ["1", "true", "TRUE", " on ", "yes"]) {
            expect(
                interactive.isInteractiveButtonsEnabled({ [FLAG]: value })
            ).toBe(true);
        }
    });
});

/* ==========================================
 * 2. BUTTON IDS ARE A STABLE CONTRACT
 * ========================================== */

describe("button id contract", () => {
    test("the main menu exposes exactly these four ids", () => {
        expect(
            interactive.MAIN_MENU_BUTTONS.map((button) => [
                button.id,
                button.digit,
            ])
        ).toEqual([
            ["menu_track", "1"],
            ["menu_status", "2"],
            ["menu_admin", "3"],
            ["menu_home", "0"],
        ]);
    });

    test("the post-delivery sub-menu has its OWN id namespace", () => {
        const postIds = interactive.POST_DELIVERY_BUTTONS.map(
            (button) => button.id
        );

        expect(postIds).toEqual([
            "delivered_history",
            "delivered_problem",
            "delivered_again",
            "delivered_home",
        ]);

        // A stale main-menu id must never be read as a post-delivery
        // option, even though both use the digit "1".
        for (const id of postIds) {
            expect(
                interactive.MAIN_MENU_BUTTONS.some(
                    (button) => button.id === id
                )
            ).toBe(false);
        }
    });

    test("every id is unique across both menus", () => {
        const ids = interactive.ALL_BUTTONS.map((button) => button.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    test("labels stay within WhatsApp's limit and are unique per menu", () => {
        for (const buttons of [
            interactive.MAIN_MENU_BUTTONS,
            interactive.POST_DELIVERY_BUTTONS,
        ]) {
            const labels = buttons.map((button) => button.label);

            expect(new Set(labels).size).toBe(labels.length);

            for (const label of labels) {
                expect([...label].length).toBeLessThanOrEqual(20);
                expect(label.trim()).toBe(label);
            }
        }
    });

    test("every digit is a real menu key", () => {
        for (const button of interactive.ALL_BUTTONS) {
            expect(["0", "1", "2", "3"]).toContain(button.digit);
        }
    });
});

/* ==========================================
 * 3. ID → INTENT (the tap ≡ the typed digit)
 * ========================================== */

describe("button id maps onto the existing menu digits", () => {
    test("each main-menu id yields its digit", () => {
        expect(interactive.digitFromButton("menu_track")).toBe("1");
        expect(interactive.digitFromButton("menu_status")).toBe("2");
        expect(interactive.digitFromButton("menu_admin")).toBe("3");
        expect(interactive.digitFromButton("menu_home")).toBe("0");
    });

    test("each post-delivery id yields its digit", () => {
        expect(interactive.digitFromButton("delivered_history")).toBe("1");
        expect(interactive.digitFromButton("delivered_problem")).toBe("2");
        expect(interactive.digitFromButton("delivered_again")).toBe("3");
        expect(interactive.digitFromButton("delivered_home")).toBe("0");
    });

    test("an unknown or hostile id is never guessed at", () => {
        for (const value of [
            "hack",
            "menu_track_x",
            "menu_",
            "1",
            "",
            "   ",
            null,
            undefined,
            42,
            {},
        ]) {
            expect(interactive.digitFromButton(value)).toBeNull();
        }
    });

    test("a tap whose client echoed the label still maps", () => {
        expect(interactive.digitFromButton("📦 Lacak Resi")).toBe("1");
        expect(interactive.digitFromButton("menu utama")).toBe("0");
    });

    test("ids are matched case-insensitively", () => {
        expect(interactive.digitFromButton("MENU_TRACK")).toBe("1");
    });
});

/* ==========================================
 * 4. READING A TAP FROM THE ENVELOPE
 * ========================================== */

describe("reading the tapped button from an inbound message", () => {
    test("native flow paramsJson is the primary source", () => {
        expect(interactive.readButtonId(buttonTap("menu_track").message)).toBe(
            "menu_track"
        );
    });

    test("malformed or id-less paramsJson does not throw", () => {
        expect(
            interactive.readButtonId({
                interactiveResponseMessage: {
                    nativeFlowResponseMessage: { paramsJson: "{" },
                },
            })
        ).toBeNull();

        expect(
            interactive.readButtonId({
                interactiveResponseMessage: {
                    nativeFlowResponseMessage: {
                        paramsJson: JSON.stringify({
                            display_text: "Lacak Resi",
                        }),
                    },
                },
            })
        ).toBeNull();
    });

    test("older button / template / list responses are understood", () => {
        expect(
            interactive.readButtonId({
                buttonsResponseMessage: { selectedButtonId: "menu_status" },
            })
        ).toBe("menu_status");

        expect(
            interactive.readButtonId({
                templateButtonReplyMessage: { selectedId: "menu_admin" },
            })
        ).toBe("menu_admin");

        expect(
            interactive.readButtonId({
                listResponseMessage: {
                    singleSelectReply: { selectedRowId: "menu_home" },
                },
            })
        ).toBe("menu_home");
    });

    test("an explicit id wins over the echoed display text", () => {
        const envelope = buttonTap("menu_admin", {
            displayText: "📦 Lacak Resi",
        });

        expect(interactive.readButtonId(envelope.message)).toBe("menu_admin");
    });

    test("a response with only display text still reaches a digit", () => {
        const envelope = {
            interactiveResponseMessage: {
                body: { text: "📦 Lacak Resi" },
            },
        };

        // The label is what the envelope carries…
        expect(interactive.readButtonId(envelope)).toBe("📦 Lacak Resi");
        // …and it still maps onto the digit the tap stood for.
        expect(interactive.readButtonDigit(envelope)).toBe("1");
    });

    test("readButtonDigit reads a whole envelope (id preferred)", () => {
        expect(
            interactive.readButtonDigit(
                buttonTap("menu_admin", {
                    displayText: "📦 Lacak Resi",
                }).message
            )
        ).toBe("3");
    });

    test("an ordinary text message carries no button id", () => {
        expect(
            interactive.readButtonId({ conversation: "menu_track" })
        ).toBeNull();
        expect(interactive.readButtonId(null)).toBeNull();
    });
});

/* ==========================================
 * 5. PAYLOAD
 * ========================================== */

describe("interactive payload", () => {
    test("the body IS the complete numbered menu (the fallback)", () => {
        const content = interactive.buildInteractiveContent({
            menu: "MAIN",
            bodyText: MAIN_MENU_TEXT,
        });

        expect(content.interactiveMessage.body.text).toBe(MAIN_MENU_TEXT);
        expect(content.interactiveMessage.body.text).toContain("1. 📦 Lacak Resi");
        expect(content.interactiveMessage.body.text).toContain("0. 🏠 Menu Utama");
        expect(content.interactiveMessage.body.text).toContain(
            "Balas dengan angka pilihan kamu."
        );
    });

    test("it explains that the numbers still work", () => {
        const content = interactive.buildInteractiveContent({
            menu: "MAIN",
            bodyText: MAIN_MENU_TEXT,
        });

        expect(content.interactiveMessage.footer.text).toContain("angka");
    });

    test("it carries one quick_reply button per menu option", () => {
        const content = interactive.buildInteractiveContent({
            menu: "MAIN",
            bodyText: MAIN_MENU_TEXT,
        });

        const buttons = content.interactiveMessage.nativeFlowMessage.buttons;

        expect(buttons).toHaveLength(4);

        for (const button of buttons) {
            expect(button.name).toBe(
                interactive.QUICK_REPLY_BUTTON_NAME
            );

            const params = JSON.parse(button.buttonParamsJson) as {
                display_text: string;
                id: string;
            };

            expect(interactive.digitFromButton(params.id)).not.toBeNull();
            expect(params.display_text).toBeTruthy();
        }
    });

    test("the post-delivery payload uses the post-delivery ids", () => {
        const content = interactive.buildInteractiveContent({
            menu: "POST_DELIVERY",
            bodyText: POST_DELIVERY_MENU_TEXT,
        });

        const ids = content.interactiveMessage.nativeFlowMessage.buttons.map(
            (button) =>
                (JSON.parse(button.buttonParamsJson) as { id: string }).id
        );

        expect(ids).toEqual([
            "delivered_history",
            "delivered_problem",
            "delivered_again",
            "delivered_home",
        ]);
    });

    /*
     * The real protobuf round trip (generateWAMessageFromContent +
     * encode/decode against the actual proto) lives in
     * scripts/verify-whatsapp-interactive-payload.ts.
     *
     * It cannot run here: @whiskeysockets/baileys is ESM-only and this
     * Jest project is CommonJS. That script proves the payload ENCODES —
     * it still does not prove any device renders a button, which only a
     * manual Android/iPhone test can show.
     */
});

/* ==========================================
 * 6. WHICH REPLY IS A MENU
 * ========================================== */

describe("menu detection (which replies may carry buttons)", () => {
    test("the main menu is recognized", () => {
        expect(interactive.menuKindForReply(mainMenu())).toBe("MAIN");
    });

    test("the post-delivery menu is recognized", () => {
        expect(interactive.menuKindForReply(postDeliveryMenu())).toBe(
            "POST_DELIVERY"
        );
    });

    test("a reply that EMBEDS the post-delivery menu is recognized", () => {
        const reply = buildTrackingReply(
            {
                id: ORDER_ID,
                orderNumber: ORDER_NUMBER,
                status: "COMPLETED",
                paymentStatus: "PAID",
                createdAt: mockNow,
                shippingProvider: "MENGANTAR",
                providerCourier: "JNE",
                shippingCourier: "JNE",
                shippingService: "REG",
                trackingNumber: "JNE1234567890",
                trackingUrl: null,
                shipmentStatus: "DELIVERED",
                shippingPaymentStatus: "PAID",
            },
            null
        );

        expect(reply).toContain(postDeliveryMenu());
        expect(interactive.menuKindForReply(reply)).toBe("POST_DELIVERY");
    });

    test("ordinary replies are NOT menus", () => {
        expect(interactive.menuKindForReply(handoffNotice())).toBeNull();
        expect(interactive.menuKindForReply(askOrderNumber())).toBeNull();
        expect(interactive.menuKindForReply("")).toBeNull();
        expect(interactive.menuKindForReply(null)).toBeNull();
    });
});

/* ==========================================
 * 7. PARSER — A TAP BECOMES THE SAME INTENT
 * ========================================== */

describe("a tap is classified as the digit it stands for", () => {
    test("a tap wins over the echoed label text", () => {
        const parsed = parseInboundMessage(
            "📦 Lacak Resi",
            "menu_track"
        );

        expect(parsed.command).toBe("DIGIT");
        expect(parsed.digit).toBe("1");
        expect(parsed.viaButton).toBe(true);
        expect(parsed.nonText).toBe(false);
    });

    test("a tap on the post-delivery menu maps to its own digit", () => {
        expect(
            parseInboundMessage(null, "delivered_history").digit
        ).toBe("1");
        expect(
            parseInboundMessage(null, "delivered_problem").digit
        ).toBe("2");
    });

    test("an unknown id falls through to the text rules", () => {
        const parsed = parseInboundMessage("menu", "not_our_button");

        expect(parsed.command).toBe("MENU");
        expect(parsed.viaButton).toBeUndefined();
    });

    test("typed text is unchanged (no button involved)", () => {
        const parsed = parseInboundMessage("1");

        expect(parsed.command).toBe("DIGIT");
        expect(parsed.digit).toBe("1");
        expect(parsed.viaButton).toBeUndefined();
    });

    test("a tap still cannot turn a draft into a binding", () => {
        const parsed = parseInboundMessage(
            `Nomor Pesanan: ${ORDER_NUMBER}`,
            "menu_track"
        );

        expect(parsed.digit).toBe("1");
        expect(parsed.confirmDraft).toBe(false);
    });
});

/* ==========================================
 * 8. END-TO-END: FLAG OFF vs FLAG ON
 * ========================================== */

describe("delivery with the flag OFF (production default)", () => {
    test("the menu is sent as text and NO interactive message is attempted", async () => {
        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            textMessage("menu"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.interactives).toHaveLength(0);
        expect(sent.texts).toHaveLength(1);
        expect(sent.texts[0].text).toBe(MAIN_MENU_TEXT);
    });
});

describe("delivery with the flag ON", () => {
    beforeEach(() => {
        process.env[FLAG] = "1";
    });

    test("the menu is delivered as ONE interactive message", async () => {
        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            textMessage("menu"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.interactives).toHaveLength(1);
        // Exactly one message reaches the customer — never a duplicate.
        expect(sent.texts).toHaveLength(0);

        const content = sent.interactives[0].content;

        expect(content.interactiveMessage.body.text).toBe(MAIN_MENU_TEXT);
        expect(
            content.interactiveMessage.nativeFlowMessage.buttons
        ).toHaveLength(4);
    });

    test("a REFUSED interactive send falls back to the numbered text", async () => {
        const { deps, sent } = makeDeps({
            sendInteractive: jest.fn(async () => ({
                success: false,
                errorCode: "INTERACTIVE_SEND_FAILED",
            })),
        });

        const result = await handleIncomingMessage(
            textMessage("menu"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.texts).toHaveLength(1);
        expect(sent.texts[0].text).toBe(MAIN_MENU_TEXT);
    });

    test("a THROWING interactive sender still yields the text menu", async () => {
        const { deps, sent } = makeDeps({
            sendInteractive: jest.fn(async () => {
                throw new Error("relay exploded");
            }),
        });

        const result = await handleIncomingMessage(
            textMessage("menu"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.texts).toHaveLength(1);
        expect(sent.texts[0].text).toBe(MAIN_MENU_TEXT);
    });

    test("without an interactive sender installed, text is used", async () => {
        const { deps, sent } = makeDeps();
        delete deps.sendInteractive;

        const result = await handleIncomingMessage(
            textMessage("menu"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.texts).toHaveLength(1);
        expect(sent.texts[0].text).toBe(MAIN_MENU_TEXT);
    });

    test("the post-delivery sub-menu is interactive too", async () => {
        seedVerifiedState();
        mockDb.orders.push(
            orderRow({ status: "COMPLETED", shipmentStatus: "DELIVERED" })
        );

        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_home"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.interactives).toHaveLength(1);
    });
});

/* ==========================================
 * 9. A TAP REUSES THE GUARDED FLOW
 * ========================================== */

describe("taps travel through the existing guards", () => {
    beforeEach(() => {
        process.env[FLAG] = "1";
    });

    test("tapping Lacak Resi without a bound order asks for the order number", async () => {
        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_track"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(deliveredBodies(sent)).toEqual([askOrderNumber()]);
        // Nothing about any order was released.
        expect(deliveredBodies(sent).join(" ")).not.toContain(ORDER_NUMBER);
    });

    test("tapping Status Pesanan is still worthless for someone else's order", async () => {
        // The order belongs to a DIFFERENT phone number.
        mockDb.orders.push(
            orderRow({ phone: OTHER_PHONE_LOCAL })
        );

        /*
         * A moving clock: the customer taps, then types the order
         * number a moment later. The gap matters because the per-chat
         * cooldown suppresses a second reply inside 3 seconds — the
         * anti-flood rule applies to buttons exactly as it does to
         * typed digits.
         */
        let clock = mockNow;

        const { deps, sent } = makeDeps({ now: () => clock });

        const tapResult = await handleIncomingMessage(
            buttonTap("menu_status"),
            deps
        );

        expect(tapResult).toBe("REPLIED");

        clock = new Date(mockNow.getTime() + 10 * 1000);

        const result = await handleIncomingMessage(
            textMessage(ORDER_NUMBER, { id: "TXT-2" }),
            deps
        );

        expect(result).toBe("REPLIED");

        const bodies = deliveredBodies(sent).join("\n");

        expect(bodies).not.toContain("JNE1234567890");
        expect(bodies).not.toContain("STATUS PESANAN");
        // Identical answer to a non-existent order → not an oracle.
        expect(bodies).toContain("tidak menemukan pesanan");
    });

    test("tapping Status Pesanan for the sender's OWN order answers", async () => {
        mockDb.orders.push(orderRow());
        seedVerifiedState();

        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_status"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(deliveredBodies(sent).join("\n")).toContain(
            "STATUS PESANAN"
        );
    });

    test("tapping Hubungi Admin pauses the bot for a human and records it once", async () => {
        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_admin"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(deliveredBodies(sent)).toEqual([handoffNotice()]);

        const row = mockDb.chatStates.get(SENDER_JID);

        expect(row?.state).toBe(CHAT_STATE.HANDOFF);
        expect(row?.pauseUntil).toBeInstanceOf(Date);
        expect(deps.audit).toHaveBeenCalledTimes(1);
    });

    test("tapping Menu Utama re-arms a handed-off chat", async () => {
        seedVerifiedState({
            state: CHAT_STATE.HANDOFF,
            pauseUntil: new Date(mockNow.getTime() + 60 * 60 * 1000),
        });

        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_home"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(deliveredBodies(sent)).toEqual([MAIN_MENU_TEXT]);

        const row = mockDb.chatStates.get(SENDER_JID);

        expect(row?.state).toBe(CHAT_STATE.MENU);
        expect(row?.pauseUntil).toBeNull();
    });

    test("a redelivered tap is deduplicated (one reply, ever)", async () => {
        const { deps, sent } = makeDeps();
        const tap = buttonTap("menu_home", { id: "TAP-DUP" });

        const first = await handleIncomingMessage(tap, deps);
        const second = await handleIncomingMessage(tap, deps);

        expect(first).toBe("REPLIED");
        expect(second).toBe("DUPLICATE");
        expect(deliveredBodies(sent)).toHaveLength(1);
    });

    test("a tap from a group chat is ignored", async () => {
        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_track", { jid: "12345@g.us" }),
            deps
        );

        expect(result).toBe("IGNORED");
        expect(deliveredBodies(sent)).toHaveLength(0);
    });

    test("a tap that is really a fromMe echo is ignored", async () => {
        const { deps, sent } = makeDeps();
        const tap = buttonTap("menu_track");

        tap.key.fromMe = true;

        const result = await handleIncomingMessage(tap, deps);

        expect(result).toBe("IGNORED");
        expect(deliveredBodies(sent)).toHaveLength(0);
    });

    test("the interactive payload leaks no sensitive order data", async () => {
        mockDb.orders.push(
            orderRow({
                status: "COMPLETED",
                shipmentStatus: "DELIVERED",
            })
        );
        seedVerifiedState();

        const { deps, sent } = makeDeps();

        const result = await handleIncomingMessage(
            buttonTap("menu_track"),
            deps
        );

        expect(result).toBe("REPLIED");
        expect(sent.interactives).toHaveLength(1);

        const content = sent.interactives[0].content;

        expect(interactive.menuKindForReply(
            content.interactiveMessage.body.text
        )).not.toBeNull();

        // Everything WhatsApp is handed for this message.
        const wire = JSON.stringify(content);

        expect(wire).not.toContain(ORDER_ADDRESS);
        expect(wire).not.toContain(ORDER_EMAIL);
        expect(wire).not.toContain(ORDER_TOKEN_HASH);
        expect(wire).not.toContain(ORDER_PAYMENT_REF);
        expect(wire).not.toContain(SENDER_PHONE_LOCAL);
        expect(wire).not.toContain(SENDER_PHONE_NORMALIZED);
        expect(wire).not.toContain("@");
        expect(wire).not.toContain("s.whatsapp.net");

        // …while the customer still gets the menus they can act on.
        expect(content.interactiveMessage.body.text).toContain(
            POST_DELIVERY_MENU_TEXT
        );
    });
});

/* ==========================================
 * 10. ONE SOCKET, NO SECOND SESSION
 * ========================================== */

describe("the interactive layer never opens a second session", () => {
    const source = fs.readFileSync(
        path.join(process.cwd(), "lib/whatsapp/service.ts"),
        "utf8"
    );

    test("exactly one socket is ever created", () => {
        const calls = source.match(/makeWASocket\(/g) ?? [];

        expect(calls).toHaveLength(1);
    });

    test("the interactive send reuses the existing socket reference", () => {
        const start = source.indexOf("sendInteractiveMessage");

        expect(start).toBeGreaterThan(-1);

        const body = source.slice(start, start + 3000);

        expect(body).toContain("this.socket.relayMessage");
        expect(body).toContain("generateWAMessageFromContent");
        expect(body).not.toContain("makeWASocket(");
    });
});
