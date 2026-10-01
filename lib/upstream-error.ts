/*
 * ============================================================
 * UPSTREAM ERROR NORMALIZATION
 * ============================================================
 *
 * A single, dependency-free classification for outbound fetch
 * failures (RajaOngkir, Mengantar, ...). Before this, a timeout
 * surfaced as a raw `AbortError: This operation was aborted` in the
 * logs and, at the HTTP layer, as an indistinguishable 500/502.
 *
 * Categories are INTERNAL only. Routes translate them into a safe,
 * user-facing message and must never return the category, a stack
 * trace, an upstream URL containing a key, or an upstream body.
 */

export type UpstreamErrorCategory =
    | "UPSTREAM_TIMEOUT"
    | "UPSTREAM_NETWORK_ERROR"
    | "UPSTREAM_HTTP_ERROR";

export class UpstreamError extends Error {
    readonly category: UpstreamErrorCategory;
    readonly status?: number;

    constructor(
        category: UpstreamErrorCategory,
        message: string,
        options?: { status?: number; cause?: unknown }
    ) {
        super(message);

        this.name = "UpstreamError";
        this.category = category;
        this.status = options?.status;

        if (options?.cause !== undefined) {
            (this as { cause?: unknown }).cause =
                options.cause;
        }
    }
}

/**
 * A timeout abort is a DOMException named "AbortError" in undici /
 * browsers; some runtimes use "TimeoutError". Both mean the same
 * thing here.
 */
export function isAbortError(error: unknown): boolean {
    if (
        typeof error !== "object" ||
        error === null
    ) {
        return false;
    }

    const name = (error as { name?: string }).name;

    return name === "AbortError" || name === "TimeoutError";
}

/**
 * Classify a thrown fetch error. `timedOutByUs` is true when OUR own
 * AbortController timer fired (the only abort source inside
 * fetchWithRetry — callers never pass their own signal).
 */
export function buildUpstreamError(
    error: unknown,
    timedOutByUs: boolean
): UpstreamError {
    if (timedOutByUs || isAbortError(error)) {
        return new UpstreamError(
            "UPSTREAM_TIMEOUT",
            "Upstream request timed out.",
            { cause: error }
        );
    }

    const causeCode =
        (error as { cause?: { code?: string } })?.cause
            ?.code ??
        (error as { code?: string })?.code;

    if (error instanceof TypeError || causeCode) {
        return new UpstreamError(
            "UPSTREAM_NETWORK_ERROR",
            "Upstream network error.",
            { cause: error }
        );
    }

    return new UpstreamError(
        "UPSTREAM_NETWORK_ERROR",
        "Upstream request failed.",
        { cause: error }
    );
}

export function isUpstreamError(
    error: unknown
): error is UpstreamError {
    return error instanceof UpstreamError;
}

export function isUpstreamTimeout(
    error: unknown
): boolean {
    return (
        error instanceof UpstreamError &&
        error.category === "UPSTREAM_TIMEOUT"
    );
}
