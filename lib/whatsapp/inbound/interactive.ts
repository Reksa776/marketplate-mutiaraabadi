/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — INTERACTIVE (NATIVE FLOW) BUTTONS
 * ==========================================================
 *
 * OPT-IN, AND OFF BY DEFAULT.
 *
 * WHY IT IS OPT-IN
 *
 *   Baileys 7.0.0-rc14 has NO supported send-side API for interactive
 *   messages: `AnyMessageContent` carries no `buttons`/`interactiveMessage`
 *   field, and nothing in its send path can build one. The only route is
 *   hand-assembling the `interactiveMessage` protobuf and handing it to
 *   `relayMessage()` — an UNSUPPORTED path. WhatsApp itself then decides
 *   whether a button is rendered at all: rendering depends on the
 *   recipient's client (Android has been reported to show nothing while
 *   iOS/Web draw them), and a receiver can even be shown "message not
 *   compatible".
 *
 *   Therefore this module NEVER replaces the numbered menu. It only adds
 *   an opt-in enhancement on top of it, and the surrounding pipeline
 *   keeps sending the plain numbered text whenever the interactive send
 *   is unavailable, refused or fails. A successful send is NOT evidence
 *   that a button was displayed.
 *
 * ENABLE IT ONLY FOR A CONTROLLED TEST
 *
 *   WHATSAPP_INTERACTIVE_BUTTONS=1     → interactive buttons are ATTEMPTED
 *   (unset / anything else)            → plain numbered text only
 *
 *   Do not switch it on in production before it has been verified
 *   manually on both WhatsApp Android and WhatsApp iPhone.
 *
 * BUTTON IDS ARE A STABLE CONTRACT
 *
 *   A click returns the button ID we sent, so the IDs below are an
 *   interface: the handler maps them onto the SAME menu digits the
 *   customer would have typed. Button clicks therefore travel through
 *   the identical pipeline — ownership verification, dedupe, cooldown
 *   and rate limits all still apply.
 *
 * This module is pure: no Baileys, no database, no network.
 */

import {
    MAIN_MENU_TEXT,
    POST_DELIVERY_MENU_TEXT,
} from "./menu";
import type { MenuDigit } from "./parse";

/* ==========================================
 * FEATURE FLAG
 * ========================================== */

/** Set to `1`/`true`/`on`/`yes` to ATTEMPT interactive buttons. */
export const INTERACTIVE_BUTTONS_ENV =
    "WHATSAPP_INTERACTIVE_BUTTONS";

/**
 * Is the interactive layer enabled?
 *
 * Defaults to FALSE for every value that is not an explicit opt-in,
 * including unset, empty, "0", "false" and typos — an unsafe/unclear
 * environment must never enable an unsupported WhatsApp feature.
 */
export function isInteractiveButtonsEnabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    const raw = env?.[INTERACTIVE_BUTTONS_ENV];

    if (typeof raw !== "string") {
        return false;
    }

    const value = raw.trim().toLowerCase();

    return (
        value === "1" ||
        value === "true" ||
        value === "on" ||
        value === "yes"
    );
}

/* ==========================================
 * BUTTON DEFINITIONS
 * ========================================== */

/**
 * `quick_reply` is the native-flow button name that reports the tap back
 * to us. The other native-flow names (`cta_url`, `cta_call`,
 * `single_select`, `review_and_pay`, …) either open something external
 * or require a verified business account, so the bot deliberately uses
 * only this one.
 */
export const QUICK_REPLY_BUTTON_NAME = "quick_reply";

export type InteractiveMenu = "MAIN" | "POST_DELIVERY";

export type InteractiveButton = {
    /** Stable id sent to WhatsApp and returned on a click. */
    id: string;
    /** Customer-facing label. WhatsApp truncates long labels (~20). */
    label: string;
    /** The menu digit this button is equivalent to typing. */
    digit: MenuDigit;
};

/**
 * Main menu buttons — ONE per numbered option, so a click and a typed
 * digit always reach the same decision branch.
 */
