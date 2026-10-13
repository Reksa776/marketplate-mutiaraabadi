/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — CONVERSATION STATE, DEDUPE, RATE LIMITS
 * ==========================================================
 *
 * All mutable bot state lives in the database, NOT in a module-level
 * object, and that is deliberate:
 *
 *   * a PM2 reload / deploy must not resurrect a handoff (the bot would
 *     otherwise start interrupting a human admin mid-conversation),
 *   * a re-delivered message must not be answered twice, even across a
 *     restart,
 *   * the per-chat reply budget must survive a crash loop, so a
 *     misbehaving chat cannot reset its own allowance by forcing one.
 *
 * EVERY window is an explicit timestamp (cooldown, reply budget,
 * handoff pause, lockout, conversation TTL), so there is no hidden
 * "session" state anywhere.
 *
 * The inbound ledger is TWO-PHASE (see prisma/schema.prisma):
 * a claim row is created BEFORE the reply is sent, and only marked DONE
 * once the provider ACCEPTED the message. A failed attempt is marked
 * FAILED, which lets a re-delivery try again — a message must never be
 * lost permanently merely because its id was recorded.
 */

import { prisma } from "@/lib/prisma";

/* ==========================================
 * STATE VALUES
 * ========================================== */

export const CHAT_STATE = {
    IDLE: "IDLE",
    MENU: "MENU",
    AWAITING_ORDER: "AWAITING_ORDER",
    VERIFIED_TRACKING: "VERIFIED_TRACKING",
    VERIFIED_DELIVERED: "VERIFIED_DELIVERED",
    HANDOFF: "HANDOFF",
} as const;

export type ChatBotState =
    (typeof CHAT_STATE)[keyof typeof CHAT_STATE];

export type PendingIntent = "TRACK" | "STATUS";

/* ==========================================
 * WINDOWS
 * ========================================== */

/** How long a menu / awaiting-order flow stays "open". */
export const CONVERSATION_TTL_MS = 15 * 60 * 1000;

/** How long a phone-verified order binding stays usable. */
export const VERIFIED_TTL_MS = 30 * 60 * 1000;

/** Bot silence after a handoff to a human admin. */
export const HANDOFF_PAUSE_MS = 120 * 60 * 1000;

/** Lockout after repeated failed order bindings. */
export const BIND_LOCKOUT_MS = 30 * 60 * 1000;

/** Failed bindings tolerated before the lockout. */
export const MAX_FAILED_BINDS = 5;

/** Minimum gap between two bot replies in the same chat. */
export const REPLY_COOLDOWN_MS = 3000;

/** Replies allowed per chat per window (anti-flood). */
export const MAX_REPLIES_PER_WINDOW = 20;
export const REPLY_WINDOW_MS = 60 * 60 * 1000;

/** Delivery attempts per inbound message before giving up. */
export const MAX_INBOUND_ATTEMPTS = 3;

/** A PROCESSING claim older than this is treated as crashed. */
export const STALE_CLAIM_MS = 2 * 60 * 1000;

/** How long inbound ledger rows are kept (opportunistic cleanup). */
export const INBOUND_RETENTION_MS = 60 * 60 * 1000;

/**
 * How long an IDLE chat's state row is kept before it is dropped.
 *
 * Deliberately orders of magnitude larger than the longest live window
 * (HANDOFF_PAUSE_MS = 2 hours), so cleanup can never expire a handoff or
 * a lockout that is still in force — it only removes conversations that
 * ended long ago.
 */
export const CHAT_STATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/* ==========================================
 * STATE SHAPE
 * ========================================== */

export type ChatState = {
    chatId: string;
    state: ChatBotState;
    verifiedOrderId: number | null;
    verifiedAt: Date | null;
    pendingIntent: PendingIntent | null;
    pauseUntil: Date | null;
    blockedUntil: Date | null;
    failedBindAttempts: number;
    replyCount: number;
    windowStartedAt: Date | null;
    lastActivityAt: Date;
    lastReplyAt: Date | null;
};

