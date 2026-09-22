"use client";

import Script from "next/script";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import {
    isAdminPath,
    type TikTokPixelConfig,
} from "@/lib/analytics/tiktok";

/**
 * ==========================================
 * TIKTOK PIXEL — STOREFRONT
 * ==========================================
 *
 * Script yang dieksekusi adalah kode dari Admin
 * Settings (sudah dipisahkan dari tag <script> di
 * lib/analytics/tiktok-pixel-code).
 *
 * Application code TIDAK menambahkan ttq.page():
 * base code milik admin yang bertanggung jawab atas
 * initialization + PageView.
 */
export default function TikTokPixel({
    enabled,
    pixelId,
    pixelName,
    script,
}: TikTokPixelConfig) {
    const pathname = usePathname();

    const active =
        enabled &&
        !isAdminPath(pathname) &&
        script.trim().length > 0;

    useEffect(() => {
        if (!active) {
            return;
        }

        /*
         * Kontrak internal aplikasi: beri tahu komponen
         * lain (ViewContent, dll) bahwa pixel sudah
         * tersedia di halaman ini.
         */
        window.dispatchEvent(
            new Event("tiktok-pixel-ready")
        );
    }, [active]);

    /*
     * Nonaktif, kode kosong, atau route admin:
     * tidak ada script yang dirender.
     */
    if (!active) {
        return null;
    }

    return (
        <Script
            id="tiktok-pixel-base"
            strategy="afterInteractive"
            data-pixel-id={pixelId ?? undefined}
            data-pixel-name={
                pixelName ?? undefined
            }
        >
            {script}
        </Script>
    );
}
