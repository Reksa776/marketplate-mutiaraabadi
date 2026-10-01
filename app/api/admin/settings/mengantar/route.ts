import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/auth";
import {
    isMengantarConfigured,
    listMengantarPickupAddresses,
    listMengantarPickupTimes,
    redactMengantarKey,
    searchMengantarAreas,
} from "@/lib/mengantar";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * GET /api/admin/settings/mengantar
 * ============================================================
 *
 * ADMIN-only, read-only resolver for the "Mengantar Shipping"
 * settings section. It exposes the official Mengantar public API
 * lookups the admin needs so IDs never have to be copy-pasted
 * by hand:
 *
 *   ?resource=areas            &keyword=   → origin AREA search
 *   ?resource=pickup-addresses             → account pickup addresses
 *   ?resource=pickup-times     &addressId= → that address's time slots
 *
 * SECURITY:
 *   - ADMIN session required (the proxy also guards /api/admin/).
 *   - The Mengantar API key stays on the server: it lives in the URL
 *     path inside lib/mengantar, and every error message is redacted.
 *   - Only normalized, non-secret fields are returned.
 *
 * When the Mengantar API key is not configured on the server we
 * return `configured: false` with an empty list (HTTP 200) so the
 * UI can degrade to a safe manual entry instead of a hard error.
 * ============================================================
 */

async function checkAdmin(): Promise<boolean> {
    const session = await auth();

    if (!session?.user) return false;

    return (session.user as { role?: string }).role === "ADMIN";
}

export async function GET(request: NextRequest) {
    try {
        if (!(await checkAdmin())) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const { searchParams } = new URL(request.url);
        const resource = searchParams.get("resource");

        if (!resource) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Resource wajib diisi.",
                },
                { status: 400 }
            );
        }

        if (!isMengantarConfigured()) {
            return NextResponse.json({
                success: true,
                configured: false,
                data: [],
                message:
                    "API key Mengantar belum diatur di server. Isi ID pickup secara manual.",
            });
        }

        switch (resource) {
            case "areas": {
                const keyword = (
                    searchParams.get("keyword") ?? ""
                ).trim();

                if (!keyword) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "Kata kunci pencarian area wajib diisi.",
                        },
                        { status: 400 }
                    );
                }

                const areas =
                    await searchMengantarAreas(keyword);

                return NextResponse.json({
                    success: true,
                    configured: true,
                    data: areas.map((area) => ({
                        id: area._id,
                        province: area.PROVINCE_NAME ?? null,
                        city: area.CITY_NAME ?? null,
                        district: area.DISTRICT_NAME ?? null,
                        subdistrict:
                            area.SUBDISTRICT_NAME ?? null,
                        postalCode: area.ZIP_CODE ?? null,
                    })),
                });
            }

            case "pickup-addresses": {
                const addresses =
                    await listMengantarPickupAddresses();

                return NextResponse.json({
                    success: true,
                    configured: true,
                    data: addresses,
                });
            }

            case "pickup-times": {
                const addressId = (
                    searchParams.get("addressId") ?? ""
                ).trim();

                if (!addressId) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "addressId wajib diisi.",
                        },
                        { status: 400 }
                    );
                }

                const times =
                    await listMengantarPickupTimes(addressId);

                return NextResponse.json({
                    success: true,
                    configured: true,
                    data: times,
                });
            }

            default:
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Resource tidak valid.",
                    },
                    { status: 400 }
                );
        }
    } catch (error) {
        console.error(
            "MENGANTAR SETTINGS LOOKUP ERROR:",
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
                    "Gagal mengambil data dari Mengantar. Coba lagi sebentar lagi.",
            },
            { status: 502 }
        );
    }
}
