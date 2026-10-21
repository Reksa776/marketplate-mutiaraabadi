import { Suspense } from "react";

import TikTokAdvancedMatching from "./TikTokAdvancedMatching";
import TikTokAttribution from "./TikTokAttribution";
import TikTokPageViewTracker from "./TikTokPageViewTracker";
import TikTokPixel from "./TikTokPixel";
import MetaPixel from "./MetaPixel";
import { extractMetaPixelId, normalizeMetaPixelCode, stripMetaAutomaticPageView } from "@/lib/analytics/meta-pixel-code";

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
 * Advanced Matching: identifier pelanggan diambil oleh
 * endpoint server khusus (authenticated-only) — bukan dari
 * HTML maupun bundle client. Endpoint itu mengembalikan
 * DIGEST SHA-256 saja (tidak pernah email/nomor mentah),
 * lalu Browser Pixel meneruskannya apa adanya ke
 * `ttq.identify()`. Events API server memakai digest yang
 * sama persis, jadi kedua channel menunjuk orang yang sama.
 */
export default async function AnalyticsProvider() {
    const tiktokPixel =
        await getTikTokPixelConfig();
    const metaPixel = await (async () => {
        try {
            const { prisma } = await import("@/lib/prisma");
            const setting = await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: { metaPixelEnabled: true, metaPixelId: true, metaPixelCode: true },
            });
            const code = normalizeMetaPixelCode(setting?.metaPixelCode);
            const pixelId = extractMetaPixelId(code) ?? setting?.metaPixelId?.trim() ?? "";
            return {
                enabled: setting?.metaPixelEnabled === true && /^\d{5,20}$/.test(pixelId),
                pixelId: /^\d{5,20}$/.test(pixelId) ? pixelId : null,
                script: stripMetaAutomaticPageView(code),
            };
        } catch {
            return { enabled: false, pixelId: null, script: "" };
        }
    })();

    return (
        <>
            <Suspense fallback={null}>
                <MetaPixel enabled={metaPixel.enabled} pixelId={metaPixel.pixelId} script={metaPixel.script} />
            </Suspense>
            <TikTokPixel
                enabled={tiktokPixel.enabled}
                pixelId={tiktokPixel.pixelId}
                pixelName={tiktokPixel.pixelName}
                script={tiktokPixel.script}
            />

            <TikTokAdvancedMatching
                enabled={tiktokPixel.enabled}
            />

            {/*
             * Application-controlled PageView. The base code's own
             * `ttq.page()` is stripped, so this is the ONLY source of
             * PageView — fired after Advanced Matching identity has
             * settled. Wrapped in Suspense because it reads search
             * params (required by the App Router).
             */}
            <Suspense fallback={null}>
                <TikTokPageViewTracker
                    enabled={tiktokPixel.enabled}
                />
            </Suspense>

            <TikTokAttribution />
        </>
    );
}
