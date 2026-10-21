/**
 * ==========================================
 * PAYMENT STATUS POLLER (BROWSER)
 * ==========================================
 *
 * The bounded "wait for the webhook to settle the order" loop used by
 * /checkout/payment-finish.
 *
 * It exists as its own module because the previous inline loop could
 * not be tested (it lived inside a React effect) and had five real
 * defects:
 *
 *   1. it CALLED `poll()` from inside a `setState` updater, so React
 *      could run the updater more than once for the same tick;
 *   2. it kept the interval alive after a FINAL status (PAID / FAILED
 *      / EXPIRED), so the page kept hitting `/api/payment/status`;
 *   3. the "max attempts" branch only ran when the updater was
 *      called, so a settled page could still tick;
 *   4. two ticks could overlap: a slow request was still in flight
 *      when the next interval fired;
 *   5. it had no explicit "stopped" state, so the component had to
 *      infer one from `loading`.
 *
 * Contract:
 *   - AT MOST one request in flight at any time
 *   - stops on the first final status
 *   - stops after `maxAttempts` requests (final included)
 *   - `stop()` is idempotent and always clears the timer
 *   - `onDone` runs at most once, on any stop reason
 *
 * The poller never mutates the order: it only reports what the server
 * returned. Payment state stays authoritative on the server.
 */

export const DEFAULT_PAYMENT_STATUS_INTERVAL_MS = 3000;

export const DEFAULT_PAYMENT_STATUS_MAX_ATTEMPTS = 15;

export type PaymentStatusPollerOptions<T> = {
    /**
     * Read the current status. Return `null` when the response is not
     * usable (unexpected body, non-2xx) — that only counts as an
     * attempt. A thrown error is treated the same way.
     */
    fetchStatus: () => Promise<T | null>;
    /** True when the server status can no longer change. */
    isFinal: (status: T) => boolean;
    /** Called with every usable status, in request order. */
    onStatus: (status: T) => void;
    /** Called once when polling stops (final status or budget spent). */
    onDone?: () => void;
    /**
     * Request failures are not fatal (they only spend an attempt);
     * this hook keeps them observable instead of silent.
     */
    onError?: (error: unknown) => void;
    intervalMs?: number;
    maxAttempts?: number;
};

export type PaymentStatusPoller = {
    start: () => void;
    stop: () => void;
    isStopped: () => boolean;
};

export function createPaymentStatusPoller<T>({
    fetchStatus,
    isFinal,
    onStatus,
    onDone,
    onError,
    intervalMs = DEFAULT_PAYMENT_STATUS_INTERVAL_MS,
    maxAttempts = DEFAULT_PAYMENT_STATUS_MAX_ATTEMPTS,
}: PaymentStatusPollerOptions<T>): PaymentStatusPoller {
    let stopped = false;
    let inFlight = false;
    let attempts = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const clearTimer = () => {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };

    const finish = () => {
        if (stopped) {
            return;
        }

        stopped = true;
        clearTimer();

        if (onDone) {
            onDone();
        }
    };

    const stop = () => {
        finish();
    };

    async function poll(): Promise<void> {
        if (stopped || inFlight) {
            return;
        }

        inFlight = true;

        try {
            const status = await fetchStatus();

            /*
             * The component may have unmounted (or the loop may have
             * already settled) while the request was in flight. The
             * late response must not touch any state.
             */
            if (stopped) {
                return;
            }

            attempts += 1;

            if (status !== null) {
                onStatus(status);

                if (isFinal(status)) {
                    finish();
                    return;
                }
            }

            if (attempts >= maxAttempts) {
                finish();
            }
        } catch (error) {
            /*
             * Network errors are not fatal: they only spend an
             * attempt, exactly like an unusable response.
             */
            if (stopped) {
                return;
            }

            if (onError) {
                onError(error);
            }

            attempts += 1;

            if (attempts >= maxAttempts) {
                finish();
            }
        } finally {
            inFlight = false;
        }
    }

    return {
        start() {
            if (stopped) {
                return;
            }

            /*
             * The timer is installed BEFORE the first request so a
             * synchronous settle can still clear it.
             */
            timer = setInterval(() => {
                void poll();
            }, intervalMs);

            void poll();
        },

        stop,

        isStopped() {
            return stopped;
        },
    };
}
