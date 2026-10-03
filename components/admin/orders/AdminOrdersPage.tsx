"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import toast from "react-hot-toast";
import Link from "next/link";
import {
    resolveMengantarAdminStatus,
    type MengantarAdminStatusTone,
} from "@/lib/mengantar/admin-status";

type OrderItem = {
    id: number;
    productName: string;
    variantName: string;
    quantity: number;
    price: string | number;
    subtotal: string | number;
};

type OrderUser = {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
};

type Order = {
    id: number;
    orderNumber: string;
    recipientName: string;
    phone: string;
    address: string;
    city: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;
    subtotal: string | number;
    shippingCost: string | number;
    total: string | number;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    shippingCourier: string | null;
    shippingService: string | null;
    trackingNumber: string | null;

    // ---- Shipment fulfilment provider (Mengantar) ----
    shippingProvider?: string | null;
    providerShipmentId?: string | null;
    shipmentStatus?: string | null;
    shippingPaymentStatus?: string | null;

    createdAt: string;
    user?: OrderUser | null;
    items: OrderItem[];
};

type Pagination = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

function rupiah(value: string | number) {
    return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

function date(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function statusLabel(status: string) {
    switch (status) {
        case "PENDING": return "Pending";
        case "PAID": return "Dibayar";
        case "PROCESSING": return "Diproses";
        case "SHIPPED": return "Dikirim";
        case "COMPLETED": return "Selesai";
        case "CANCELLED": return "Dibatalkan";
        case "REFUND_PENDING": return "Refund Diproses";
        default: return status;
    }
}

function statusClass(status: string) {
    switch (status) {
        case "PENDING": return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
        case "PAID": return "bg-yellow-50 text-yellow-700 ring-1 ring-inset ring-yellow-200";
        case "PROCESSING": return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
        case "SHIPPED": return "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200";
        case "COMPLETED": return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
        case "CANCELLED": return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200";
        case "REFUND_PENDING": return "bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200";
        default: return "bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-200";
    }
}

function paymentStatusClass(status: string) {
    switch (status) {
        case "PAID": return "text-emerald-600";
        case "PENDING": return "text-amber-600";
        case "FAILED":
        case "EXPIRED": return "text-red-600";
        default: return "text-gray-500";
    }
}

/*
 * Tone → badge classes for the "Status Mengantar" column. The tone is
 * resolved by the shared, pure `resolveMengantarAdminStatus` helper so
 * the list and the detail page can never disagree.
 */
function mengantarToneClass(tone: MengantarAdminStatusTone) {
    switch (tone) {
        case "info": return "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200";
        case "progress": return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200";
        case "success": return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
        case "warning": return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
        case "danger": return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200";
        default: return "bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-200";
    }
}

type ImportRowResult = {
    row: number;
    orderNumber: string;
    trackingNumber: string;
    courier: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    reason: string;
};

type ImportResult = {
    summary: {
        total: number;
        success: number;
        failed: number;
        skipped: number;
    };
    results: ImportRowResult[];
};

export default function AdminOrdersPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [page, setPage] = useState(1);

    // ---- Tracking Import State ----
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [showImportResult, setShowImportResult] = useState(false);
    const [downloadingTemplate, setDownloadingTemplate] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadOrders = useCallback(async (pageNum: number, searchVal: string, statusVal: string) => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            params.set("page", String(pageNum));
            params.set("limit", "20");
            if (searchVal.trim()) params.set("search", searchVal.trim());
            if (statusVal !== "ALL") params.set("status", statusVal);

            const response = await fetch(`/api/admin/orders?${params.toString()}`, { cache: "no-store" });
            const data = await response.json();

            if (!response.ok) {
                toast.error(data.message ?? "Gagal mengambil pesanan.");
                return;
            }

            setOrders(data.data?.items ?? []);
            setPagination(data.data?.pagination ?? { page: 1, limit: 20, total: 0, totalPages: 0 });
        } catch (error) {
            console.error(error);
            toast.error("Terjadi kesalahan.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadOrders(page, search, statusFilter);
    }, [page, loadOrders]);

    function handleSearch(e: React.FormEvent) {
        e.preventDefault();
        setPage(1);
        loadOrders(1, search, statusFilter);
    }

    function handleStatusFilter(value: string) {
        setStatusFilter(value);
        setPage(1);
        loadOrders(1, search, value);
    }

    if (loading && orders.length === 0) {
        return (
            <div className="p-4 sm:p-6">
                <div className="h-7 w-32 animate-pulse rounded-md bg-gray-200" />
                <div className="mt-2 h-4 w-64 animate-pulse rounded bg-gray-100" />
                <div className="mt-6 h-80 animate-pulse rounded-xl border border-gray-100 bg-white" />
            </div>
        );
    }

    // ---- Download Template ----
    async function handleDownloadTemplate() {
        try {
            setDownloadingTemplate(true);
            const response = await fetch("/api/admin/orders/tracking-template", {
                cache: "no-store",
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.message ?? "Gagal mengunduh template.");
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "template-import-resi.xlsx";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            toast.success("Template berhasil diunduh.");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengunduh template."
            );
        } finally {
            setDownloadingTemplate(false);
        }
    }

    // ---- Upload Excel ----
    async function handleUploadExcel(file: File) {
        try {
            setImporting(true);
            setImportResult(null);
            setShowImportResult(false);

            const formData = new FormData();
            formData.append("file", file);

            const response = await fetch("/api/admin/orders/tracking-import", {
                method: "POST",
                body: formData,
                cache: "no-store",
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.message ?? "Gagal memproses import.");
            }

            setImportResult(data.data);
            setShowImportResult(true);

            const summary = data.data.summary;
            if (summary.failed > 0 && summary.success === 0) {
                toast.error(`Import selesai. ${summary.failed} baris gagal.`);
            } else if (summary.failed > 0) {
                toast.success(`Import selesai: ${summary.success} berhasil, ${summary.failed} gagal, ${summary.skipped} dilewati.`);
            } else {
                toast.success(`Import selesai: ${summary.success} berhasil.`);
            }

            // Reload orders list
            loadOrders(page, search, statusFilter);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal memproses import."
            );
        } finally {
            setImporting(false);
        }
    }

    function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (file) {
            handleUploadExcel(file);
        }
        // Reset input so same file can be re-selected
        e.target.value = "";
    }

    // ---- Download Error Report ----
    async function handleDownloadErrorReport(errors: ImportRowResult[]) {
        try {
            const response = await fetch("/api/admin/orders/tracking-error-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ errors }),
                cache: "no-store",
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.message ?? "Gagal mengunduh error report.");
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `error-report-import-resi.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            toast.success("Error report berhasil diunduh.");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengunduh error report."
            );
        }
    }

    return (
        <div className="p-4 sm:p-6">
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Pesanan</h1>
                <p className="text-sm text-gray-500">Kelola pesanan customer dan pantau proses pengirimannya.</p>
            </div>

            {/* ---- IMPORT RESI SECTION ---- */}
            <div className="mt-4 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-lg">📦</span>
                    <div>
                        <p className="text-sm font-medium text-gray-900">Import Resi Bulk</p>
                        <p className="text-xs text-gray-500">Download template, isi nomor resi, lalu upload kembali.</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={handleDownloadTemplate}
                        disabled={downloadingTemplate}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs font-medium text-gray-700 transition hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <span>📥</span>
                        {downloadingTemplate ? "Mengunduh..." : "Download Template"}
                    </button>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={importing}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <span>{importing ? "⏳" : "📤"}</span>
                        {importing ? "Memproses..." : "Import Resi Excel"}
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleFileSelect}
                        className="hidden"
                    />
                </div>
            </div>

            {/* ---- IMPORT RESULT PANEL ---- */}
            {showImportResult && importResult && (
                <div className="mt-4 rounded-xl border border-gray-200 bg-white">
                    <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                        <div>
                            <h3 className="text-sm font-semibold text-gray-900">Hasil Import Resi</h3>
                            <p className="mt-0.5 text-xs text-gray-500">Ringkasan proses import Excel</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowImportResult(false)}
                            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="px-5 py-4">
                        {/* Summary */}
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div className="rounded-lg bg-gray-50 px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wide text-gray-400">Total</p>
                                <p className="mt-0.5 text-lg font-semibold text-gray-900">{importResult.summary.total}</p>
                            </div>
                            <div className="rounded-lg bg-emerald-50 px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wide text-emerald-600">Berhasil</p>
                                <p className="mt-0.5 text-lg font-semibold text-emerald-700">{importResult.summary.success}</p>
                            </div>
                            <div className="rounded-lg bg-red-50 px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wide text-red-600">Gagal</p>
                                <p className="mt-0.5 text-lg font-semibold text-red-700">{importResult.summary.failed}</p>
                            </div>
                            <div className="rounded-lg bg-amber-50 px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wide text-amber-600">Dilewati</p>
                                <p className="mt-0.5 text-lg font-semibold text-amber-700">{importResult.summary.skipped}</p>
                            </div>
                        </div>

                        {/* Error Report Button */}
                        {importResult.summary.failed > 0 && (
                            <div className="mt-4">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const errors = importResult.results.filter((r) => r.status === "FAILED");
                                        handleDownloadErrorReport(errors);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-xs font-medium text-red-700 transition hover:bg-red-50"
                                >
                                    <span>📥</span>
                                    Download Error Report
                                </button>
                            </div>
                        )}

                        {/* Results Table */}
                        <div className="mt-4 overflow-x-auto">
                            <table className="w-full min-w-[700px] text-left">
                                <thead className="border-b border-gray-100 bg-gray-50/70">
                                    <tr>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Baris</th>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Nomor Pesanan</th>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Nomor Resi</th>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Ekspedisi</th>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                                        <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Keterangan</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {importResult.results.map((r, idx) => (
                                        <tr key={idx} className="transition-colors hover:bg-gray-50/50">
                                            <td className="px-3 py-2.5 text-xs text-gray-500">{r.row}</td>
                                            <td className="px-3 py-2.5 text-xs font-medium text-gray-900">{r.orderNumber}</td>
                                            <td className="px-3 py-2.5 text-xs text-gray-700">{r.trackingNumber}</td>
                                            <td className="px-3 py-2.5 text-xs text-gray-700">{r.courier}</td>
                                            <td className="px-3 py-2.5">
                                                <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                                    r.status === "SUCCESS"
                                                        ? "bg-emerald-50 text-emerald-700"
                                                        : r.status === "SKIPPED"
                                                            ? "bg-amber-50 text-amber-700"
                                                            : "bg-red-50 text-red-700"
                                                }`}>
                                                    {r.status === "SUCCESS" ? "✅ Berhasil" : r.status === "SKIPPED" ? "⏭️ Dilewati" : "❌ Gagal"}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2.5 text-xs text-gray-500">{r.reason}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
                <div className="border-b border-gray-100 px-5 py-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <h2 className="text-sm font-semibold text-gray-900">Semua Pesanan</h2>
                            <p className="mt-0.5 text-xs text-gray-500">
                                Menampilkan {orders.length} dari {pagination.total} pesanan
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => { setSearch(""); setStatusFilter("ALL"); setPage(1); loadOrders(1, "", "ALL"); }}
                            className="self-start text-xs font-medium text-gray-500 hover:text-gray-900 lg:self-auto"
                        >
                            Reset filter
                        </button>
                    </div>

                    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <form onSubmit={handleSearch} className="relative flex-1 lg:max-w-sm">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">⌕</span>
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Cari nomor pesanan, nama..."
                                className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-400"
                            />
                        </form>
                        <select
                            value={statusFilter}
                            onChange={(e) => handleStatusFilter(e.target.value)}
                            className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-gray-400"
                        >
                            <option value="ALL">Semua status</option>
                            <option value="PENDING">Pending</option>
                            <option value="PROCESSING">Diproses</option>
                            <option value="SHIPPED">Dikirim</option>
                            <option value="COMPLETED">Selesai</option>
                            <option value="CANCELLED">Dibatalkan</option>
                        </select>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-left">
                        <thead className="border-b border-gray-100 bg-gray-50/70">
                            <tr>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Pesanan</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Customer</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Total</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Pembayaran</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Status Mengantar</th>
                                <th className="px-5 py-3.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tanggal</th>
                                <th className="px-5 py-3.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {orders.map((order) => (
                                <tr key={order.id} className="group transition-colors hover:bg-gray-50/70">
                                    <td className="px-5 py-4">
                                        <p className="text-sm font-semibold text-gray-900">{order.orderNumber}</p>
                                        <p className="mt-1 text-[11px] text-gray-400">{order.items.length} item</p>
                                    </td>
                                    <td className="px-5 py-4">
                                        <p className="truncate text-sm font-medium text-gray-900">{order.user?.name ?? order.recipientName}</p>
                                        <p className="mt-0.5 truncate text-xs text-gray-500">{order.user?.phone ?? order.phone}</p>
                                    </td>
                                    <td className="px-5 py-4">
                                        <p className="whitespace-nowrap text-sm font-semibold text-gray-900">{rupiah(order.total)}</p>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className={`inline-flex whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold ${statusClass(order.status)}`}>
                                            {statusLabel(order.status)}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <p className="text-xs font-medium text-gray-800">{order.paymentMethod}</p>
                                        <p className={`mt-0.5 text-xs font-medium ${paymentStatusClass(order.paymentStatus)}`}>{order.paymentStatus}</p>
                                    </td>
                                    <td className="px-5 py-4">
                                        {(() => {
                                            const mengantar =
                                                resolveMengantarAdminStatus(
                                                    order
                                                );

                                            return (
                                                <div className="flex flex-col gap-1">
                                                    <span
                                                        className={`inline-flex w-fit whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold ${mengantarToneClass(
                                                            mengantar.tone
                                                        )}`}
                                                    >
                                                        {
                                                            mengantar.label
                                                        }
                                                    </span>
                                                    {mengantar.trackingNumber && (
                                                        <span className="whitespace-nowrap text-[11px] text-gray-400">
                                                            Resi:{" "}
                                                            {
                                                                mengantar.trackingNumber
                                                            }
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </td>
                                    <td className="px-5 py-4">
                                        <p className="whitespace-nowrap text-xs text-gray-500">{date(order.createdAt)}</p>
                                    </td>
                                    <td className="px-5 py-4 text-right">
                                        <Link
                                            href={`/admin/orders/${order.id}`}
                                            className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-gray-300 hover:bg-gray-50"
                                        >
                                            Detail
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {orders.length === 0 && (
                    <div className="border-t border-gray-100 px-6 py-14 text-center">
                        <p className="text-sm font-medium text-gray-900">Pesanan tidak ditemukan</p>
                        <p className="mt-1 text-xs text-gray-500">Coba ubah kata kunci atau filter.</p>
                    </div>
                )}

                {pagination.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
                        <p className="text-xs text-gray-500">
                            Halaman {pagination.page} dari {pagination.totalPages}
                        </p>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                disabled={page <= 1}
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Sebelumnya
                            </button>
                            <button
                                type="button"
                                disabled={page >= pagination.totalPages}
                                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Selanjutnya
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
