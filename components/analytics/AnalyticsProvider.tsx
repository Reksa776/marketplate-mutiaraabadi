import TikTokAdvancedMatching from "./TikTokAdvancedMatching";
import TikTokAttribution from "./TikTokAttribution";
import TikTokPixel from "./TikTokPixel";

import { getTikTokPixelConfig } from "@/lib/analytics/tiktok-config";

/**
 * Server component: resolusi konfigurasi TikTok Pixel
 * dari database.
 *
 * Browser tidak pernah memanggil API pengaturan untuk
 * mendapatkan Pixel ID / Pixel Code — yang dikirim ke
 * client hanya konfigurasi yang diperlukan untuk
 * rendering storefront.
 *
 * Token akses (server-only) TIDAK pernah ikut ke sini.
 *
 * Advanced Matching hanya menerima DIGEST (SHA-256) dari
 * endpoint server; data mentah pelanggan tidak pernah
 * dirender ke HTML maupun ke bundle client.
 */
export default async function AnalyticsProvider() {
    const tiktokPixel =
        await getTikTokPixelConfig();

    return (
        <>
            <TikTokPixel
                enabled={tiktokPixel.enabled}
                pixelId={tiktokPixel.pixelId}
                pixelName={tiktokPixel.pixelName}
                script={tiktokPixel.script}
            />

            <TikTokAdvancedMatching
                enabled={tiktokPixel.enabled}
            />

            <TikTokAttribution />
        </>
    );
}
