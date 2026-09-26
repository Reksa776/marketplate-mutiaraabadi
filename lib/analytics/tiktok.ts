export type TikTokEventProperties = Record<
    string,
    unknown
>;

/**
 * Konfigurasi TikTok Pixel yang dipakai storefront.
 *
 * `script` sudah berupa JavaScript inline yang siap
 * dieksekusi (tag <script> dari kode admin sudah
 * dibuang oleh lib/analytics/tiktok-pixel-code).
 */
export type TikTokPixelConfig = {
    enabled: boolean;
    pixelId: string | null;
    pixelName: string | null;
    script: string;
};

export const DISABLED_TIKTOK_PIXEL: TikTokPixelConfig = {
    enabled: false,
    pixelId: null,
    pixelName: null,
    script: "",
};

/**
 * Area internal (dashboard admin) yang TIDAK boleh
 * dikirim ke TikTok.
 */
export const ADMIN_PATH_PREFIX = "/admin";

/**
 * TikTok Pixel ID yang valid:
 *
 * - panjang 10–30 karakter
 * - hanya huruf kapital A–Z dan angka 0–9
 *
 * Aturan ini otomatis menolak JavaScript, HTML, URL,
 * spasi, tanda kutip, dan karakter lain yang bisa
 * disalahgunakan sebagai script injection.
 */
export const TIKTOK_PIXEL_ID_PATTERN = /^[A-Z0-9]{10,30}$/;

declare global {
    interface Window {
        ttq?: {
            track: (
                event: string,
                properties?: TikTokEventProperties,
                /*
                 * TikTok Pixel's own third argument. The pixel
                 * expects the snake_case `event_id` key.
                 */
                options?: { event_id?: string }
            ) => void;
            page?: () => void;
            /**
             * Manual Advanced Matching.
             *
             * ALWAYS fed with SHA-256 digests — never raw PII
             * (see lib/analytics/tiktok-user-match).
             */
            identify?: (
                identifiers: TikTokUserMatchIdentifiers
            ) => void;
        };
    }
}

/**
 * TikTok Pixel event options.
 *
 * `event_id` is the deduplication key: the SAME value must be
 * sent by the browser Pixel and the server-side Events API so
 * TikTok keeps a single conversion.
 */
export type TikTokEventOptions = {
    eventId?: string;
};

export const TIKTOK_EVENT_ID_PREFIX = "ttq";

/**
 * Event name TikTokPixel dispatches once the base code is mounted.
 */
export const TIKTOK_PIXEL_READY_EVENT =
    "tiktok-pixel-ready";

/**
 * Give up waiting for a Pixel that never loads (blocked script,
 * offline visitor) instead of holding timers forever.
 */
export const TIKTOK_PIXEL_READY_TIMEOUT_MS = 15000;

/** How often to re-check for `window.ttq`. */
export const TIKTOK_PIXEL_READY_POLL_MS = 250;

/** True once the TikTok base code has registered `window.ttq`. */
export function isTikTokPixelReady(): boolean {
    return (
        typeof window !== "undefined" &&
        Boolean(window.ttq)
    );
}

/**
 * Run `callback` as soon as the Pixel can accept events, then stop.
 *
 * Needed because the base code loads asynchronously: an event fired
 * before `window.ttq` exists is silently dropped. Waiting for one
 * "ready" event is not enough either, since that event can fire
 * BEFORE the page's effects subscribe to it (the layout mounts
 * first), so this also polls until `window.ttq` appears.
 *
 * The callback runs AT MOST once. Returns a cancel function.
 */
export function whenTikTokPixelReady(
    callback: () => void,
    options?: {
        timeoutMs?: number;
        pollMs?: number;
    }
): () => void {
    if (typeof window === "undefined") {
        return () => {};
    }

    if (isTikTokPixelReady()) {
        callback();
        return () => {};
    }

    const timeoutMs =
        options?.timeoutMs ??
        TIKTOK_PIXEL_READY_TIMEOUT_MS;

    const pollMs =
        options?.pollMs ??
        TIKTOK_PIXEL_READY_POLL_MS;

    let settled = false;
    let interval: ReturnType<typeof setInterval> | null =
        null;
    let timeout: ReturnType<typeof setTimeout> | null =
        null;

    /* Not every environment exposing `window` supports events. */
    const canListen =
        typeof window.addEventListener ===
        "function";

    const stop = () => {
        if (interval !== null) {
            clearInterval(interval);
            interval = null;
        }

        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }

        if (!canListen) {
            return;
        }

        window.removeEventListener(
            TIKTOK_PIXEL_READY_EVENT,
            onReady
        );
    };

    const finish = () => {
        if (settled) {
            return;
        }

        settled = true;
        stop();
        callback();
    };

    function onReady() {
        finish();
    }

    if (canListen) {
        window.addEventListener(
            TIKTOK_PIXEL_READY_EVENT,
            onReady
        );
    }

    interval = setInterval(() => {
        if (isTikTokPixelReady()) {
            finish();
        }
    }, pollMs);

    timeout = setTimeout(() => {
        settled = true;
        stop();
    }, timeoutMs);

    return () => {
        settled = true;
        stop();
    };
}

