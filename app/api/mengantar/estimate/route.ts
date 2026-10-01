import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";
import {
    isMengantarConfigured,
    redactMengantarKey,
} from "@/lib/mengantar";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";
import {
    buildMengantarShippingOptions,
    getMengantarOriginConfig,
} from "@/lib/mengantar/shipping";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * POST /api/mengantar/estimate
 * ============================================================
 *
 * Server-side Mengantar shipping estimate.
 *
 * SECURITY:
 *   - Authenticated only (also enforced by the proxy).
 *   - The Mengantar API key NEVER leaves the server; the client only
 *     ever receives normalized ShippingOption[].
 *   - The client sends an addressId + weight. Origin/destination areas
 *     are resolved server-side from the DB — the client can never
 *     choose the origin or inject a provider destination id.
 *   - The response cost is authoritative and re-verified at order
 *     creation, so a tampered client quote cannot create an order.
 * ============================================================
 */

const MAX_WEIGHT_GRAMS = 30000;

export async function POST(request: Request) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Silakan login terlebih dahulu.",
                },
                { status: 401 }
            );
        }

        const rate = rateLimiters.shippingCost(
            getClientIp(request)
        );

        if (!rate.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Terlalu banyak permintaan. Coba lagi sebentar lagi.",
                },
                {
                    status: 429,
                    headers: {
                        "Retry-After": String(
                            Math.ceil(
                                rate.retryAfterMs / 1000
                            )
                        ),
                    },
                }
            );
        }

        if (!isMengantarConfigured()) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Mengantar belum dikonfigurasi.",
                },
                { status: 503 }
            );
        }

        let body: {
            addressId?: unknown;
            weight?: unknown;
            codAmount?: unknown;
        };

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Body request tidak valid.",
                },
                { status: 400 }
            );
        }

        const addressId = String(
            body.addressId ?? ""
        );

        if (!addressId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Alamat wajib dipilih.",
                },
                { status: 400 }
            );
        }

        const weight = Number(body.weight);

        if (
            !Number.isFinite(weight) ||
            weight <= 0 ||
            Math.ceil(weight) > MAX_WEIGHT_GRAMS
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Berat paket tidak valid.",
                },
                { status: 400 }
            );
        }

        const codAmount =
            body.codAmount === undefined
                ? undefined
                : Number(body.codAmount);

        // Ownership: only the customer's own address is used.
        const address = await prisma.userAddress.findFirst({
            where: {
                id: addressId,
                userId: session.user.id,
            },
        });

        if (!address) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Alamat tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        const origin = await getMengantarOriginConfig();

        if (!origin) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Konfigurasi pickup Mengantar belum diatur.",
                },
                { status: 503 }
            );
        }

        const options = await buildMengantarShippingOptions({
            address,
            weightGrams: Math.ceil(weight),
            codAmount:
                typeof codAmount === "number" &&
                Number.isFinite(codAmount) &&
                codAmount > 0
                    ? codAmount
                    : undefined,
        });

        return NextResponse.json({
            success: true,
            data: options,
            weight: Math.ceil(weight),
            provider: "MENGANTAR",
        });
    } catch (error) {
        console.error(
            "MENGANTAR ESTIMATE ERROR:",
            error instanceof Error
                ? redactMengantarKey(error.message)
                : error
        );

        if (error instanceof UpstreamError) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Layanan Mengantar sedang tidak merespons. Silakan coba lagi.",
                },
                { status: isUpstreamTimeout(error) ? 504 : 502 }
            );
        }

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? redactMengantarKey(
                              error.message
                          )
                        : "Gagal menghitung ongkir.",
            },
            { status: 500 }
        );
    }
}
