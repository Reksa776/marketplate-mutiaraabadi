import { prisma } from "@/lib/prisma";

import {
    MENGANTAR_COURIERS,
    MengantarError,
    estimateMengantarShipping,
    isMengantarConfigured,
    searchMengantarAreas,
    toInternalCourier,
    toMengantarCourier,
    type MengantarArea,
    type MengantarCourier,
    type MengantarEstimateEntry,
} from "@/lib/mengantar";

/*
 * ============================================================
 * MENGANTAR SHIPPING — SERVER-ONLY LAYER
 * ============================================================
 *
 * RESPONSIBILITY SPLIT (RajaOngkir vs Mengantar):
 *   - RajaOngkir : province → city → district → subdistrict →
 *                  postal code dropdowns + destination lookup
 *                  (UNCHANGED, still the address source of truth).
 *   - Mengantar  : shipping estimate, courier availability, COD
 *                  availability, shipment creation, tracking.
 *
 * The normalized address (name, phone, address, province, city,
 * district, subdistrict, postalCode) is what we send to Mengantar.
 * We NEVER send rajaOngkirDestinationId as a Mengantar ID.
 * ============================================================
 */

export type MengantarShippingOption = {
    provider: "MENGANTAR";
    /**
     * Exact Mengantar courier name (JNE, JT, SieCepat, ...). This is
     * the ONLY selector Mengantar order creation accepts.
     */
    courier: MengantarCourier;
    /** Internal (lowercase) courier code, for legacy UI/tracking. */
    courierCode: string;
    courierName: string;
    /**
     * Mengantar's standard regular service. Order creation does not
     * accept a service parameter; this is display-only.
     */
    service: string;
    description: string;
    /** Authoritative price (IDR) from Mengantar. */
    cost: number;
    etd: string;
    supportsCod: boolean;
    /** Mengantar COD service fee percentage reported by the estimate. */
    codFeePercent: number;
};

