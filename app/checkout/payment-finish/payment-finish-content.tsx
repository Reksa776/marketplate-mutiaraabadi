"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
    buildTikTokEventId,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";
import { buildTikTokOrderProperties } from "@/lib/analytics/tiktok-catalog";

type OrderStatus = {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    total: number;
};

export default function PaymentFinishContent() {
    const searchParams = useSearchParams();

    const reference =
        searchParams.get("payment");

    const [order, setOrder] =
        useState<OrderStatus | null>(null);

    const [loading, setLoading] =
        useState(true);

    const [attempts, setAttempts] =
        useState(0);

    const maxAttempts = 15;

    useEffect(() => {
        if (!reference) {
            setLoading(false);
            return;
        }

        let cancelled = false;

        async function poll() {
            try {
                const response =
                    await fetch(
                        `/api/payment/status?reference=${encodeURIComponent(
                            reference!
                        )}`,
                        {
                            cache: "no-store",
                        }
                    );

                const result =
                    await response.json();

                if (cancelled) {
                    return;
                }

                if (
                    response.ok &&
                    result.success
                ) {
                    setOrder(result.data);

                    /*
                     * Berhenti polling kalau
                     * status sudah final.
                     */

                    const isFinal =
                        result.data
                            .paymentStatus ===
                            "PAID" ||
                        result.data
                            .paymentStatus ===
                            "FAILED" ||
                        result.data
                            .paymentStatus ===
                            "EXPIRED";

                    if (isFinal) {
                        setLoading(false);
                        return;
                    }
                }

                setAttempts(
                    (prev) => prev + 1
                );
            } catch (error) {
                console.error(
                    "POLL PAYMENT STATUS ERROR:",
                    error
                );

                setAttempts(
                    (prev) => prev + 1
                );
            }
        }

        poll();

        const interval = setInterval(() => {
            setAttempts((current) => {
                if (
                    current >= maxAttempts
                ) {
                    clearInterval(
                        interval
                    );

                    setLoading(false);

                    return current;
                }

                poll();

                return current;
            });
        }, 3000);

        return () => {
            cancelled = true;

            clearInterval(interval);
        };
    }, [reference]);

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
    }    const isPaid =
        order?.paymentStatus === "PAID";

    const isFailed =
        order?.paymentStatus === "FAILED" || order?.paymentStatus === "EXPIRED";

    const isPending = !isPaid && !isFailed;

    /*
     * ==========================================
     * TIKTOK PIXEL - COMPLETE PAYMENT
     * ==========================================
     *
     * Fire when payment is confirmed as PAID.
     * Only fires once when isPaid first becomes
     * true (tracked via order.id dependency).
     */
    useEffect(() => {
        if (!isPaid || !order) {
            return;
        }

        whenTikTokReadyForEvents(() => {
            trackTikTokEvent(
                "CompletePayment",
                /*
                 * The status endpoint returns the order total only, so
                 * this deduplicated copy sends value + currency +
                 * order_id; the authoritative contents[] travel on the
                 * server-side copy of the same event_id.
                 */
                buildTikTokOrderProperties([], {
                    value: order.total,
                    orderId: order.orderNumber,
                }),
                {
                    /*
                     * Shared dedup id — identical to the server-side
                     * Events API CompletePayment event_id.
                     */
                    eventId: buildTikTokEventId(
                        "CompletePayment",
                        order.orderNumber
                    ),
                }
            );
        });
    }, [isPaid, order]);

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