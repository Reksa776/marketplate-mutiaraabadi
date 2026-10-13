import { prisma } from "@/lib/prisma";
import {
    normalizeEmail,
    normalizePhone,
} from "@/lib/guest-identity";
import { resolveMengantarDestinationAreaId } from "@/lib/mengantar/shipping";

/**
 * ==========================================
 * GUEST ADDRESS — SERVER-SIDE VALIDATION + DESTINATION RESOLUTION
 * ==========================================
 *
 * A guest has no `UserAddress` row, so the checkout address arrives
 * inline in the request body. That makes it UNTRUSTED INPUT and it must
 * never be used verbatim as a shipping destination.
 *
 * This module:
 *   1. Validates and normalizes every field (name, phone, email,
 *      address, postal code).
 *   2. Canonicalizes province/city/district/sub-district/postal code
 *      from the stored region hierarchy when the buyer selected a
 *      region (so a tampered label cannot change the destination).
 *   3. Resolves the shipping destination IDs SERVER-SIDE:
 *        - `rajaOngkirDestinationId` is accepted only when it exists in
 *          the synced RajaOngkir region table (a client-sent id that
 *          cannot be verified is discarded, never trusted).
 *        - `mengantarDestinationAreaId` is resolved by
 *          `/address/search`; the client never supplies it.
 *   4. Never writes to `UserAddress` — guest addresses are stored on
 *      the Order only, which already has all the address columns.
 *
 * Anything this module cannot verify stays NULL rather than being
 * invented; the checkout then fails closed if the selected courier
 * provider needs it.
 */

export class GuestAddressError extends Error {
    status = 400;

    constructor(message: string) {
        super(message);
        this.name = "GuestAddressError";
    }
}

export type GuestAddressInput = {
    recipientName?: unknown;
    phone?: unknown;
    email?: unknown;
    address?: unknown;
    note?: unknown;
    province?: unknown;
    city?: unknown;
    district?: unknown;
    subdistrict?: unknown;
    postalCode?: unknown;

    /* Optional region picker ids (validated against the DB). */
    provinceId?: unknown;
    regencyId?: unknown;
    districtId?: unknown;
    villageId?: unknown;

    /* Optional client hint — verified before use. */
    rajaOngkirDestinationId?: unknown;

    latitude?: unknown;
    longitude?: unknown;
};

export type ResolvedGuestAddress = {
    recipientName: string;
    phone: string;
    email: string;
    address: string;
    note: string | null;
    province: string;
    city: string;
    district: string;
    subdistrict: string | null;
    postalCode: string;
    rajaOngkirDestinationId: number | null;
    mengantarDestinationAreaId: string | null;
    latitude: number | null;
    longitude: number | null;
};

const MAX_NAME = 120;
const MAX_PHONE = 32;
const MAX_EMAIL = 191;
const MAX_ADDRESS = 1000;
const MAX_NOTE = 1000;

function requireString(
    value: unknown,
    label: string,
    maxLength: number
): string {
    if (typeof value !== "string") {
        throw new GuestAddressError(
            `${label} wajib diisi.`
        );
    }

    const trimmed = value.trim();

    if (!trimmed) {
        throw new GuestAddressError(
            `${label} wajib diisi.`
        );
    }

    if (trimmed.length > maxLength) {
        throw new GuestAddressError(
            `${label} terlalu panjang.`
        );
    }

    return trimmed;
}

function optionalString(
    value: unknown,
    maxLength: number
): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();

    if (!trimmed) {
        return null;
    }

    return trimmed.slice(0, maxLength);
}

