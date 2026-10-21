"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type MetaPixelProps = {
    enabled: boolean;
    pixelId: string | null;
    script: string;
};

export default function MetaPixel({ enabled, pixelId, script }: MetaPixelProps) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const active = enabled && /^\d{5,20}$/.test(pixelId ?? "") && !pathname.startsWith("/admin");
    const query = searchParams.toString();
    const lastPageView = useRef("");
    const routeKey = `${pathname}?${query}`;
    const trackPageView = useCallback(() => {
        if (!active || typeof window.fbq !== "function" || lastPageView.current === routeKey) return;
        lastPageView.current = routeKey;
        window.fbq("track", "PageView");
    }, [active, routeKey]);

    useEffect(() => {
        trackPageView();
    }, [trackPageView]);

    if (!active || !script.trim()) return null;

    return (
        <Script id="meta-pixel" data-pixel-id={pixelId ?? undefined} strategy="afterInteractive" onReady={() => {
            trackPageView();
            window.dispatchEvent(new Event("meta-pixel-ready"));
        }}>
            {script}
        </Script>
    );
}

declare global {
    interface Window {
        fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; push?: (...args: unknown[]) => void; loaded?: boolean; version?: string; }
    }
}
