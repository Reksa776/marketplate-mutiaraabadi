import {
    createMengantarPickupTime,
    type MengantarPickupTime,
} from "@/lib/mengantar";
import type { MengantarOriginConfig } from "@/lib/mengantar/shipping";

/*
 * ============================================================
 * MENGANTAR PICKUP SCHEDULE RESOLVER
 * ============================================================
 *
 * Mengantar requires a pickup schedule for `scheduledPickup` orders:
 *   POST /time { address_id, date: mm-dd-yyyy, time }
 * The slot MUST be ≥ 90 minutes in the future (documented rule).
 * The slot's `_id` is the only valid `pickup.time_id` for POST /order.
 *
 * PHASE 3 CONTRACT AUDIT (official docs, api-public.mengantar.com/docs):
 *   - POST /time returns `{ _id, date, time, status, isSunday, address }`.
 *     `date` is an ISO datetime (e.g. "2026-02-03T00:00:00.000Z"), NOT
 *     `mm-dd-yyyy`; GET /time returns `date` as an epoch number. We
 *     therefore persist the VALIDATED WIB slot we requested, never the
 *     provider's echoed date.
 *   - Within ONE POST /order the single `pickup.time_id` applies to
 *     every item in the `orders` batch (batch-internal sharing is
 *     documented). Reuse ACROSS separate POST /order calls is NOT
 *     documented.
 *   - The docs are silent on POST /time idempotency, schedule expiry,
 *     duplicate schedules, `time_id` locking by POST /order, cleanup,
 *     and POST /time rate limits. No sandbox API key is configured, so
 *     cross-request reuse could not be verified.
 *
 * POLICY (defensive):
 *   - dropOff mode (no configured pickup time) → no schedule.
 *   - scheduledPickup mode → ALWAYS create a FRESH slot just before
 *     creating the shipment. Cross-request `time_id` reuse is
 *     UNPROVEN by the provider, so the safe policy is one fresh
 *     schedule per shipment; reuse MUST NOT be implemented without
 *     explicit provider confirmation. If slot creation fails we never
 *     fabricate a shipment.
 *
 * The pure slot math is separated from the IO call so it can be
 * unit-tested without env / network.
 * ============================================================
 */

/** Documented available pickup hours (WIB). */
export const MENGANTAR_PICKUP_SLOT_HOURS = [
    9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
] as const;

/** Documented minimum lead time before the pickup slot. */
export const MENGANTAR_MIN_LEAD_MINUTES = 90;

/** Asia/Jakarta (WIB) is UTC+7 with no DST. */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

type WibParts = {
    year: number;
    /** 0-based month (Date.UTC semantics). */
    month: number;
    day: number;
    hour: number;
};

function toWibParts(epochMs: number): WibParts {
    const d = new Date(epochMs + WIB_OFFSET_MS);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth(),
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
    };
}

/** Convert a WIB wall-clock date/time into an epoch (ms). */
function wibToEpoch(
    year: number,
    month: number,
    day: number,
    hour: number
): number {
    return (
        Date.UTC(year, month, day, hour, 0, 0, 0) - WIB_OFFSET_MS
    );
}

export type MengantarPickupSlot = {
    /** mm-dd-yyyy (Mengantar's documented format). */
    date: string;
    /** e.g. "9:00" … "18:00". */
    time: string;
    /** Epoch (ms) of the slot start. */
    epochMs: number;
};

/**
 * The next valid pickup slot ≥ now + 90 minutes, expressed in WIB.
 * Scans today first, then the following days (bounded).
 *
 * Pure — no env / network. Returns the slot the caller must POST.
 */
export function computeNextMengantarPickupSlot(
    now: Date = new Date()
): MengantarPickupSlot {
    const thresholdMs =
        now.getTime() + MENGANTAR_MIN_LEAD_MINUTES * 60 * 1000;

    const base = toWibParts(now.getTime());

    for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
        const dayEpoch = wibToEpoch(
            base.year,
            base.month,
            base.day + dayOffset,
            0
        );
        const day = toWibParts(dayEpoch);

        for (const hour of MENGANTAR_PICKUP_SLOT_HOURS) {
            const slotEpoch = wibToEpoch(
                day.year,
                day.month,
                day.day,
                hour
            );

            if (slotEpoch >= thresholdMs) {
                return {
                    date: `${pad2(day.month + 1)}-${pad2(
                        day.day
                    )}-${day.year}`,
                    time: `${hour}:00`,
                    epochMs: slotEpoch,
                };
            }
        }
    }

    throw new Error(
        "Tidak dapat menentukan jadwal pickup Mengantar yang valid."
    );
}

/**
 * Parse an existing Mengantar slot (mm-dd-yyyy / HH:mm) into an epoch.
 * Returns null when the shape is not recognized.
 */
export function parseMengantarPickupSlot(
    date: unknown,
    time: unknown
): number | null {
    const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(
        String(date ?? "").trim()
    );
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(
        String(time ?? "").trim()
    );

    if (!dateMatch || !timeMatch) return null;

    const month = Number(dateMatch[1]);
    const day = Number(dateMatch[2]);
    const year = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);

    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        return null;
    }

    return wibToEpoch(year, month - 1, day, hour) + minute * 60 * 1000;
}

export type ResolvedMengantarPickup =
    | {
          type: "dropOff";
          address_id: string;
          schedule: null;
      }
    | {
          type: "scheduledPickup";
          volume: "volumeMotor";
          address_id: string;
          time_id: string;
          schedule: { date: string; time: string };
      };

/**
 * Resolve the pickup payload for POST /order.
 *
 * dropOff      → no schedule, no network call.
 * scheduled    → create a FRESH /time slot (never reuse an existing
 *                id) and return it. Throws on failure so the caller
 *                can retry without fabricating a shipment.
 */
export async function resolveMengantarPickupSchedule(
    config: MengantarOriginConfig,
    now: Date = new Date()
): Promise<ResolvedMengantarPickup> {
    // Mode is DERIVED: a configured pickup time ⇒ scheduledPickup.
    if (!config.pickupTimeId) {
        return {
            type: "dropOff",
            address_id: config.pickupAddressId,
            schedule: null,
        };
    }

    const slot = computeNextMengantarPickupSlot(now);

    let created: MengantarPickupTime;

    try {
        created = await createMengantarPickupTime({
            addressId: config.pickupAddressId,
            date: slot.date,
            time: slot.time,
        });
    } catch (error) {
        throw error;
    }

    return {
        type: "scheduledPickup",
        volume: "volumeMotor",
        address_id: config.pickupAddressId,
        time_id: created._id,
        // Persist the slot we VALIDATED (mm-dd-yyyy / H:00 WIB), not the
        // provider's echoed `date` — POST /time returns an ISO datetime
        // there, which would corrupt the display-persisted pickupDate.
        schedule: {
            date: slot.date,
            time: slot.time,
        },
    };
}
