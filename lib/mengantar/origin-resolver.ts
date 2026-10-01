import { prisma } from "@/lib/prisma";

import {
    listMengantarPickupAddresses,
    searchMengantarAreas,
} from "@/lib/mengantar";
import {
    rankOriginCandidates,
    rankPickupCandidates,
    type OriginMatch,
    type PickupMatch,
    type StoreAddress,
} from "@/lib/mengantar/matching";

/*
 * ============================================================
 * MENGANTAR ORIGIN / PICKUP RESOLVER — SERVER-ONLY
 * ============================================================
 *
 * Reads the canonical store address (never a customer address) and
 * resolves the two Mengantar ids the shipping flow needs.
 *
 * One resolve = at most ONE `/address/search` + ONE `/address`
 * call. Candidates are ranked locally (lib/mengantar/matching.ts).
 *
 * `rajaOngkirDestinationId` is carried ONLY as a legacy reference —
 * it is never used as a Mengantar id.
 * ============================================================
 */

export type CanonicalStoreAddress = StoreAddress & {
    rajaOngkirDestinationId: number | null;
};

export async function getCanonicalStoreAddress(): Promise<CanonicalStoreAddress | null> {
    const store = await prisma.storeSetting.findUnique({
        where: { id: 1 },
        select: {
            storeName: true,
            address: true,
            province: true,
            city: true,
            district: true,
            subdistrict: true,
            postalCode: true,
            rajaOngkirDestinationId: true,
        },
    });

    if (!store) return null;

    return {
        storeName: store.storeName ?? "",
        address: store.address ?? "",
        province: store.province ?? null,
        city: store.city ?? null,
        district: store.district ?? null,
        subdistrict: store.subdistrict ?? null,
        postalCode: store.postalCode ?? null,
        rajaOngkirDestinationId:
            store.rajaOngkirDestinationId ?? null,
    };
}

/**
 * The search keyword sent to `/address/search`. Most specific first
 * so the provider returns a small, precise candidate set.
 */
export function buildOriginSearchKeyword(
    store: StoreAddress
): string {
    return [
        store.subdistrict,
        store.district,
        store.city,
        store.province,
        store.postalCode,
    ]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join(" ");
}

/**
 * Resolve the Mengantar origin AREA from the store address. Exactly
 * one search request; deterministic filtering happens locally.
 */
export async function resolveMengantarOriginArea(
    store: StoreAddress
): Promise<OriginMatch> {
    const keyword = buildOriginSearchKeyword(store);

    if (!keyword) {
        return { status: "INSUFFICIENT_DATA" };
    }

    const areas = await searchMengantarAreas(keyword);

    return rankOriginCandidates(store, areas);
}

/**
 * Resolve the Mengantar pickup ADDRESS from the store address.
 *
 * SAFETY: a pickup id may never equal the resolved origin area id,
 * and a pickup is only ever taken from the provider response.
 */
export async function resolveMengantarPickupAddress(
    store: StoreAddress,
    originAreaId?: string | null
): Promise<PickupMatch> {
    const pickups = await listMengantarPickupAddresses();

    const match = rankPickupCandidates(store, pickups);

    if (
        match.status === "MATCHED" &&
        originAreaId &&
        match.pickup._id === originAreaId
    ) {
        // Must never happen (different id spaces) — fail safe.
        return { status: "NOT_FOUND" };
    }

    return match;
}

export type MengantarStoreResolution = {
    store: CanonicalStoreAddress;
    origin: OriginMatch;
    pickup: PickupMatch;
};

/**
 * Full resolution used by the admin "Deteksi Otomatis" action.
 * Read-only: it never writes to the DB and never creates a shipment.
 */
export async function resolveMengantarStoreConfiguration(): Promise<MengantarStoreResolution | null> {
    const store = await getCanonicalStoreAddress();

    if (!store) return null;

    const origin = await resolveMengantarOriginArea(store);

    const pickup = await resolveMengantarPickupAddress(
        store,
        origin.status === "MATCHED"
            ? origin.area._id
            : null
    );

    return { store, origin, pickup };
}
