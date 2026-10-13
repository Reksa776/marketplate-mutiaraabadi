/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — INBOUND TEXT PARSING (PURE)
 * ==========================================================
 *
 * Turns the raw text of an inbound WhatsApp message into ONE
 * unambiguous intent. Nothing in this file talks to the database, the
 * WhatsApp socket or the network, so every rule below is unit testable
 * and can never be influenced by the state of a live session.
 *
 * SECURITY POSTURE
 *
 *   * The order number found here is a LOOKUP HINT, never proof of
 *     ownership. A customer who knows (or guesses) an order number gets
 *     nothing from this module — binding happens elsewhere and requires
 *     the sender's WhatsApp number to match the order's checkout phone.
 *   * The text is treated as hostile input: it is never reversed into
 *     another customer's order, never stored, and never echoed back.
 *   * A message that matches the WEBSITE confirmation draft is
 *     recognized structurally (the `Nomor Pesanan:` field), but the
 *     status written inside that draft is deliberately IGNORED: it is a
 *     snapshot from the moment the customer pressed the button, not the
 *     order's current state.
 */

/** Menu keys the bot accepts. */
export type MenuDigit = "0" | "1" | "2" | "3";

export type InboundCommand =
    /** Menu / greeting / "menu utama" */
    | "MENU"
    /** Abandon the current flow */
    | "CANCEL"
    /** A single menu key */
    | "DIGIT"
    /** An order number to look up (hint only) */
    | "ORDER_NUMBER"
    /** Customer is reporting a problem / asking for a human */
    | "COMPLAINT"
    /** Anything else */
    | "OTHER";

export type ParsedInbound = {
    command: InboundCommand;
    digit?: MenuDigit;
    /**
     * True only for an EXPLICIT request for the menu ("menu", "menu
     * utama", "mulai", "start", …) — not for a plain greeting.
     *
     * The distinction matters during a handoff: a greeting must NOT
     * re-arm the bot while a human admin is talking to the customer,
     * while an explicit "menu" must always work.
     */
    explicitMenu: boolean;
    /** Untrusted lookup hint — never proof of ownership. */
    orderNumber?: string;
    /**
     * True when the message matched the website's "Konfirmasi Pesanan"
     * draft (lib/whatsapp/order-confirm.ts buildOrderConfirmMessage).
     */
    confirmDraft: boolean;
    /** True when the message carried no readable text at all. */
    nonText: boolean;
};

/** Words that EXPLICITLY ask for the menu (they re-arm after a handoff). */
const EXPLICIT_MENU_KEYWORDS = new Set([
    "menu",
    "menu utama",
    "utama",
    "mulai",
    "start",
    "home",
]);

/**
 * Greetings open the menu for a fresh chat, but they must NOT be able
 * to re-arm the bot inside an admin handoff.
 */
const GREETING_KEYWORDS = new Set([
    "halo",
    "hallo",
    "hai",
    "hi",
    "hello",
    "hei",
    "pagi",
    "siang",
    "sore",
    "malam",
    "assalamualaikum",
    "permisi",
    "misi",
]);

/** Any word that opens (or re-opens) the main menu. */
const MENU_KEYWORDS = new Set([
    ...EXPLICIT_MENU_KEYWORDS,
    ...GREETING_KEYWORDS,
]);

/** Words that leave the current flow. */
const CANCEL_KEYWORDS = new Set([
    "batal",
    "batalkan",
    "cancel",
    "keluar",
    "exit",
    "stop",
    "udahan",
    "selesai",
]);

/**
 * Phrases that hand the conversation to a human admin.
 *
 * Deliberately one-directional: a false positive only costs the customer
 * a (safe) human handoff, while a false negative leaves a complaint
 * being answered by a bot.
 *
 * Natural Indonesian inserts words between "belum" and the verb
 * ("paket belum SAYA terima"), which a plain substring list misses —
 * hence the bounded wildcard patterns. The bound is what keeps runtime
 * predictable and stops the pattern from spanning a whole paragraph.
 */
