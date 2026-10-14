/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — INBOUND ORCHESTRATOR
 * ==========================================================
 *
 * The single entry point wired to the EXISTING Baileys session
 * (`messages.upsert` in lib/whatsapp/service.ts). There is no second
 * socket, no second auth directory and no separate polling process.
 *
 * REQUEST PIPELINE (in order, and the order matters)
 *
 *   1. envelope sanity   — must have a message id and a chat JID
 *   2. self / group filter — `fromMe`, groups, status broadcasts,
 *                            newsletters are dropped (a manual admin
 *                            reply is a `fromMe` message, which is what
 *                            keeps the bot from interrupting a human)
 *   3. age filter        — replayed history is never answered
 *   4. intent parsing    — pure text classification, PLUS an interactive
 *                          button tap mapped by its stable id onto the
 *                          SAME digit the customer could have typed,
 *                          PLUS the plain tracking words ("resi",
 *                          "lacak", "tracking") mapped onto menu key 1
 *   5. dedupe claim      — BEFORE any reply, keyed by message id
 *   6. decision          — state machine + order lookup
 *   7. send              — plain text, and (only when explicitly
 *                          enabled) an interactive menu as an ADDITION
 *   8. persist           — state only after the provider ACCEPTED it
 *
 * INTERACTIVE BUTTONS ARE ADDITIVE AND OFF BY DEFAULT
 *
 *   Baileys 7.x has no supported send-side API for interactive
 *   messages, so buttons are attempted only when
 *   WHATSAPP_INTERACTIVE_BUTTONS is explicitly enabled, and the
 *   numbered text menu is still the interface: every menu message
 *   carries the full numbered list, and a refused/failed interactive
 *   send silently degrades to that text.
 *
 * FAIL-CLOSED POSTURE
 *
 *   * An order is only ever bound when the SENDER'S WhatsApp number
 *     matches `Order.phone`. An order number alone unlocks nothing.
 *   * "No such order" and "not your order" produce the SAME answer, so
 *     the bot is not an order-number oracle.
 *   * When the sender number cannot be derived (LID addressing), the
 *     customer is redirected to the website instead of being shown
 *     anything.
 *   * Tracking is READ-ONLY: no order/shipment field is ever written by
 *     this pipeline. The official tracking page link (./tracking-url)
 *     does not weaken that: it carries at most an order-number PREFILL
 *     hint, and only on a path where this chat was already matched to
 *     the order.
 *   * Nothing here throws to the Baileys emitter: every failure is
 *     caught, counted and (at most) logged with a short code — never
 *     with the customer's message body.
 */

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import {
    extractSenderPhones,
    isCustomerChatJid,
    maskChatJid,
    orderPhoneMatches,
} from "./identity";
import {
    extractText,
    parseInboundMessage,
    readMessageTimestampMs,
    MAX_INBOUND_MESSAGE_AGE_MS,
    type MenuDigit,
    type ParsedInbound,
} from "./parse";
import * as interactive from "./interactive";
import * as menu from "./menu";
import {
    buildHistoryReply,
    buildStatusReply,
    buildTrackingReply,
    isDelivered,
    isTerminalOrderState,
    type BotOrder,
} from "./replies";
import {
    loadTrackingView,
    type TrackingView,
} from "./tracking";
import * as chatState from "./state";
import { CHAT_STATE } from "./state";
import {
    buildOrderTrackingUrl,
    OFFICIAL_TRACKING_PAGE_URL,
} from "./tracking-url";

/* ==========================================
 * ACTOR / LIMITS
 * ========================================== */

/** Audit actor for bot-generated handoffs (there is no admin session). */
export const BOT_AUDIT_ACTOR = "system:whatsapp-auto-reply";

/**
 * The ONLY order columns this pipeline may read.
 *
 * `phone` is included because ownership binding — and the RajaOngkir
 * `last_phone_number` parameter — require it. It is NEVER printed,
 * never returned and never logged.
 */
const ORDER_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    paymentStatus: true,
    createdAt: true,
    shippingProvider: true,
    providerCourier: true,
    shippingCourier: true,
    shippingService: true,
    trackingNumber: true,
    trackingUrl: true,
    shipmentStatus: true,
    shippingPaymentStatus: true,
    phone: true,
} as const;

