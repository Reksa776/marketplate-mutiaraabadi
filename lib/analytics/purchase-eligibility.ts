/**
 * ==========================================
 * BROWSER PURCHASE ELIGIBILITY
 * ==========================================
 *
 * Which orders may emit a browser CompletePayment / Purchase on the
 * confirmation page.
 *
 * WHY THIS IS A MODULE:
 *   The confirmation page is reachable by URL for ANY order the
 *   session owns. Without this gate an unpaid (PENDING / PROCESSING /
 *   FAILED / EXPIRED) order would emit a conversion with the SAME
 *   deterministic event_id as the authoritative server event — a false
 *   conversion that the vendor's dedup window could then use to
 *   suppress the real one.
 *
 *   It lives here (instead of inline in the page) so the rules are
 *   unit-tested directly rather than only guessed from source text.
 *
 * The shared purchase claim (lib/analytics/purchase-claim) is a
 * DUPLICATE guard, not an eligibility guard: it never decides whether
 * an order is convertible, only whether this browser already emitted.
 */

export type BrowserPurchaseEligibilityInput = {
    paymentStatus: string;
    paymentMethod: string | null | undefined;
    status: string;
};

/**
 * True when this order may emit exactly one browser Purchase.
 *
 *  - PAID: the authoritative conversion.
 *  - COD: its paymentStatus stays UNPAID and it has no payment
 *    webhook, so the placed order itself is the conversion. A
 *    refunded or cancelled COD order must never fire.
 *  - everything else (PENDING, FAILED, EXPIRED, REFUNDED non-COD):
 *    not convertible.
 */
export function isBrowserPurchaseEligible({
    paymentStatus,
    paymentMethod,
    status,
}: BrowserPurchaseEligibilityInput): boolean {
    if (paymentStatus === "PAID") {
        return true;
    }

    return (
        paymentMethod === "COD" &&
        paymentStatus !== "REFUNDED" &&
        status !== "CANCELLED"
    );
}