/**
 * Build a deterministic event id shared by the browser Pixel and
 * the server Events API.
 *
 * Deterministic (not random) so both channels produce the exact
 * same string for the same logical action.
 *
 * Contains NO secret: only the event name and a public reference
 * (e.g. the order number, which is already exposed to the buyer).
 */
export function buildTikTokEventId(
    event: string,
    reference: string | number
): string {
    const safeEvent = String(event)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");

    const safeReference = String(reference).trim();

    return `${TIKTOK_EVENT_ID_PREFIX}:${safeEvent}:${safeReference}`;
}

/**
 * Normalisasi nilai mentah menjadi Pixel ID yang
 * aman disimpan.
 *
 * Mengembalikan null kalau nilainya tidak valid.
 */
export function normalizeTikTokPixelId(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value
        .trim()
        .toUpperCase();

    return isValidTikTokPixelId(normalized)
        ? normalized
        : null;
}

/**
 * Validasi Pixel ID yang SUDAH dinormalisasi.
 */
export function isValidTikTokPixelId(
    value: unknown
): value is string {
    return (
        typeof value === "string" &&
        TIKTOK_PIXEL_ID_PATTERN.test(
            value
        )
    );
}

/**
 * Route internal (admin dashboard) tidak ikut
 * dilacak supaya aktivitas admin tidak terkirim
 * ke TikTok.
 */
export function isAdminPath(
    pathname: string | null | undefined
): boolean {
    if (!pathname) {
        return false;
    }

    return (
        pathname === ADMIN_PATH_PREFIX ||
        pathname.startsWith(
            `${ADMIN_PATH_PREFIX}/`
        )
    );
}

/**
 * Kirim event TikTok dari komponen client.
 *
 * TIDAK ada Advanced Matching / PII di sini:
 * hanya event + parameter yang sudah dipilih
 * pemanggil (harga, nama produk, dsb).
 *//**
 * Advanced Matching identifiers, exactly as TikTok's
 * `ttq.identify()` names them.
 *
 * Every value MUST already be a SHA-256 digest. This module never
 * sees, computes from, or forwards a raw email / phone number.
 */
export type TikTokUserMatchIdentifiers = {
    email?: string;
    phone_number?: string;
    external_id?: string;
};

/**
 * Register Advanced Matching keys for the current visitor.
 *
 * TikTok applies them to the events that follow, which is why this
 * runs before any tracked event. It sends NO event by itself, so it
 * can never double a PageView.
 *
 * Returns true when the pixel accepted the identifiers.
 */
export function trackTikTokUserMatch(
    identifiers: TikTokUserMatchIdentifiers
): boolean {
    if (
        typeof window === "undefined" ||
        !window.ttq ||
        typeof window.ttq.identify !==
            "function"
    ) {
        return false;
    }

    const payload: TikTokUserMatchIdentifiers =
        {};

    if (identifiers.email) {
        payload.email = identifiers.email;
    }

    if (identifiers.phone_number) {
        payload.phone_number =
            identifiers.phone_number;
    }

    if (identifiers.external_id) {
        payload.external_id =
            identifiers.external_id;
    }

    /*
     * Nothing usable: skip entirely instead of pushing an empty
     * object (never a placeholder, never a hash of nothing).
     */
    if (
        Object.keys(payload).length === 0
    ) {
        return false;
    }

    try {
        window.ttq.identify(payload);
        return true;
    } catch (error) {
        console.error(
            "TIKTOK IDENTIFY ERROR:",
            error
        );

        return false;
    }
}

export function trackTikTokEvent(
    event: string,
    properties?: TikTokEventProperties,
    options?: TikTokEventOptions
) {
    if (
        typeof window === "undefined" ||
        !window.ttq ||
        typeof window.ttq.track !==
            "function"
    ) {
        return;
    }

    try {
        /*
         * When an event id is present we pass it as the pixel's
         * third argument so TikTok can deduplicate this event
         * against the server-side Events API copy.
         */
        if (options?.eventId) {
            window.ttq.track(
                event,
                properties,
                { event_id: options.eventId }
            );
        } else {
            window.ttq.track(
                event,
                properties
            );
        }
    } catch (error) {
        console.error(
            "TIKTOK TRACK ERROR:",
            error
        );
    }
}