type OrderRow = BotOrder & { phone: string | null };

export type SendResult = {
    success: boolean;
    errorCode?: string;
};

/**
 * Injectable seams. Production uses the real Baileys singleton; tests
 * drive the whole pipeline without a WhatsApp connection.
 */
export type BotDeps = {
    send: (jid: string, text: string) => Promise<SendResult>;
    /**
     * OPTIONAL interactive (native flow) sender.
     *
     * Absent → the pipeline simply never attempts a button, which is the
     * default posture. Present → it is used only when the feature flag is
     * explicitly enabled, and any non-success answer falls back to
     * `send`.
     */
    sendInteractive?: (
        jid: string,
        content: interactive.WhatsAppInteractiveContent
    ) => Promise<SendResult>;
    now: () => Date;
    loadTracking: (
        order: Parameters<typeof loadTrackingView>[0],
        options?: { useCache?: boolean }
    ) => Promise<TrackingView>;
    /**
     * Official tracking page link for a reply.
     *
     * Absent → the real builder (./tracking-url) is used, which returns
     * null whenever no trustworthy origin is configured and then leaves
     * every reply with its previous text-only wording. Callers pass an
     * order number ONLY after `bindOrder` proved the sender owns it.
     */
    trackingUrl?: (
        orderNumber?: string | null
    ) => string | null;
    audit: typeof createAuditLog;
};

export type HandledResult =
    | "REPLIED"
    | "IGNORED"
    | "DUPLICATE"
    | "EXHAUSTED"
    | "SUPPRESSED"
    | "FAILED";

const defaultDeps: BotDeps = {
    async send(jid, text) {
        /*
         * Dynamic import keeps Baileys out of any static dependency
         * graph that reaches this module (the same pattern the
         * notification provider and admin-number module already use).
         */
        const { getWhatsAppService } = await import(
            "@/lib/whatsapp/service"
        );

        return getWhatsAppService().sendMessage(jid, text);
    },
    async sendInteractive(jid, content) {
        const { getWhatsAppService } = await import(
            "@/lib/whatsapp/service"
        );

        return getWhatsAppService().sendInteractiveMessage(
            jid,
            content
        );
    },
    now: () => new Date(),
    loadTracking: (order, options) =>
        loadTrackingView(order, options),
    trackingUrl: (orderNumber) =>
        buildOrderTrackingUrl(orderNumber),
    audit: createAuditLog,
};

/**
 * Resolve the tracking page link through the injected seam so tests can
 * drive both the linked and the unlinked wording without touching the
 * environment.
 */
function trackingLinkFor(
    deps: BotDeps,
    orderNumber?: string | null
): string | null {
    const resolve = deps.trackingUrl ?? buildOrderTrackingUrl;

    try {
        return resolve(orderNumber) ?? null;
    } catch {
        /*
         * A link is a nice-to-have: if building it ever fails, the reply
         * must still be sent (text-only) instead of dropping the
         * customer's message.
         */
        return null;
    }
}

/* ==========================================
 * THROTTLED INFRASTRUCTURE LOGGING
 * ========================================== */

const INFRA_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;
let lastInfraErrorAt = 0;

/** Test hook. */
export function resetInfraErrorThrottle(): void {
    lastInfraErrorAt = 0;
}

/**
 * Log an infrastructure failure at most once per interval.
 *
 * Deliberately logs the ERROR, never the payload: no customer text, no
 * phone number, no order number, no token.
 */
function logInfraError(error: unknown): void {
    const now = Date.now();

    if (now - lastInfraErrorAt < INFRA_ERROR_LOG_INTERVAL_MS) {
        return;
    }

    lastInfraErrorAt = now;

    console.error(
        "[WHATSAPP BOT] Inbound handling failed:",
        error instanceof Error ? error.message : error
    );
}

function errorCodeOf(error: unknown): string {
    if (error && typeof error === "object") {
        const code = (error as { code?: unknown }).code;

        if (typeof code === "string" && code) {
            return code;
        }
    }

    return "HANDLER_ERROR";
}

function asObject(
    value: unknown
): Record<string, unknown> | null {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
}

/* ==========================================
 * ENTRY POINT — WIRED TO messages.upsert
 * ========================================== */

