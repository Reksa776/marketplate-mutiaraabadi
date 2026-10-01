import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { isMengantarConfigured } from "@/lib/mengantar";
import type {
    MengantarArea,
    MengantarPickupAddress,
} from "@/lib/mengantar";
import {
    resolveMengantarStoreConfiguration,
} from "@/lib/mengantar/origin-resolver";
import type {
    OriginMatch,
    PickupMatch,
} from "@/lib/mengantar/matching";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

export const dynamic = "force-dynamic";

/*
 * ============================================================
 * POST /api/admin/settings/mengantar/resolve
 * ============================================================
 *
 * ADMIN-only "Deteksi Otomatis". Reads the canonical store address
 * and returns a SAFE PREVIEW of the resolved Mengantar origin area +
 * pickup address. It is READ-ONLY:
 *   - never writes to StoreSetting
 *   - never creates a shipment / order
 *   - never touches payment or shipment state
 *
 * The admin must explicitly save afterwards (PUT /api/admin/settings).
 *
 * SECURITY: the API key stays on the server (URL path inside
 * lib/mengantar) and is never part of this response. No raw provider
 * body is echoed — only normalized, non-secret fields.
 * ============================================================
 */

/**
 * Auth outcome: 401 = no session, 403 = session but not ADMIN.
 */
async function checkAdmin(): Promise<401 | 403 | "OK"> {
    const session = await auth();

    if (!session?.user) return 401;

    if (
        (session.user as { role?: string }).role !==
        "ADMIN"
    ) {
        return 403;
    }

    return "OK";
}

function safeArea(area: MengantarArea) {
    return {
        id: area._id,
        province: area.PROVINCE_NAME ?? null,
        city: area.CITY_NAME ?? null,
        district: area.DISTRICT_NAME ?? null,
        subdistrict: area.SUBDISTRICT_NAME ?? null,
        postalCode: area.ZIP_CODE ?? null,
    };
}

function safePickup(pickup: MengantarPickupAddress) {
    return {
        id: pickup._id,
        name: pickup.name,
        address: pickup.address,
        areaId: pickup.areaId,
    };
}

function serializeOrigin(match: OriginMatch) {
    switch (match.status) {
        case "MATCHED":
            return {
                status: match.status,
                confidence: match.confidence,
                matchedFields: match.matchedFields,
                ...safeArea(match.area),
            };
        case "AMBIGUOUS":
            return {
                status: match.status,
                candidates: match.candidates.map(safeArea),
            };
        default:
            return { status: match.status };
    }
}

function serializePickup(match: PickupMatch) {
    switch (match.status) {
        case "MATCHED":
            return {
                status: match.status,
                confidence: match.confidence,
                matchedFields: match.matchedFields,
                ...safePickup(match.pickup),
            };
        case "AMBIGUOUS":
            return {
                status: match.status,
                candidates:
                    match.candidates.map(safePickup),
            };
        default:
            return { status: match.status };
    }
}

export async function POST() {
    try {
        const authorization = await checkAdmin();

        if (authorization !== "OK") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        authorization === 401
                            ? "Unauthorized."
                            : "Forbidden.",
                },
                { status: authorization }
            );
        }

        if (!isMengantarConfigured()) {
            return NextResponse.json(
                {
                    success: false,
                    configured: false,
                    message:
                        "API key Mengantar belum diatur di server. Resolusi otomatis tidak tersedia.",
                },
                { status: 503 }
            );
        }

        const resolution =
            await resolveMengantarStoreConfiguration();

        if (!resolution) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Pengaturan toko belum tersedia.",
                },
                { status: 404 }
            );
        }

        const { store, origin, pickup } = resolution;

        return NextResponse.json({
            success: true,
            configured: true,
            store: {
                storeName: store.storeName,
                address: store.address,
                province: store.province,
                city: store.city,
                district: store.district,
                subdistrict: store.subdistrict,
                postalCode: store.postalCode,
            },
            origin: serializeOrigin(origin),
            pickup: serializePickup(pickup),
            confidence:
                origin.status === "MATCHED" &&
                pickup.status === "MATCHED"
                    ? origin.confidence
                    : null,
        });
    } catch (error) {
        console.error(
            "MENGANTAR RESOLVE ERROR:",
            error instanceof Error ? error.message : error
        );

        if (error instanceof UpstreamError) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Layanan Mengantar sedang tidak merespons. Silakan coba lagi.",
                },
                {
                    status: isUpstreamTimeout(error)
                        ? 504
                        : 502,
                }
            );
        }

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mendeteksi konfigurasi Mengantar otomatis.",
            },
            { status: 500 }
        );
    }
}
