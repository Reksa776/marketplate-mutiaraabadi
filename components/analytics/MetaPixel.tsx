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
    const routeKey = pathname + (query ? `?${query}` : "");
    const trackPageView = useCallback(() => {
        if (!active || !window.__META_PIXEL_READY || typeof window.fbq !== "function" || lastPageView.current === routeKey || window.__META_LAST_PAGE_VIEW === routeKey) return;
        lastPageView.current = routeKey;
        window.__META_LAST_PAGE_VIEW = routeKey;
        window.fbq("track", "PageView");
    }, [active, routeKey]);

    useEffect(() => {
        trackPageView();
    }, [trackPageView]);

    if (!active || !script.trim()) return null;

    const executableScript = `${script}\n;window.__META_PIXEL_ID='${pixelId}';if(window.fbq){window.__META_PIXEL_READY=true;window.fbq('track','PageView');window.__META_LAST_PAGE_VIEW=window.location.pathname+window.location.search;window.dispatchEvent(new Event('meta-pixel-ready'));}`;

    return <Script id="meta-pixel" strategy="afterInteractive">{executableScript}</Script>;
}

declare global {
    interface Window {
        fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; push?: (...args: unknown[]) => void; loaded?: boolean; version?: string; }
        __META_PIXEL_ID?: string;
        __META_PIXEL_READY?: boolean;
        __META_LAST_PAGE_VIEW?: string;
    }
}