/**
 * Handle a batch of inbound messages from Baileys.
 *
 * Never rejects: one bad message can neither stop the batch nor reach
 * the socket emitter.
 */
export async function handleIncomingMessages(
    messages: unknown,
    deps: Partial<BotDeps> = {}
): Promise<void> {
    const resolved: BotDeps = { ...defaultDeps, ...deps };
    const batch = Array.isArray(messages) ? messages : [];

    if (batch.length === 0) {
        return;
    }

    for (const message of batch) {
        try {
            await handleIncomingMessage(message, resolved);
        } catch (error) {
            logInfraError(error);
        }
    }

    // Best effort, never on the reply path.
    void chatState.cleanupInboundMessages(resolved.now());
    void chatState.cleanupChatStates(resolved.now());
}

/**
 * Handle ONE inbound Baileys message.
 */
export async function handleIncomingMessage(
    message: unknown,
    deps: Partial<BotDeps> = {}
): Promise<HandledResult> {
    const resolved: BotDeps = { ...defaultDeps, ...deps };

    const envelope = asObject(message);
    const key = asObject(envelope?.key);

    const messageId =
        typeof key?.id === "string" ? key.id : null;
    const chatId =
        typeof key?.remoteJid === "string"
            ? key.remoteJid
            : null;

    /* ---- 1. envelope sanity ---- */
    if (!messageId || !chatId) {
        return "IGNORED";
    }

    /* ---- 2. never answer ourselves, groups or broadcasts ---- */
    if (key?.fromMe === true) {
        return "IGNORED";
    }

    if (!isCustomerChatJid(chatId)) {
        return "IGNORED";
    }

    /* ---- 3. replayed history is not a live request ---- */
    const now = resolved.now();
    const timestampMs = readMessageTimestampMs(
        envelope?.messageTimestamp
    );

    if (
        timestampMs !== null &&
        now.getTime() - timestampMs >
            MAX_INBOUND_MESSAGE_AGE_MS
    ) {
        return "IGNORED";
    }

    /* ---- 4. intent ---- */
    const parsed = parseInboundMessage(
        extractText(envelope?.message),
        /*
         * A tap carries the id WE generated, so it is read from the
         * envelope and mapped onto the identical menu digit — the click
         * is not a second, less-guarded way into the flow.
         */
        interactive.readButtonId(envelope?.message)
    );

    /* ---- 5. dedupe claim (before any reply) ---- */
    let claim: chatState.InboundClaimResult;

    try {
        claim = await chatState.claimInboundMessage({
            messageId,
            chatId,
            now,
        });
    } catch (error) {
        /*
         * FAIL CLOSED: without a durable claim we could answer the same
         * message twice, so we answer nothing at all. (This is also what
         * happens before the migration is applied.)
         */
        logInfraError(error);
        return "FAILED";
    }

    if (claim === "DUPLICATE") {
        return "DUPLICATE";
    }

    if (claim === "EXHAUSTED") {
        return "EXHAUSTED";
    }

    /* ---- 6-8. decide → send → persist ---- */
    try {
        const outcome = await process({
            chatId,
            messageId,
            key,
            parsed,
            now,
            deps: resolved,
        });

        if (outcome === "FAILED") {
            return "FAILED";
        }

        /*
         * Anything that reached a deliberate conclusion is DONE:
         * replied, deliberately silent (handoff/paused/budget), or
         * intentionally ignored. Only a real failure stays re-claimable.
         */
        await chatState.markInboundDone(messageId, now);

        return outcome;
    } catch (error) {
        await chatState
            .markInboundFailed(messageId, errorCodeOf(error))
            .catch(() => undefined);

        logInfraError(error);

        return "FAILED";
    }
}

/* ==========================================
 * PROCESSING
 * ========================================== */

