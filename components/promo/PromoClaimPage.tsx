"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FiCheck, FiCopy, FiGift, FiShoppingBag } from "react-icons/fi";

type PromoState = {
    active: boolean;
    claimed: boolean;
    voucherCode: string | null;
    dailyQuota: number;
    claimedCount: number;
    remaining: number;
    claimable: boolean;
    quotaDate: string;
};

export default function PromoClaimPage({
    slug,
    title,
    description,
}: {
    slug: string;
    title: string;
    description: string | null;
}) {
    const [status, setStatus] = useState<PromoState | null>(null);
    const [loading, setLoading] = useState(true);
    const [claiming, setClaiming] = useState(false);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`/api/promos/${encodeURIComponent(slug)}/claim`, {
                cache: "no-store",
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Promo belum bisa dimuat.");
            }
            setStatus(result.data);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Promo belum bisa dimuat.");
        } finally {
            setLoading(false);
        }
    }, [slug]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        // Keep a page that stays open across midnight in sync with the
        // next Jakarta quota day, without polling the endpoint.
        const now = Date.now();
        const wibNow = new Date(now + 7 * 60 * 60 * 1000);
        const nextMidnightWib = Date.UTC(
            wibNow.getUTCFullYear(),
            wibNow.getUTCMonth(),
            wibNow.getUTCDate() + 1
        );
        const timer = window.setTimeout(
            () => void refresh(),
            Math.max(1000, nextMidnightWib - now - 7 * 60 * 60 * 1000 + 1000)
        );
        return () => window.clearTimeout(timer);
    }, [refresh, status?.quotaDate]);

    async function claim() {
        setClaiming(true);
        setError("");
        try {
            const response = await fetch(`/api/promos/${encodeURIComponent(slug)}/claim`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const result = await response.json();
            if (response.status === 409 || response.status === 410) {
                await refresh();
                return;
            }
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Voucher belum bisa diklaim.");
            }
            await refresh();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Voucher belum bisa diklaim.");
        } finally {
            setClaiming(false);
        }
    }

    async function copyCode() {
        if (!status?.voucherCode) return;
        await navigator.clipboard.writeText(status.voucherCode);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
    }

    const exhausted = !loading && status && !status.claimed && (!status.active || !status.claimable);

    return (
        <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-rose-50 via-white to-amber-50 px-4 py-12">
            <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-rose-200/40 blur-3xl" />
            <div aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-amber-200/40 blur-3xl" />

            <section className="relative w-full max-w-xl rounded-3xl border border-white bg-white/90 p-7 text-center shadow-xl shadow-rose-900/5 backdrop-blur sm:p-10">
                {loading ? (
                    <div className="py-12 text-sm text-gray-500">Memeriksa kuota promo...</div>
                ) : exhausted ? (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                            <FiGift size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-600">{title}</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">Kamu terlambat</h1>
                        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-600">
                            Kuota klaim promo hari ini sudah habis atau periode promonya telah berakhir. Tenang, masih ada promo menarik lainnya.
                        </p>
                        <Link href="/products" className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gray-950 px-6 text-sm font-bold text-white transition hover:bg-gray-800">
                            <FiShoppingBag /> Ambil promo yang nggak kalah lainnya di sini
                        </Link>
                    </>
                ) : status?.claimed && status.voucherCode ? (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                            <FiCheck size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Voucher berhasil diklaim</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950">Selamat, promonya buat kamu!</h1>
                        <p className="mt-3 text-sm leading-6 text-gray-600">Gunakan kode voucher ini saat checkout. Klaim browser ini sudah tercatat untuk hari ini.</p>
                        <div className="mx-auto mt-6 flex max-w-sm items-center justify-between gap-3 rounded-xl border border-dashed border-emerald-400 bg-emerald-50 px-4 py-3">
                            <code className="text-lg font-black tracking-widest text-emerald-900">{status.voucherCode}</code>
                            <button type="button" onClick={() => void copyCode()} className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-emerald-800 shadow-sm">
                                {copied ? <FiCheck /> : <FiCopy />} {copied ? "Tersalin" : "Salin"}
                            </button>
                        </div>
                        <Link href="/products" className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gray-950 px-6 text-sm font-bold text-white transition hover:bg-gray-800">
                            <FiShoppingBag /> Lihat produk
                        </Link>
                    </>
                ) : (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-rose-700">
                            <FiGift size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-600">Promo spesial untuk kamu</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">Selamat!</h1>
                        <h2 className="mt-2 text-xl font-bold text-gray-800">{title}</h2>
                        {description && <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-600">{description}</p>}
                        <p className="mt-5 text-sm text-gray-500">Kuota klaim hari ini tersisa <strong className="text-gray-900">{status?.remaining ?? 0}</strong>.</p>
                        <button type="button" disabled={claiming || !status?.claimable} onClick={() => void claim()} className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-6 text-sm font-bold text-white transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60">
                            <FiGift /> {claiming ? "Memproses klaim..." : "Klaim Voucher"}
                        </button>
                    </>
                )}

                {error && (
                    <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {error} <button type="button" onClick={() => void refresh()} className="ml-1 font-semibold underline">Coba lagi</button>
                    </div>
                )}
            </section>
        </main>
    );
}
