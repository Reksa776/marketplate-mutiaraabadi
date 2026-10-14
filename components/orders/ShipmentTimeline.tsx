"use client";

/**
 * ==========================================
 * SHIPMENT TIMELINE
 * ==========================================
 *
 * The ONE timeline renderer for a parcel's journey: the public tracking
 * page (`/lacak`) uses it, so a second implementation cannot drift from
 * what the customer was told in WhatsApp.
 *
 * Entries arrive NEWEST FIRST (see lib/tracking/tracking-page.ts), so the
 * top dot is the most recent scan and is highlighted.
 *
 * Presentational only: no fetching, no state, no timers.
 */

export type ShipmentTimelineEntry = {
    date?: string | null;
    description?: string | null;
    location?: string | null;
};

type Props = {
    entries: ShipmentTimelineEntry[];
    emptyText?: string;
};

export default function ShipmentTimeline({
    entries,
    emptyText = "Belum ada riwayat perjalanan paket.",
}: Props) {
    if (!entries.length) {
        return (
            <div className="rounded-xl bg-gray-50 px-4 py-5">
                <p className="text-sm text-gray-500">{emptyText}</p>
            </div>
        );
    }

    return (
        <ol className="mt-4 space-y-0">
            {entries.map((item, index) => {
                const date = String(item.date ?? "").trim();
                const location = String(
                    item.location ?? ""
                ).trim();

                return (
                    <li
                        key={`${date}-${index}`}
                        className="flex gap-3"
                    >
                        <div className="flex flex-col items-center">
                            <span
                                aria-hidden="true"
                                className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                                    index === 0
                                        ? "bg-rose-600"
                                        : "bg-gray-300"
                                }`}
                            />

                            {index < entries.length - 1 && (
                                <span
                                    aria-hidden="true"
                                    className="mt-1 w-px flex-1 bg-gray-200"
                                />
                            )}
                        </div>

                        <div className="min-w-0 pb-5">
                            <p className="text-sm leading-5 font-semibold text-gray-900">
                                {String(
                                    item.description ?? ""
                                ).trim() || "Pembaruan pengiriman"}
                            </p>

                            {date && (
                                <p className="mt-0.5 text-xs text-gray-500">
                                    {date}
                                </p>
                            )}

                            {location && (
                                <p className="mt-0.5 text-xs text-gray-500">
                                    {location}
                                </p>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