async function process(input: {
    chatId: string;
    messageId: string;
    key: Record<string, unknown> | null;
    parsed: ParsedInbound;
    now: Date;
    deps: BotDeps;
}): Promise<HandledResult> {
    const { chatId, messageId, key, parsed, now, deps } = input;

    const senderPhones = extractSenderPhones(key);

    const state = await chatState.loadChatState(chatId, now);

    const decision = await decide({
        chatId,
        senderPhones,
        parsed,
        state,
        now,
        deps,
    });

    if (!decision.reply) {
        await chatState.persistChatState({
            state,
            patch: decision.patch,
            now,
            replied: false,
        });

        return "IGNORED";
    }

    /*
     * Anti-flood: cooldown and the per-chat budget suppress the SEND
     * (the state still advances, so the customer's last command is
     * honoured if they simply repeat it).
     */
    if (
        chatState.isCooldownActive(state, now) ||
        chatState.isReplyBudgetExhausted(state, now)
    ) {
        await chatState.persistChatState({
            state,
            patch: decision.patch,
            now,
            replied: false,
        });

        return "SUPPRESSED";
    }

    const sent = await deliver({
        deps,
        chatId,
        reply: decision.reply,
    });

    if (!sent?.success) {
        /*
         * The customer never received it → this message stays
         * re-claimable and the state is left untouched, so a
         * re-delivery answers correctly.
         */
        await chatState
            .markInboundFailed(
                messageId,
                sent?.errorCode ?? "SEND_FAILED"
            )
            .catch(() => undefined);

        return "FAILED";
    }

    try {
        await chatState.persistChatState({
            state,
            patch: decision.patch,
            now,
            replied: true,
        });
    } catch (error) {
        /*
         * The customer ALREADY received this reply. Failing the message
         * now would let a re-delivery send it a second time, so the
         * state write is allowed to fail here (and is logged) instead of
         * turning a delivered reply into a retry.
         */
        logInfraError(error);
    }

    return "REPLIED";
}

/* ==========================================
 * DELIVERY (TEXT ALWAYS, BUTTONS OPTIONALLY)
 * ========================================== */

/**
 * Deliver one reply through the existing singleton session.
 *
 * The numbered text is ALWAYS the customer's safety net, so:
 *
 *   flag off                          → plain text (default),
 *   flag on + accepted               → interactive menu (whose body IS
 *                                       the complete numbered text),
 *   flag on + refused/failed/absent  → plain text.
 *
 * An interactive attempt is never retried and never throws: a button
 * WhatsApp refuses must not become a repeated message in the chat, and
 * must not fail the inbound message (the customer still gets the menu).
 */
async function deliver(input: {
    deps: BotDeps;
    chatId: string;
    reply: string;
}): Promise<SendResult> {
    const { deps, chatId, reply } = input;

    const menu = interactive.menuKindForReply(reply);

    if (
        menu &&
        deps.sendInteractive &&
        interactive.isInteractiveButtonsEnabled()
    ) {
        let attempt: SendResult | null = null;

        try {
            attempt = await deps.sendInteractive(
                chatId,
                interactive.buildInteractiveContent({
                    menu,
                    bodyText: reply,
                })
            );
        } catch (error) {
            logInfraError(error);
        }

        if (attempt?.success) {
            return attempt;
        }
    }

    return deps.send(chatId, reply);
}

/* ==========================================
 * DECISION
 * ========================================== */

type Decision = {
    reply: string | null;
    patch: chatState.ChatStatePatch;
};

type DecideInput = {
    chatId: string;
    senderPhones: string[];
    parsed: ParsedInbound;
    state: chatState.ChatState;
    now: Date;
    deps: BotDeps;
};

function patchOf(
    ...patches: chatState.ChatStatePatch[]
): chatState.ChatStatePatch {
    return Object.assign({}, ...patches);
}

