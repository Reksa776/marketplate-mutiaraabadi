"use client";

/**
 * ==========================================
 * SHIPMENT TRACKING PANEL (READ-ONLY)
 * ==========================================
 *
 * The panel behind the public tracking page (`/lacak`). It answers one
 * question — where is my parcel — and nothing else:
 *
 *   * DATA SOURCE: the SAME production endpoints the order pages use,
 *     with the SAME authorization (`GET /api/orders/[id]` and
 *     `GET /api/orders/[id]/tracking`, both ownership-guarded by
 *     `authorizeOrderRequest`). No second tracking adapter, no second
 *     authorization, no direct provider call from the browser.
 *   * READ-ONLY: this component never POSTs/PATCHes anything, so
 *     tracking can never change an order status.
 *   * NO sensitive projection is kept or rendered: the order response
 *     also carries address, phone and items, and none of those fields
 *     are read from it here (see TRACKED_FIELDS).
 *   * Provider failure degrades: the stored shipment status is shown
 *     with an honest note and a MANUAL retry — never a raw error, and
 *     never an automatic poll.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { FaWhatsapp } from "react-icons/fa";

import ShipmentTimeline from "./ShipmentTimeline";
import {
    SHIPMENT_STAGE_LABELS,
    TRACKING_UPDATE_UNAVAILABLE_NOTE,
    resolveProviderRead,
    resolveShipmentStage,
    shouldReadProvider,
    shipmentStageHint,
    type TrackingProviderView,
} from "@/lib/tracking/tracking-page";

/**
 * The ONLY order fields this panel reads. Everything else in the
 * response (address, phone, email, items, totals, payment data) is
 * deliberately dropped on the floor.
 */
const TRACKED_FIELDS = [
    "id",
    "orderNumber",
    "status",
    "paymentStatus",
    "shippingProvider",
    "providerCourier",
    "shippingCourier",
    "shippingService",
    "trackingNumber",
    "shipmentStatus",
] as const;

type TrackedOrder = {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    shippingProvider: string | null;
    providerCourier: string | null;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;
};

type Props = {
    orderId: number;
};

function pickTrackedOrder(data: unknown): TrackedOrder | null {
    if (!data || typeof data !== "object") {
        return null;
    }

    const source = data as Record<string, unknown>;

    const projected: Record<string, unknown> = {};

    for (const field of TRACKED_FIELDS) {
        projected[field] = source[field] ?? null;
    }

    if (typeof projected.id !== "number") {
        return null;
    }

    return projected as unknown as TrackedOrder;
}

const STAGE_BADGE: Record<string, string> = {
    DELIVERED: "bg-emerald-50 text-emerald-700",
    COMPLETED: "bg-emerald-50 text-emerald-700",
    CANCELLED: "bg-red-50 text-red-700",
    RETURNED: "bg-red-50 text-red-700",
    UNDELIVERED: "bg-amber-50 text-amber-700",
    DELETED: "bg-gray-100 text-gray-600",
    IN_TRANSIT: "bg-blue-50 text-blue-700",
};