export function defaultChatState(
    chatId: string,
    now: Date = new Date()
): ChatState {
    return {
        chatId,
        state: CHAT_STATE.IDLE,
        verifiedOrderId: null,
        verifiedAt: null,
        pendingIntent: null,
        pauseUntil: null,
        blockedUntil: null,
        failedBindAttempts: 0,
        replyCount: 0,
        windowStartedAt: null,
        lastActivityAt: now,
        lastReplyAt: null,
    };
}

function toState(value: unknown): ChatBotState {
    const candidate = String(value ?? "");

    return (Object.values(CHAT_STATE) as string[]).includes(
        candidate
    )
        ? (candidate as ChatBotState)
        : CHAT_STATE.IDLE;
}

function toIntent(value: unknown): PendingIntent | null {
    return value === "TRACK" || value === "STATUS"
        ? value
        : null;
}

function toDate(value: unknown): Date | null {
    return value instanceof Date ? value : null;
}

/* ==========================================
 * DERIVED CHECKS
 * ========================================== */

/**
 * True when the flow context (menu position, pending intent, verified
 * binding) is too old to keep. Anti-abuse counters are NOT reset here —
 * they carry their own explicit windows.
 */
export function isFlowExpired(
    state: ChatState,
    now: Date = new Date()
): boolean {
    const age = now.getTime() - state.lastActivityAt.getTime();
    const ttl = state.verifiedOrderId
        ? VERIFIED_TTL_MS
        : CONVERSATION_TTL_MS;

    return age > ttl;
}

/** Is the phone-verified order binding still usable? */
export function isBindingValid(
    state: ChatState,
    now: Date = new Date()
): boolean {
    if (!state.verifiedOrderId || !state.verifiedAt) {
        return false;
    }

    return (
        now.getTime() - state.verifiedAt.getTime() <=
        VERIFIED_TTL_MS
    );
}

/** Are we inside a handoff window (bot must stay silent)? */
export function isPaused(
    state: ChatState,
    now: Date = new Date()
): boolean {
    return Boolean(
        state.pauseUntil &&
            state.pauseUntil.getTime() > now.getTime()
    );
}

/** Are we inside a failed-verification lockout? */
export function isBlocked(
    state: ChatState,
    now: Date = new Date()
): boolean {
    return Boolean(
        state.blockedUntil &&
            state.blockedUntil.getTime() > now.getTime()
    );
}

/** Too soon to send another reply in this chat? */
export function isCooldownActive(
    state: ChatState,
    now: Date = new Date()
): boolean {
    if (!state.lastReplyAt) {
        return false;
    }

    return (
        now.getTime() - state.lastReplyAt.getTime() <
        REPLY_COOLDOWN_MS
    );
}

/** Reply budget for the current window exhausted? */
export function isReplyBudgetExhausted(
    state: ChatState,
    now: Date = new Date()
): boolean {
    if (!state.windowStartedAt) {
        return false;
    }

    if (
        now.getTime() - state.windowStartedAt.getTime() >
        REPLY_WINDOW_MS
    ) {
        return false;
    }

    return state.replyCount >= MAX_REPLIES_PER_WINDOW;
}

/* ==========================================
 * LOAD / PERSIST
 * ========================================== */

/**
 * Read a chat's state. A missing row yields defaults (no row is created
 * for a chat the bot decides to ignore, so spam cannot grow the table).
 */
