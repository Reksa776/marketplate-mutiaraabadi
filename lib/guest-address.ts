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

/**
 * Does a stored region name agree with the label the buyer selected?
 *
 * Provider region feeds differ in casing, punctuation and naming
 * conventions ("SELAPARANG (SELAPRANG)"), so the comparison is done on
 * alphanumerics only and also accepts a contained match.
 *
 * This is the guard that stops an id from a DIFFERENT id space from
 * silently re-pointing the destination at an unrelated region: an id is
 * only adopted when the row it resolves to is the place that was
 * actually selected.
 */
function regionLabelMatches(
    submitted: unknown,
    stored: unknown
): boolean {
    const a = String(submitted ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

    const b = String(stored ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

    // Nothing to compare against — do not block on a missing label.
    if (!a || !b) return true;

    return a === b || a.includes(b) || b.includes(a);
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
     * The region ids come from the BROWSER and are never trusted. The
     * address form is fed by the shipping provider's own region feed,
     * whose id space is NOT the same as the local region tables, so a
     * perfectly valid selection can carry an id this server cannot
     * resolve.
     *
     * Each id is therefore VERIFIED against the local table and accepted
     * only when it also belongs to its parent — kelurahan inside
     * kecamatan inside kota inside provinsi. An id that cannot be
     * verified (unknown, or belonging to a different parent) is
     * DISCARDED, never invented and never fatal: this mirrors the
     * tolerant contract already used by POST /api/addresses, keeps
     * checkout from blocking on a badge the buyer cannot fix, and does
     * not weaken anything security-relevant because the shipping
     * destination is still resolved server-side from the final address.
     *
     * When a level DOES verify, the stored hierarchy wins for the
     * destination labels — client-sent province/city/district strings
     * are then ignored for that level and its parents.
     */
    const asId = (value: unknown): number | null => {
        const n = Number(value);
        return Number.isInteger(n) && n > 0 ? n : null;
    };

    const provinceId = asId(input.provinceId);
    const regencyId = asId(input.regencyId);
    const districtId = asId(input.districtId);
    const villageId = asId(input.villageId);

    let province: string | null = null;
    let city: string | null = null;
    let district: string | null = null;
    let subdistrict: string | null = null;
    let postalCodeFromRegion: string | null =
        null;

    /* KELURAHAN / DESA — deepest level, so it wins when it verifies. */
    if (villageId) {
        const village = await prisma.village.findUnique({
            where: { id: villageId },
            select: {
                name: true,
                postalCode: true,
                districtId: true,
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
            console.warn(
                "GUEST ADDRESS: kelurahan id tidak ada di tabel lokal — id diabaikan."
            );
        } else if (
            !regionLabelMatches(
                input.subdistrict,
                village.name
            )
        ) {
            console.warn(
                "GUEST ADDRESS: kelurahan id menunjuk wilayah lain — id diabaikan."
            );
        } else if (
            districtId &&
            village.districtId !== districtId
        ) {
            console.warn(
                "GUEST ADDRESS: kelurahan tidak berada di kecamatan yang dipilih — id diabaikan."
            );
        } else {
            const mapped = mapRegion(village);

            province = mapped.province;
            city = mapped.city;
            district = mapped.district;
            subdistrict = mapped.subdistrict;
            postalCodeFromRegion = village.postalCode;
        }
    }

    /* KECAMATAN — used only when the kelurahan did not verify. */
    if (district === null && districtId) {
        const row = await prisma.district.findUnique({
            where: { id: districtId },
            select: {
                name: true,
                regencyId: true,
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
            console.warn(
                "GUEST ADDRESS: kecamatan id tidak ada di tabel lokal — id diabaikan."
            );
        } else if (
            !regionLabelMatches(input.district, row.name)
        ) {
            console.warn(
                "GUEST ADDRESS: kecamatan id menunjuk wilayah lain — id diabaikan."
            );
        } else if (
            regencyId &&
            row.regencyId !== regencyId
        ) {
            console.warn(
                "GUEST ADDRESS: kecamatan tidak berada di kota yang dipilih — id diabaikan."
            );
        } else {
            province = row.regency.province.name;
            city = row.regency.name;
            district = row.name;
        }
    }

    /* KOTA / KABUPATEN */
    if (city === null && regencyId) {
        const row = await prisma.regency.findUnique({
            where: { id: regencyId },
            select: {
                name: true,
                provinceId: true,
                province: {
                    select: { name: true },
                },
            },
        });

        if (!row) {
            console.warn(
                "GUEST ADDRESS: kota id tidak ada di tabel lokal — id diabaikan."
            );
        } else if (
            !regionLabelMatches(input.city, row.name)
        ) {
            console.warn(
                "GUEST ADDRESS: kota id menunjuk wilayah lain — id diabaikan."
            );
        } else if (
            provinceId &&
            row.provinceId !== provinceId
        ) {
            console.warn(
                "GUEST ADDRESS: kota tidak berada di provinsi yang dipilih — id diabaikan."
            );
        } else {
            province = row.province.name;
            city = row.name;
        }
    }

    /* PROVINSI */
    if (province === null && provinceId) {
        const row = await prisma.province.findUnique({
            where: { id: provinceId },
            select: { name: true },
        });

        if (!row) {
            console.warn(
                "GUEST ADDRESS: provinsi id tidak ada di tabel lokal — id diabaikan."
            );
        } else if (
            !regionLabelMatches(input.province, row.name)
        ) {
            console.warn(
                "GUEST ADDRESS: provinsi id menunjuk wilayah lain — id diabaikan."
            );
        } else {
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
