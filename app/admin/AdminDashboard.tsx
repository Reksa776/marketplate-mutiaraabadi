"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
    FiBox,
    FiFileText,
    FiShoppingBag,
    FiUsers,
    FiTrendingUp,
} from "react-icons/fi";
import DashboardStats from "@/components/admin/DashboardStats";
import SalesChart from "@/components/admin/SalesChart";
import OrderStatusCard from "@/components/admin/OrderStatusCard";
import PaymentMethodCard from "@/components/admin/PaymentMethodCard";
import TopProductsCard from "@/components/admin/TopProductsCard";
import RecentOrdersCard from "@/components/admin/RecentOrdersCard";
import AdminMenuCard from "@/components/admin/AdminMenuCard";


export default function AdminPage() {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function loadDashboard() {
            try {
                const response = await fetch(
                    "/api/admin/dashboard?period=7d",
                    {
                        cache: "no-store",
                    }
                );

                const result =
                    await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(
                        result.message ||
                        "Gagal mengambil dashboard."
                    );
                }

                setData(result.data);
            } catch (error) {
                console.error(
                    "LOAD ADMIN DASHBOARD ERROR:",
                    error
                );
            } finally {
                setLoading(false);
            }
        }

        loadDashboard();
    }, []);

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50">
                <div className="mx-auto max-w-7xl px-5 py-10">
                    <div className="animate-pulse">
                        <div className="h-8 w-64 rounded bg-gray-200" />

                        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                            {[1, 2, 3, 4].map(
                                (item) => (
                                    <div
                                        key={item}
                                        className="h-32 rounded-2xl bg-gray-200"
                                    />
                                )
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="min-h-screen bg-gray-50">
                <div className="mx-auto max-w-7xl px-5 py-10">
                    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600">
                        Gagal mengambil data dashboard.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50">
            {/* HEADER */}
            <div className="border-b border-gray-200 bg-white">
                <div className="mx-auto max-w-7xl px-5 py-7 sm:px-6">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <p className="text-sm font-semibold text-rose-600">
                                Admin Dashboard
                            </p>

                            <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
                                Ringkasan Toko
                            </h1>

                            <p className="mt-2 text-sm text-gray-500">
                                Pantau penjualan, pesanan,
                                produk, dan performa toko.
                            </p>
                        </div>

                        <Link
                            href="/admin/reports"
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800"
                        >
                            <FiFileText size={17} />
                            Laporan Penjualan
                        </Link>
                    </div>
                </div>
            </div>


            {/* CONTENT */}
            <div className="mx-auto max-w-7xl px-5 py-3 sm:px-6">
                <section className="my-8">
                    <div className="mb-4">
                        <h2 className="text-lg font-bold text-gray-900">
                            Menu Cepat
                        </h2>

                        <p className="mt-1 text-sm text-gray-500">
                            Akses fitur administrasi toko.
                        </p>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <AdminMenuCard
                            href="/admin/products"
                            icon={FiBox}
                            title="Produk"
                            description="Kelola produk dan variant."
                        />

                        <AdminMenuCard
                            href="/admin/orders"
                            icon={FiShoppingBag}
                            title="Pesanan"
                            description="Lihat dan proses pesanan."
                        />

                        <AdminMenuCard
                            href="/admin/users"
                            icon={FiUsers}
                            title="Pengguna"
                            description="Kelola pengguna toko."
                        />

                        <AdminMenuCard
                            href="/admin/reports"
                            icon={FiTrendingUp}
                            title="Reporting"
                            description="Lihat dan download laporan."
                        />
                    </div>
                </section>
                <DashboardStats
                    summary={data.summary}
                />

                <div className="mt-6">
                    <SalesChart
                        data={data.dailySales}
                    />
                </div>

                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                    <OrderStatusCard
                        data={data.orderStatus}
                    />

                    <PaymentMethodCard
                        data={data.paymentMethod}
                    />
                </div>

                <div className="mt-6 grid gap-6 xl:grid-cols-2">
                    <TopProductsCard
                        data={data.topProducts}
                    />

                    <RecentOrdersCard
                        data={data.recentOrders}
                    />
                </div>

                {/* FLASH SALES & CAMPAIGNS */}
                <div className="mt-6 grid gap-6 xl:grid-cols-2">
                    {/* Active Flash Sales */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-5">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-gray-900">Flash Sale Aktif</h3>
                            <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-700">
                                {data.summary?.activeFlashSalesCount ?? 0}
                            </span>
                        </div>
                        {data.activeFlashSales && data.activeFlashSales.length > 0 ? (
                            <div className="mt-4 space-y-3">
                                {data.activeFlashSales.slice(0, 5).map((fs: any) => (
                                    <div key={fs.id} className="flex items-center justify-between">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-gray-900">{fs.name}</p>
                                            <p className="text-xs text-gray-500">{fs.soldCount}/{fs.saleStock} terjual</p>
                                        </div>
                                        <div className="ml-3 h-1.5 w-16 overflow-hidden rounded-full bg-gray-100">
                                            <div
                                                className="h-full rounded-full bg-rose-500"
                                                style={{ width: `${Math.min(100, (fs.soldCount / fs.saleStock) * 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-4 text-sm text-gray-400">Tidak ada flash sale aktif</p>
                        )}
                    </div>

                    {/* Active Campaigns */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-5">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-gray-900">Kampanye Aktif</h3>
                            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                                {data.summary?.activeCampaignsCount ?? 0}
                            </span>
                        </div>
                        {data.activeCampaigns && data.activeCampaigns.length > 0 ? (
                            <div className="mt-4 space-y-3">
                                {data.activeCampaigns.slice(0, 5).map((c: any) => (
                                    <div key={c.id} className="flex items-center justify-between">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-gray-900">{c.name}</p>
                                            <p className="text-xs text-gray-500">{c.type}</p>
                                        </div>
                                        <span className="ml-3 text-xs text-gray-400">
                                            s/d {new Date(c.endAt).toLocaleDateString("id-ID", { day: "2-digit", month: "short" })}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-4 text-sm text-gray-400">Tidak ada kampanye aktif</p>
                        )}
                    </div>
                </div>

                {/* OPERATIONAL SUMMARY */}
                <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
                        <p className="text-xs font-medium text-gray-500">Menunggu Diproses</p>
                        <p className="mt-2 text-xl font-semibold text-amber-600">{data.summary?.pendingOrders ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
                        <p className="text-xs font-medium text-gray-500">Pembayaran Gagal</p>
                        <p className="mt-2 text-xl font-semibold text-red-600">{data.summary?.failedPayments ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
                        <p className="text-xs font-medium text-gray-500">Flash Sale Aktif</p>
                        <p className="mt-2 text-xl font-semibold text-rose-600">{data.summary?.activeFlashSalesCount ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
                        <p className="text-xs font-medium text-gray-500">Kampanye Aktif</p>
                        <p className="mt-2 text-xl font-semibold text-blue-600">{data.summary?.activeCampaignsCount ?? 0}</p>
                    </div>
                </div>

            </div>
        </div>
    );
}