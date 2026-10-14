"use client";

/**
 * ==========================================
 * PUBLIC RESI LOOKUP (NO LOGIN)
 * ==========================================
 *
 * The input the WhatsApp menu points customers at: one waybill number,
 * one button, the parcel's journey on the website.
 *
 * HOW IT DECIDES (and why it is safe)
 *
 *   1. The value is normalized + validated in the BROWSER first, so an
 *      obviously bad resi never costs a request (the same rule is
 *      re-applied server-side — the client check is a convenience, never
 *      a security boundary).
 *   2. Exactly ONE request is made, to the read-only
 *      `GET /api/tracking/resi`, and nothing is cached (`no-store`).
 *   3. The route — not this component — decides what may be shown. No
 *      order, address, phone, e-mail, item or payment field ever reaches
 *      the browser through it, and a provider failure is an honest note
 *      rather than a made-up status.
 *   4. No login, no OTP, no cookie: a waybill is the tracking key, and
 *      the response carries shipment facts only.
 */

import { useCallback, useState } from "react";
import { FiPackage, FiSearch } from "react-icons/fi";

import ShipmentTimeline from "./ShipmentTimeline";
import {
    RESI_INVALID_MESSAGE,
    RESI_NOT_FOUND_MESSAGE,
    RESI_SERVICE_ERROR_MESSAGE,
    RESI_THROTTLED_MESSAGE,
    normalizeResi,
    type ResiTrackingView,
} from "@/lib/tracking/resi-lookup";

type LookupState =
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "result"; view: ResiTrackingView }
    | { phase: "error"; message: string };

const STATUS_BADGE: Record<string, string> = {
    DELIVERED: "bg-emerald-50 text-emerald-700",
    CANCELLED: "bg-red-50 text-red-700",
    RETURNED: "bg-red-50 text-red-700",
    UNDELIVERED: "bg-amber-50 text-amber-700",
    DELETED: "bg-gray-100 text-gray-600",
    PICKED_UP: "bg-blue-50 text-blue-700",
    IN_TRANSIT: "bg-blue-50 text-blue-700",
};

function pickView(data: unknown): ResiTrackingView | null {
    if (!data || typeof data !== "object") {
        return null;
    }

    const view = data as Partial<ResiTrackingView>;

    if (
        typeof view.waybill !== "string" ||
        !view.status ||
        typeof view.status.label !== "string"
    ) {
        return null;
    }

    return {
        waybill: view.waybill,
        courier: view.courier ?? null,
        service: view.service ?? null,
        status: {
            code: view.status.code ?? null,
            label: view.status.label,
        },
        delivered: view.delivered === true,
        timeline: Array.isArray(view.timeline)
            ? view.timeline
            : [],
        lastUpdate: view.lastUpdate ?? null,
        notes: Array.isArray(view.notes) ? view.notes : [],
        source: view.source === "PROVIDER" ? "PROVIDER" : "STORED",
    };
}

