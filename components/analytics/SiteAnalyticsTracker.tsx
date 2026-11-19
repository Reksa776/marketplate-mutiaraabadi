"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const VISITOR_KEY = "ma_analytics_visitor";
const SESSION_KEY = "ma_analytics_session";

function createId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = Math.floor(Math.random() * 16);
        return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
    });
}

function getOrCreateId(storage: Storage, key: string): string {
    try {
        const existing = storage.getItem(key);
        if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
        const id = createId();
        storage.setItem(key, id);
        return id;
    } catch {
        return createId();
    }
}

export default function SiteAnalyticsTracker() {
    const pathname = usePathname();
    const lastPath = useRef<string | null>(null);

    useEffect(() => {
        if (!pathname || /^\/admin(?:\/|$)/.test(pathname) || lastPath.current === pathname) return;
        lastPath.current = pathname;

        let visitorId: string;
        let sessionId: string;
        try {
            visitorId = getOrCreateId(window.localStorage, VISITOR_KEY);
            sessionId = getOrCreateId(window.sessionStorage, SESSION_KEY);
        } catch {
            visitorId = createId();
            sessionId = createId();
        }
        const events = pathname === "/checkout"
            ? ["PAGE_VIEW", "CHECKOUT_START"]
            : ["PAGE_VIEW"];

        for (const eventType of events) {
            void fetch("/api/analytics/visit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    visitorId,
                    sessionId,
                    eventType,
                    path: pathname,
                    referrer: document.referrer,
                }),
                keepalive: true,
                credentials: "same-origin",
            }).catch(() => undefined);
        }
    }, [pathname]);

    return null;
}
