import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanPath(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 512) return null;
    if (!value.startsWith("/") || value.startsWith("//") || /[?#\u0000-\u001f]/.test(value)) return null;
    if (/^\/admin(?:\/|$)/.test(value) || value.startsWith("/api/")) return null;
    return value;
}

export async function POST(request: Request) {
    try {
        const fetchSite = request.headers.get("sec-fetch-site");
        if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
            return NextResponse.json({ success: false }, { status: 403 });
        }

        const contentLength = Number(request.headers.get("content-length") || 0);
        if (contentLength > 4096) {
            return NextResponse.json({ success: false }, { status: 413 });
        }

        const ip = getClientIp(request);
        if (!rateLimiters.siteAnalytics(ip).allowed) {
            return NextResponse.json({ success: false }, { status: 429 });
        }

        const body = await request.json() as Record<string, unknown>;
        const visitorId = typeof body.visitorId === "string" ? body.visitorId : "";
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const eventType = body.eventType;
        const path = cleanPath(body.path);

        if (
            !UUID_PATTERN.test(visitorId) ||
            !UUID_PATTERN.test(sessionId) ||
            !path ||
            (eventType !== "PAGE_VIEW" && eventType !== "CHECKOUT_START")
        ) {
            return NextResponse.json({ success: false }, { status: 400 });
        }

        let referrerHost: string | null = null;
        if (typeof body.referrer === "string" && body.referrer.length <= 2048) {
            try {
                const parsedReferrer = new URL(body.referrer);
                if (parsedReferrer.protocol === "https:" || parsedReferrer.protocol === "http:") {
                    referrerHost = parsedReferrer.hostname.slice(0, 255);
                }
            } catch {
                // Invalid referrers are omitted; never retain arbitrary URL text.
            }
        }

        await prisma.siteAnalyticsEvent.create({
            data: {
                visitorId,
                sessionId,
                eventType,
                path,
                referrerHost,
            },
        });

        return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
    } catch {
        return NextResponse.json({ success: false }, { status: 400 });
    }
}