type AddressForMengantar = {
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

/*
 * ============================================================
 * ORIGIN CONFIG (store pickup)
 * ============================================================
 */

export type MengantarOriginConfig = {
    originAreaId: string;
    pickupAddressId: string;
    pickupTimeId: string | null;
};

export async function getMengantarOriginConfig(): Promise<MengantarOriginConfig | null> {
    const store = await prisma.storeSetting.findUnique({
        where: { id: 1 },
        select: {
            mengantarOriginAreaId: true,
            mengantarPickupAddressId: true,
            mengantarPickupTimeId: true,
        },
    });

    if (
        !store?.mengantarOriginAreaId ||
        !store?.mengantarPickupAddressId
    ) {
        return null;
    }

    return {
        originAreaId: store.mengantarOriginAreaId,
        pickupAddressId: store.mengantarPickupAddressId,
        pickupTimeId: store.mengantarPickupTimeId ?? null,
    };
}

/*
 * ============================================================
 * DESTINATION AREA RESOLUTION
 * ============================================================
 *
 * Mengantar only accepts its OWN area `_id`. We resolve it from the
 * normalized address fields via /address/search, then cache it on the
 * UserAddress row.
 *
 * The cache is invalidated whenever the area-ish fields change (the
 * address CRUD routes null it out), so a stale ID cannot leak.
 */

function normalizeToken(value: unknown): string {
    return String(value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

/**
 * Best-effort match of a normalized address against Mengantar's area
 * list. Priority: ZIP → subdistrict → district → city → province.
 * Returns null when nothing plausible is found (caller must NOT
 * invent an area id).
 */
function pickBestArea(
    areas: MengantarArea[],
    address: AddressForMengantar
): MengantarArea | null {
    if (!Array.isArray(areas) || areas.length === 0) {
        return null;
    }

    const zip = normalizeToken(address.postalCode);
    const subdistrict = normalizeToken(address.subdistrict);
    const district = normalizeToken(address.district);
    const city = normalizeToken(address.city);
    const province = normalizeToken(address.province);

    let best: MengantarArea | null = null;
    let bestScore = 0;

    for (const area of areas) {
        let score = 0;

        if (zip && normalizeToken(area.ZIP_CODE) === zip) {
            score += 8;
        }
        if (
            subdistrict &&
            normalizeToken(area.SUBDISTRICT_NAME) ===
                subdistrict
        ) {
            score += 4;
        }
        if (
            district &&
            normalizeToken(area.DISTRICT_NAME) === district
        ) {
            score += 2;
        }
        if (city && normalizeToken(area.CITY_NAME) === city) {
            score += 2;
        }
        if (
            province &&
            normalizeToken(area.PROVINCE_NAME) === province
        ) {
            score += 1;
        }

        if (score > bestScore && area._id) {
            bestScore = score;
            best = area;
        }
    }

    // Require a minimum signal so we never return a random area.
    return bestScore >= 3 ? best : null;
}

export async function resolveMengantarDestinationAreaId(
    address: AddressForMengantar
): Promise<string | null> {
    if (address.mengantarDestinationAreaId) {
        return address.mengantarDestinationAreaId;
    }

    if (!isMengantarConfigured()) {
        return null;
    }

    const keyword = [
        address.subdistrict,
        address.district,
        address.city,
        address.province,
        address.postalCode,
    ]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join(" ");

    if (!keyword) {
        return null;
    }

    const areas = await searchMengantarAreas(keyword);

    const matched = pickBestArea(areas, address);

    if (!matched?._id) {
        return null;
    }

    // Cache on the address row when this is a persisted address.
    if (address.id) {
        try {
            await prisma.userAddress.update({
                where: { id: address.id },
                data: {
                    mengantarDestinationAreaId: matched._id,
                },
            });
        } catch {
            /* cache write is best-effort */
        }
    }

    return matched._id;
}

/*
 * ============================================================
 * BUILD SHIPPING OPTIONS
 * ============================================================
 */

function gramsToKilograms(weightGrams: number): number {
    const kg = Math.ceil(Number(weightGrams)) / 1000;
    // Mengantar bills a minimum of 1 kg.
    return Math.max(1, Number(kg.toFixed(2)));
}

function entryToOption(
    courier: MengantarCourier,
    entry: MengantarEstimateEntry
): MengantarShippingOption | null {
    if (entry.unsupported === true) return null;

    const cost = Number(
        entry.estimatedPrice ??
            entry.price ??
            NaN
    );

    if (!Number.isFinite(cost) || cost <= 0) {
        return null;
    }

    const etd =
        entry.estimatedDate ??
        entry.estimate_delivery ??
        "";

    return {
        provider: "MENGANTAR",
        courier,
        courierCode: toInternalCourier(courier),
        courierName: courier,
        service: "REG",
        description: String(etd),
        cost: Math.round(cost),
        etd: String(etd),
        // COD is available only when the courier explicitly says so.
        supportsCod: entry.unsupported_cod === false,
        codFeePercent: Number(entry.codFee ?? 0),
    };
}

/**
 * Returns normalized, server-derived shipping options for a
 * destination address. `weightGrams` is converted to kilograms.
 *
 * All couriers are requested in a single call (courier=all) — the
 * public estimate is per-courier and does NOT expose a service
 * dimension, so one option per available courier is produced.
 */
export async function buildMengantarShippingOptions({
    address,
    weightGrams,
    codAmount,
}: {
    address: AddressForMengantar;
    weightGrams: number;
    codAmount?: number;
}): Promise<MengantarShippingOption[]> {
    if (!isMengantarConfigured()) {
        throw new MengantarError(
            "Mengantar belum dikonfigurasi."
        );
    }

    const origin = await getMengantarOriginConfig();

    if (!origin) {
        throw new MengantarError(
            "Konfigurasi pickup Mengantar belum diatur."
        );
    }

    const destinationAreaId =
        await resolveMengantarDestinationAreaId(address);

    if (!destinationAreaId) {
        throw new MengantarError(
            "Alamat tujuan belum dapat dipetakan ke area Mengantar."
        );
    }

    const weightKg = gramsToKilograms(weightGrams);

    const data = await estimateMengantarShipping({
        originAreaId: origin.originAreaId,
        destinationAreaId,
        weightKg,
        courier: "all",
        codAmount,
    });

    const options: MengantarShippingOption[] = [];

    for (const [courierName, entry] of Object.entries(data)) {
        // The estimate key casing differs per courier; only accept
        // names we can map back to a supported Mengantar courier.
        const matched = (MENGANTAR_COURIERS as readonly string[]).find(
            (c) => c.toLowerCase() === courierName.toLowerCase()
        );

        if (!matched) continue;

        const option = entryToOption(
            matched as MengantarCourier,
            entry
        );

        if (option) options.push(option);
    }

    options.sort((a, b) => a.cost - b.cost);

    return options;
}

/**
 * Server-authoritative re-verification. The client-supplied cost is
 * IGNORED: we ask Mengantar again for the exact courier and compare.
 * Returns the authoritative price, or null when the courier/service
 * is not actually available for this route.
 */
export async function verifyMengantarShippingCost({
    address,
    weightGrams,
    courier,
    codAmount,
}: {
    address: AddressForMengantar;
    weightGrams: number;
    courier: string;
    codAmount?: number;
}): Promise<number | null> {
    const shippingCourier = toMengantarCourier(courier);

    if (!shippingCourier) {
        throw new MengantarError(
            "Kurir tidak tersedia di Mengantar."
        );
    }

    const options = await buildMengantarShippingOptions({
        address,
        weightGrams,
        codAmount,
    });

    const match = options.find(
        (option) => option.courier === shippingCourier
    );

    if (!match) {
        throw new MengantarError(
            `Layanan ${shippingCourier} tidak tersedia untuk pengiriman ini. Silakan pilih ulang layanan pengiriman.`
        );
    }

    return match.cost;
}