async function decide(
    input: DecideInput
): Promise<Decision> {
    const { parsed, state, now } = input;

    const silence: Decision = { reply: null, patch: {} };

    /* ---- Lockout: stay silent, by design ---- */
    if (chatState.isBlocked(state, now)) {
        return silence;
    }

    /*
     * Handoff window: a human admin owns this chat. Only an explicit
     * menu request re-arms the bot; everything else gets NO answer
     * (silence is what stops the bot from talking over the admin).
     */
    if (chatState.isPaused(state, now)) {
        /*
         * Only an EXPLICIT menu request re-arms the bot: a plain
         * greeting ("halo") must not make it talk over the admin who is
         * answering this customer right now.
         */
        const wantsMenu =
            parsed.explicitMenu === true ||
            (parsed.command === "DIGIT" && parsed.digit === "0");

        if (!wantsMenu) {
            return silence;
        }

        return {
            reply: menu.mainMenu(),
            patch: {
                state: CHAT_STATE.MENU,
                pauseUntil: null,
                pendingIntent: null,
            },
        };
    }

    /* A handoff whose window lapsed resumes normal serving. */
    const resumePatch: chatState.ChatStatePatch =
        state.state === CHAT_STATE.HANDOFF
            ? {
                  state: CHAT_STATE.IDLE,
                  pauseUntil: null,
                  pendingIntent: null,
              }
            : {};

    /*
     * ---- Website confirmation draft ----
     *
     * The customer tapped the button on their order page. They get the
     * welcome menu; the draft's order is bound in the background ONLY
     * when the sender's number matches, and a failed attempt is counted
     * but never disclosed (no order-number oracle). The status written
     * inside the draft is ignored outright — see parse.ts.
     */
    if (parsed.command === "ORDER_NUMBER" && parsed.confirmDraft) {
        const bind = await bindOrder(
            parsed.orderNumber,
            input.senderPhones
        );

        if (bind.ok) {
            return {
                reply: menu.mainMenu(),
                patch: patchOf(resumePatch, {
                    state: CHAT_STATE.MENU,
                    verifiedOrderId: bind.order.id,
                    verifiedAt: now,
                    pendingIntent: null,
                    failedBindAttempts: 0,
                }),
            };
        }

        /*
         * A failed draft is counted EXACTLY like a failed manual order
         * number — sharing the same bounded counter and the same lockout.
         * Otherwise pasting drafts repeatedly would sidestep the abuse
         * control that typing order numbers is subject to.
         */
        return {
            reply: menu.mainMenu(),
            patch: patchOf(
                resumePatch,
                {
                    state: CHAT_STATE.MENU,
                    pendingIntent: null,
                },
                failedBindPatch(state, now)
            ),
        };
    }

    /* ---- Menu / cancel ---- */
    if (parsed.command === "MENU") {
        return {
            reply: menu.mainMenu(),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                pendingIntent: null,
            }),
        };
    }

    if (parsed.command === "CANCEL") {
        return {
            reply: menu.mainMenu(),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                verifiedOrderId: null,
                verifiedAt: null,
                pendingIntent: null,
            }),
        };
    }

    /* ---- A bare order number ---- */
    if (parsed.command === "ORDER_NUMBER") {
        return handleOrderNumber(input);
    }

    /* ---- Menu keys ---- */
    if (parsed.command === "DIGIT" && parsed.digit) {
        return handleDigit(input, parsed.digit);
    }

    /* ---- Complaint / ask for a human ---- */
    if (parsed.command === "COMPLAINT") {
        return handoff(input, {
            complaint: true,
            resumePatch,
        });
    }

    /* ---- Plain tracking words ("resi", "lacak", "tracking") ---- */
    if (parsed.command === "TRACK") {
        /*
         * Identical to menu key "1": the same instruction + official
         * tracking page hand-off. A typed word therefore reaches no
         * tracking data at all — it merely gets the customer to the
         * page that is built for it.
         *
         * parse.ts classifies COMPLAINT before TRACK, so a problem report
         * that happens to mention a resi still reaches a human.
         */
        return handleDigit(input, "1");
    }

    /* ---- Everything else ---- */
    if (parsed.nonText) {
        return {
            reply: menu.nonTextHint(),
            patch: {},
        };
    }

    if (state.state === CHAT_STATE.IDLE) {
        return {
            reply: menu.mainMenu(),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                pendingIntent: null,
            }),
        };
    }

    return { reply: menu.unknownCommand(), patch: {} };
}

/* ==========================================
 * MENU KEYS
 * ========================================== */

