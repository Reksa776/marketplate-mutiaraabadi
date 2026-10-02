import { isAdminPath } from "@/lib/analytics/tiktok";

/**
 * ==========================================
 * TIKTOK PAGEVIEW — NAVIGATION RULE
 * ==========================================
 *
 * Pure, client-safe decision logic for the application-controlled
 * PageView. Kept out of the React component so the rule is directly
 * testable without a DOM / renderer.
 *
 * WHY PAGEVIEW IS APPLICATION-CONTROLLED:
 *   `ttq.page()` (admin base code) is queued synchronously at Pixel
 *   load, i.e. before Advanced Matching identity is applied, so
 *   PageView could never carry email/phone. The base-code call is
 *   stripped (lib/analytics/tiktok-config) and PageView is emitted by
 *   components/analytics/TikTokPageViewTracker after
 *   `whenTikTokReadyForEvents()`.
 */

/**
 * A navigation is identified by its pathname PLUS its query string, so
 * a "same pathname, different filters" SPA navigation is its own
 * PageView, while a re-render of the same URL is not.
 */
export function tiktokPageViewSignature(
    pathname: string | null | undefined,
    search: string | null | undefined
): string {
    const path = pathname ?? "";

    if (!search) {
        return path;
    }

    return `${path}?${search}`;
}

export type TikTokPageViewDecision = {
    enabled: boolean;
    pathname: string | null | undefined;
    /** Navigation signature of the CURRENT render. */
    signature: string;
    /** Signature the tracker already fired for, if any. */
    lastFiredSignature: string | null;
};

/**
 * True when this navigation should emit PageView.
 *
 * - disabled / admin routes → never
 * - the same navigation twice → never (Strict Mode, re-render,
 *   hydration must not duplicate)
 * - a new pathname/search → yes
 *
 * Anonymous visitors are NOT excluded: identity settling as `null` is
 * a legitimate state, and PageView must still fire (with no fabricated
 * identifier — identity only ever travels via `ttq.identify()`).
 */
export function shouldTrackTikTokPageView(
    decision: TikTokPageViewDecision
): boolean {
    if (!decision.enabled) {
        return false;
    }

    if (isAdminPath(decision.pathname)) {
        return false;
    }

    return (
        decision.lastFiredSignature !== decision.signature
    );
}
