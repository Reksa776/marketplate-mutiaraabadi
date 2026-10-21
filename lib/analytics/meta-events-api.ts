import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { extractMetaPixelId, normalizeMetaAccessToken } from "@/lib/analytics/meta-pixel-code";

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v22.0";
const META_EVENTS_TIMEOUT_MS = 3000;

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function hashEmail(value: string | null | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? sha256(normalized) : undefined;
}

function hashPhone(value: string | null | undefined): string | undefined {
    const digits = value?.replace(/\D/g, "") ?? "";
    return digits.length >= 8 && digits.length <= 15 ? sha256(digits) : undefined;
}

export async function trackMetaServerPurchase(input: {
    orderNumber: string;
    total: number;
    email?: string | null;
    phone?: string | null;
    pageUrl?: string | null;
    ip?: string | null;
    userAgent?: string | null;
}): Promise<void> {
    try {
        let eventSourceUrl: string | null = null;
        try {
            const candidate = input.pageUrl || process.env.NEXT_PUBLIC_APP_URL;
            if (candidate) {
                const parsed = new URL(candidate);
                if (parsed.protocol === "https:" || parsed.protocol === "http:") eventSourceUrl = parsed.toString();
            }
        } catch {
            eventSourceUrl = null;
        }
        if (!eventSourceUrl) {
            console.info("[META CAPI] Purchase skipped", { reason: "missing_event_source_url" });
            return;
        }

        const setting = await prisma.storeSetting.findUnique({
            where: { id: 1 },
            select: { metaPixelEnabled: true, metaPixelId: true, metaPixelCode: true, metaPixelAccessToken: true },
        });
        const pixelId = extractMetaPixelId(setting?.metaPixelCode ?? "") ?? setting?.metaPixelId ?? null;
        const accessToken = normalizeMetaAccessToken(setting?.metaPixelAccessToken);
        if (!setting?.metaPixelEnabled || !pixelId || !accessToken) {
            console.info("[META CAPI] Purchase skipped", { reason: !setting?.metaPixelEnabled ? "pixel_disabled" : !pixelId ? "missing_pixel_id" : "missing_access_token" });
            return;
        }

        const userData: Record<string, string | string[]> = {};
        const em = hashEmail(input.email);
        const ph = hashPhone(input.phone);
        if (em) userData.em = [em];
        if (ph) userData.ph = [ph];
        if (input.ip) userData.client_ip_address = input.ip;
        if (input.userAgent) userData.client_user_agent = input.userAgent;

        const eventId = `meta:purchase:${input.orderNumber}`;
        const endpoint = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events`);
        endpoint.searchParams.set("access_token", accessToken);
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(META_EVENTS_TIMEOUT_MS),
            body: JSON.stringify({
                data: [{
                    event_name: "Purchase",
                    event_time: Math.floor(Date.now() / 1000),
                    event_id: eventId,
                    action_source: "website",
                    event_source_url: eventSourceUrl,
                    user_data: userData,
                    custom_data: { currency: "IDR", value: Number(input.total), order_id: input.orderNumber },
                }],
            }),
        });
        const payload = await response.json().catch(() => null) as { events_received?: number; error?: { code?: number } } | null;
        if (response.ok && payload?.events_received === 1) {
            console.info("[META CAPI] Purchase accepted", { eventId, status: response.status });
        } else {
            console.warn("[META CAPI] Purchase not accepted", { eventId, status: response.status, code: payload?.error?.code });
        }
    } catch (error) {
        console.warn("[META CAPI] Purchase request failed", { reason: error instanceof Error ? error.name : "unknown" });
    }
}
