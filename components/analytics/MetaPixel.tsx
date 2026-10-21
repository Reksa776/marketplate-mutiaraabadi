"use client";

import Script from "next/script";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type MetaPixelProps = {
    enabled: boolean;
    pixelId: string | null;
};

export default function MetaPixel({ enabled, pixelId }: MetaPixelProps) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const active = enabled && /^\d{5,20}$/.test(pixelId ?? "") && !pathname.startsWith("/admin");
    const query = searchParams.toString();

    useEffect(() => {
        if (active && typeof window.fbq === "function") {
            window.fbq("track", "PageView");
        }
    }, [active, pathname, query]);

    if (!active) return null;

    return (
        <Script id="meta-pixel" strategy="afterInteractive">
            {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');`}
        </Script>
    );
}

declare global {
    interface Window {
        fbq?: ((...args: (string | number)[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; push?: (...args: unknown[]) => void; loaded?: boolean; version?: string; }
    }
}