const COMPLAINT_PATTERNS: RegExp[] = [
    /komplain|komplen|keluhan|masalah|kecewa|rusak|pecah|banding|lapor(?:an)?/,
    /belum\s+(?:\w+\s+){0,3}(?:terima|diterima|sampai|kirim|dikirim)/,
    /tidak\s+(?:\w+\s+){0,3}(?:terima|diterima|sampai|kirim|dikirim)/,
    /gagal\s+(?:terima|diterima|antar|diantar)/,
    /salah\s+(?:kirim|barang|produk|alamat|orang)/,
    /(?:mau|ingin|ajukan|minta)\s+refund/,
    /\badmin\b|\bcs\b|customer service/,
];

/**
 * Phrases that LOOK like a complaint pattern but mean the opposite.
 * Checked first, so "tidak masalah" / "tidak apa-apa" stay in the
 * self-service flow instead of pausing the bot for two hours.
 */
const COMPLAINT_NEGATIVE_PATTERNS: RegExp[] = [
    /tidak\s+(?:masalah|apa-apa|apa apa)/,
    /nggak\s+(?:masalah|apa-apa|apa apa)/,
    /gak\s+(?:masalah|apa-apa|apa apa)/,
];

/** Max length of an order-number token we are willing to look up. */
export const MAX_ORDER_NUMBER_LENGTH = 64;

/**
 * ==========================================================
 * TEXT EXTRACTION
 * ==========================================================
 *
 * Reads only the parts of a Baileys message that carry CUSTOMER TEXT.
 * Button/list/quick-reply payloads are included so a client that still
 * renders them keeps working, but nothing here ever sends buttons.
 *
 * Stickers, images, audio, location and other non-text payloads return
 * null → the bot answers with the menu instead of guessing.
 */
export function extractText(message: unknown): string | null {
    if (!message || typeof message !== "object") {
        return null;
    }

    const envelope = message as Record<string, unknown>;

    const candidates: Array<unknown> = [
        envelope.conversation,
        pickString(envelope.extendedTextMessage, "text"),
        pickString(envelope.buttonsResponseMessage, "selectedButtonId"),
        pickString(envelope.templateButtonReplyMessage, "selectedId"),
        pickString(envelope.listResponseMessage, "title"),
        pickString(
            pickObject(envelope.listResponseMessage, "singleSelectReply"),
            "selectedRowId"
        ),
        pickString(envelope.interactiveResponseMessage, "body", "text"),
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate;
        }
    }

    return null;
}

