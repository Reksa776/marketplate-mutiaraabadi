import {
    whenTikTokPixelReady,
    type TikTokUserMatchIdentifiers,
} from "@/lib/analytics/tiktok";

/**
 * ==========================================
 * TIKTOK IDENTITY READINESS (BROWSER)
 * ==========================================
 *
 * A single, shared readiness signal for Advanced Matching.
 *
 * PROBLEM IT SOLVES:
 *   Browser events used to fire as soon as the Pixel was ready,
 *   independently of the async Advanced Matching lookup. A
 *   signed-in customer's first events could therefore be sent
 *   WITHOUT identity.
 *
 * CONTRACT:
 *   - anonymous / pixel-disabled / admin: settled immediately
 *     (never blocks tracking)
 *   - authenticated: settles only after `ttq.identify()` has been
 *     applied (or after a bounded timeout, so a blocked Pixel can
 *     never stall the app)
 *
 * Event components call `whenTikTokReadyForEvents()` instead of
 * talking to the Pixel or the store directly.
 */

type Listener = (
    identifiers: TikTokUserMatchIdentifiers | null
) => void;

let settled = false;
let identifiers: TikTokUserMatchIdentifiers | null =
    null;

const listeners = new Set<Listener>();

/** True when two identifier sets carry exactly the same digests. */
function sameIdentifiers(
    a: TikTokUserMatchIdentifiers,
    b: TikTokUserMatchIdentifiers
): boolean {
    return (
        a.email === b.email &&
        a.phone_number === b.phone_number &&
        a.external_id === b.external_id
    );
}

/**
 * Upper bound on how long an event waits for identity. Mirrors the
 * Pixel readiness budget: if identity cannot be established, events
 * still fire (anonymous) rather than being lost.
 */
export const TIKTOK_IDENTITY_WAIT_TIMEOUT_MS = 4000;

/** Identifiers currently known to the browser (may be null). */
export function getTikTokIdentity():
    | TikTokUserMatchIdentifiers
    | null {
    return identifiers;
}

/** True once identity resolution has finished. */
export function isTikTokIdentitySettled(): boolean {
    return settled;
}

/**
 * Mark identity resolution as finished and notify every waiter.
 * Idempotent: the first settlement wins.
 */
export function settleTikTokIdentity(
    next: TikTokUserMatchIdentifiers | null
): void {
    if (settled) {
        return;
    }

    settled = true;
    identifiers = next;

    const pending = Array.from(listeners);
    listeners.clear();

    for (const listener of pending) {
        try {
            listener(next);
        } catch {
            /* A listener must never break settlement. */
        }
    }
}

/**
 * Raise a previously-anonymous identity to a real one.
 *
 * WHY THIS EXISTS:
 *   The store is a one-shot settlement, which is correct for the
 *   common case. But a visitor can become authenticated mid-session
 *   (login / register without a full page load). The first
 *   settlement then recorded "anonymous" and the real identifiers
 *   that arrive afterwards had nowhere to go, so any event
 *   registered in that window fired without matching keys.
 *
 *   Upgrading is deliberately narrow:
 *     - anonymous  -> identified : allowed (the fix)
 *     - identified -> identified : allowed (identifier refresh)
 *     - anything   -> anonymous  : IGNORED, so identity can never
 *                                   be downgraded or lost
 *
 *   Waiters are NOT re-notified: they have already fired (that is
 *   what "settled" means). This only makes the identifiers visible
 *   to events registered AFTER the upgrade.
 */
export function upgradeTikTokIdentity(
    next: TikTokUserMatchIdentifiers | null
): void {
    /* Never downgrade, and never upgrade to nothing. */
    if (!next) {
        return;
    }

    if (identifiers && sameIdentifiers(identifiers, next)) {
        return;
    }

    identifiers = next;
}

/**
 * Run `callback` once identity resolution has settled.
 *
 * - already settled → synchronous, returns a no-op cancel
 * - otherwise → queued, with a bounded timeout that settles as
 *   anonymous so tracking is never blocked forever
 */
export function whenTikTokIdentitySettled(
    callback: Listener,
    options?: {
        timeoutMs?: number;
    }
): () => void {
    if (settled) {
        callback(identifiers);
        return () => {};
    }

    let finished = false;

    const listener: Listener = (value) => {
        if (finished) {
            return;
        }

        finished = true;
        callback(value);
    };

    listeners.add(listener);

    const timeout = setTimeout(() => {
        listeners.delete(listener);

        if (finished) {
            return;
        }

        finished = true;
        callback(null);
    }, options?.timeoutMs ?? TIKTOK_IDENTITY_WAIT_TIMEOUT_MS);

    return () => {
        finished = true;
        listeners.delete(listener);
        clearTimeout(timeout);
    };
}

/**
 * Run `callback` once BOTH identity has settled and the Pixel can
 * accept events. This is the one entry point event components use:
 *
 *   authenticated → identity applied first, THEN the event
 *   anonymous     → identity settles immediately, unchanged from
 *                   before (no extra blocking)
 *
 * Returns a cancel function. The callback runs at most once.
 */
export function whenTikTokReadyForEvents(
    callback: () => void,
    options?: {
        identityTimeoutMs?: number;
    }
): () => void {
    let cancelPixel: () => void = () => {};

    const cancelIdentity = whenTikTokIdentitySettled(
        () => {
            cancelPixel = whenTikTokPixelReady(
                callback
            );
        },
        { timeoutMs: options?.identityTimeoutMs }
    );

    return () => {
        cancelIdentity();
        cancelPixel();
    };
}

/**
 * Test-only reset so the module-level state does not leak between
 * tests.
 */
export function resetTikTokIdentityForTests(): void {
    settled = false;
    identifiers = null;
    listeners.clear();
}
