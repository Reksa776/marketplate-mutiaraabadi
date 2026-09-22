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
 */
export default async function AnalyticsProvider() {
    const tiktokPixel =
        await getTikTokPixelConfig();

    return (
        <TikTokPixel
            enabled={tiktokPixel.enabled}
            pixelId={tiktokPixel.pixelId}
            pixelName={tiktokPixel.pixelName}
            script={tiktokPixel.script}
        />
    );
}
