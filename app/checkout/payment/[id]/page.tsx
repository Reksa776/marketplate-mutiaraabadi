"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { trackTikTokEvent } from "@/lib/analytics/tiktok";
import type { PaymentView } from "@/lib/payment/order-payment";
import QrisPanel from "./QrisPanel";

/* ==========================================
 * ECOMMERCE PAYMENT PAGE
 * ==========================================
 *
 * The customer pays WITHOUT leaving the store:
 *
 *   Checkout → create order → iPaymu direct payment
 *   → THIS page (QR / VA number / e-wallet action)
 *   → webhook settles the order → this page flips to PAID
 *
 * Rules enforced here:
 *  - the browser only ever talks to OUR server
 *    (GET /api/orders/[id]/payment-status)
 *  - this page NEVER marks an order as paid; status changes only come
 *    from the server, which itself only reflects the signed webhook
 *  - when the provider payment window closes, we ask the server to
 *    settle the expiry (POST /api/orders/[id]/expire); the server
 *    re-validates the expiry before cancelling anything
 */

const POLL_INTERVAL_MS = 3000;

const FINAL_PAYMENT_STATUSES = [
    "PAID",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
];

function formatRupiah(value: number): string {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

function formatDateTime(value: string | null): string {
    if (!value) return "-";

    return new Date(value).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

function formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function PaymentInstructionPage() {
    const params = useParams<{ id: string }>();
    const orderId = params?.id ?? "";
    const router = useRouter();

    const [view, setView] = useState<PaymentView | null>(null);
    const [notFound, setNotFound] = useState(false);
    const [loading, setLoading] = useState(true);
    const [now, setNow] = useState(() => Date.now());
    const [copied, setCopied] = useState(false);

    // Expiry settlement must be requested at most once per page view.
    const expiryRequested = useRef(false);
    const completedTracked = useRef(false);

    const poll = useCallback(async () => {
        if (!orderId) return;

        try {
            const response = await fetch(
                `/api/orders/${orderId}/payment-status`,
                { cache: "no-store" }
            );

            if (response.status === 401) {
                router.push("/login");
                return;
            }

            if (response.status === 404) {
                setNotFound(true);
                setLoading(false);
                return;
            }

            const result = await response.json();

            if (!response.ok || !result?.success) {
                setLoading(false);
                return;
            }

            setView(result.data as PaymentView);
            setLoading(false);
        } catch (error) {
            console.error("PAYMENT STATUS POLL ERROR:", error);
            setLoading(false);
        }
    }, [orderId, router]);

    /* ==========================================
     * POLLING (UX ONLY)
     * ========================================== */

    useEffect(() => {
        if (!orderId) return;

        let cancelled = false;

        const tick = () => {
            if (!cancelled) poll();
        };

        tick();

        const interval = setInterval(tick, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [orderId, poll]);

    /* ==========================================
     * COUNTDOWN
     * ========================================== */

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const expiresAt = view?.expiresAt ? new Date(view.expiresAt).getTime() : null;
    const remainingMs = expiresAt ? expiresAt - now : null;
    const isFinal =
        !!view && FINAL_PAYMENT_STATUSES.includes(view.paymentStatus);

    /* ==========================================
     * EXPIRY SETTLEMENT
     * ==========================================
     *
     * The server decides: it only cancels when the provider expiry
     * (plus grace) has already passed and the order still awaits
     * payment. A payment is therefore never lost to this call.
     */

    useEffect(() => {
        if (!view || expiryRequested.current) return;
        if (isFinal || !view.canPay) return;
        if (remainingMs === null || remainingMs > 0) return;

        expiryRequested.current = true;

        fetch(`/api/orders/${orderId}/expire`, { method: "POST" })
            .catch((error) => {
                console.error("EXPIRE REQUEST ERROR:", error);
            })
            .finally(() => poll());
    }, [view, isFinal, remainingMs, orderId, poll]);

    /* ==========================================
     * TIKTOK PIXEL — COMPLETE PAYMENT
     * ========================================== */

    useEffect(() => {
        if (!view || view.paymentStatus !== "PAID") return;
        if (completedTracked.current) return;

        completedTracked.current = true;

        trackTikTokEvent("CompletePayment", {
            content_id: view.orderNumber,
            value: view.amount,
            currency: "IDR",
            contents: [],
        });
    }, [view]);

    /* ==========================================
     * COPY PAYMENT NUMBER
     * ========================================== */

    async function copyPaymentNo() {
        const value = view?.instruction.paymentNo;
        if (!value) return;

        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    }

    /* ==========================================
     * RENDER HELPERS
     * ========================================== */

    function shell(content: React.ReactNode) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-lg">
                    <div className="rounded-3xl border bg-white p-8">
                        {content}
                    </div>
                </div>
            </main>
        );
    }

    if (loading && !view) {
        return shell(
            <div className="text-center">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-rose-600 border-t-transparent" />
                <h1 className="mt-5 text-xl font-bold">Memuat pembayaran...</h1>
            </div>
        );
    }

    if (notFound) {
        return shell(
            <div className="text-center">
                <p className="font-medium">Pesanan tidak ditemukan.</p>
                <Link
                    href="/orders"
                    className="mt-4 inline-block rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700"
                >
                    Lihat Pesanan Saya
                </Link>
            </div>
        );
    }

    if (!view) {
        return shell(
            <div className="text-center">
                <p className="font-medium">
                    Status pembayaran tidak dapat dimuat.
                </p>
                <button
                    onClick={() => poll()}
                    className="mt-4 rounded-xl border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                    Coba Lagi
                </button>
            </div>
        );
    }

    const { instruction } = view;

    /* ==========================================
     * PAID
     * ========================================== */

    if (view.paymentStatus === "PAID") {
        return shell(
            <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl text-green-600">
                    ✓
                </div>

                <h1 className="mt-5 text-xl font-bold text-green-600">
                    Pembayaran Berhasil
                </h1>

                <p className="mt-2 text-sm text-gray-500">
                    Pesanan {view.orderNumber} telah dikonfirmasi
                    {view.paidAt ? ` pada ${formatDateTime(view.paidAt)}` : ""}.
                </p>

                <div className="mt-6 flex flex-col gap-3">
                    <Link
                        href={`/orders/${view.orderId}`}
                        className="rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                    >
                        Lihat Detail Pesanan
                    </Link>

                    <Link
                        href="/"
                        className="rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                        Kembali ke Beranda
                    </Link>
                </div>
            </div>
        );
    }

    /* ==========================================
     * FAILED / EXPIRED / CANCELLED
     * ========================================== */

    if (
        view.paymentStatus === "FAILED" ||
        view.paymentStatus === "EXPIRED" ||
        view.status === "CANCELLED"
    ) {
        const expired = view.isExpired;

        return shell(
            <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-3xl text-red-600">
                    ✕
                </div>

                <h1 className="mt-5 text-xl font-bold text-red-600">
                    {expired
                        ? "Pembayaran Kedaluwarsa"
                        : "Pembayaran Tidak Berhasil"}
                </h1>

                <p className="mt-2 text-sm text-gray-500">
                    {expired
                        ? "Batas waktu pembayaran untuk pesanan ini telah berakhir. Stok dan voucher telah dikembalikan."
                        : "Pembayaran untuk pesanan ini tidak dapat diselesaikan."}
                </p>

                <p className="mt-2 text-xs text-gray-400">
                    {view.orderNumber}
                </p>

                <div className="mt-6 flex flex-col gap-3">
                    <Link
                        href={`/orders/${view.orderId}`}
                        className="rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                    >
                        Buka Pesanan (Bayar Lagi)
                    </Link>

                    <Link
                        href="/"
                        className="rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                        Kembali ke Beranda
                    </Link>
                </div>
            </div>
        );
    }

    /* ==========================================
     * WAITING FOR PAYMENT
     * ========================================== */

    const statusLabel = view.canPay
        ? "Menunggu Pembayaran"
        : "Menunggu Konfirmasi";

    return shell(
        <div>
            <div className="text-center">
                <span className="inline-flex rounded-full bg-amber-100 px-4 py-1.5 text-xs font-semibold text-amber-700">
                    {statusLabel}
                </span>

                <h1 className="mt-4 text-xl font-bold text-gray-900">
                    Selesaikan Pembayaran
                </h1>

                <p className="mt-1 text-sm text-gray-500">
                    Pesanan {view.orderNumber}
                </p>
            </div>

            <div className="mt-6 rounded-2xl bg-gray-50 p-5 text-center">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                    Total Pembayaran
                </p>

                <p className="mt-1 text-2xl font-bold text-gray-900">
                    {formatRupiah(instruction.amount)}
                </p>
            </div>

            {/* ==============================
             * QRIS
             * ============================== */}

            {instruction.kind === "QRIS" && (
                <div className="mt-6 text-center">
                    <p className="text-sm font-semibold text-gray-700">
                        Scan QRIS berikut dengan aplikasi bank / e-wallet Anda
                    </p>

                    {/*
                     * The QR is generated LOCALLY from the raw QRIS payload
                     * (`qrString`). The provider URL is an HTML QR page, not
                     * an image, so it is only offered as a fallback link.
                     * A QRIS payload is never shown as a payment code.
                     */}
                    <QrisPanel
                        qrString={instruction.qrString}
                        qrisPageUrl={instruction.qrisPageUrl}
                    />
                </div>
            )}

            {/* ==============================
             * VIRTUAL ACCOUNT
             * ============================== */}

            {instruction.kind === "VIRTUAL_ACCOUNT" && (
                <div className="mt-6">
                    <div className="rounded-2xl border p-5">
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            Bank
                        </p>

                        <p className="mt-1 text-lg font-bold text-gray-900">
                            {instruction.channelLabel ?? "-"}
                        </p>

                        <p className="mt-4 text-xs uppercase tracking-wide text-gray-500">
                            Nomor Virtual Account
                        </p>

                        <p className="mt-1 break-all font-mono text-xl font-bold tracking-wider text-gray-900">
                            {instruction.paymentNo ?? "-"}
                        </p>

                        <button
                            onClick={copyPaymentNo}
                            disabled={!instruction.paymentNo}
                            className="mt-3 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            {copied ? "Nomor Tersalin ✓" : "Salin Nomor VA"}
                        </button>
                    </div>

                    <p className="mt-3 text-xs text-gray-500">
                        Bayar melalui m-banking / ATM ke nomor Virtual Account
                        di atas. Jumlah harus sama persis dengan total
                        pembayaran.
                    </p>
                </div>
            )}

            {/* ==============================
             * E-WALLET
             * ============================== */}

            {instruction.kind === "EWALLET" && (
                <div className="mt-6">
                    <div className="rounded-2xl border p-5 text-center">
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            E-Wallet
                        </p>

                        <p className="mt-1 text-lg font-bold text-gray-900">
                            {instruction.channelLabel ?? "-"}
                        </p>

                        {instruction.actionUrl && (
                            <a
                                href={instruction.actionUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-4 inline-block w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                            >
                                Buka Aplikasi E-Wallet
                            </a>
                        )}

                        {instruction.paymentNo && (
                            <div className="mt-4">
                                <p className="text-xs uppercase tracking-wide text-gray-500">
                                    Kode Pembayaran
                                </p>

                                <p className="mt-1 break-all font-mono text-lg font-semibold tracking-wider text-gray-900">
                                    {instruction.paymentNo}
                                </p>

                                <button
                                    onClick={copyPaymentNo}
                                    className="mt-3 w-full rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                                >
                                    {copied ? "Tersalin ✓" : "Salin Kode"}
                                </button>
                            </div>
                        )}

                        {!instruction.actionUrl && !instruction.paymentNo && (
                            <p className="mt-3 text-sm text-gray-500">
                                Selesaikan pembayaran dari aplikasi e-wallet
                                Anda, lalu halaman ini akan diperbarui
                                otomatis.
                            </p>
                        )}
                    </div>

                    <p className="mt-3 text-xs text-gray-500">
                        Setelah membuka aplikasi, selesaikan pembayaran sesuai
                        nominal di atas.
                    </p>
                </div>
            )}

            {/* ==============================
             * STATUS / EXPIRY
             * ============================== */}

            <div className="mt-6 space-y-2 rounded-2xl bg-gray-50 p-4 text-sm">
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className="font-semibold text-gray-900">
                        {view.paymentStatus}
                    </span>
                </div>

                {expiresAt && (
                    <div className="flex items-center justify-between">
                        <span className="text-gray-500">
                            Batas Pembayaran
                        </span>
                        <span className="font-semibold text-gray-900">
                            {formatDateTime(view.expiresAt)}
                        </span>
                    </div>
                )}

                {remainingMs !== null && remainingMs > 0 && (
                    <div className="flex items-center justify-between">
                        <span className="text-gray-500">Sisa Waktu</span>
                        <span className="font-mono font-semibold text-amber-600">
                            {formatCountdown(remainingMs)}
                        </span>
                    </div>
                )}
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs text-gray-500">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Halaman ini mengecek status pembayaran Anda secara otomatis.
            </div>

            <div className="mt-6 flex flex-col gap-3">
                <button
                    onClick={() => poll()}
                    className="rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                    Cek Status Sekarang
                </button>

                <Link
                    href={`/orders/${view.orderId}`}
                    className="text-center text-sm font-semibold text-rose-600 hover:text-rose-700"
                >
                    Lihat Detail Pesanan
                </Link>
            </div>
        </div>
    );
}