export const MAIN_MENU_BUTTONS: readonly InteractiveButton[] = [
    {
        id: "menu_track",
        label: "📦 Lacak Resi",
        digit: "1",
    },
    {
        id: "menu_status",
        label: "📋 Status Pesanan",
        digit: "2",
    },
    {
        id: "menu_admin",
        label: "👨‍💼 Hubungi Admin",
        digit: "3",
    },
    {
        id: "menu_home",
        label: "🏠 Menu Utama",
        digit: "0",
    },
] as const;

/**
 * Post-delivery sub-menu buttons. They are a SEPARATE id namespace from
 * the main menu on purpose: "1" means "Lacak Resi" on the main menu but
 * "Lihat Riwayat Pengiriman" here, so a stale click must not be read as
 * the wrong service.
 */
export const POST_DELIVERY_BUTTONS: readonly InteractiveButton[] = [
    {
        id: "delivered_history",
        label: "🚚 Riwayat Kirim",
        digit: "1",
    },
    {
        id: "delivered_problem",
        label: "⚠️ Ada Masalah",
        digit: "2",
    },
    {
        id: "delivered_again",
        label: "🛍️ Belanja Lagi",
        digit: "3",
    },
    {
        id: "delivered_home",
        label: "🏠 Menu Utama",
        digit: "0",
    },
] as const;

/** Every button this bot can attach, in one list. */
export const ALL_BUTTONS: readonly InteractiveButton[] = [
    ...MAIN_MENU_BUTTONS,
    ...POST_DELIVERY_BUTTONS,
];

export function buttonsFor(
    menu: InteractiveMenu
): readonly InteractiveButton[] {
    return menu === "POST_DELIVERY"
        ? POST_DELIVERY_BUTTONS
        : MAIN_MENU_BUTTONS;
}

/**
 * Which numbered menu (if any) a reply IS, so the caller can attach the
 * matching buttons without every return site having to remember to.
 *
 * Compared against the very same constants the reply was built from, so
 * editing the menu copy can never silently detach the buttons.
 */
export function menuKindForReply(
    reply: unknown
): InteractiveMenu | null {
    if (typeof reply !== "string" || !reply) {
        return null;
    }

    if (reply === MAIN_MENU_TEXT) {
        return "MAIN";
    }

    if (reply.includes(POST_DELIVERY_MENU_TEXT)) {
        return "POST_DELIVERY";
    }

    return null;
}

/* ==========================================
 * ID → INTENT MAPPING
 * ========================================== */