function optionalNumber(
    value: unknown
): number | null {
    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function normalizePostalCode(
    value: unknown
): string {
    const raw = requireString(
        value,
        "Kode pos",
        20
    );

    const digits = raw.replace(/\D/g, "");

    if (digits.length < 3 || digits.length > 10) {
        throw new GuestAddressError(
            "Kode pos tidak valid."
        );
    }

    return digits;
}

function mapRegion(
    region: {
        name: string;
        district: {
            name: string;
            regency: {
                name: string;
                province: { name: string };
            };
        };
    }
) {
    return {
        province: region.district.regency.province.name,
        city: region.district.regency.name,
        district: region.district.name,
        subdistrict: region.name,
    };
}

/**
 * Validate, normalize and resolve a guest shipping address.
 *
 * @throws GuestAddressError (status 400) on invalid input.
 */
export async function resolveGuestAddress(
    input: GuestAddressInput
): Promise<ResolvedGuestAddress> {
    const recipientName = requireString(
        input.recipientName,
        "Nama penerima",
        MAX_NAME
    );

    const rawPhone = requireString(
        input.phone,
        "Nomor telepon",
        MAX_PHONE
    );

    const phone = normalizePhone(rawPhone);

    if (!phone || phone.length < 9 || phone.length > 15) {
        throw new GuestAddressError(
            "Nomor telepon tidak valid."
        );
    }

    const email = normalizeEmail(input.email);

    if (
        !email ||
        email.length > MAX_EMAIL ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        throw new GuestAddressError(
            "Email tidak valid."
        );
    }

    const address = requireString(
        input.address,
        "Alamat lengkap",
        MAX_ADDRESS
    );

    const note = optionalString(input.note, MAX_NOTE);

    /* ==========================================
     * REGION RESOLUTION (canonical names win)
     * ==========================================
     *
     * When the buyer picked a village/region id, the stored hierarchy is
     * the source of truth for the destination labels — client-sent
     * province/city/district strings are then IGNORED for resolution.
     */
    const villageId = (() => {
        const n = Number(input.villageId);
        return Number.isInteger(n) && n > 0 ? n : null;
    })();

    let province: string | null = null;
    let city: string | null = null;
    let district: string | null = null;
    let subdistrict: string | null = null;
    let postalCodeFromRegion: string | null =
        null;

    if (villageId) {
        const village = await prisma.village.findUnique({
            where: { id: villageId },
            select: {
                name: true,
                postalCode: true,
                district: {
                    select: {
                        name: true,
                        regency: {
                            select: {
                                name: true,
                                province: {
                                    select: {
                                        name: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!village) {
            throw new GuestAddressError(
                "Kelurahan/desa yang dipilih tidak ditemukan."
            );
        }

        const mapped = mapRegion(village);

        province = mapped.province;
        city = mapped.city;
        district = mapped.district;
        subdistrict = mapped.subdistrict;
        postalCodeFromRegion = village.postalCode;
    } else {
        const districtId = Number(input.districtId);
        const regencyId = Number(input.regencyId);
        const provinceId = Number(input.provinceId);

        if (Number.isInteger(districtId) && districtId > 0) {
            const row = await prisma.district.findUnique({
                where: { id: districtId },
                select: {
                    name: true,
                    regency: {
                        select: {
                            name: true,
                            province: {
                                select: { name: true },
                            },
                        },
                    },
                },
            });

            if (!row) {
                throw new GuestAddressError(
                    "Kecamatan yang dipilih tidak ditemukan."
                );
            }

            province = row.regency.province.name;
            city = row.regency.name;
            district = row.name;
        } else if (
            Number.isInteger(regencyId) &&
            regencyId > 0
        ) {
            const row = await prisma.regency.findUnique({
                where: { id: regencyId },
                select: {
                    name: true,
                    province: {
                        select: { name: true },
                    },
                },
            });

            if (!row) {
                throw new GuestAddressError(
                    "Kota/kabupaten yang dipilih tidak ditemukan."
                );
            }

            province = row.province.name;
            city = row.name;
        } else if (
            Number.isInteger(provinceId) &&
            provinceId > 0
        ) {
            const row = await prisma.province.findUnique({
                where: { id: provinceId },
                select: { name: true },
            });

            if (!row) {
                throw new GuestAddressError(
                    "Provinsi yang dipilih tidak ditemukan."
                );
            }

            province = row.name;
        }
    }

    /* ==========================================
     * FALLBACK: plain text fields
     * ==========================================
     * Used only when no region id was supplied. Names are still
     * required so the courier can resolve a destination.
     */
    const finalProvince =
        province ??
        requireString(
            input.province,
            "Provinsi",
            MAX_NAME
        );

    const finalCity =
        city ??
        requireString(
            input.city,
            "Kota/kabupaten",
            MAX_NAME
        );

    const finalDistrict =
        district ??
        requireString(
            input.district,
            "Kecamatan",
            MAX_NAME
        );

    const finalSubdistrict =
        subdistrict ??
        optionalString(input.subdistrict, MAX_NAME);

    const finalPostalCode = postalCodeFromRegion
        ? normalizePostalCode(
              postalCodeFromRegion
          )
        : normalizePostalCode(input.postalCode);

    /* ==========================================
     * RAJAONGKIR DESTINATION — VERIFIED ONLY
     * ==========================================
     *
     * A client-sent destination id is used only if it exists in the
     * synced region table; otherwise we attempt a name-based lookup.
     * An unverifiable id is discarded (never trusted, never invented).
     */
    let rajaOngkirDestinationId: number | null =
        null;

    const claimedDestination = Number(
        input.rajaOngkirDestinationId
    );

    if (
        Number.isInteger(claimedDestination) &&
        claimedDestination > 0
    ) {
        const verified =
            await prisma.rajaOngkirRegion.findUnique({
                where: {
                    destinationId:
                        claimedDestination,
                },
                select: { destinationId: true },
            });

        if (verified) {
            rajaOngkirDestinationId =
                verified.destinationId;
        }
    }

    if (rajaOngkirDestinationId === null) {
        const matched =
            await prisma.rajaOngkirRegion.findFirst({
                where: {
                    postalCode: finalPostalCode,
                    subdistrict: finalSubdistrict
                        ? finalSubdistrict
                        : undefined,
                },
                select: { destinationId: true },
            });

        if (matched) {
            rajaOngkirDestinationId =
                matched.destinationId;
        }
    }

    /* ==========================================
     * MENGANTAR AREA — RESOLVED SERVER-SIDE
     * ==========================================
     * Never accepted from the client; resolved via /address/search
     * against the normalized address and cached on the order.
     */
    const mengantarDestinationAreaId =
        await resolveMengantarDestinationAreaId({
            recipientName,
            phone,
            address,
            province: finalProvince,
            city: finalCity,
            district: finalDistrict,
            subdistrict: finalSubdistrict,
            postalCode: finalPostalCode,
        });

    return {
        recipientName,
        phone,
        email,
        address,
        note,
        province: finalProvince,
        city: finalCity,
        district: finalDistrict,
        subdistrict: finalSubdistrict,
        postalCode: finalPostalCode,
        rajaOngkirDestinationId,
        mengantarDestinationAreaId,
        latitude: optionalNumber(input.latitude),
        longitude: optionalNumber(input.longitude),
    };
}