async function handleDigit(
    input: DecideInput,
    digit: MenuDigit
): Promise<Decision> {
    const { state, now } = input;

    const resumePatch: chatState.ChatStatePatch =
        state.state === CHAT_STATE.HANDOFF
            ? {
                  state: CHAT_STATE.IDLE,
                  pauseUntil: null,
              }
            : {};

    /* ---- 0. Menu Utama ---- */
    if (digit === "0") {
        return {
            reply: menu.mainMenu(),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                pendingIntent: null,
            }),
        };
    }

    /* ---- 3. Hubungi Admin ---- */
    if (digit === "3") {
        return handoff(input, {
            complaint: false,
            resumePatch,
        });
    }

    const boundOrder = await loadBoundOrder(input);

    /* ==========================================
     * Post-delivery sub-menu (delivered / completed)
     * ========================================== */
    if (state.state === CHAT_STATE.VERIFIED_DELIVERED) {
        if (digit === "1") {
            if (!boundOrder) {
                return askForOrderNumber(
                    input,
                    resumePatch,
                    "TRACK"
                );
            }

            /*
             * The ONLY place a terminal shipment triggers a provider
             * read — and only because the customer explicitly asked for
             * the delivery history.
             */
            const view = await input.deps.loadTracking(
                boundOrder,
                { useCache: false }
            );

            return {
                reply: buildHistoryReply(boundOrder, view, {
                    trackUrl: trackingLinkFor(
                        input.deps,
                        boundOrder.orderNumber
                    ),
                }),
                patch: patchOf(resumePatch, {
                    state: CHAT_STATE.VERIFIED_DELIVERED,
                    verifiedOrderId: boundOrder.id,
                    verifiedAt: now,
                }),
            };
        }

        if (digit === "2") {
            return handoff(input, {
                complaint: true,
                resumePatch,
                order: boundOrder,
            });
        }

        if (digit === "3") {
            return {
                reply: menu.shopAgain(),
                patch: patchOf(resumePatch, {
                    state: CHAT_STATE.VERIFIED_DELIVERED,
                }),
            };
        }
    }

    /* ==========================================
     * 1. Lacak Resi — TRACKING PAGE HAND-OFF
     * ==========================================
     *
     * The bot no longer collects a resi (or an order number) on this
     * key. The reply is the SAME instruction + official tracking page
     * link in EVERY state, so this menu key discloses nothing about any
     * order and cannot be used as an oracle: nothing is matched, no
     * binding is attempted and no courier call is made here.
     *
     * Order-bound tracking stays reachable ONLY through the paths that
     * already guard it: "2. Status Pesanan" (ownership-verified reply)
     * and a bare order number typed by the customer — both still go
     * through `trackingDecision`/`bindOrder` unchanged. The website
     * keeps the full order-number + OTP recovery (app/lacak).
     */
    if (digit === "1") {
        return {
            reply: menu.trackingInstruction(
                trackingLinkFor(input.deps) ??
                    OFFICIAL_TRACKING_PAGE_URL
            ),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                pendingIntent: null,
            }),
        };
    }

    /* ==========================================
     * 2. Status Pesanan
     * ========================================== */
    if (digit === "2") {
        if (!boundOrder) {
            return askForOrderNumber(
                input,
                resumePatch,
                "STATUS"
            );
        }

        return {
            reply: buildStatusReply(boundOrder, {
                trackUrl: trackingLinkFor(
                    input.deps,
                    boundOrder.orderNumber
                ),
            }),
            patch: patchOf(resumePatch, {
                state: state.state === CHAT_STATE.VERIFIED_DELIVERED
                    ? CHAT_STATE.VERIFIED_DELIVERED
                    : CHAT_STATE.VERIFIED_TRACKING,
                verifiedOrderId: boundOrder.id,
                verifiedAt: now,
            }),
        };
    }

    return { reply: menu.unknownCommand(), patch: {} };
}

/** The customer picked a service but no order is bound (yet). */
function askForOrderNumber(
    input: DecideInput,
    resumePatch: chatState.ChatStatePatch,
    intent: chatState.PendingIntent = "TRACK"
): Decision {
    return {
        /*
         * Nothing is verified for this chat yet, so the link is the BARE
         * tracking page: no order number may be attached to it.
         */
        reply: menu.askOrderNumber(
            trackingLinkFor(input.deps)
        ),
        patch: patchOf(resumePatch, {
            state: CHAT_STATE.AWAITING_ORDER,
            pendingIntent: intent,
        }),
    };
}