export default function ShipmentTrackingPanel({
    orderId,
}: Props) {
    const [order, setOrder] = useState<TrackedOrder | null>(
        null
    );

    const [providerView, setProviderView] =
        useState<TrackingProviderView | null>(null);

    const [loading, setLoading] = useState(true);
    const [providerFailed, setProviderFailed] =
        useState(false);

    /* Manual refresh counter — nothing here ever polls. */
    const [reloadKey, setReloadKey] = useState(0);
    const [refreshing, setRefreshing] = useState(false);

    /*
     * The help hand-off. The url is built SERVER-side by
     * /api/orders/[id]/whatsapp-confirm (ownership-guarded) because the
     * destination number must come from the connected WhatsApp session,
     * never from this component or the request.
     */
    const [helpUrl, setHelpUrl] = useState<string | null>(null);
    const [helpChecked, setHelpChecked] = useState(false);

    useEffect(() => {
        let active = true;
        const controller = new AbortController();

        async function load() {
            try {
                setLoading(true);

                const response = await fetch(
                    `/api/orders/${orderId}`,
                    {
                        method: "GET",
                        cache: "no-store",
                        signal: controller.signal,
                    }
                );

                const result = await response.json();

                if (!active) return;

                const parsed = response.ok
                    ? pickTrackedOrder(result?.data)
                    : null;

                if (!parsed) {
                    setOrder(null);
                    setProviderView(null);

                    return;
                }

                setOrder(parsed);

                /*
                 * A provider read is a PAID call: it happens once, only
                 * when the stored state says there is something to ask
                 * the courier about.
                 */
                if (!shouldReadProvider(parsed)) {
                    setProviderView(null);
                    setProviderFailed(false);

                    return;
                }

                try {
                    const trackingResponse = await fetch(
                        `/api/orders/${orderId}/tracking`,
                        {
                            method: "GET",
                            cache: "no-store",
                            signal: controller.signal,
                        }
                    );

                    const trackingResult =
                        await trackingResponse.json();

                    if (!active) return;

                    /*
                     * Honest degradation: an HTTP error (400/500) or a
                     * `success: false` body keeps the stored status —
                     * already rendered above — and only raises a note.
                     */
                    const outcome = resolveProviderRead({
                        ok: trackingResponse.ok,
                        body: trackingResult,
                    });

                    setProviderView(outcome.view);
                    setProviderFailed(outcome.note);
                } catch (error) {
                    if (!active) return;

                    if (
                        error instanceof Error &&
                        error.name === "AbortError"
                    ) {
                        return;
                    }

                    /* A thrown request degrades exactly like a 500. */
                    const outcome = resolveProviderRead(null);

                    setProviderView(outcome.view);
                    setProviderFailed(outcome.note);
                }
            } catch (error) {
                if (!active) return;

                if (
                    error instanceof Error &&
                    error.name === "AbortError"
                ) {
                    return;
                }

                setOrder(null);
                setProviderView(null);
            } finally {
                if (active) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        }

        load();

        return () => {
            active = false;
            controller.abort();
        };
    }, [orderId, reloadKey]);

    useEffect(() => {
        let active = true;
        const controller = new AbortController();

        async function loadHelp() {
            try {
                const response = await fetch(
                    `/api/orders/${orderId}/whatsapp-confirm?intent=problem`,
                    {
                        method: "GET",
                        headers: { Accept: "application/json" },
                        signal: controller.signal,
                    }
                );

                const result = await response.json();

                if (!active) return;

                const url =
                    response.ok &&
                    result?.success === true &&
                    result?.data?.available === true &&
                    typeof result.data.url === "string"
                        ? result.data.url
                        : null;

                setHelpUrl(url);
            } catch {
                if (!active) return;

                setHelpUrl(null);
            } finally {
                if (active) {
                    setHelpChecked(true);
                }
            }
        }

        loadHelp();

        return () => {
            active = false;
            controller.abort();
        };
    }, [orderId]);

    const refresh = useCallback(() => {
        setRefreshing(true);
        setReloadKey((value) => value + 1);
    }, []);

    if (loading) {
        return (
            <section className="border border-gray-200 bg-white px-5 py-6">
                <div className="h-5 w-40 animate-pulse rounded bg-gray-200" />

                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {[0, 1, 2].map((index) => (
                        <div
                            key={index}
                            className="h-20 animate-pulse rounded-xl bg-gray-100"
                        />
                    ))}
                </div>
            </section>
        );
    }

    if (!order) {
        return (
            <section className="border border-gray-200 bg-white px-5 py-6">
                <h2 className="text-base font-bold text-gray-900">
                    Pesanan tidak dapat dibuka
                </h2>

                <p className="mt-1.5 text-sm leading-6 text-gray-500">
                    Akses pesanan ini tidak tersedia di
                    perangkat ini. Pulihkan akses dengan
                    kode verifikasi, lalu buka halaman ini
                    kembali.
                </p>
            </section>
        );
    }

    const stage = resolveShipmentStage(order);
    const hint = shipmentStageHint(stage);

    /*
     * The resi is the STORED value: the provider payload is a display
     * extra, never the identifier the customer is told to quote.
     */
    const resi = order.trackingNumber;

    const courier =
        order.providerCourier ??
        order.shippingCourier ??
        null;

    return (
        <section className="border border-gray-200 bg-white px-5 py-6">
            {/* HEADER */}

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-base font-bold text-gray-900">
                        Pengiriman
                    </h2>

                    <p className="mt-1 text-xs break-all text-gray-500">
                        {order.orderNumber}
                    </p>
                </div>

                <span
                    className={`inline-flex shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold ${
                        STAGE_BADGE[stage] ??
                        "bg-gray-100 text-gray-600"
                    }`}
                >
                    {SHIPMENT_STAGE_LABELS[stage]}
                </span>
            </div>

            {/* SHIPMENT IDENTITY */}

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                    <p className="text-[11px] text-gray-500">
                        Kurir
                    </p>

                    <p className="mt-1 text-sm font-semibold break-words text-gray-900 uppercase">
                        {courier ?? "-"}
                    </p>
                </div>

                <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                    <p className="text-[11px] text-gray-500">
                        Layanan
                    </p>

                    <p className="mt-1 text-sm font-semibold break-words text-gray-900">
                        {order.shippingService ?? "-"}
                    </p>
                </div>

                <div className="rounded-xl bg-gray-50 px-3.5 py-3">
                    <p className="text-[11px] text-gray-500">
                        Nomor Resi
                    </p>

                    <p className="mt-1 text-sm font-semibold break-all text-gray-900">
                        {resi ?? "Belum tersedia"}
                    </p>
                </div>
            </div>

            {/* STAGE EXPLANATION */}

            {hint && (
                <p className="mt-4 rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800">
                    {hint}
                </p>
            )}

            {/* PROVIDER FAILURE */}

            {providerFailed && (
                <div className="mt-4 rounded-xl bg-gray-50 px-3.5 py-3">
                    <p className="text-xs leading-5 text-gray-600">
                        ℹ️ {TRACKING_UPDATE_UNAVAILABLE_NOTE}
                    </p>
                </div>
            )}

            {/* DELIVERY PROOF */}

            {providerView?.delivered && (
                <div className="mt-4 rounded-xl bg-emerald-50 px-3.5 py-3">
                    <p className="text-sm font-bold text-emerald-700">
                        Paket sudah diterima
                    </p>

                    {providerView.deliveredReceiver && (
                        <p className="mt-1 text-xs text-emerald-700">
                            Diterima oleh{" "}
                            {providerView.deliveredReceiver}
                        </p>
                    )}

                    {providerView.deliveredAt && (
                        <p className="mt-1 text-xs text-emerald-600">
                            {providerView.deliveredAt}
                        </p>
                    )}
                </div>
            )}

            {/* TIMELINE */}

            <div className="mt-6 flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-gray-900">
                    Perjalanan Paket
                </h3>

                <button
                    type="button"
                    onClick={refresh}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
                >
                    <FiRefreshCw
                        size={13}
                        aria-hidden="true"
                        className={
                            refreshing
                                ? "animate-spin"
                                : undefined
                        }
                    />

                    {refreshing
                        ? "Memperbarui..."
                        : "Perbarui"}
                </button>
            </div>

            <ShipmentTimeline
                entries={providerView?.entries ?? []}
                emptyText={
                    providerFailed
                        ? "Riwayat perjalanan paket belum dapat diambil dari ekspedisi saat ini."
                        : order.trackingNumber
                          ? "Riwayat perjalanan paket belum tersedia dari ekspedisi."
                          : "Riwayat akan tampil setelah paket diserahkan ke ekspedisi."
                }
            />

            {/* HELP */}

            <div className="mt-6 border-t border-gray-100 pt-5">
                <h3 className="text-sm font-bold text-gray-900">
                    Ada masalah dengan pesanan ini?
                </h3>

                <p className="mt-1.5 text-xs leading-5 text-gray-500">
                    Admin kami akan membantu pengecekan
                    lebih lanjut.
                </p>

                {helpUrl ? (
                    <a
                        href={helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1DA851] sm:w-auto"
                    >
                        <FaWhatsapp
                            className="h-4 w-4"
                            aria-hidden="true"
                        />
                        Hubungi Admin via WhatsApp
                    </a>
                ) : (
                    helpChecked && (
                        <p className="mt-3 rounded-lg bg-gray-50 px-3.5 py-2.5 text-xs leading-5 text-gray-600">
                            WhatsApp Admin belum tersedia
                            saat ini. Balas{" "}
                            <span className="font-semibold">
                                3
                            </span>{" "}
                            di chat WhatsApp Mutiara Abadi
                            untuk dibantu admin kami.
                        </p>
                    )
                )}
            </div>

            {/*
             * NAVIGATION OUT OF THIS ORDER
             *
             * The same two options the order detail page offers. Both are
             * ordinary routes that authorize PER REQUEST — no token,
             * e-mail, phone number or order number travels in either
             * href, so knowing one order still opens nothing else.
             *
             * "Lacak Pesanan Lain" drops the `?pesanan=` hint, which is
             * what `TrackingLookup` derives its state from, so this page
             * returns to the empty lookup form instead of the parcel that
             * is already on screen.
             */}
            <div className="mt-5 flex flex-wrap gap-2.5 border-t border-gray-100 pt-5">
                <Link
                    href="/orders"
                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
                >
                    📦 Lihat Semua Pesanan Saya
                </Link>

                <Link
                    href="/lacak"
                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
                >
                    🔍 Lacak Pesanan Lain
                </Link>
            </div>
        </section>
    );
}
