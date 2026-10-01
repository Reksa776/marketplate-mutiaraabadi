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
import {
    isMengantarConfigured,
    listMengantarPickupAddresses,
    listMengantarPickupTimes,
    redactMengantarKey,
} from "@/lib/mengantar";
import {
    buildMengantarSettingsView,
    resolveMengantarSettingsInput,
} from "@/lib/mengantar/settings";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

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
    faviconUrl: true,
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

    // Mengantar pickup configuration (server-side only; never sent to
    // the browser client bundle — only this admin projection reads it).
    mengantarOriginAreaId: true,
    mengantarPickupAddressId: true,
    mengantarPickupTimeId: true,

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
    faviconUrl: string | null;
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
    mengantarOriginAreaId: string | null;
    mengantarPickupAddressId: string | null;
    mengantarPickupTimeId: string | null;
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
        /**
         * Read-only here: the favicon is uploaded/removed via
         * /api/admin/settings/favicon so a normal settings save
         * can never wipe it. Included so the settings UI can
         * preview the active icon.
         */
        faviconUrl: setting.faviconUrl,
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
        /*
         * Safe Mengantar projection: configured booleans + the
         * (non-secret) pickup identifiers. Never the API key or
         * webhook secret.
         */
        ...buildMengantarSettingsView({
            apiConfigured: isMengantarConfigured(),
            originAreaId: setting.mengantarOriginAreaId,
            pickupAddressId:
                setting.mengantarPickupAddressId,
            pickupTimeId: setting.mengantarPickupTimeId,
        }),
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

        /*
         * ============================
         * MENGANTAR PICKUP CONFIG
         * ============================
         *
         * Normalize + validate BEFORE anything is written. A
         * partial config (origin XOR pickup) and malformed ids are
         * rejected here — the browser value is never trusted.
         * An all-empty submission is valid (clears the config).
         */
        const mengantarResult =
            resolveMengantarSettingsInput(body);

        if (!mengantarResult.ok) {
            return NextResponse.json(
                {
                    success: false,
                    field: mengantarResult.field,
                    message: mengantarResult.message,
                },
                { status: 400 }
            );
        }

        const mengantarSettings =
            mengantarResult.value;

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
                    mengantarOriginAreaId: true,
                    mengantarPickupAddressId: true,
                    mengantarPickupTimeId: true,
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

        /*
         * ============================
         * MENGANTAR PICKUP VERIFICATION
         * ============================
         *
         * Format/consistency validation already happened above
         * (resolveMengantarSettingsInput). When the API key IS
         * configured we additionally verify the ids against the
         * LIVE Mengantar account (GET /address, GET /time).
         * Read-only — this never creates a shipment or charges
         * the balance.
         */
        const previousMengantar = {
            originAreaId:
                previousSetting?.mengantarOriginAreaId ??
                null,
            pickupAddressId:
                previousSetting?.mengantarPickupAddressId ??
                null,
            pickupTimeId:
                previousSetting?.mengantarPickupTimeId ??
                null,
        };

        const mengantarChanged =
            previousMengantar.originAreaId !==
                mengantarSettings.originAreaId ||
            previousMengantar.pickupAddressId !==
                mengantarSettings.pickupAddressId ||
            previousMengantar.pickupTimeId !==
                mengantarSettings.pickupTimeId;

        if (
            mengantarChanged &&
            isMengantarConfigured() &&
            mengantarSettings.pickupAddressId
        ) {
            try {
                const addresses =
                    await listMengantarPickupAddresses();

                if (
                    !addresses.some(
                        (address) =>
                            address._id ===
                            mengantarSettings.pickupAddressId
                    )
                ) {
                    return NextResponse.json(
                        {
                            success: false,
                            field: "mengantarPickupAddressId",
                            message:
                                "Pickup address Mengantar tidak ditemukan pada akun. Pilih dari daftar pickup address yang terdaftar.",
                        },
                        { status: 400 }
                    );
                }

                if (mengantarSettings.pickupTimeId) {
                    const times =
                        await listMengantarPickupTimes(
                            mengantarSettings.pickupAddressId
                        );

                    if (
                        !times.some(
                            (slot) =>
                                slot._id ===
                                mengantarSettings.pickupTimeId
                        )
                    ) {
                        return NextResponse.json(
                            {
                                success: false,
                                field: "mengantarPickupTimeId",
                                message:
                                    "Slot waktu pickup Mengantar tidak valid. Muat ulang daftar slot.",
                            },
                            { status: 400 }
                        );
                    }
                }
            } catch (error) {
                console.error(
                    "MENGANTAR SETTINGS VERIFY ERROR:",
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
                            "Tidak dapat memverifikasi konfigurasi pickup ke Mengantar. Coba lagi sebentar lagi.",
                    },
                    { status: 502 }
                );
            }
        }

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

                    mengantarOriginAreaId:
                        mengantarSettings.originAreaId,

                    mengantarPickupAddressId:
                        mengantarSettings.pickupAddressId,

                    mengantarPickupTimeId:
                        mengantarSettings.pickupTimeId,

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

                    mengantarOriginAreaId:
                        mengantarSettings.originAreaId,

                    mengantarPickupAddressId:
                        mengantarSettings.pickupAddressId,

                    mengantarPickupTimeId:
                        mengantarSettings.pickupTimeId,

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
         * ============================
         * MENGANTAR AUDIT LOG
         * ============================
         *
         * Non-secret identifiers + mode only. The API key and
         * webhook secret are never part of the config and are never
         * written to the audit metadata.
         */
        if (mengantarChanged) {
            await createAuditLog({
                adminId,
                action: "MENGANTAR_SETTINGS_UPDATED",
                entityType: "StoreSetting",
                entityId: 1,
                description:
                    "Konfigurasi pickup Mengantar diperbarui.",
                metadata: {
                    mengantarOriginAreaId:
                        mengantarSettings.originAreaId,
                    mengantarPickupAddressId:
                        mengantarSettings.pickupAddressId,
                    mengantarPickupTimeId:
                        mengantarSettings.pickupTimeId,
                    mengantarPickupMode:
                        mengantarSettings.mode,
                },
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