/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — SENDER IDENTITY (PURE)
 * ==========================================================
 *
 * Extracts WHO is talking to us, from the message envelope only.
 *
 * WHY THE ENVELOPE AND NOT THE TEXT
 *
 *   The text of a message is fully attacker-controlled: anyone can type
 *   "Nomor Pesanan: ORD-…". The sender's WhatsApp **number**, by
 *   contrast, is authenticated by WhatsApp itself and cannot be spoofed
 *   in a 1:1 chat. That is the only ownership signal this bot may use —
 *   see `orderPhoneMatches()`.
 *
 * WHAT THIS FACTOR DOES AND DOES NOT PROVE
 *
 *   A match proves the sender CONTROLS the phone number recorded at
 *   checkout. It is deliberately treated as a WEAK factor: it only
 *   unlocks non-sensitive shipment information, never the order's
 *   address, items, payment data, tokens or any account-level access.
 *   (Example edge case: an order whose recipient phone was typed by
 *   somebody else. That is exactly why the released data set stays
 *   limited to what the carrier already publishes via the resi.)
 *
 * LID ADDRESSING — FAIL CLOSED
 *
 *   WhatsApp increasingly addresses chats with a LID (`@lid`), which is
 *   an internal identifier and NOT a phone number. A `@lid` chat is
 *   still a customer chat (we answer it), but it yields NO phone
 *   candidate, so binding fails closed and the customer is pointed at
 *   the website's own order recovery instead of being sent a guess.
 *   Baileys exposes the phone-number JID for such messages as
 *   `key.remoteJidAlt` / `key.participantAlt`; those are used when
 *   present.
 *
 * This module never imports Baileys (keeps the dependency out of every
 * consumer) and never touches the network.
 */

import crypto from "crypto";

import { normalizePhone } from "@/lib/guest-identity";

/** Host of a phone-number JID. */
const PN_HOSTS = new Set(["s.whatsapp.net", "c.us"]);
/** Internal WhatsApp identifier — a chat, but not a dialable number. */
const LID_HOST = "lid";
const GROUP_HOST = "g.us";
const NEWSLETTER_HOST = "newsletter";
const BROADCAST_HOST = "broadcast";
/** WhatsApp's own status broadcast, spelled as a whole JID. */
const STATUS_BROADCAST_JID = "status@broadcast";

/** Host part of a JID ("62812…@s.whatsapp.net" → "s.whatsapp.net"). */
export function jidHost(
    jid: unknown
): string | null {
    if (typeof jid !== "string") {
        return null;
    }

    const value = jid.trim();
    const separator = value.lastIndexOf("@");

    if (separator <= 0 || separator === value.length - 1) {
        return null;
    }

    return value.slice(separator + 1).toLowerCase();
}

/**
 * User part of a JID, with the multi-device suffix removed
 * ("6281234567890:12@s.whatsapp.net" → "6281234567890").
 */
export function jidUser(
    jid: unknown
): string | null {
    if (typeof jid !== "string") {
        return null;
    }

    const value = jid.trim();
    const separator = value.lastIndexOf("@");

    const beforeHost =
        separator > 0 ? value.slice(0, separator) : value;

    const user = beforeHost.split(":")[0].trim();

    return user || null;
}

/**
 * Is this a 1:1 CUSTOMER chat we may answer?
 *
 * Groups, status broadcasts and newsletter/channel JIDs are rejected
 * here so a group message can never be treated as a private tracking
 * request (`@lid` is accepted: it is a real customer chat, it simply
 * cannot be phone-verified).
 */
export function isCustomerChatJid(
    jid: unknown
): boolean {
    if (typeof jid !== "string") {
        return false;
    }

    const value = jid.trim();

    if (!value) {
        return false;
    }

    if (
        value === STATUS_BROADCAST_JID ||
        value === "broadcast"
    ) {
        return false;
    }

    const host = jidHost(value);

    if (!host) {
        return false;
    }

    if (
        host === GROUP_HOST ||
        host === BROADCAST_HOST ||
        host === NEWSLETTER_HOST
    ) {
        return false;
    }

    return (
        PN_HOSTS.has(host) || host === LID_HOST
    );
}

