"use client";

import { useCallback, useEffect, useState } from "react";
import {
    Area,
    AreaChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { FiActivity, FiEye, FiShoppingCart, FiUsers } from "react-icons/fi";

type Period = "7d" | "30d" | "90d";
type AnalyticsData = {
    period: Period;
    summary: { visitors: number; pageViews: number; checkoutStarts: number; orders: number; paidOrders: number };
    previous: { visitors: number; pageViews: number; checkoutStarts: number; orders: number; paidOrders: number };
    chart: Array<{ date: string; visitors: number; pageViews: number; checkoutStarts: number; orders: number; paidOrders: number }>;
    topPages: Array<{ path: string; pageViews: number }>;
    topReferrers: Array<{ host: string; visits: number }>;
};

function formatDate(value: string, compact = false) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        ...(compact ? {} : { month: "short" }),
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatChange(current: number, previous: number): string {
    if (previous === 0) return current === 0 ? "Sama seperti periode sebelumnya" : "Ada aktivitas baru";
    const percent = ((current - previous) / previous) * 100;
    const rounded = Math.round(percent);
    return `${rounded > 0 ? "+" : ""}${rounded}% dari periode sebelumnya`;
}

const cards = [
    { key: "visitors", label: "Pengunjung unik", icon: FiUsers, color: "text-violet-600", bg: "bg-violet-50" },
    { key: "pageViews", label: "Total kunjungan halaman", icon: FiEye, color: "text-blue-600", bg: "bg-blue-50" },
    { key: "checkoutStarts", label: "Mulai checkout", icon: FiShoppingCart, color: "text-amber-600", bg: "bg-amber-50" },
    { key: "orders", label: "Pesanan dibuat", icon: FiActivity, color: "text-emerald-600", bg: "bg-emerald-50" },
] as const;

export default function AnalyticsDashboardPage() {
    const [period, setPeriod] = useState<Period>("7d");
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`/api/admin/analytics?period=${period}`, { cache: "no-store" });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || "Data analitik gagal dimuat.");
            setData(result.data as AnalyticsData);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Data analitik gagal dimuat.");
        } finally {
            setLoading(false);
        }
    }, [period]);

    useEffect(() => { void load(); }, [load]);

    return (
        <div className="min-h-screen bg-gray-50">
            <div className="border-b border-gray-200 bg-white">
                <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-7 sm:flex-row sm:items-end sm:justify-between sm:px-6">
                    <div>
                        <p className="text-sm font-semibold text-rose-600">Analitik Toko</p>
                        <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">Pengunjung & Checkout</h1>
                        <p className="mt-2 text-sm text-gray-500">Pantau lalu lintas website dan perjalanan pengunjung menjadi pesanan.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <label htmlFor="analytics-period" className="text-sm font-medium text-gray-600">Periode</label>
                        <select id="analytics-period" value={period} onChange={(event) => setPeriod(event.target.value as Period)} className="rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm font-medium text-gray-800 outline-none focus:border-rose-500">
                            <option value="7d">7 hari</option>
                            <option value="30d">30 hari</option>
                            <option value="90d">90 hari</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="mx-auto max-w-7xl space-y-6 px-5 py-7 sm:px-6">
                {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
                {loading && !data ? (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map((card) => <div key={card.key} className="h-32 animate-pulse rounded-2xl bg-gray-200" />)}</div>
                ) : data ? <>
                    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        {cards.map((card) => {
                            const Icon = card.icon;
                            const current = data.summary[card.key];
                            const previous = data.previous[card.key];
                            return <article key={card.key} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm font-medium text-gray-500">{card.label}</p>
                                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.bg} ${card.color}`}><Icon size={19} /></span>
                                </div>
                                <p className="mt-4 text-3xl font-bold tracking-tight text-gray-900">{current.toLocaleString("id-ID")}</p>
                                <p className="mt-1 text-xs text-gray-500">{formatChange(current, previous)}</p>
                            </article>;
                        })}
                    </section>

                    <section className="grid gap-4 sm:grid-cols-2">
                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                            <p className="text-sm font-medium text-gray-500">Pembayaran berhasil</p>
                            <p className="mt-2 text-2xl font-bold text-gray-900">{data.summary.paidOrders.toLocaleString("id-ID")}</p>
                            <p className="mt-1 text-xs text-gray-500">Pesanan berstatus pembayaran lunas pada periode ini.</p>
                        </div>
                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                            <p className="text-sm font-medium text-gray-500">Rasio pengunjung menjadi pesanan</p>
                            <p className="mt-2 text-2xl font-bold text-gray-900">{data.summary.visitors ? `${((data.summary.orders / data.summary.visitors) * 100).toFixed(1)}%` : "0%"}</p>
                            <p className="mt-1 text-xs text-gray-500">Pesanan dibuat dibanding pengunjung unik.</p>
                        </div>
                    </section>

                    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                        <div className="mb-5">
                            <h2 className="text-lg font-bold text-gray-900">Perkembangan harian</h2>
                            <p className="mt-1 text-sm text-gray-500">Pengunjung unik, kunjungan halaman, checkout, dan pesanan yang dibuat.</p>
                        </div>
                        <div className="h-[340px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={data.chart} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                                    <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                                    <XAxis dataKey="date" tickFormatter={(value) => formatDate(String(value), true)} tickLine={false} axisLine={false} minTickGap={18} />
                                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                                    <Tooltip labelFormatter={(value) => formatDate(String(value))} />
                                    <Legend />
                                    <Area type="monotone" dataKey="visitors" name="Pengunjung" stroke="#7c3aed" fill="#7c3aed" fillOpacity={0.10} strokeWidth={2} />
                                    <Area type="monotone" dataKey="pageViews" name="Kunjungan halaman" stroke="#2563eb" fill="#2563eb" fillOpacity={0.05} strokeWidth={2} />
                                    <Area type="monotone" dataKey="checkoutStarts" name="Mulai checkout" stroke="#d97706" fill="#d97706" fillOpacity={0.04} strokeWidth={2} />
                                    <Area type="monotone" dataKey="orders" name="Pesanan" stroke="#059669" fill="#059669" fillOpacity={0.04} strokeWidth={2} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </section>

                    <section className="grid gap-6 xl:grid-cols-2">
                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                            <h2 className="text-lg font-bold text-gray-900">Halaman paling banyak dikunjungi</h2>
                            {data.topPages.length ? <div className="mt-4 divide-y divide-gray-100">{data.topPages.map((item) => <div key={item.path} className="flex items-center justify-between gap-4 py-3 text-sm"><span className="truncate font-medium text-gray-700">{item.path}</span><span className="shrink-0 font-semibold text-gray-900">{item.pageViews.toLocaleString("id-ID")}</span></div>)}</div> : <p className="mt-4 text-sm text-gray-500">Belum ada data untuk periode ini.</p>}
                        </div>
                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                            <h2 className="text-lg font-bold text-gray-900">Sumber kunjungan</h2>
                            {data.topReferrers.length ? <div className="mt-4 divide-y divide-gray-100">{data.topReferrers.map((item) => <div key={item.host} className="flex items-center justify-between gap-4 py-3 text-sm"><span className="truncate font-medium text-gray-700">{item.host}</span><span className="shrink-0 font-semibold text-gray-900">{item.visits.toLocaleString("id-ID")}</span></div>)}</div> : <p className="mt-4 text-sm text-gray-500">Belum ada data sumber untuk periode ini.</p>}
                        </div>
                    </section>
                    <p className="text-xs leading-5 text-gray-400">Pengunjung unik dihitung dari browser anonim. Data kunjungan mulai terkumpul setelah analitik diaktifkan; data sebelum itu tidak tersedia. Nomor, email, dan alamat IP tidak disimpan dalam catatan kunjungan.</p>
                </> : null}
            </div>
        </div>
    );
}
