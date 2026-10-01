// lib/fetchWithRetry.ts
import {
  buildUpstreamError,
  type UpstreamError,
} from "./upstream-error";

/*
 * ============================================================
 * SHARED OUTBOUND FETCH HELPER
 * ============================================================
 *
 * Used by lib/rajaongkir.ts and lib/mengantar.ts only.
 *
 * RETRY POLICY (deliberate):
 *   - Read-only methods (GET / HEAD): at most `retries` extra
 *     attempts (default 1) on a TIMEOUT or NETWORK error, with a
 *     small linear backoff.
 *   - Any other method (POST / PUT / PATCH / DELETE): ZERO retries
 *     UNLESS the caller explicitly opts in with `idempotent: true`
 *     (e.g. RajaOngkir domestic-cost, a side-effect-free pricing
 *     POST). Retrying a write is unsafe — Mengantar `POST /order`
 *     and `POST /order/pay-unpaid` are not idempotent, so a lost
 *     response could create a duplicate shipment or double-charge
 *     the seller balance. Those callers must NOT set the flag.
 *
 * NOTE: no caller ever passes its own AbortSignal — fetchWithRetry
 * owns the only abort source (its per-attempt timer), so an abort is
 * always a timeout.
 *
 * TIMEOUT:
 *   `timeoutMs` is the PER-ATTEMPT ceiling. It is deliberately left
 *   at 8s: measured upstream latency for these endpoints is
 *   ≤1s (p100 ~0.7s from the app host), so 8s is already ~11x the
 *   observed worst case. The fix for a slow upstream is the retry +
 *   error normalization below, not a larger ceiling.
 *
 * FAILURE NORMALIZATION:
 *   Every failure is rethrown as an `UpstreamError` carrying an
 *   internal category (UPSTREAM_TIMEOUT / UPSTREAM_NETWORK_ERROR),
 *   so callers never see a raw `AbortError: This operation was
 *   aborted`.
 */

export type FetchWithRetryOptions = {
  /** Extra attempts AFTER the first, for read-only methods only. */
  retries?: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Base backoff; the Nth retry waits `delayMs * (attempt + 1)`. */
  delayMs?: number;
  /**
   * Opt a non-GET request into retries. Only set this for calls
   * that are safe to repeat (no side effects).
   */
  idempotent?: boolean;
};

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  {
    retries = 1,
    timeoutMs = 8000,
    delayMs = 500,
    idempotent = false,
  }: FetchWithRetryOptions = {}
): Promise<Response> {
  const method = String(options.method ?? "GET").toUpperCase();
  const isReadOnly = method === "GET" || method === "HEAD";

  // Read-only + explicitly idempotent calls may retry; writes never do.
  const maxRetries =
    isReadOnly || idempotent ? Math.max(0, retries) : 0;

  let lastError: UpstreamError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);

      const upstreamError = buildUpstreamError(err, timedOut);
      lastError = upstreamError;

      const retryable =
        upstreamError.category === "UPSTREAM_TIMEOUT" ||
        upstreamError.category === "UPSTREAM_NETWORK_ERROR";

      if (!retryable || attempt === maxRetries) break;

      await new Promise((r) =>
        setTimeout(r, delayMs * (attempt + 1))
      );
    }
  }

  throw lastError ?? buildUpstreamError(new Error("unknown"), false);
}
