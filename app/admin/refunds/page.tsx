"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import { useDialog } from "@/components/ui/Dialog";

type Refund = {
    id: number;
    orderId: number;
    orderNumber: string;
    customer: {
        id: string;
        name: string;
        email: string;
    };
    orderTotal: number;
    refundAmount: number;
    reason: string | null;
    status: string;
    paymentMethod: string;
    orderStatus: string;
    requestedBy: string;
    processedBy: string | null;
    providerRef: string | null;
    bank: {
        bankName: string | null;
        bankAccountName: string | null;
        bankAccountNumber: string | null;
    } | null;
    proofFilePath: string | null;
    requestedAt: string;
    processedAt: string;
};

type Summary = {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
};

type Pagination = {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
};

function formatRupiah(value: number) {
    return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

function formatDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

function getStatusLabel(status: string) {
    const labels: Record<string, string> = {
        PENDING: "Menunggu",
        PROCESSING: "Diproses",
        COMPLETED: "Selesai",
        FAILED: "Gagal",
    };
    return labels[status] || status;
}

function getStatusClass(status: string) {
    switch (status) {
        case "PENDING":
            return "bg-yellow-100 text-yellow-700";
        case "PROCESSING":
            return "bg-blue-100 text-blue-700";
        case "COMPLETED":
            return "bg-green-100 text-green-700";
        case "FAILED":
            return "bg-red-100 text-red-700";
        default:
            return "bg-gray-100 text-gray-700";
    }
}

function maskAccount(value?: string | null) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length <= 4) return "****";
    return "****" + digits.slice(-4);
}

