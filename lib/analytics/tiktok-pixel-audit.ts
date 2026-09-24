import { createHash } from "node:crypto";

import { last4OfTikTokAccessToken } from "@/lib/analytics/tiktok-access-token";

export type TikTokPixelSnapshot = {
    enabled: boolean;
    pixelId: string | null;
    pixelName: string | null;
    code: string | null;
    /**
     * Server-only Events API credential. Optional so older
     * callers/tests that predate the token keep compiling.
     * NEVER written to the audit log in raw form.
     */
    accessToken?: string | null;
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
    return shortHash(code);
}

/**
 * Hash pendek dari Access Token.
 *
 * Dipakai untuk mendeteksi pergantian token di audit log
 * TANPA menyimpan token itu sendiri.
 */
export function hashTikTokAccessToken(
    token: string | null | undefined
): string | null {
    return shortHash(token);
}

function shortHash(
    value: string | null | undefined
): string | null {
    if (!value) {
        return null;
    }

    return createHash("sha256")
        .update(value)
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

    const previousToken = previous?.accessToken ?? null;
    const nextToken = next.accessToken ?? null;

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

        /*
         * Access Token: HANYA metadata aman. Raw token tidak
         * pernah masuk audit log — yang disimpan cuma status,
         * panjang, last-4, dan hash-nya.
         */
        accessTokenChanged:
            previousToken !== nextToken,
        accessTokenConfigured:
            nextToken !== null,
        accessTokenLength: nextToken?.length ?? 0,
        accessTokenLast4: last4OfTikTokAccessToken(
            nextToken
        ),
        accessTokenHash: hashTikTokAccessToken(
            nextToken
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
        (next.code ?? null) ||
        (previous.accessToken ?? null) !==
            (next.accessToken ?? null)
    );
}