async function handleOrderNumber(
    input: DecideInput
): Promise<Decision> {
    const { parsed, state, now } = input;

    const resumePatch: chatState.ChatStatePatch =
        state.state === CHAT_STATE.HANDOFF
            ? {
                  state: CHAT_STATE.IDLE,
                  pauseUntil: null,
                  pendingIntent: null,
              }
            : {};

    const bind = await bindOrder(
        parsed.orderNumber,
        input.senderPhones
    );

    if (bind.ok) {
        const intent = state.pendingIntent ?? "TRACK";

        if (intent === "STATUS") {
            return {
                reply: buildStatusReply(bind.order, {
                    trackUrl: trackingLinkFor(
                        input.deps,
                        bind.order.orderNumber
                    ),
                }),
                patch: patchOf(resumePatch, {
                    state: CHAT_STATE.VERIFIED_TRACKING,
                    verifiedOrderId: bind.order.id,
                    verifiedAt: now,
                    pendingIntent: null,
                    failedBindAttempts: 0,
                }),
            };
        }

        return trackingDecision(
            input,
            bind.order,
            resumePatch,
            { verifiedOrderId: bind.order.id }
        );
    }

    /*
     * No sender number to verify against (LID addressing): answer
     * honestly and do NOT burn an attempt — it is not the customer's
     * fault that their chat carries no phone number.
     */
    if (input.senderPhones.length === 0) {
        return {
            reply: menu.unverifiableSender(
                trackingLinkFor(input.deps)
            ),
            patch: patchOf(resumePatch, {
                state: CHAT_STATE.MENU,
                pendingIntent: null,
            }),
        };
    }

    const failure = failedBindPatch(state, now);

    if (failure.blockedUntil !== undefined) {
        return {
            reply: menu.tooManyAttempts(),
            patch: patchOf(resumePatch, failure),
        };
    }

    return {
        /*
         * Ownership was NOT proven for the submitted order number, so the
         * link stays bare: attaching that number to the page URL would
         * turn the reply into a hint about somebody else's order.
         */
        reply: menu.orderNotFound(
            trackingLinkFor(input.deps)
        ),
        patch: patchOf(
            resumePatch,
            {
                state: CHAT_STATE.AWAITING_ORDER,
                pendingIntent: state.pendingIntent,
            },
            failure
        ),
    };
}

/**
 * The counter patch for ONE failed order binding.
 *
 * Shared by the website-draft path and the manual order-number path, so
 * abuse control is identical no matter how the customer submits an order
 * number: the counter is bounded and reaching MAX_FAILED_BINDS applies
 * the same temporary lockout (during which the bot stays silent).
 */
function failedBindPatch(
    state: chatState.ChatState,
    now: Date
): chatState.ChatStatePatch {
    const attempts = state.failedBindAttempts + 1;

    if (attempts >= chatState.MAX_FAILED_BINDS) {
        return {
            state: CHAT_STATE.IDLE,
            verifiedOrderId: null,
            verifiedAt: null,
            pendingIntent: null,
            failedBindAttempts: 0,
            blockedUntil: new Date(
                now.getTime() + chatState.BIND_LOCKOUT_MS
            ),
        };
    }

    return { failedBindAttempts: attempts };
}

/* ==========================================
 * TRACKING
 * ========================================== */

async function trackingDecision(
    input: DecideInput,
    order: OrderRow,
    resumePatch: chatState.ChatStatePatch,
    extraPatch: chatState.ChatStatePatch = {}
): Promise<Decision> {
    const { now } = input;

    /*
     * FINAL shipments are answered from stored state only: re-polling a
     * parcel that is already delivered/returned/cancelled would cost a
     * provider call and could not add anything. The explicit "Lihat
     * Riwayat Pengiriman" action still refreshes on demand.
     */
    const terminal = isTerminalOrderState(order);

    const view = terminal
        ? null
        : await input.deps.loadTracking(order, {
              useCache: true,
          });

    return {
        reply: buildTrackingReply(order, view, {
            trackUrl: trackingLinkFor(
                input.deps,
                order.orderNumber
            ),
        }),
        patch: patchOf(resumePatch, {
            state:
                isDelivered(order) ||
                order.status === "COMPLETED"
                    ? CHAT_STATE.VERIFIED_DELIVERED
                    : CHAT_STATE.VERIFIED_TRACKING,
            verifiedOrderId: order.id,
            verifiedAt: now,
            pendingIntent: null,
            failedBindAttempts: 0,
        }, extraPatch),
    };
}

/* ==========================================
 * HANDOFF
 * ========================================== */