function normalizeKey(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[\u200d\u200b\u200e\u200f\uFE0F]/g, "")
        .replace(/[\u2190-\u2BFF\u2600-\u27BF\uFE0F]/g, " ")
        .replace(/[\u{1F000}-\u{1FAFF}]/gu, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

const DIGIT_BY_BUTTON_ID = new Map<string, MenuDigit>(
    ALL_BUTTONS.map((button) => [
        button.id.toLowerCase(),
        button.digit,
    ])
);

/**
 * Label → digit, used ONLY for a click that arrives without a usable id
 * (some clients echo the display text instead). Normalized so emoji and
 * punctuation cannot break the match.
 */
const DIGIT_BY_BUTTON_LABEL = new Map<string, MenuDigit>(
    ALL_BUTTONS.map((button) => [
        normalizeKey(button.label),
        button.digit,
    ])
);

/**
 * Map a stable button id (or, as a fallback, its display label) to the
 * menu digit it is equivalent to. Unknown input yields null, so the
 * message falls through to the ordinary text classification instead of
 * being guessed at.
 */
export function digitFromButton(
    value: unknown
): MenuDigit | null {
    if (typeof value !== "string") {
        return null;
    }

    const byId = DIGIT_BY_BUTTON_ID.get(value.trim().toLowerCase());

    if (byId) {
        return byId;
    }

    return DIGIT_BY_BUTTON_LABEL.get(normalizeKey(value)) ?? null;
}

/* ==========================================
 * READING A CLICK
 * ========================================== */

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
 * A native-flow click carries its payload as JSON inside
 * `nativeFlowResponseMessage.paramsJson` (`{"id":"menu_track"}` for the
 * buttons we send). Parsed defensively: malformed JSON is not an error,
 * it just yields no id.
 */
function readNativeFlowId(message: unknown): string | null {
    const paramsJson = pickString(
        message,
        "interactiveResponseMessage",
        "nativeFlowResponseMessage",
        "paramsJson"
    );

    if (!paramsJson) {
        return null;
    }

    try {
        const parsed = JSON.parse(paramsJson) as unknown;

        if (!parsed || typeof parsed !== "object") {
            return null;
        }

        const envelope = parsed as Record<string, unknown>;

        for (const key of ["id", "button_id", "buttonId"]) {
            const value = envelope[key];

            if (typeof value === "string" && value.trim()) {
                return value;
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * The button identifier carried by an inbound message, across the
 * message shapes WhatsApp/Baileys may use for a tap.
 *
 * Checked in order of reliability: an explicit id (native flow, then
 * the older button/list responses) before the display text.
 */
export function readButtonId(message: unknown): string | null {
    if (!message || typeof message !== "object") {
        return null;
    }

    const candidates: Array<string | null> = [
        readNativeFlowId(message),
        pickString(
            message,
            "buttonsResponseMessage",
            "selectedButtonId"
        ),
        pickString(
            message,
            "templateButtonReplyMessage",
            "selectedId"
        ),
        pickString(
            message,
            "listResponseMessage",
            "singleSelectReply",
            "selectedRowId"
        ),
        /*
         * Last resort: the response body. Only consulted INSIDE an
         * interactive response, so ordinary typed text can never be
         * mistaken for a button tap.
         */
        pickString(message, "interactiveResponseMessage", "body", "text"),
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return null;
}

/** The menu digit a click is equivalent to, if it maps to one. */
export function readButtonDigit(
    message: unknown
): MenuDigit | null {
    return digitFromButton(readButtonId(message));
}

/* ==========================================
 * PAYLOAD
 * ========================================== */

/**
 * Structural shape of the message we hand to Baileys' `relayMessage`.
 *
 * Declared here (instead of importing Baileys) so the payload stays
 * unit-testable without a WhatsApp connection. The fields mirror
 * `proto.Message.InteractiveMessage`.
 */
export type WhatsAppInteractiveContent = {
    interactiveMessage: {
        body: { text: string };
        footer: { text: string };
        nativeFlowMessage: {
            buttons: Array<{
                name: string;
                buttonParamsJson: string;
            }>;
        };
    };
};

/**
 * Shown under the buttons.
 *
 * It states that the numbers still work, because the buttons are
 * best-effort: the customer is never left with a message they cannot
 * act on when a button is not drawn.
 */
export const INTERACTIVE_FOOTER_TEXT =
    "Ketuk tombol di atas, atau balas dengan angka pilihan.";

/**
 * Build the interactive message for a menu.
 *
 * `bodyText` is ALWAYS the full numbered menu: if WhatsApp drops the
 * buttons, the message the customer receives is still the complete,
 * usable text menu. This is a real payload plus a real fallback — never
 * text pretending to be a button.
 */
export function buildInteractiveContent(input: {
    menu: InteractiveMenu;
    bodyText: string;
}): WhatsAppInteractiveContent {
    return {
        interactiveMessage: {
            body: { text: String(input.bodyText ?? "") },
            footer: { text: INTERACTIVE_FOOTER_TEXT },
            nativeFlowMessage: {
                buttons: buttonsFor(input.menu).map(
                    (button) => ({
                        name: QUICK_REPLY_BUTTON_NAME,
                        buttonParamsJson: JSON.stringify({
                            display_text: button.label,
                            id: button.id,
                        }),
                    })
                ),
            },
        },
    };
}
