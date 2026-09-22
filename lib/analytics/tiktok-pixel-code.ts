/**
 * ==========================================
 * TIKTOK PIXEL CODE (ADMIN CONFIGURED)
 * ==========================================
 *
 * Admin dapat menyimpan base code TikTok apa adanya
 * (termasuk tag <script> dari TikTok Events Manager).
 *
 * File ini TIDAK melakukan sanitasi terhadap isi
 * JavaScript — requirement memang mengizinkan admin
 * menyimpan custom Pixel Code, dan sanitasi agresif
 * akan merusak pixel.
 *
 * Yang dilakukan di sini hanya:
 *   - mengambil isi <script> ... </script> supaya bisa
 *     dieksekusi lewat next/script
 *   - mempertahankan format asli (multiline)
 *   - membaca metadata (ttq.load / ttq.page) untuk
 *     peringatan di admin, TANPA mengubah kode
 */

export const MAX_TIKTOK_PIXEL_CODE_LENGTH = 20000;

export const MAX_TIKTOK_PIXEL_NAME_LENGTH = 100;

export type TikTokPixelCodeAnalysis = {
    /** Kode berisi tag <script> ... </script> */
    hasScriptTag: boolean;

    /** src dari <script src="..."> yang tidak punya isi inline */
    externalScriptSources: string[];

    /** JavaScript inline yang benar-benar dieksekusi */
    script: string;

    /** Tidak ada JavaScript yang bisa dijalankan */
    isEmpty: boolean;

    /** Pixel ID yang ditemukan di ttq.load("...") */
    pixelIds: string[];

    hasLoadCall: boolean;
    hasPageCall: boolean;

    /** Peringatan (informatif): kode memanggil ttq.identify (Advanced Matching) */
    hasIdentifyCall: boolean;
};

const SCRIPT_BLOCK_PATTERN =
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const SCRIPT_SRC_PATTERN = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i;

const LOAD_CALL_PATTERN =
    /ttq\s*\.\s*load\s*\(\s*["']([^"']+)["']/gi;

/**
 * Ambil nilai dari `ttq.load("...")` di dalam kode.
 */
export function extractTikTokPixelIds(
    code: string
): string[] {
    if (typeof code !== "string" || !code) {
        return [];
    }

    const ids: string[] = [];

    for (const match of code.matchAll(
        LOAD_CALL_PATTERN
    )) {
        const id = match[1]?.trim();

        if (id && !ids.includes(id)) {
            ids.push(id);
        }
    }

    return ids;
}

/**
 * Analisa kode pixel tanpa mengubahnya.
 */
export function analyzeTikTokPixelCode(
    code: string | null | undefined
): TikTokPixelCodeAnalysis {
    const raw = typeof code === "string" ? code : "";

    const inlineParts: string[] = [];
    const externalScriptSources: string[] = [];

    let hasScriptTag = false;

    for (const match of raw.matchAll(
        SCRIPT_BLOCK_PATTERN
    )) {
        hasScriptTag = true;

        const attributes = match[1] ?? "";
        const inner = match[2] ?? "";
        const srcMatch = SCRIPT_SRC_PATTERN.exec(
            attributes
        );

        if (srcMatch) {
            const src =
                srcMatch[2] ??
                srcMatch[3] ??
                "";

            if (src) {
                externalScriptSources.push(src);
            }
        }

        if (inner.trim()) {
            inlineParts.push(inner.trim());
        }
    }

    /*
     * Kalau admin menempel JavaScript tanpa tag <script>,
     * pakai apa adanya.
     */
    const script = hasScriptTag
        ? inlineParts.join("\n")
        : raw.trim();

    const pixelIds =
        extractTikTokPixelIds(raw);

    return {
        hasScriptTag,
        externalScriptSources,
        script,
        isEmpty: script.trim().length === 0,
        pixelIds,
        hasLoadCall: /ttq\s*\.\s*load\s*\(/i.test(
            raw
        ),
        hasPageCall: /ttq\s*\.\s*page\s*\(/i.test(
            raw
        ),
        hasIdentifyCall:
            /ttq\s*\.\s*identify\s*\(/i.test(raw),
    };
}

/**
 * Normalisasi nilai yang dikirim admin.
 *
 * - hanya string
 * - membuang spasi di luar kode saja
 * - TIDAK mengubah isi kode (multiline & indentasi
 *   dipertahankan apa adanya)
 * - batas panjang supaya tidak ada payload raksasa
 *
 * Mengembalikan null kalau nilainya tidak valid.
 */
export function normalizeTikTokPixelCode(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const code = value.trim();

    if (!code) {
        return null;
    }

    if (
        code.length >
        MAX_TIKTOK_PIXEL_CODE_LENGTH
    ) {
        return null;
    }

    return code;
}

/**
 * Nama pixel (label dari TikTok Events Manager).
 */
export function normalizeTikTokPixelName(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const name = value.trim();

    if (!name) {
        return null;
    }

    return name.slice(
        0,
        MAX_TIKTOK_PIXEL_NAME_LENGTH
    );
}

/**
 * Cari Pixel ID di dalam kode yang BERBEDA dengan
 * Pixel ID di settings.
 *
 * Mengembalikan null kalau tidak ada konflik, atau
 * kalau salah satunya tidak ada.
 *
 * TIDAK mengubah kode — admin yang memutuskan.
 */
export function findTikTokPixelIdMismatch(
    configuredPixelId: string | null | undefined,
    code: string | null | undefined
): string | null {
    if (!configuredPixelId || !code) {
        return null;
    }

    const idsInCode =
        extractTikTokPixelIds(code);

    if (idsInCode.length === 0) {
        return null;
    }

    const configured =
        configuredPixelId.trim().toUpperCase();

    const mismatch = idsInCode.find(
        (id) => id.trim().toUpperCase() !== configured
    );

    return mismatch ?? null;
}
