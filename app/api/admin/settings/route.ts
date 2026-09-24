import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rajaOngkirFetch } from "@/lib/rajaongkir";
import { normalizeTikTokPixelId } from "@/lib/analytics/tiktok";
import {
    MAX_TIKTOK_PIXEL_CODE_LENGTH,
    analyzeTikTokPixelCode,
    findTikTokPixelIdMismatch,
    normalizeTikTokPixelCode,
    normalizeTikTokPixelName,
} from "@/lib/analytics/tiktok-pixel-code";
import {
    MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH,
    last4OfTikTokAccessToken,
    normalizeTikTokPixelAccessToken,
} from "@/lib/analytics/tiktok-access-token";
import {
    buildTikTokPixelAuditMetadata,
    hasTikTokPixelChanges,
} from "@/lib/analytics/tiktok-pixel-audit";
import { createAuditLog } from "@/lib/admin/audit-log";

/**
 * Fields the admin settings UI may read. Deliberately explicit —
 * `tiktokPixelAccessToken` is NOT in this list, so it can never
 * be serialised to the browser by accident.
 */
const SETTINGS_SELECT = {
    storeName: true,
    phone: true,
    email: true,
    logo: true,
    address: true,

    tiktokPixelEnabled: true,
    tiktokPixelId: true,
    tiktokPixelName: true,
    tiktokPixelCode: true,

    provinceId: true,
    province: true,
    cityId: true,
    city: true,
    districtId: true,
    district: true,
    subdistrictId: true,
    subdistrict: true,
    postalCode: true,
    rajaOngkirDestinationId: true,
    latitude: true,
    longitude: true,
} as const;

/**
 * Safe admin-facing projection of StoreSetting.
 *
 * NEVER includes the Access Token. The token is represented only
 * as a configured flag + last-4 hint.
 */
type SettingsProjectionSource = {
    storeName: string;
    phone: string | null;
    email: string | null;
    logo: string | null;
    address: string;
    tiktokPixelEnabled: boolean;
    tiktokPixelId: string | null;
    tiktokPixelName: string | null;
    tiktokPixelCode: string | null;
    provinceId: number | null;
    province: string | null;
    cityId: number | null;
    city: string | null;
    districtId: number | null;
    district: string | null;
    subdistrictId: number | null;
    subdistrict: string | null;
    postalCode: string | null;
    rajaOngkirDestinationId: number | null;
    latitude: unknown;
    longitude: unknown;
};

function toSettingsResponse(
    setting: SettingsProjectionSource,
    accessToken: string | null
) {
    return {
        storeName: setting.storeName,
        phone: setting.phone,
        email: setting.email,
        logo: setting.logo,
        address: setting.address,

        tiktokPixelEnabled:
            setting.tiktokPixelEnabled,
        tiktokPixelId: setting.tiktokPixelId,
        tiktokPixelName:
            setting.tiktokPixelName,
        tiktokPixelCode:
            setting.tiktokPixelCode,

        tiktokPixelAccessTokenConfigured:
            accessToken !== null,
        tiktokPixelAccessTokenLast4:
            last4OfTikTokAccessToken(accessToken),

        provinceId: setting.provinceId,
        province: setting.province,
        cityId: setting.cityId,
        city: setting.city,
        districtId: setting.districtId,
        district: setting.district,
        subdistrictId: setting.subdistrictId,
        subdistrict: setting.subdistrict,
        postalCode: setting.postalCode,
        rajaOngkirDestinationId:
            setting.rajaOngkirDestinationId,
        latitude: setting.latitude,
        longitude: setting.longitude,
    };
}

/**
 * Session ADMIN yang valid, atau null.
 */
async function getAdminUserId(): Promise<string | null> {
    const session = await auth();

    if (!session?.user) {
        return null;
    }

    if (
        (session.user as { role?: string })
            .role !== "ADMIN"
    ) {
        return null;
    }

    return session.user.id ?? null;
}

async function isAdmin() {
    return (await getAdminUserId()) !== null;
}
function nullableNumber(
    value: unknown
): number | null {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const numberValue =
        Number(value);

    return Number.isFinite(numberValue)
        ? numberValue
        : null;
}

/**
 * Ambil RajaOngkir destination ID berdasarkan
 * data wilayah toko.
 *
 * Kita tidak menerima destination ID dari frontend.
 * Backend yang menentukan dan menyimpannya.
 */
