"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
    whenTikTokReadyForEvents,
} from "@/lib/analytics/tiktok-identity";
import { trackAuthoritativeTikTokPurchase } from "@/components/analytics/PurchaseTracker";
import type { TikTokUserMatchIdentifiers } from "@/lib/analytics/tiktok";
import {
    createPaymentStatusPoller,
} from "@/lib/payment/payment-status-poll";

type OrderStatus = {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    total: number;
    /** Authoritative SHA-256 digests from GET /api/payment/status. */
    identity?: TikTokUserMatchIdentifiers | null;
};

/**
 * Payment states the provider can no longer change. Polling stops the
 * moment one of them is observed.
 */
const FINAL_PAYMENT_STATUSES = [
    "PAID",
    "FAILED",
    "EXPIRED",
];

function isFinalPaymentStatus(
    paymentStatus: string
): boolean {
    return FINAL_PAYMENT_STATUSES.includes(
        paymentStatus
    );
}

export default function PaymentFinishContent() {
    const searchParams = useSearchParams();

    const reference =
        searchParams.get("payment");

    const [order, setOrder] =
        useState<OrderStatus | null>(null);

    const [loading, setLoading] =
        useState(true);

    /*
     * Per-mount guard: one browser CompletePayment per order per
     * mount at most. The shared purchase claim additionally covers
     * remounts, reloads and the other confirmation routes.
     */
    const purchaseTracked = useRef<string | null>(
        null
    );

    useEffect(() => {
        /*
         * Without a reference there is nothing to poll: the "not
         * found" screen is rendered below and `loading` is unused.
         * (Setting state synchronously here would only add a
         * cascading render.)
         */
        if (!reference) {
            return;
        }

        /*
         * Bounded polling owned by lib/payment/payment-status-poll:
         * one request in flight, stops on the first final status,
         * stops after the attempt budget, and cleared on unmount.
         * The effect no longer calls the fetcher from a state
         * updater, so a React re-run can never schedule extra polls.
         */
        const poller =
            createPaymentStatusPoller<OrderStatus>({
                fetchStatus: async () => {
                    const response = await fetch(
                        `/api/payment/status?reference=${encodeURIComponent(
                            reference
                        )}`,
                        {
                            cache: "no-store",
                        }
                    );

                    if (!response.ok) {
                        return null;
                    }

                    const result =
                        await response.json();

                    if (
                        !result?.success ||
                        !result?.data
                    ) {
                        return null;
                    }

                    return result.data as OrderStatus;
                },

                isFinal: (status) =>
                    isFinalPaymentStatus(
                        status.paymentStatus
                    ),

                onStatus: (status) => {
                    setOrder(status);
                },

                onDone: () => {
                    setLoading(false);
                },

                onError: (error) => {
                    console.error(
                        "POLL PAYMENT STATUS ERROR:",
                        error
                    );
                },
            });

        poller.start();

        return () => {
            poller.stop();
        };
    }, [reference]);

    const isPaid =
        order?.paymentStatus === "PAID";

    const isFailed =
        order?.paymentStatus === "FAILED" || order?.paymentStatus === "EXPIRED";

    const isPending = !isPaid && !isFailed;

    /*
     * Only primitives (plus the server-built digest object) drive the
     * Purchase effect. `order` itself is never a dependency again: the
     * poller used to hand back a NEW object every 3 seconds, which
     * re-ran this effect and emitted CompletePayment once per tick.
     */
    const paidOrderNumber =
        isPaid && order ? order.orderNumber : null;

    const paidTotal =
        isPaid && order ? order.total : 0;

    const paidIdentity =
        isPaid && order ? order.identity ?? null : null;

    /*
     * ==========================================
     * TIKTOK PIXEL - COMPLETE PAYMENT
     * ==========================================
     *
     * Fire when payment is confirmed as PAID. The ref guard keeps it
     * to one call per mount; the shared purchase claim inside
     * `trackAuthoritativeTikTokPurchase` keeps it to one event per
     * order + pixel per tab across remounts, reloads and the other
     * confirmation routes.
     */
    useEffect(() => {
        if (!paidOrderNumber) {
            return;
        }

        if (
            purchaseTracked.current ===
            paidOrderNumber
        ) {
            return;
        }

        purchaseTracked.current =
            paidOrderNumber;

        whenTikTokReadyForEvents(() => {
            /*
             * Authoritative Advanced Matching + event in one call:
             * `ttq.identify(<Order → User digests>)` runs BEFORE the
             * CompletePayment track, so the conversion carries
             * email / phone even when the session identity store
             * settles anonymous. event_id stays
             * `ttq:completepayment:<orderNumber>` for server dedup.
             *
             * The status endpoint returns the order total only, so
             * this copy sends value + currency + order_id; the
             * authoritative contents[] travel on the server-side copy
             * of the same event_id.
             */
            trackAuthoritativeTikTokPurchase({
                orderId: paidOrderNumber,
                total: paidTotal,
                items: [],
                identity: paidIdentity,
            });
        });
    }, [
        paidOrderNumber,
        paidTotal,
        paidIdentity,
    ]);

    /*
     * The "missing reference" screen is a render decision, not a hook
     * branch: it lives AFTER every hook so the hook order stays
     * identical on every render.
     */
    if (!reference) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-lg">
                    <div className="rounded-3xl border bg-white p-8 text-center">
                        <p className="font-medium">
                            Referensi pembayaran
                            tidak ditemukan.
                        </p>

                        <Link
                            href="/"
                            className="mt-4 inline-block rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700"
                        >
                            Kembali ke Beranda
                        </Link>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8">
            <div className="mx-auto max-w-lg">
                <div className="rounded-3xl border bg-white p-8 text-center">

                    {isPending &&
                        loading && (
                            <>
                                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-rose-600 border-t-transparent" />

                                <h1 className="mt-5 text-xl font-bold">
                                    Memeriksa
                                    Status
                                    Pembayaran...
                                </h1>

                                <p className="mt-2 text-sm text-gray-500">
                                    Mohon
                                    tunggu,
                                    kami
                                    sedang
                                    mengonfirmasi
                                    pembayaran
                                    Anda.
                                </p>
                            </>
                        )}

                    {isPending &&
                        !loading && (
                            <>
                                <h1 className="text-xl font-bold text-amber-600">
                                    Pembayaran
                                    Sedang
                                    Diproses
                                </h1>

                                <p className="mt-2 text-sm text-gray-500">
                                    Status
                                    pembayaran
                                    Anda
                                    masih
                                    diproses.
                                    Silakan
                                    cek
                                    kembali
                                    di halaman
                                    Pesanan
                                    Saya
                                    beberapa
                                    saat lagi.
                                </p>
                            </>
                        )}

                    {isPaid && (
                        <>
                            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl text-green-600">
                                ✓
                            </div>

                            <h1 className="mt-5 text-xl font-bold text-green-600">
                                Pembayaran
                                Berhasil
                            </h1>

                            <p className="mt-2 text-sm text-gray-500">
                                Pesanan{" "}
                                {
                                    order.orderNumber
                                }{" "}
                                telah
                                dikonfirmasi.
                            </p>
                        </>
                    )}

                    {isFailed && (
                        <>
                            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-3xl text-red-600">
                                ✕
                            </div>

                            <h1 className="mt-5 text-xl font-bold text-red-600">
                                Pembayaran
                                Gagal
                            </h1>

                            <p className="mt-2 text-sm text-gray-500">
                                Pembayaran
                                untuk pesanan{" "}
                                {
                                    order?.orderNumber
                                }{" "}
                                tidak berhasil
                                diselesaikan.
                            </p>
                        </>
                    )}

                    <div className="mt-6 flex flex-col gap-3">
                        {order && (
                            <Link
                                href={`/orders/${order.id}`}
                                className="rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                            >
                                Lihat Detail
                                Pesanan
                            </Link>
                        )}

                        <Link
                            href="/"
                            className="rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        >
                            Kembali ke
                            Beranda
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}
