/*
 * ============================================================
 * MENGANTAR PICKUP SETTINGS — PURE VALIDATION
 * ============================================================
 *
 * Pure, dependency-free helpers used by the admin settings route.
 * Keeping this separate from the API client means the validation
 * rules can be unit-tested without env / network / DB.
 *
 * The three StoreSetting fields map to Mengantar concepts:
 *   mengantarOriginAreaId   → area _id  (estimate origin_id)
 *   mengantarPickupAddressId→ pickup _id (POST /order pickup.address_id)
 *   mengantarPickupTimeId   → time _id  (scheduledPickup.time_id)
 *
 * RULES (verified against the shipment contract in
 * lib/mengantar/shipment.ts):
 *   - origin + pickup are REQUIRED together (a partial config is
 *     rejected), because getMengantarOriginConfig() needs both.
 *   - pickupTime is OPTIONAL: NULL means dropOff (no time_id).
 *   - "scheduled" MODE requires a pickup time.
 *   - An all-empty submission is valid and clears the config
 *     (Mengantar disabled) — it must never block saving the rest
 *     of the store settings.
 *
 * NOTE: this validates FORMAT only. Existence against the live
 * Mengantar account is checked separately in the settings route
 * (GET /address, GET /time) when an API key is configured.
 */

/**
 * Mengantar identifiers are Mongo ObjectIds in practice, but we keep
 * the allowed shape slightly wider so a provider-format change can
 * never lock an admin out. Rejects empty, whitespace and any value
 * carrying URL/shell metacharacters.
 */
export const MENGANTAR_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidMengantarId(value: unknown): boolean {
    if (typeof value !== "string") return false;
    return MENGANTAR_ID_PATTERN.test(value.trim());
}

export type MengantarPickupMode = "dropoff" | "scheduled";

export type MengantarSettingsValue = {
    originAreaId: string | null;
    pickupAddressId: string | null;
    pickupTimeId: string | null;
    mode: MengantarPickupMode;
};

export type MengantarSettingsResult =
    | { ok: true; value: MengantarSettingsValue }
    | { ok: false; field: string; message: string };

function asTrimmedString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize + validate the raw PUT body's Mengantar fields.
 */
export function resolveMengantarSettingsInput(
    body: unknown
): MengantarSettingsResult {
    const source = (body ?? {}) as Record<string, unknown>;

    const origin = asTrimmedString(
        source.mengantarOriginAreaId
    );
    const pickup = asTrimmedString(
        source.mengantarPickupAddressId
    );
    const time = asTrimmedString(
        source.mengantarPickupTimeId
    );

    const rawMode = source.mengantarPickupMode;
    const mode: MengantarPickupMode =
        rawMode === "scheduled" || rawMode === "dropoff"
            ? rawMode
            : time
              ? "scheduled"
              : "dropoff";

    const anyProvided = Boolean(origin || pickup || time);

    // Nothing provided → clear the configuration (dropOff, disabled).
    if (!anyProvided) {
        if (mode === "scheduled") {
            return {
                ok: false,
                field: "mengantarPickupTimeId",
                message:
                    "Scheduled Pickup membutuhkan origin area, pickup address, dan slot waktu pickup.",
            };
        }

        return {
            ok: true,
            value: {
                originAreaId: null,
                pickupAddressId: null,
                pickupTimeId: null,
                mode: "dropoff",
            },
        };
    }

    // Partial configuration is rejected: origin and pickup must be
    // set together (getMengantarOriginConfig requires both).
    if (!origin) {
        return {
            ok: false,
            field: "mengantarOriginAreaId",
            message: "Origin area Mengantar wajib diisi.",
        };
    }

    if (!isValidMengantarId(origin)) {
        return {
            ok: false,
            field: "mengantarOriginAreaId",
            message: "Origin area Mengantar tidak valid.",
        };
    }

    if (!pickup) {
        return {
            ok: false,
            field: "mengantarPickupAddressId",
            message: "Pickup address Mengantar wajib diisi.",
        };
    }

    if (!isValidMengantarId(pickup)) {
        return {
            ok: false,
            field: "mengantarPickupAddressId",
            message: "Pickup address Mengantar tidak valid.",
        };
    }

    let pickupTimeId: string | null = time || null;

    if (mode === "scheduled") {
        if (!pickupTimeId) {
            return {
                ok: false,
                field: "mengantarPickupTimeId",
                message:
                    "Pilih slot waktu pickup untuk Scheduled Pickup, atau ubah ke Drop-off.",
            };
        }

        if (!isValidMengantarId(pickupTimeId)) {
            return {
                ok: false,
                field: "mengantarPickupTimeId",
                message:
                    "Slot waktu pickup Mengantar tidak valid.",
            };
        }
    } else {
        // Drop-off never carries a time id.
        pickupTimeId = null;
    }

    return {
        ok: true,
        value: {
            originAreaId: origin,
            pickupAddressId: pickup,
            pickupTimeId,
            mode,
        },
    };
}

/**
 * Safe admin-facing Mengantar view. Deliberately takes NO credentials:
 * the API key / webhook secret are never part of this shape, so they
 * can never be serialised by accident.
 */
export function buildMengantarSettingsView(input: {
    apiConfigured: boolean;
    originAreaId: string | null;
    pickupAddressId: string | null;
    pickupTimeId: string | null;
}) {
    return {
        /** MENGANTAR_API_KEY present in the server env. */
        mengantarApiConfigured: input.apiConfigured,
        /** origin + pickup stored → estimate/shipment can run. */
        mengantarPickupConfigured: Boolean(
            input.originAreaId && input.pickupAddressId
        ),
        mengantarOriginAreaId: input.originAreaId,
        mengantarPickupAddressId: input.pickupAddressId,
        mengantarPickupTimeId: input.pickupTimeId,
    };
}
