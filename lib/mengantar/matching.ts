import type {
    MengantarArea,
    MengantarPickupAddress,
} from "@/lib/mengantar";

/*
 * ============================================================
 * MENGANTAR — DETERMINISTIC MATCHER (PURE)
 * ============================================================
 *
 * Maps the canonical StoreSetting address to a Mengantar origin
 * AREA and a pickup ADDRESS. No I/O, no env, no DB — so the rules
 * are unit-testable and can never disagree with the resolver.
 *
 * HARD RULES (verified against the live API):
 *   - origin and pickup live in DIFFERENT id spaces. A pickup id is
 *     never an origin id and vice versa.
 *   - a postal code is NOT unique: 45467 alone is shared by 13
 *     subdistricts in Cingambul. Postal-only matching must never
 *     pick one.
 *   - the pickup address' area can differ from the store subdistrict
 *     (real data: store NAGARAKEMBANG, pickup RAWA). So a
 *     subdistrict is a hard filter for the ORIGIN but only a signal
 *     for the PICKUP.
 *
 * The matcher NEVER guesses: it returns MATCHED only for a single
 * deterministic candidate, otherwise AMBIGUOUS / NOT_FOUND /
 * INSUFFICIENT_DATA.
 */

export type StoreAddress = {
    storeName: string;
    address: string;
    province: string | null;
    city: string | null;
    district: string | null;
    subdistrict: string | null;
    postalCode: string | null;
};

export type MatchConfidence = "EXACT" | "STRONG";

export type OriginMatch =
    | {
          status: "MATCHED";
          area: MengantarArea;
          matchedFields: string[];
          confidence: MatchConfidence;
      }
    | { status: "AMBIGUOUS"; candidates: MengantarArea[] }
    | { status: "NOT_FOUND" }
    | { status: "INSUFFICIENT_DATA" };

export type PickupMatch =
    | {
          status: "MATCHED";
          pickup: MengantarPickupAddress;
          matchedFields: string[];
          confidence: MatchConfidence;
      }
    | {
          status: "AMBIGUOUS";
          candidates: MengantarPickupAddress[];
      }
    | { status: "NOT_FOUND" }
    | { status: "INSUFFICIENT_DATA" };