export async function loadChatState(
    chatId: string,
    now: Date = new Date()
): Promise<ChatState> {
    const row =
        await prisma.whatsAppChatState.findUnique({
            where: { chatId },
        });

    if (!row) {
        return defaultChatState(chatId, now);
    }

    const state: ChatState = {
        chatId: row.chatId,
        state: toState(row.state),
        verifiedOrderId:
            typeof row.verifiedOrderId === "number"
                ? row.verifiedOrderId
                : null,
        verifiedAt: toDate(row.verifiedAt),
        pendingIntent: toIntent(row.pendingIntent),
        pauseUntil: toDate(row.pauseUntil),
        blockedUntil: toDate(row.blockedUntil),
        failedBindAttempts: row.failedBindAttempts ?? 0,
        replyCount: row.replyCount ?? 0,
        windowStartedAt: toDate(row.windowStartedAt),
        lastActivityAt: toDate(row.lastActivityAt) ?? now,
        lastReplyAt: toDate(row.lastReplyAt),
    };

    /*
     * An expired flow is dropped — a stale menu must not swallow the
     * customer's next message. Explicit windows (pause / lockout) and
     * the counters used to enforce them are preserved.
     */
    if (isFlowExpired(state, now)) {
        return {
            ...state,
            state: CHAT_STATE.IDLE,
            verifiedOrderId: null,
            verifiedAt: null,
            pendingIntent: null,
        };
    }

    return state;
}

export type ChatStatePatch = {
    state?: ChatBotState;
    verifiedOrderId?: number | null;
    verifiedAt?: Date | null;
    pendingIntent?: PendingIntent | null;
    pauseUntil?: Date | null;
    blockedUntil?: Date | null;
    failedBindAttempts?: number;
};

/**
 * Persist the state after a decision, and account for the reply that was
 * (or was not) actually delivered.
 *
 * `replied` is what makes the reply budget honest: it is only counted
 * when the provider accepted the message.
 */
export async function persistChatState(input: {
    state: ChatState;
    patch: ChatStatePatch;
    now: Date;
    replied: boolean;
}): Promise<void> {
    const { state, patch, now, replied } = input;

    const windowActive =
        state.windowStartedAt !== null &&
        now.getTime() - state.windowStartedAt.getTime() <=
            REPLY_WINDOW_MS;

    const replyCount = replied
        ? (windowActive ? state.replyCount : 0) + 1
        : windowActive
          ? state.replyCount
          : 0;

    const windowStartedAt = windowActive
        ? state.windowStartedAt
        : replied
          ? now
          : null;

    const data = {
        state: patch.state ?? state.state,
        verifiedOrderId:
            patch.verifiedOrderId !== undefined
                ? patch.verifiedOrderId
                : state.verifiedOrderId,
        verifiedAt:
            patch.verifiedAt !== undefined
                ? patch.verifiedAt
                : state.verifiedAt,
        pendingIntent:
            patch.pendingIntent !== undefined
                ? patch.pendingIntent
                : state.pendingIntent,
        pauseUntil:
            patch.pauseUntil !== undefined
                ? patch.pauseUntil
                : state.pauseUntil,
        blockedUntil:
            patch.blockedUntil !== undefined
                ? patch.blockedUntil
                : state.blockedUntil,
        failedBindAttempts:
            patch.failedBindAttempts !== undefined
                ? patch.failedBindAttempts
                : state.failedBindAttempts,
        replyCount,
        windowStartedAt,
        lastActivityAt: now,
        lastReplyAt: replied ? now : state.lastReplyAt,
    };

    await prisma.whatsAppChatState.upsert({
        where: { chatId: state.chatId },
        create: { chatId: state.chatId, ...data },
        update: data,
    });
}

/* ==========================================
 * INBOUND DEDUPE (TWO-PHASE CLAIM)
 * ========================================== */

export type InboundClaimResult =
    | "CLAIMED"
    | "DUPLICATE"
    | "EXHAUSTED";

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

/**
 * Claim an inbound message id.
 *
 *   CLAIMED    → this delivery owns the message; reply and then mark DONE
 *   DUPLICATE  → already handled (or another worker is handling it now)
 *   EXHAUSTED  → already failed MAX_INBOUND_ATTEMPTS times; do not retry
 *
 * A FAILED or stale PROCESSING row is re-claimable via a compare-and-set
 * on (status, attempts), so exactly one worker takes over.
 */