async function handoff(
    input: DecideInput,
    options: {
        complaint: boolean;
        resumePatch: chatState.ChatStatePatch;
        order?: OrderRow | null;
    }
): Promise<Decision> {
    const { chatId, state, now, deps } = input;

    const order =
        options.order ??
        (chatState.isBindingValid(state, now)
            ? await loadBoundOrder(input)
            : null);

    const reply = options.complaint
        ? menu.complaintHandoffNotice({
              deliveredPerCourier: order
                  ? isDelivered(order)
                  : false,
          })
        : menu.handoffNotice();

    /*
     * Handoff is also a safety valve: the bot stops answering until the
     * window lapses (or the customer explicitly asks for the menu), so
     * a human admin owns the conversation from here.
     */
    const patch = patchOf(options.resumePatch, {
        state: CHAT_STATE.HANDOFF,
        pauseUntil: new Date(
            now.getTime() + chatState.HANDOFF_PAUSE_MS
        ),
        pendingIntent: null,
    });

    notifyHandoff({
        chatId,
        complaint: options.complaint,
        order,
        deps,
    });

    return { reply, patch };
}

/**
 * Record a pending handoff for the admin panel.
 *
 * This is the whole "ticket system": one AdminAuditLog row surfaced by
 * /api/admin/whatsapp/handoffs. No customer message content is stored,
 * and only a MASKED chat label is kept.
 */
function notifyHandoff(input: {
    chatId: string;
    complaint: boolean;
    order: OrderRow | null;
    deps: BotDeps;
}): void {
    const { chatId, complaint, order, deps } = input;

    const params = {
        adminId: BOT_AUDIT_ACTOR,
        action: "WHATSAPP_HANDOFF" as const,
        entityType: (order ? "Order" : "WhatsAppChat") as
            | "Order"
            | "WhatsAppChat",
        ...(order ? { entityId: order.id } : {}),
        description: complaint
            ? "Pelanggan melaporkan kendala melalui balasan otomatis WhatsApp; menunggu admin."
            : "Pelanggan meminta bantuan admin melalui balasan otomatis WhatsApp.",
        metadata: {
            source: "WHATSAPP_AUTO_REPLY",
            chat: maskChatJid(chatId),
            reason: complaint ? "COMPLAINT" : "MENU_HANDOFF",
            orderNumber: order?.orderNumber ?? null,
        },
    };

    try {
        const pending = deps.audit(params) as unknown;

        if (
            pending &&
            typeof (pending as Promise<void>).catch ===
                "function"
        ) {
            (pending as Promise<void>).catch(() => undefined);
        }
    } catch {
        /*
         * An audit failure must never break a customer reply (and
         * createAuditLog already swallows its own errors).
         */
    }
}

/* ==========================================
 * ORDER LOOKUP / BINDING
 * ========================================== */

type BindResult =
    | { ok: true; order: OrderRow }
    | { ok: false };

/**
 * Resolve an order number to an order THIS SENDER owns.
 *
 * `Order.phone` is compared AFTER normalization (in code, not in SQL) so
 * legacy rows stored in another format still match, and so a row can
 * only ever be reached through the sender's own number.
 */
async function bindOrder(
    orderNumber: string | undefined,
    senderPhones: string[]
): Promise<BindResult> {
    if (!orderNumber || senderPhones.length === 0) {
        return { ok: false };
    }

    const order = (await prisma.order.findFirst({
        where: { orderNumber },
        select: ORDER_SELECT,
    })) as OrderRow | null;

    if (!order) {
        return { ok: false };
    }

    if (!orderPhoneMatches(senderPhones, order.phone)) {
        return { ok: false };
    }

    return { ok: true, order };
}

/**
 * Re-read the order this chat is bound to, re-verifying ownership.
 *
 * Re-reading on every request is what keeps an old message from showing
 * an old status (§ requirement), and re-checking the phone means a
 * binding can never outlive the identity it was granted to.
 */
async function loadBoundOrder(
    input: DecideInput
): Promise<OrderRow | null> {
    const { state, now } = input;

    if (!chatState.isBindingValid(state, now)) {
        return null;
    }

    const order = (await prisma.order.findFirst({
        where: { id: state.verifiedOrderId as number },
        select: ORDER_SELECT,
    })) as OrderRow | null;

    if (!order) {
        return null;
    }

    if (!orderPhoneMatches(input.senderPhones, order.phone)) {
        return null;
    }

    return order;
}