export default function ResiLookup() {
    const [resi, setResi] = useState("");
    const [state, setState] = useState<LookupState>({
        phase: "idle",
    });

    const loading = state.phase === "loading";

    const submit = useCallback(
        async (event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();

            if (loading) return;

            const normalized = normalizeResi(resi);

            if (!normalized) {
                setState({
                    phase: "error",
                    message: RESI_INVALID_MESSAGE,
                });

                return;
            }

            setState({ phase: "loading" });

            try {
                const response = await fetch(
                    `/api/tracking/resi?resi=${encodeURIComponent(
                        normalized
                    )}`,
                    { method: "GET", cache: "no-store" }
                );

                if (!response.ok) {
                    setState({
                        phase: "error",
                        message:
                            response.status === 400
                                ? RESI_INVALID_MESSAGE
                                : response.status === 404
                                  ? RESI_NOT_FOUND_MESSAGE
                                  : response.status === 429
                                    ? RESI_THROTTLED_MESSAGE
                                    : RESI_SERVICE_ERROR_MESSAGE,
                    });

                    return;
                }

                const body = await response.json();

                const view = response.ok
                    ? pickView(body?.data)
                    : null;

                setState(
                    view
                        ? { phase: "result", view }
                        : {
                              phase: "error",
                              message:
                                  RESI_SERVICE_ERROR_MESSAGE,
                          }
                );
            } catch {
                setState({
                    phase: "error",
                    message: RESI_SERVICE_ERROR_MESSAGE,
                });
            }
        },
        [loading, resi]
    );

    const view = state.phase === "result" ? state.view : null;

    return (
        <section className="border border-gray-200 bg-white px-5 py-6">
            <div className="flex items-center gap-2">
                <FiPackage
                    size={16}
                    className="text-gray-500"
                    aria-hidden="true"
                />

                <h2 className="text-sm font-bold text-gray-900">
                    Lacak Resi
                </h2>
            </div>

            <p className="mt-1.5 text-xs leading-5 text-gray-500">
                Masukkan nomor resi pengiriman kamu.
                Status dan perjalanan paket akan
                ditampilkan di sini.
            </p>

            <form
                onSubmit={submit}
                className="mt-4 flex flex-col gap-3 sm:flex-row"
            >
                <label className="sr-only" htmlFor="resi-input">
                    Nomor Resi
                </label>

                <input
                    id="resi-input"
                    name="resi"
                    value={resi}
                    onChange={(event) =>
                        setResi(event.target.value)
                    }
                    placeholder="Contoh: JT1234567890"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={40}
                    inputMode="text"
                    className="w-full rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 uppercase transition outline-none placeholder:normal-case placeholder:text-gray-400 focus:border-rose-500 focus:ring-2 focus:ring-rose-100"
                />

                <button
                    type="submit"
                    disabled={loading || resi.trim().length === 0}
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <FiSearch size={15} aria-hidden="true" />

                    {loading ? "Melacak..." : "Lacak Resi"}
                </button>
            </form>

            {loading && (
                <div className="mt-5 grid gap-3">
                    <div className="h-16 animate-pulse rounded-xl bg-gray-100" />

                    <div className="h-16 animate-pulse rounded-xl bg-gray-100" />
                </div>
            )}

            {state.phase === "error" && (
                <p
                    role="status"
                    className="mt-4 rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800"
                >
                    {state.message}
                </p>
            )}

            {view && (
                <div className="mt-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs text-gray-500">
                                Nomor Resi
                            </p>

                            <p className="mt-0.5 text-sm font-semibold break-all text-gray-900">
                                {view.waybill}
                            </p>
                        </div>

                        <span
                            className={`inline-flex shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold ${
                                STATUS_BADGE[
                                    view.status.code ?? ""
                                ] ?? "bg-gray-100 text-gray-600"
                            }`}
                        >
                            {view.status.label}
                        </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                            <p className="text-[11px] text-gray-500">
                                Kurir
                            </p>

                            <p className="mt-1 text-sm font-semibold break-words text-gray-900 uppercase">
                                {view.courier ?? "-"}
                            </p>
                        </div>

                        <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                            <p className="text-[11px] text-gray-500">
                                Layanan
                            </p>

                            <p className="mt-1 text-sm font-semibold break-words text-gray-900">
                                {view.service ?? "-"}
                            </p>
                        </div>
                    </div>

                    {view.notes.map((note) => (
                        <p
                            key={note}
                            className="mt-3 rounded-xl bg-gray-50 px-3.5 py-3 text-xs leading-5 text-gray-600"
                        >
                            ℹ️ {note}
                        </p>
                    ))}

                    <div className="mt-5 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-bold text-gray-900">
                            Perjalanan Paket
                        </h3>

                        {view.lastUpdate && (
                            <p className="text-[11px] text-gray-500">
                                Update terakhir: {view.lastUpdate}
                            </p>
                        )}
                    </div>

                    <ShipmentTimeline
                        entries={view.timeline}
                        emptyText={
                            view.notes.length > 0
                                ? "Riwayat perjalanan paket belum dapat diambil dari ekspedisi saat ini."
                                : "Riwayat perjalanan paket belum tersedia dari ekspedisi."
                        }
                    />

                    <button
                        type="button"
                        onClick={() => {
                            setState({ phase: "idle" });
                            setResi("");
                        }}
                        className="mt-5 w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 sm:w-auto"
                    >
                        Lacak resi lain
                    </button>
                </div>
            )}
        </section>
    );
}
