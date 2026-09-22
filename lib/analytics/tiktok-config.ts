import { prisma } from "@/lib/prisma";

import {
    DISABLED_TIKTOK_PIXEL,
    normalizeTikTokPixelId,
    type TikTokPixelConfig,
} from "@/lib/analytics/tiktok";

import {
    analyzeTikTokPixelCode,
    normalizeTikTokPixelName,
} from "@/lib/analytics/tiktok-pixel-code";

/**
 * Ambil konfigurasi TikTok Pixel dari StoreSetting.
 *
 * HANYA dipanggil dari server component / route handler.
 *
 * Yang dikirim ke client adalah JavaScript inline yang
 * sudah dipisahkan dari tag <script> — bukan kode mentah
 * dari halaman admin, dan bukan seluruh isi pengaturan.
 *
 * Kalau pembacaan gagal (mis. kolom belum dimigrasi) pixel
 * dianggap nonaktif — halaman toko tetap bisa dirender.
 */
export async function getTikTokPixelConfig(): Promise<TikTokPixelConfig> {
    try {
        const setting =
            await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: {
                    tiktokPixelEnabled: true,
                    tiktokPixelId: true,
                    tiktokPixelName: true,
                    tiktokPixelCode: true,
                },
            });

        if (!setting?.tiktokPixelEnabled) {
            return { ...DISABLED_TIKTOK_PIXEL };
        }

        const analysis = analyzeTikTokPixelCode(
            setting.tiktokPixelCode
        );

        /*
         * Pixel hanya dijalankan kalau ada kode yang
         * benar-benar bisa dieksekusi.
         */
        if (analysis.isEmpty) {
            return { ...DISABLED_TIKTOK_PIXEL };
        }

        return {
            enabled: true,

            /*
             * Pixel ID dipakai sebagai metadata
             * (data-pixel-id) dan untuk deteksi
             * mismatch di admin — bukan untuk
             * membangun script.
             */
            pixelId: normalizeTikTokPixelId(
                setting.tiktokPixelId
            ),

            pixelName: normalizeTikTokPixelName(
                setting.tiktokPixelName
            ),

            script: analysis.script,
        };
    } catch (error) {
        console.error(
            "GET TIKTOK PIXEL CONFIG ERROR:",
            error
        );

        return { ...DISABLED_TIKTOK_PIXEL };
    }
}