export async function claimInboundMessage(input: {
    messageId: string;
    chatId: string;
    now?: Date;
}): Promise<InboundClaimResult> {
    const now = input.now ?? new Date();

    try {
        await prisma.whatsAppInboundMessage.create({
            data: {
                messageId: input.messageId,
                chatId: input.chatId,
            },
        });

        return "CLAIMED";
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }

    const existing =
        await prisma.whatsAppInboundMessage.findUnique({
            where: { messageId: input.messageId },
        });

    // Row vanished between the conflict and the read: treat as ours.
    if (!existing) {
        return "CLAIMED";
    }

    if (existing.status === "DONE") {
        return "DUPLICATE";
    }

    if (existing.attempts >= MAX_INBOUND_ATTEMPTS) {
        await prisma.whatsAppInboundMessage.updateMany({
            where: { messageId: input.messageId },
            data: {
                status: "DONE",
                processedAt: now,
                lastError: "MAX_ATTEMPTS_REACHED",
            },
        });

        return "EXHAUSTED";
    }

    const updatedAt =
        existing.updatedAt instanceof Date
            ? existing.updatedAt
            : now;

    const stale =
        now.getTime() - updatedAt.getTime() > STALE_CLAIM_MS;

    if (existing.status === "PROCESSING" && !stale) {
        // Another delivery is working on it right now.
        return "DUPLICATE";
    }

    const taken =
        await prisma.whatsAppInboundMessage.updateMany({
            where: {
                messageId: input.messageId,
                status: existing.status,
                attempts: existing.attempts,
            },
            data: {
                status: "PROCESSING",
                attempts: { increment: 1 },
                lastError: null,
            },
        });

    return taken.count === 1 ? "CLAIMED" : "DUPLICATE";
}

/** The reply was accepted by the provider — never re-process this id. */
export async function markInboundDone(
    messageId: string,
    now: Date = new Date()
): Promise<void> {
    await prisma.whatsAppInboundMessage.updateMany({
        where: { messageId },
        data: {
            status: "DONE",
            processedAt: now,
            lastError: null,
        },
    });
}

/**
 * Processing/reply failed. The row becomes re-claimable, so a
 * re-delivery can still answer the customer.
 *
 * Only a short ERROR CODE is stored — never the customer's message.
 */
export async function markInboundFailed(
    messageId: string,
    errorCode: string
): Promise<void> {
    await prisma.whatsAppInboundMessage.updateMany({
        where: { messageId },
        data: {
            status: "FAILED",
            lastError: String(errorCode).slice(0, 190),
        },
    });
}

/**
 * Opportunistic retention: drop ledger rows older than the window.
 * Best effort — a failure here must never affect a reply.
 */
export async function cleanupInboundMessages(
    now: Date = new Date()
): Promise<void> {
    try {
        await prisma.whatsAppInboundMessage.deleteMany({
            where: {
                receivedAt: {
                    lt: new Date(
                        now.getTime() - INBOUND_RETENTION_MS
                    ),
                },
            },
        });
    } catch (error) {
        console.error(
            "[WHATSAPP BOT] Inbound cleanup skipped:",
            error instanceof Error ? error.message : error
        );
    }
}

/**
 * Drop state rows for conversations that ended long ago.
 *
 * Keeps the table bounded (one row per chat, otherwise kept forever)
 * without ever touching a live window: only rows idle for
 * CHAT_STATE_RETENTION_MS are removed. Best effort, like the cleanup
 * above.
 */
export async function cleanupChatStates(
    now: Date = new Date()
): Promise<void> {
    try {
        await prisma.whatsAppChatState.deleteMany({
            where: {
                lastActivityAt: {
                    lt: new Date(
                        now.getTime() - CHAT_STATE_RETENTION_MS
                    ),
                },
            },
        });
    } catch (error) {
        console.error(
            "[WHATSAPP BOT] Chat state cleanup skipped:",
            error instanceof Error ? error.message : error
        );
    }
}
