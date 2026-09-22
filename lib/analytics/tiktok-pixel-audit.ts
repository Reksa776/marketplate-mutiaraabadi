import { createHash } from "node:crypto";

export type TikTokPixelSnapshot = {
    enabled: boolean;
    pixelId: string | null;
    pixelName: string | null;
    code: string | null;
};

/**
 * Hash pendek dari Pixel Code.
 *
 * Dipakai untuk mendeteksi perubahan kode tanpa
 * menyimpan kode itu sendiri.
 */
export function hashTikTokPixelCode(
    code: string | null | undefined
): string | null {
    if (!code) {
        return null;
    }

    return createHash("sha256")
        .update(code)
        .digest("hex")
        .slice(0, 16);
}

/**
 * Metadata untuk audit log TIKTOK_PIXEL_UPDATED.
 *
 * PENTING: raw Pixel Code TIDAK PERNAH masuk sini.
 * Yang dicatat hanya status, ID, nama, panjang kode,
 * dan hash-nya.
 */
export function buildTikTokPixelAuditMetadata(
    previous: TikTokPixelSnapshot | null,
    next: TikTokPixelSnapshot
): Record<string, unknown> {
    const previousCode = previous?.code ?? null;
    const nextCode = next.code ?? null;

    return {
        enabled: next.enabled,
        pixelId: next.pixelId,
        pixelName: next.pixelName,

        // Sebelumnya ada / tidak ada kode
        hadPixelCodeBefore:
            previousCode !== null,
        hasPixelCode: nextCode !== null,

        // Perubahan + ukuran + hash (bukan isi kode)
        pixelCodeChanged:
            previousCode !== nextCode,
        pixelCodeLength: nextCode?.length ?? 0,
        pixelCodeHash: hashTikTokPixelCode(
            nextCode
        ),
    };
}

/**
 * True kalau konfigurasi TikTok Pixel berubah.
 */
export function hasTikTokPixelChanges(
    previous: TikTokPixelSnapshot | null,
    next: TikTokPixelSnapshot
): boolean {
    if (!previous) {
        return true;
    }

    return (
        previous.enabled !== next.enabled ||
        previous.pixelId !== next.pixelId ||
        previous.pixelName !== next.pixelName ||
        (previous.code ?? null) !==
        (next.code ?? null)
    );
}
