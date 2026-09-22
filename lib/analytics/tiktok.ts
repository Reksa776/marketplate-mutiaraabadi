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
                properties?: TikTokEventProperties
            ) => void;
            page?: () => void;
        };
    }
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
 */
export function trackTikTokEvent(
    event: string,
    properties?: TikTokEventProperties
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
        window.ttq.track(
            event,
            properties
        );
    } catch (error) {
        console.error(
            "TIKTOK TRACK ERROR:",
            error
        );
    }
}