/** Exact field comparison: uppercase, strip everything non-alnum. */
export function normalizeField(value: unknown): string {
    return String(value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

/** Free-text comparison: uppercase, punctuation → single spaces. */
export function normalizeText(value: unknown): string {
    return String(value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

/** Whole-phrase containment on normalized text. */
export function textContainsPhrase(
    haystack: unknown,
    needle: unknown
): boolean {
    const phrase = normalizeText(needle);
    if (!phrase) return false;

    return ` ${normalizeText(haystack)} `.includes(
        ` ${phrase} `
    );
}

const ORIGIN_FIELDS = [
    "postalCode",
    "province",
    "city",
    "district",
    "subdistrict",
] as const;

type OriginField = (typeof ORIGIN_FIELDS)[number];

function areaFieldMatches(
    area: MengantarArea,
    field: OriginField,
    store: StoreAddress
): boolean {
    switch (field) {
        case "postalCode":
            return (
                normalizeField(area.ZIP_CODE) ===
                normalizeField(store.postalCode)
            );
        case "province":
            return (
                normalizeField(area.PROVINCE_NAME) ===
                normalizeField(store.province)
            );
        case "city":
            return (
                normalizeField(area.CITY_NAME) ===
                    normalizeField(store.city) ||
                normalizeField(area.CITY_NAME_SI) ===
                    normalizeField(store.city)
            );
        case "district":
            return (
                normalizeField(area.DISTRICT_NAME) ===
                normalizeField(store.district)
            );
        case "subdistrict":
            return (
                normalizeField(area.SUBDISTRICT_NAME) ===
                normalizeField(store.subdistrict)
            );
        default:
            return false;
    }
}

function confidenceFor(
    matchedFields: string[]
): MatchConfidence {
    return matchedFields.length >= 4 ? "EXACT" : "STRONG";
}

function dedupeAreas(
    areas: MengantarArea[]
): MengantarArea[] {
    const seen = new Set<string>();
    const out: MengantarArea[] = [];

    for (const area of areas) {
        if (!area?._id || seen.has(area._id)) continue;
        seen.add(area._id);
        out.push(area);
    }

    return out;
}

function dedupePickups(
    pickups: MengantarPickupAddress[]
): MengantarPickupAddress[] {
    const seen = new Set<string>();
    const out: MengantarPickupAddress[] = [];

    for (const pickup of pickups) {
        if (!pickup?._id || seen.has(pickup._id)) continue;
        seen.add(pickup._id);
        out.push(pickup);
    }

    return out;
}

/**
 * A candidate must match EVERY store field that is present. A
 * postal-code-only or city-only store would therefore produce many
 * candidates → AMBIGUOUS, never a guess.
 */
export function rankOriginCandidates(
    store: StoreAddress,
    areas: MengantarArea[]
): OriginMatch {
    // Need at least one anchoring field.
    if (!store.postalCode && !store.city && !store.province) {
        return { status: "INSUFFICIENT_DATA" };
    }

    const presentFields = ORIGIN_FIELDS.filter((field) =>
        Boolean(store[field])
    );

    const matched = dedupeAreas(
        (areas ?? []).filter(
            (area) =>
                area?._id &&
                presentFields.every((field) =>
                    areaFieldMatches(area, field, store)
                )
        )
    );

    if (matched.length === 0) {
        return { status: "NOT_FOUND" };
    }

    if (matched.length > 1) {
        return { status: "AMBIGUOUS", candidates: matched };
    }

    const area = matched[0];
    const matchedFields = presentFields.filter((field) =>
        areaFieldMatches(area, field, store)
    );

    return {
        status: "MATCHED",
        area,
        matchedFields,
        confidence: confidenceFor(matchedFields),
    };
}

const PICKUP_GEO_FIELDS = [
    "postalCode",
    "province",
    "city",
    "district",
] as const;

type PickupGeoField = (typeof PICKUP_GEO_FIELDS)[number];

/**
 * Every available geo field must appear as a whole phrase in the
 * pickup's ADDRESS text (not its name). When more than one pickup
 * survives, the store name may disambiguate — but only as a tie
 * breaker, never on its own.
 */
export function rankPickupCandidates(
    store: StoreAddress,
    pickups: MengantarPickupAddress[]
): PickupMatch {
    const presentFields = PICKUP_GEO_FIELDS.filter((field) =>
        Boolean(store[field])
    );

    if (presentFields.length === 0) {
        return { status: "INSUFFICIENT_DATA" };
    }

    const usable = dedupePickups(pickups ?? []);

    const scored = usable
        .map((pickup) => {
            const haystack = pickup.address ?? "";
            const matchedFields = presentFields.filter(
                (field: PickupGeoField) =>
                    textContainsPhrase(
                        haystack,
                        store[field]
                    )
            );
            return { pickup, matchedFields };
        })
        .filter(
            (entry) =>
                entry.matchedFields.length ===
                presentFields.length
        );

    if (scored.length === 0) {
        return { status: "NOT_FOUND" };
    }

    if (scored.length === 1) {
        return {
            status: "MATCHED",
            pickup: scored[0].pickup,
            matchedFields: scored[0].matchedFields,
            confidence: confidenceFor(
                scored[0].matchedFields
            ),
        };
    }

    // Tie-break by normalized store name — only among candidates
    // that already satisfy every geo field.
    const storeName = normalizeText(store.storeName);

    if (storeName) {
        const nameMatches = scored.filter((entry) =>
            textContainsPhrase(
                entry.pickup.name,
                store.storeName
            )
        );

        if (nameMatches.length === 1) {
            return {
                status: "MATCHED",
                pickup: nameMatches[0].pickup,
                matchedFields:
                    nameMatches[0].matchedFields,
                confidence: "STRONG",
            };
        }
    }

    return {
        status: "AMBIGUOUS",
        candidates: scored.map((entry) => entry.pickup),
    };
}
