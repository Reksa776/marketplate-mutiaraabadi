import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";
import {
    claimDailyPromo,
    hashPromoVisitorKey,
    isPromoActive,
    PROMO_VISITOR_COOKIE,
    promoQuotaDate,
} from "@/lib/promo-claim";

export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function rateLimited(request: NextRequest) {
    return !rateLimiters.voucherValidation(
        `promo-claim:${getClientIp(request)}`
    ).allowed;
}

function setVisitorCookie(response: NextResponse, value: string) {
    response.cookies.set(PROMO_VISITOR_COOKIE, value, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
    });
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    if (rateLimited(request)) {
        return NextResponse.json(
            { success: false, message: "Terlalu banyak permintaan. Coba lagi sebentar." },
            { status: 429 }
        );
    }

    const { slug } = await params;
    const visitorKey = request.cookies.get(PROMO_VISITOR_COOKIE)?.value ??
        randomBytes(32).toString("base64url");
    const visitorKeyHash = hashPromoVisitorKey(visitorKey);
    const quotaDate = promoQuotaDate();
    const promo = await prisma.promoLanding.findUnique({
        where: { slug },
        include: {
            daily: {
                where: { quotaDate },
                select: { claimedCount: true },
                take: 1,
            },
        },
    });

    if (!promo) {
        return NextResponse.json(
            { success: false, message: "Promo tidak ditemukan." },
            { status: 404 }
        );
    }

    const claim = await prisma.promoClaim.findUnique({
        where: {
            promoId_quotaDate_visitorKeyHash: {
                promoId: promo.id,
                quotaDate,
                visitorKeyHash,
            },
        },
        select: { id: true },
    });
    const claimedCount = promo.daily[0]?.claimedCount ?? 0;
    const active =
        isPromoActive(promo) &&
        promo.variantId !== null &&
        promo.promoPrice !== null;
    const remaining = Math.max(0, promo.dailyQuota - claimedCount);
    const response = NextResponse.json({
        success: true,
        data: {
            active,
            claimed: Boolean(claim),
            variantId: promo.variantId,
            dailyQuota: promo.dailyQuota,
            claimedCount,
            remaining,
            // Claiming the voucher only saves the visitor's entitlement.
            // Daily quota is checked when they press Buy Now and reserved
            // atomically when an order is created.
            claimable: active && !claim,
            timeZone: "Asia/Jakarta",
            quotaDate: quotaDate.toISOString().slice(0, 10),
        },
    }, { headers: { "Cache-Control": "no-store, private" } });

    if (!request.cookies.has(PROMO_VISITOR_COOKIE)) {
        setVisitorCookie(response, visitorKey);
    }

    return response;
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    if (rateLimited(request)) {
        return NextResponse.json(
            { success: false, message: "Terlalu banyak permintaan. Coba lagi sebentar." },
            { status: 429 }
        );
    }

    const visitorKey = request.cookies.get(PROMO_VISITOR_COOKIE)?.value;
    if (!visitorKey) {
        return NextResponse.json(
            { success: false, message: "Muat ulang halaman promo lalu coba lagi." },
            { status: 428 }
        );
    }

    const { slug } = await params;
    const result = await claimDailyPromo({
        slug,
        visitorKeyHash: hashPromoVisitorKey(visitorKey),
    });

    if (result.status === "NOT_FOUND") {
        return NextResponse.json(
            { success: false, message: "Promo tidak ditemukan." },
            { status: 404 }
        );
    }
    if (result.status === "INACTIVE") {
        return NextResponse.json(
            { success: false, code: "PROMO_INACTIVE", message: "Periode promo sudah berakhir atau promo tidak aktif." },
            { status: 410 }
        );
    }
    if (result.status !== "CLAIMED") {
        return NextResponse.json(
            { success: false, message: "Promo tidak dapat diklaim." },
            { status: 400 }
        );
    }

    return NextResponse.json({
        success: true,
        data: {
            alreadyClaimed: result.alreadyClaimed,
        },
    }, { headers: { "Cache-Control": "no-store, private" } });
}