export default function AdminRefundsPage() {
    const [refunds, setRefunds] = useState<Refund[]>([]);
    const [summary, setSummary] = useState<Summary>({ pending: 0, processing: 0, completed: 0, failed: 0, total: 0 });
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, totalCount: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [processingAction, setProcessingAction] = useState<number | null>(null);
    const [revealedBank, setRevealedBank] = useState<Set<number>>(new Set());
    const [uploadingProof, setUploadingProof] = useState<number | null>(null);

    async function loadRefunds(page: number = 1, searchQuery?: string, status?: string) {
        try {
            setLoading(true);

            const params = new URLSearchParams();
            params.set("page", String(page));
            params.set("limit", "10");

            const q = searchQuery !== undefined ? searchQuery : search;
            if (q) params.set("search", q);

            const s = status !== undefined ? status : statusFilter;
            if (s) params.set("status", s);

            const response = await fetch(`/api/admin/refunds?${params.toString()}`);
            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal mengambil data refund.");
            }

            setRefunds(result.data.refunds);
            setSummary(result.data.summary);
            setPagination(result.data.pagination);
        } catch (error) {
            console.error("LOAD REFUNDS ERROR:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil data refund."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadRefunds(1);
    }, []);

    const dialog = useDialog();

    async function handleRefundAction(refundId: number, orderId: number, action: "approve" | "complete" | "reject") {
        try {
            setProcessingAction(refundId);

            const confirmTitle =
                action === "complete"
                    ? "Selesaikan Refund"
                    : action === "approve"
                      ? "Setujui Refund"
                      : "Tolak Refund";
            const confirmMessage =
                action === "complete"
                    ? "Tandai refund sebagai selesai?"
                    : action === "approve"
                      ? "Setujui refund ini?"
                      : "Tolak refund ini?";

            if (!(await dialog.confirm({ title: confirmTitle, message: confirmMessage, variant: action === "reject" ? "danger" : "warning", confirmText: action === "reject" ? "Tolak" : "Ya" }))) {
                setProcessingAction(null);
                return;
            }

            let providerRef: string | undefined;
            if (action === "complete") {
                const input = await dialog.prompt({ title: "Provider Reference", message: "Masukkan provider reference ID (opsional):", placeholder: "Ref ID", required: false });
                providerRef = input || undefined;
            }

            let reason: string | undefined;
            if (action === "reject") {
                const input = await dialog.prompt({ title: "Alasan Penolakan", message: "Alasan penolakan:", placeholder: "Masukkan alasan...", required: true });
                if (!input) {
                    setProcessingAction(null);
                    return;
                }
                reason = input;
            }

            const response = await fetch(`/api/admin/orders/${orderId}/refund`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action,
                    providerRef,
                    reason,
                }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal memproses refund.");
            }

            toast.success(result.message);
            loadRefunds(pagination.page);
        } catch (error) {
            console.error("REFUND ACTION ERROR:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal memproses refund."
            );
        } finally {
            setProcessingAction(null);
        }
    }

    async function handleProofUpload(refundId: number, file?: File | null) {
        if (!file) return;

        if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) {
            toast.error("Tipe file tidak didukung. Gunakan JPG, PNG, WebP, atau PDF.");
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            toast.error("Ukuran file maksimal 5MB.");
            return;
        }

        setUploadingProof(refundId);

        try {
            const formData = new FormData();
            formData.append("file", file);

            const response = await fetch(`/api/admin/refunds/${refundId}/proof`, {
                method: "POST",
                body: formData,
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal upload bukti refund.");
            }

            toast.success("Bukti refund berhasil diupload.");
            loadRefunds(pagination.page);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal upload bukti refund."
            );
        } finally {
            setUploadingProof(null);
        }
    }

    function toggleBankReveal(refundId: number) {
        setRevealedBank((prev) => {
            const next = new Set(prev);
            if (next.has(refundId)) next.delete(refundId);
            else next.add(refundId);
            return next;
        });
    }

    return (
        <div className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-7xl">
                {/* HEADER */}
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-gray-900">
                        Dashboard Refund
                    </h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Kelola permintaan refund dari pelanggan
                    </p>
                </div>

                {/* SUMMARY CARDS */}
                <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-2xl border border-yellow-200 bg-white p-5">
                        <p className="text-sm font-medium text-gray-500">Menunggu</p>
                        <p className="mt-2 text-3xl font-bold text-yellow-600">
                            {summary.pending}
                        </p>
                    </div>
                    <div className="rounded-2xl border border-blue-200 bg-white p-5">
                        <p className="text-sm font-medium text-gray-500">Diproses</p>
                        <p className="mt-2 text-3xl font-bold text-blue-600">
                            {summary.processing}
                        </p>
                    </div>
                    <div className="rounded-2xl border border-green-200 bg-white p-5">
                        <p className="text-sm font-medium text-gray-500">Selesai</p>
                        <p className="mt-2 text-3xl font-bold text-green-600">
                            {summary.completed}
                        </p>
                    </div>
                    <div className="rounded-2xl border border-red-200 bg-white p-5">
                        <p className="text-sm font-medium text-gray-500">Gagal</p>
                        <p className="mt-2 text-3xl font-bold text-red-600">
                            {summary.failed}
                        </p>
                    </div>
                </div>

                {/* SEARCH + FILTER */}
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
                    <div className="flex-1">
                        <input
                            type="text"
                            placeholder="Cari nomor pesanan atau nama pelanggan..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    loadRefunds(1, search);
                                }
                            }}
                            className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                        />
                    </div>
                    <select
                        value={statusFilter}
                        onChange={(e) => {
                            setStatusFilter(e.target.value);
                            loadRefunds(1, undefined, e.target.value);
                        }}
                        className="rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    >
                        <option value="">Semua Status</option>
                        <option value="PENDING">Menunggu</option>
                        <option value="PROCESSING">Diproses</option>
                        <option value="COMPLETED">Selesai</option>
                        <option value="FAILED">Gagal</option>
                    </select>
                    <button
                        onClick={() => loadRefunds(1, search)}
                        className="rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                    >
                        Cari
                    </button>
                </div>

                {/* TABLE */}
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                    {loading ? (
                        <div className="p-8 text-center text-sm text-gray-500">
                            Memuat data refund...
                        </div>
                    ) : refunds.length === 0 ? (
                        <div className="p-8 text-center text-sm text-gray-500">
                            Tidak ada data refund ditemukan.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Pesanan
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Pelanggan
                                        </th>
                                        <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Jumlah Refund
                                        </th>
                                        <th className="px-6 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Status
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Alasan
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Diajukan
                                        </th>
                                        <th className="px-6 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500">
                                            Aksi
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {refunds.map((refund) => (
                                        <Fragment key={refund.id}>
                                        <tr className="hover:bg-gray-50">
                                            <td className="px-6 py-4">
                                                <Link
                                                    href={`/admin/orders/${refund.orderId}`}
                                                    className="font-semibold text-rose-600 hover:underline"
                                                >
                                                    {refund.orderNumber}
                                                </Link>
                                            </td>
                                            <td className="px-6 py-4">
                                                <p className="font-medium text-gray-900">
                                                    {refund.customer.name}
                                                </p>
                                                <p className="text-xs text-gray-500">
                                                    {refund.customer.email}
                                                </p>
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <p className="font-semibold text-gray-900">
                                                    {formatRupiah(refund.refundAmount)}
                                                </p>
                                                <p className="text-xs text-gray-500">
                                                    dari {formatRupiah(refund.orderTotal)}
                                                </p>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <span
                                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(
                                                        refund.status
                                                    )}`}
                                                >
                                                    {getStatusLabel(refund.status)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <p className="max-w-[200px] truncate text-sm text-gray-600">
                                                    {refund.reason || "-"}
                                                </p>
                                            </td>
                                            <td className="px-6 py-4">
                                                <p className="text-sm text-gray-600">
                                                    {formatDate(refund.requestedAt)}
                                                </p>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {refund.status === "PENDING" && (
                                                    <div className="flex items-center justify-center gap-2">
                                                        <button
                                                            onClick={() =>
                                                                handleRefundAction(
                                                                    refund.id,
                                                                    refund.orderId,
                                                                    "approve"
                                                                )
                                                            }
                                                            disabled={processingAction === refund.id}
                                                            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                                                        >
                                                            Setujui
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                handleRefundAction(
                                                                    refund.id,
                                                                    refund.orderId,
                                                                    "reject"
                                                                )
                                                            }
                                                            disabled={processingAction === refund.id}
                                                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                                                        >
                                                            Tolak
                                                        </button>
                                                    </div>
                                                )}
                                                {refund.status === "PROCESSING" && (
                                                    <span className="text-xs text-blue-600">
                                                        Diproses Admin
                                                    </span>
                                                )}
                                                {refund.status === "COMPLETED" && (
                                                    <span className="text-xs text-gray-400">
                                                        Selesai
                                                    </span>
                                                )}
                                                {refund.status === "FAILED" && (
                                                    <span className="text-xs text-gray-400">
                                                        Ditolak
                                                    </span>
                                                )}
                                            </td>
                                        </tr>

                                        {/* BANK + BUKTI REFUND DETAIL */}
                                        <tr className="bg-amber-50/40">
                                            <td colSpan={7} className="px-6 py-4">
                                                <div className="flex flex-wrap items-start justify-between gap-4">
                                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                                                        <div>
                                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                                                Bank Tujuan
                                                            </p>
                                                            <p className="text-sm font-medium text-gray-800">
                                                                {refund.bank?.bankName || "-"}
                                                            </p>
                                                        </div>
                                                        <div>
                                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                                                Atas Nama
                                                            </p>
                                                            <p className="text-sm font-medium text-gray-800">
                                                                {refund.bank?.bankAccountName || "-"}
                                                            </p>
                                                        </div>
                                                        <div>
                                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                                                No. Rekening
                                                            </p>
                                                            <p className="flex items-center gap-2 text-sm font-mono font-medium text-gray-800">
                                                                {revealedBank.has(refund.id)
                                                                    ? refund.bank?.bankAccountNumber
                                                                    : maskAccount(refund.bank?.bankAccountNumber)}
                                                                {refund.bank?.bankAccountNumber && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            toggleBankReveal(refund.id)
                                                                        }
                                                                        className="rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50"
                                                                    >
                                                                        {revealedBank.has(refund.id)
                                                                            ? "Sembunyikan"
                                                                            : "Lihat"}
                                                                    </button>
                                                                )}
                                                            </p>
                                                        </div>
                                                        <div>
                                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                                                Bukti Refund
                                                            </p>
                                                            <div className="flex items-center gap-2">
                                                                {(refund.status === "PENDING" ||
                                                                    refund.status === "PROCESSING") && (
                                                                    <label className="cursor-pointer rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-indigo-600 ring-1 ring-indigo-200 hover:bg-indigo-50">
                                                                        {uploadingProof === refund.id
                                                                            ? "Mengupload..."
                                                                            : refund.proofFilePath
                                                                              ? "Ganti Bukti"
                                                                              : "Upload Bukti"}
                                                                        <input
                                                                            type="file"
                                                                            accept=".jpg,.jpeg,.png,.webp,.pdf"
                                                                            className="hidden"
                                                                            onChange={(e) =>
                                                                                handleProofUpload(
                                                                                    refund.id,
                                                                                    e.target.files?.[0]
                                                                                )
                                                                            }
                                                                            disabled={
                                                                                uploadingProof === refund.id
                                                                            }
                                                                        />
                                                                    </label>
                                                                )}
                                                                {refund.proofFilePath && (
                                                                    <a
                                                                        href={`/api/admin/refunds/${refund.id}/proof`}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-green-200 hover:bg-green-50"
                                                                    >
                                                                        Lihat Bukti
                                                                    </a>
                                                                )}
                                                                {!refund.proofFilePath &&
                                                                    refund.status !== "PENDING" &&
                                                                    refund.status !== "PROCESSING" && (
                                                                        <span className="text-xs text-gray-400">
                                                                            -
                                                                        </span>
                                                                    )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {refund.status === "PROCESSING" && (
                                                        <button
                                                            onClick={() =>
                                                                handleRefundAction(
                                                                    refund.id,
                                                                    refund.orderId,
                                                                    "complete"
                                                                )
                                                            }
                                                            disabled={processingAction === refund.id}
                                                            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                                                        >
                                                            Konfirmasi Refund Selesai
                                                        </button>
                                                    )}
                                                </div>
                                                <p className="mt-2 text-[11px] text-gray-400">
                                                    Catatan: upload bukti TIDAK mengubah status refund.
                                                    Refund hanya selesai setelah admin menekan{" "}
                                                    <strong>Konfirmasi Refund Selesai</strong>.
                                                </p>
                                            </td>
                                        </tr>
                                        </Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* PAGINATION */}
                {pagination.totalPages > 1 && (
                    <div className="mt-6 flex items-center justify-between">
                        <p className="text-sm text-gray-500">
                            Menampilkan {(pagination.page - 1) * pagination.limit + 1} -{" "}
                            {Math.min(pagination.page * pagination.limit, pagination.totalCount)} dari{" "}
                            {pagination.totalCount} refund
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => loadRefunds(pagination.page - 1)}
                                disabled={pagination.page <= 1}
                                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            >
                                ← Sebelumnya
                            </button>
                            <span className="px-3 py-2 text-sm font-medium text-gray-700">
                                {pagination.page} / {pagination.totalPages}
                            </span>
                            <button
                                onClick={() => loadRefunds(pagination.page + 1)}
                                disabled={pagination.page >= pagination.totalPages}
                                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            >
                                Selanjutnya →
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