function pickObject(
    value: unknown,
    ...path: string[]
): Record<string, unknown> | null {
    let current: unknown = value;

    for (const key of path) {
        if (!current || typeof current !== "object") {
            return null;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return current && typeof current === "object"
        ? (current as Record<string, unknown>)
        : null;
}

function pickString(
    value: unknown,
    ...path: string[]
): string | null {
    let current: unknown = value;

    for (const key of path) {
        if (!current || typeof current !== "object") {
            return null;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return typeof current === "string" ? current : null;
}

/**
 * ==========================================================
 * NORMALIZATION
 * ==========================================================
 *
 * Lowercased, whitespace-collapsed, decoration stripped. Emoji and
 * trailing punctuation are removed so "1️⃣", "1." and "1" are the same
 * command, and "HALO!" is still a greeting.
 */
export function normalizeCommandText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\u200d\u200b\u200e\u200f\uFE0F]/g, "")
        // Emoji / pictographs and symbols.
        .replace(/[\u2190-\u2BFF\u2600-\u27BF\uFE0F]/g, " ")
        .replace(/[\u{1F000}-\u{1FAFF}]/gu, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s.,;:!?"'()\-*/\\|]+/, "")
        .replace(/[\s.,;:!?"'()\-*/\\|]+$/, "")
        .trim();
}

/**
 * ==========================================================
 * ORDER NUMBER TOKENS
 * ==========================================================
 *
 * Order numbers in this project are generated as
 * `{ORD|PAY-BN|PAY-CART}-{timestamp}-{8 hex}` (lib/checkout.ts
 * makeOrderNumber), so a valid token always has:
 *
 *   1. at least TWO hyphens (three or more segments),
 *   2. at least one segment with letters,
 *   3. at least one segment with digits.
 *
 * Rule 1 + 3 reject hyphenated prose ("tidak-terima-paket") and
 * hyphenated phone numbers ("0812-3456-7890"), which would otherwise be
 * mistaken for an order and burn the customer's verification budget.
 */
export function isOrderNumberToken(token: string): boolean {
    if (
        typeof token !== "string" ||
        token.length < 8 ||
        token.length > MAX_ORDER_NUMBER_LENGTH
    ) {
        return false;
    }

    const segments = token.split("-");

    if (segments.length < 3 || segments.length > 5) {
        return false;
    }

    if (segments.some((segment) => segment.length === 0)) {
        return false;
    }

    const hasLetters = segments.some((segment) =>
        /[A-Za-z]/.test(segment)
    );
    const hasDigits = segments.some((segment) =>
        /[0-9]/.test(segment)
    );

    return hasLetters && hasDigits;
}

/** First order-number-looking token in the text, if any. */
export function findOrderNumberToken(
    text: string
): string | null {
    const matches = String(text).match(
        /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g
    );

    if (!matches) {
        return null;
    }

    for (const candidate of matches) {
        if (isOrderNumberToken(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * ==========================================================
 * WEBSITE CONFIRMATION DRAFT
 * ==========================================================
 *
 * The draft the customer sends from the order page is built by
 * lib/whatsapp/order-confirm.ts and contains the line
 * `Nomor Pesanan: <orderNumber>`. Recognizing that line (rather than a
 * fixed full-message match) keeps this working when the copy around it
 * changes, while still being specific enough that ordinary chat text is
 * not mistaken for a draft.
 */
export function isConfirmDraft(text: string): boolean {
    return /nomor\s+pesanan\s*:/i.test(String(text));
}

/** Extract the order number written in a draft's `Nomor Pesanan:` line. */
export function readDraftOrderNumber(
    text: string
): string | null {
    const match = String(text).match(
        /nomor\s+pesanan\s*:\s*([^\n\r]+)/i
    );

    if (!match) {
        return null;
    }

    const value = match[1].trim();

    if (isOrderNumberToken(value)) {
        return value;
    }

    /*
     * Tolerate decoration around the value ("ORD-… ." or "(ORD-…)")
     * without ever inventing a number that is not literally present.
     */
    return findOrderNumberToken(value);
}

/**
 * ==========================================================
 * CLASSIFICATION
 * ==========================================================
 *
 * Precedence is fixed here and nowhere else:
 *
 *   1. confirmation draft   (an explicit, structured message)
 *   2. a bare order number  (an explicit lookup request)
 *   3. a single menu key
 *   4. menu / cancel keywords
 *   5. complaint routing
 *   6. anything else
 *
 * Menu keys are checked AFTER the draft/number so a customer who pastes
 * an order number that happens to end in "1" is not read as "menu 1".
 */
export function parseInboundMessage(
    text: string | null
): ParsedInbound {
    if (text === null || text === undefined) {
        return {
            command: "OTHER",
            confirmDraft: false,
            explicitMenu: false,
            nonText: true,
        };
    }

    const raw = String(text);

    if (!raw.trim()) {
        return {
            command: "OTHER",
            confirmDraft: false,
            explicitMenu: false,
            nonText: true,
        };
    }

    const confirmDraft = isConfirmDraft(raw);

    if (confirmDraft) {
        return {
            command: "ORDER_NUMBER",
            orderNumber:
                readDraftOrderNumber(raw) ?? undefined,
            confirmDraft: true,
            explicitMenu: false,
            nonText: false,
        };
    }

    const bareOrderNumber = findOrderNumberToken(raw);

    /*
     * A bare order number wins only when the message is essentially
     * JUST that number — otherwise "pesanan ORD-… statusnya apa?"
     * would skip the menu and be read as a lookup of whatever the
     * customer happened to mention.
     */
    if (bareOrderNumber) {
        const remainder = normalizeCommandText(raw)
            .replace(bareOrderNumber.toLowerCase(), "")
            .trim();

        if (!remainder || isMenuOrCancelKeyword(remainder)) {
            return {
                command: "ORDER_NUMBER",
                orderNumber: bareOrderNumber,
                confirmDraft: false,
                explicitMenu: false,
                nonText: false,
            };
        }
    }

    const normalized = normalizeCommandText(raw);

    const digit = readMenuDigit(normalized);

    if (digit) {
        return {
            command: "DIGIT",
            digit,
            confirmDraft: false,
            explicitMenu: false,
            nonText: false,
        };
    }

    if (MENU_KEYWORDS.has(normalized)) {
        return {
            command: "MENU",
            confirmDraft: false,
            explicitMenu:
                EXPLICIT_MENU_KEYWORDS.has(normalized),
            nonText: false,
        };
    }

    if (CANCEL_KEYWORDS.has(normalized)) {
        return {
            command: "CANCEL",
            confirmDraft: false,
            // An explicit cancellation also re-arms a paused chat: the
            // customer is deliberately ending the admin conversation.
            explicitMenu: true,
            nonText: false,
        };
    }

    if (isComplaintText(normalized)) {
        return {
            command: "COMPLAINT",
            confirmDraft: false,
            explicitMenu: false,
            nonText: false,
        };
    }

    return {
        command: "OTHER",
        confirmDraft: false,
        explicitMenu: false,
        nonText: false,
    };
}

/** A single menu key, with decoration tolerated ("1", "1.", "1️⃣"). */
export function readMenuDigit(
    normalizedText: string
): MenuDigit | null {
    const value = normalizedText
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/[^\p{L}\p{N}]+$/u, "")
        .trim();

    if (value === "0" || value === "1" || value === "2" || value === "3") {
        return value as MenuDigit;
    }

    return null;
}

function isMenuOrCancelKeyword(normalized: string): boolean {
    return (
        MENU_KEYWORDS.has(normalized) ||
        CANCEL_KEYWORDS.has(normalized)
    );
}

function isComplaintText(normalized: string): boolean {
    if (
        COMPLAINT_NEGATIVE_PATTERNS.some((pattern) =>
            pattern.test(normalized)
        )
    ) {
        return false;
    }

    return COMPLAINT_PATTERNS.some((pattern) =>
        pattern.test(normalized)
    );
}

/**
 * ==========================================================
 * MESSAGE AGE
 * ==========================================================
 *
 * Baileys replays buffered messages after a reconnect, and they arrive
 * with their ORIGINAL timestamp. Answering days-old history would spam
 * customers, so only messages inside this window are eligible for a
 * reply. The window is comfortably larger than a reconnect or a PM2
 * reload, so a message that arrived while the session was down is still
 * answered.
 */
export const MAX_INBOUND_MESSAGE_AGE_MS = 10 * 60 * 1000;

/**
 * Read a Baileys `messageTimestamp` (seconds) defensively.
 *
 * Accepts a plain number, a numeric string, or a protobuf Long. Returns
 * null when nothing usable is present — the caller then SKIPS the age
 * check rather than dropping a fresh message.
 */
export function readMessageTimestampMs(
    value: unknown
): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value * 1000 : null;
    }

    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed * 1000 : null;
    }

    if (typeof value === "object") {
        const long = value as {
            toNumber?: () => number;
            low?: number;
        };

        if (typeof long.toNumber === "function") {
            const parsed = long.toNumber();
            return Number.isFinite(parsed) ? parsed * 1000 : null;
        }

        if (typeof long.low === "number") {
            return long.low * 1000;
        }
    }

    return null;
}