/**
 * Every JID carried by a Baileys message key that could identify the
 * chat or its author, most authoritative first.
 */
export function inboundJidCandidates(
    key: unknown
): string[] {
    if (!key || typeof key !== "object") {
        return [];
    }

    const envelope = key as Record<string, unknown>;

    const candidates = [
        envelope.remoteJidAlt,
        envelope.participantAlt,
        envelope.remoteJid,
        envelope.participant,
    ];

    const jids: string[] = [];

    for (const candidate of candidates) {
        if (
            typeof candidate === "string" &&
            candidate.trim() &&
            !jids.includes(candidate.trim())
        ) {
            jids.push(candidate.trim());
        }
    }

    return jids;
}

/**
 * Normalized Indonesian-format phone numbers that may belong to the
 * sender. Only phone-number JIDs contribute — a LID or group identifier
 * never becomes a candidate, because feeding its digits to
 * `normalizePhone()` would fabricate a number that belongs to nobody.
 */
export function extractSenderPhones(
    key: unknown
): string[] {
    const phones: string[] = [];

    for (const jid of inboundJidCandidates(key)) {
        const host = jidHost(jid);

        if (!host || !PN_HOSTS.has(host)) {
            continue;
        }

        const normalized = normalizePhone(jidUser(jid));

        if (!normalized) {
            continue;
        }

        // A real phone number: 8–15 digits. Anything outside that (a
        // LID that leaked into a PN field, a truncated value) is not
        // usable as an identity claim.
        if (!/^\d{8,15}$/.test(normalized)) {
            continue;
        }

        if (!phones.includes(normalized)) {
            phones.push(normalized);
        }
    }

    return phones;
}

/**
 * THE ownership test: does one of the sender's numbers equal the phone
 * recorded on this order?
 *
 * Both sides go through the SAME normalizer the checkout used
 * (lib/guest-identity `normalizePhone`, applied to `Order.phone` by
 * `resolveGuestAddress`), so "0812…", "+62 812…" and "62812…" collapse
 * to one value.
 */
export function orderPhoneMatches(
    senderPhones: string[],
    orderPhone: unknown
): boolean {
    if (!Array.isArray(senderPhones) || senderPhones.length === 0) {
        return false;
    }

    const normalizedOrderPhone = normalizePhone(orderPhone);

    if (!normalizedOrderPhone) {
        return false;
    }

    return senderPhones.includes(normalizedOrderPhone);
}

/**
 * Admin-facing label for a phone number: first two digits, last four.
 * Enough to recognise a customer, not enough to reuse the number.
 */
export function maskPhoneNumber(
    phone: unknown
): string {
    const digits = String(phone ?? "").replace(/\D/g, "");

    if (digits.length < 5) {
        return "****";
    }

    const head = digits.slice(0, 2);
    const tail = digits.slice(-4);
    const hidden = "*".repeat(
        Math.max(0, digits.length - head.length - tail.length)
    );

    return `${head}${hidden}${tail}`;
}

/**
 * Admin-facing label for a chat. Phone-number chats show a masked
 * number; LID chats show an opaque short fingerprint of the JID, so the
 * admin can tell two chats apart without the identifier being exposed.
 */
export function maskChatJid(jid: unknown): string {
    const host = jidHost(jid);

    if (host && PN_HOSTS.has(host)) {
        const phone = normalizePhone(jidUser(jid));

        if (phone) {
            return maskPhoneNumber(phone);
        }
    }

    return `chat-${crypto
        .createHash("sha256")
        .update(String(jid ?? "unknown"))
        .digest("hex")
        .slice(0, 8)}`;
}