async function resolveRajaOngkirDestination(
    subdistrictId: number | null,
    cityId: number | null,
    districtId: number | null
) {
    if (!subdistrictId) {
        return null;
    }

    /**
     * Sesuaikan endpoint ini dengan endpoint
     * destination/search RajaOngkir v2 yang sudah
     * kamu gunakan di project.
     *
     * Karena data subdistrict kita sudah punya ID,
     * kita coba cari destination berdasarkan
     * subdistrict ID.
     */
    try {
        const result = await rajaOngkirFetch(
            `/destination/domestic-destination?search=${subdistrictId}`
        );

        if (
            Array.isArray(result) &&
            result.length > 0
        ) {
            const destination = result.find(
                (item: any) =>
                    Number(item.subdistrict_id) ===
                    Number(subdistrictId)
            );

            if (destination?.id) {
                return Number(destination.id);
            }

            if (result[0]?.id) {
                return Number(result[0].id);
            }
        }
    } catch (error) {
        console.error(
            "RAJAONGKIR DESTINATION RESOLVE ERROR:",
            error
        );
    }

    return null;
}

export async function GET() {
    try {
        if (!(await isAdmin())) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const setting =
            await prisma.storeSetting.findUnique({
                where: {
                    id: 1,
                },
                /*
                 * Explicit select + safe projection. The raw
                 * Access Token is read only to derive the
                 * configured flag / last-4 and is NEVER returned.
                 */
                select: {
                    ...SETTINGS_SELECT,
                    tiktokPixelAccessToken: true,
                },
            });

        return NextResponse.json({
            success: true,
            data: setting
                ? toSettingsResponse(
                      setting,
                      setting.tiktokPixelAccessToken ??
                          null
                  )
                : null,
        });
    } catch (error) {
        console.error(
            "GET STORE SETTINGS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil pengaturan toko.",
            },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: Request
) {
    try {
        /*
         * HANYA ADMIN yang boleh mengubah pengaturan
         * (termasuk melihat & menyimpan Pixel Code).
         *
         * Otorisasi server-side: menyembunyikan UI
         * saja tidak cukup.
         */
        const adminId =
            await getAdminUserId();

        if (!adminId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const body =
            await request.json();

        const provinceId =
            body.provinceId
                ? Number(body.provinceId)
                : null;

        const cityId =
            body.cityId
                ? Number(body.cityId)
                : null;

        const districtId =
            body.districtId
                ? Number(body.districtId)
                : null;

        const subdistrictId =
            body.subdistrictId
                ? Number(
                    body.subdistrictId
                )
                : null;

        /**
         * ============================
         * TIKTOK PIXEL
         * ============================
         *
         * Pixel ID: hanya nilai yang sudah dinormalisasi
         * (uppercase, alfanumerik) yang masuk database.
         *
         * Pixel Code: kode MILIK ADMIN, disimpan apa
         * adanya (multiline dipertahankan) karena memang
         * berisi JavaScript. Tidak ada sanitasi yang
         * menghapus <script> — keamanannya berasal dari
         * akses ADMIN-only + CSP + eksekusi hanya di
         * storefront.
         *
         * Validasi client-side tidak pernah dipercaya.
         */
        const rawTikTokPixelId =
            typeof body.tiktokPixelId ===
            "string"
                ? body.tiktokPixelId.trim()
                : "";

        const tiktokPixelId =
            normalizeTikTokPixelId(
                rawTikTokPixelId
            );

        if (
            rawTikTokPixelId &&
            !tiktokPixelId
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "TikTok Pixel ID tidak valid.",
                },
                { status: 400 }
            );
        }

        const tiktokPixelName =
            normalizeTikTokPixelName(
                body.tiktokPixelName
            );

        const rawTikTokPixelCode =
            typeof body.tiktokPixelCode ===
            "string"
                ? body.tiktokPixelCode.trim()
                : "";

        if (
            rawTikTokPixelCode.length >
            MAX_TIKTOK_PIXEL_CODE_LENGTH
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: `TikTok Pixel Code maksimal ${MAX_TIKTOK_PIXEL_CODE_LENGTH} karakter.`,
                },
                { status: 400 }
            );
        }

        const tiktokPixelCode =
            normalizeTikTokPixelCode(
                rawTikTokPixelCode
            );

        const pixelCodeAnalysis =
            analyzeTikTokPixelCode(
                tiktokPixelCode
            );

        /*
         * Kode yang hanya berisi <script src="..."> tidak
         * punya JavaScript inline untuk dijalankan lewat
         * next/script — tolak dengan pesan jelas daripada
         * diam-diam tidak jalan.
         */
        if (
            tiktokPixelCode &&
            pixelCodeAnalysis.isEmpty
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "TikTok Pixel Code tidak berisi JavaScript inline. Tempel kode dari TikTok Events Manager (bukan hanya tag <script src=\"...\">).",
                },
                { status: 400 }
            );
        }

        /*
         * ============================
         * TIKTOK EVENTS API ACCESS TOKEN (SECRET)
         * ============================
         *
         * Semantics:
         *   - `clearTiktokPixelAccessToken === true` → hapus token
         *   - token baru valid              → ganti token
         *   - token kosong tanpa clear      → pertahankan token lama
         *
         * Nilai mentah tidak pernah dikembalikan ke client.
         */
        const clearTikTokPixelAccessToken =
            body.clearTiktokPixelAccessToken ===
            true;

        const rawTikTokPixelAccessToken =
            typeof body.tiktokPixelAccessToken ===
            "string"
                ? body.tiktokPixelAccessToken
                : "";

        if (
            rawTikTokPixelAccessToken.length >
            MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: `TikTok Pixel Access Token maksimal ${MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH} karakter.`,
                },
                { status: 400 }
            );
        }

        const providedTikTokPixelAccessToken =
            normalizeTikTokPixelAccessToken(
                rawTikTokPixelAccessToken
            );

        if (
            rawTikTokPixelAccessToken.trim() &&
            !providedTikTokPixelAccessToken
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "TikTok Pixel Access Token tidak valid.",
                },
                { status: 400 }
            );
        }

        const tiktokPixelEnabled =
            body.tiktokPixelEnabled === true;

        if (
            tiktokPixelEnabled &&
            !tiktokPixelCode
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Isi Kode Pixel TikTok sebelum mengaktifkan pixel.",
                },
                { status: 400 }
            );
        }

        /*
         * ID di dalam kode yang berbeda dengan ID di
         * settings TIDAK di-rewrite otomatis — hanya
         * dilaporkan sebagai warning ke admin.
         */
        const pixelIdMismatch =
            findTikTokPixelIdMismatch(
                tiktokPixelId,
                tiktokPixelCode
            );

        /*
         * Snapshot nilai lama untuk audit log.
         */
        const previousSetting =
            await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: {
                    tiktokPixelEnabled: true,
                    tiktokPixelId: true,
                    tiktokPixelName: true,
                    tiktokPixelCode: true,
                    tiktokPixelAccessToken: true,
                },
            });

        /*
         * Resolusi token final: clear > replace > keep.
         */
        const nextTikTokPixelAccessToken =
            clearTikTokPixelAccessToken
                ? null
                : providedTikTokPixelAccessToken ??
                  previousSetting
                      ?.tiktokPixelAccessToken ??
                  null;

        /**
         * Jangan percaya destination ID
         * yang dikirim frontend.
         *
         * Backend yang generate.
         */
        let rajaOngkirDestinationId =
            null;

        if (subdistrictId) {
            rajaOngkirDestinationId =
                await resolveRajaOngkirDestination(
                    subdistrictId,
                    cityId,
                    districtId
                );
        }

        const setting =
            await prisma.storeSetting.upsert({
                where: {
                    id: 1,
                },

                create: {
                    id: 1,

                    storeName:
                        body.storeName?.trim() ||
                        "",

                    phone:
                        body.phone?.trim() ||
                        null,

                    email:
                        body.email?.trim() ||
                        null,

                    logo:
                        body.logo?.trim() ||
                        null,

                    address:
                        body.address?.trim() ||
                        "",
                    tiktokPixelEnabled,

                    tiktokPixelId,

                    tiktokPixelName,

                    tiktokPixelCode,

                    tiktokPixelAccessToken:
                        nextTikTokPixelAccessToken,

                    provinceId,

                    province:
                        body.province?.trim() ||
                        null,

                    cityId,

                    city:
                        body.city?.trim() ||
                        null,

                    districtId,

                    district:
                        body.district?.trim() ||
                        null,

                    subdistrictId,

                    subdistrict:
                        body.subdistrict?.trim() ||
                        null,

                    postalCode:
                        body.postalCode?.trim() ||
                        null,

                    rajaOngkirDestinationId:
                        nullableNumber(
                            body.rajaOngkirDestinationId
                        ),

                    latitude:
                        body.latitude !== null &&
                            body.latitude !==
                            undefined &&
                            body.latitude !== ""
                            ? Number(
                                body.latitude
                            )
                            : null,

                    longitude:
                        body.longitude !== null &&
                            body.longitude !==
                            undefined &&
                            body.longitude !== ""
                            ? Number(
                                body.longitude
                            )
                            : null,
                },

                update: {
                    storeName:
                        body.storeName?.trim() ||
                        "",

                    phone:
                        body.phone?.trim() ||
                        null,

                    email:
                        body.email?.trim() ||
                        null,

                    logo:
                        body.logo?.trim() ||
                        null,

                    address:
                        body.address?.trim() ||
                        "",
                    tiktokPixelEnabled,

                    tiktokPixelId,

                    tiktokPixelName,

                    tiktokPixelCode,

                    tiktokPixelAccessToken:
                        nextTikTokPixelAccessToken,

                    provinceId,

                    province:
                        body.province?.trim() ||
                        null,

                    cityId,

                    city:
                        body.city?.trim() ||
                        null,

                    districtId,

                    district:
                        body.district?.trim() ||
                        null,

                    subdistrictId,

                    subdistrict:
                        body.subdistrict?.trim() ||
                        null,

                    postalCode:
                        body.postalCode?.trim() ||
                        null,

                    rajaOngkirDestinationId:
                        nullableNumber(
                            body.rajaOngkirDestinationId
                        ),

                    latitude:
                        body.latitude !== null &&
                            body.latitude !==
                            undefined &&
                            body.latitude !== ""
                            ? Number(
                                body.latitude
                            )
                            : null,

                    longitude:
                        body.longitude !== null &&
                            body.longitude !==
                            undefined &&
                            body.longitude !== ""
                            ? Number(
                                body.longitude
                            )
                            : null,
                },
            });

        /*
         * ============================
         * AUDIT LOG
         * ============================
         *
         * Hanya dicatat kalau konfigurasi TikTok Pixel
         * berubah.
         *
         * RAW PIXEL CODE TIDAK PERNAH masuk log — yang
         * disimpan hanya metadata + hash.
         */
        const previousSnapshot =
            previousSetting
                ? {
                    enabled:
                        previousSetting.tiktokPixelEnabled,
                    pixelId:
                        previousSetting.tiktokPixelId,
                    pixelName:
                        previousSetting.tiktokPixelName,
                    code:
                        previousSetting.tiktokPixelCode,
                    accessToken:
                        previousSetting
                            .tiktokPixelAccessToken ??
                        null,
                }
                : null;

        const nextSnapshot = {
            enabled: tiktokPixelEnabled,
            pixelId: tiktokPixelId,
            pixelName: tiktokPixelName,
            code: tiktokPixelCode,
            accessToken: nextTikTokPixelAccessToken,
        };

        if (
            hasTikTokPixelChanges(
                previousSnapshot,
                nextSnapshot
            )
        ) {
            await createAuditLog({
                adminId,
                action: "TIKTOK_PIXEL_UPDATED",
                entityType: "StoreSetting",
                entityId: 1,
                description:
                    "Pengaturan TikTok Pixel diperbarui.",
                metadata:
                    buildTikTokPixelAuditMetadata(
                        previousSnapshot,
                        nextSnapshot
                    ),
            });
        }

        /*
         * StoreSetting dipakai oleh root layout (storefront),
         * termasuk halaman yang di-prerender saat build.
         *
         * Revalidate layout supaya perubahan TikTok Pixel
         * (enable/disable + Pixel Code) langsung berlaku di
         * seluruh halaman tanpa deploy ulang.
         */
        revalidatePath("/", "layout");

        return NextResponse.json({
            success: true,
            message:
                "Pengaturan toko berhasil disimpan.",
            /*
             * Safe projection — the Access Token is NEVER echoed
             * back, only its configured flag + last-4.
             */
            data: toSettingsResponse(
                setting,
                nextTikTokPixelAccessToken
            ),

            /*
             * Warning untuk admin (bukan error):
             * kode tidak diubah otomatis.
             */
            warnings: {
                pixelIdMismatch,
                pixelCodeHasLoadCall:
                    pixelCodeAnalysis.hasLoadCall,
                pixelCodeHasPageCall:
                    pixelCodeAnalysis.hasPageCall,
                pixelCodeHasIdentifyCall:
                    pixelCodeAnalysis.hasIdentifyCall,
                pixelCodePixelIds:
                    pixelCodeAnalysis.pixelIds,
            },
        });
    } catch (error) {
        console.error(
            "UPDATE STORE SETTINGS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal menyimpan pengaturan toko.",
            },
            { status: 500 }
        );
    }
}