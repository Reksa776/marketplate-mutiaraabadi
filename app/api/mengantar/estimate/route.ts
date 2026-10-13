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
import {
    GuestAddressError,
    resolveGuestAddress,
} from "@/lib/guest-address";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * POST /api/mengantar/estimate
 * ============================================================
 *
 * Server-side Mengantar shipping estimate.
 *
 * SECURITY:
 *   - PUBLIC by design (guests check out without an account), so the
 *     destination is resolved SERVER-SIDE in both branches:
 *       · logged-in buyer → their OWN saved UserAddress (id + userId)
 *       · guest           → the inline address, validated and
 *                           canonicalized by lib/guest-address.ts
 *   - The Mengantar API key NEVER leaves the server; the client only
 *     ever receives normalized ShippingOption[].
 *   - The client NEVER sends an origin, a Mengantar area id or a price.
 *   - The response cost is authoritative and re-verified at order
 *     creation, so a tampered client quote cannot create an order.
 * ============================================================
 */

const MAX_WEIGHT_GRAMS = 30000;

type ResolvedShippingAddress = {
    id?: string;
    recipientName?: string | null;
    phone?: string | null;
    address?: string | null;
    province?: string | null;
    city?: string | null;
    district?: string | null;
    subdistrict?: string | null;
    postalCode?: string | null;
    mengantarDestinationAreaId?: string | null;
};

export async function POST(request: Request) {
    try {
        const session = await auth();

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
            guestAddress?: unknown;
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

        /*
         * ==========================================
         * DESTINATION ADDRESS — RESOLVED SERVER-SIDE
         * ==========================================
         * The client only says WHICH address (a saved id it owns) or
         * supplies the GUEST fields. Neither the origin nor a Mengantar
         * area id ever comes from the browser.
         */

        let address: ResolvedShippingAddress | null = null;

        if (session?.user?.id) {
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

            // Ownership: only the customer's own address is used.
            address = await prisma.userAddress.findFirst({
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
        } else {
            /*
             * GUEST: no address book. The inline address is untrusted
             * input, so it is validated and its region/destination
             * labels are canonicalized from the stored hierarchy.
             */
            const guestAddress =
                body.guestAddress &&
                typeof body.guestAddress === "object"
                    ? (body.guestAddress as Record<
                          string,
                          unknown
                      >)
                    : null;

            if (!guestAddress) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Alamat pengiriman wajib diisi.",
                    },
                    { status: 400 }
                );
            }

            try {
                address = await resolveGuestAddress(
                    guestAddress
                );
            } catch (error) {
                if (error instanceof GuestAddressError) {
                    return NextResponse.json(
                        {
                            success: false,
                            message: error.message,
                        },
                        { status: error.status }
                    );
                }

                throw error;
            }
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
