"use client";

/* ==========================================
 * ADMIN — SCAN RESI
 * ==========================================
 *
 * UI/UX only. The scan + apply flow below is
 * unchanged: same endpoints, same payloads, same
 * validation, same authorization. Everything in
 * this file is presentation and local view state.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
    FiAlertTriangle,
    FiCheckCircle,
    FiFileText,
    FiInfo,
    FiLoader,
    FiRefreshCw,
    FiTrash2,
    FiUploadCloud,
    FiX,
} from "react-icons/fi";

import { useDialog } from "@/components/ui/Dialog";
import {
    ConfidenceBadge,
    ScanResiDetailPanel,
    StatusBadge,
    fileIcon,
    formatFileSize,
    sourceLabel,
} from "@/components/admin/scan-resi/ScanResiUi";
import type { ScanDocumentResult } from "@/lib/resi-scan/types";

type Summary = {
    total: number;
    matched: number;
    review: number;
    conflict: number;
    skipped: number;
    failed: number;
};

const ACCEPTED =
    ".pdf,.jpg,.jpeg,.png,.webp";

const MAX_FILES_HINT = 10;

type QueuedFile = {
    name: string;
    size: number;
    type: string;
};

function resultKey(
    result: ScanDocumentResult
) {
    return `${result.resolution.orderId}:${result.trackingNumber}`;
}

function isApplicable(result: ScanDocumentResult) {
    return (
        (result.status === "MATCHED_READY" ||
            result.status === "NEEDS_REVIEW") &&
        result.resolution.orderId !== null
    );
}

export default function AdminScanResiPage() {
    const inputRef = useRef<HTMLInputElement>(null);
    const dialog = useDialog();

    const [scanning, setScanning] = useState(false);
    const [results, setResults] = useState<
        ScanDocumentResult[]
    >([]);
    const [summary, setSummary] =
        useState<Summary | null>(null);
    const [applyingIds, setApplyingIds] = useState<
        Set<string>
    >(new Set());
    const [applyingAll, setApplyingAll] =
        useState(false);

    /* View-only state */
    const [dragging, setDragging] = useState(false);
    const [scanError, setScanError] = useState<
        string | null
    >(null);
    const [queuedFiles, setQueuedFiles] = useState<
        QueuedFile[]
    >([]);
    const [pendingFiles, setPendingFiles] = useState<
        File[]
    >([]);
    const [detail, setDetail] =
        useState<ScanDocumentResult | null>(null);

    /* ==========================================
     * SCAN
     * ========================================== */

    const runScan = useCallback(
        async (files: File[]) => {
            if (files.length === 0) return;

            setScanning(true);
            setScanError(null);
            setResults([]);
            setSummary(null);
            setDetail(null);
            setQueuedFiles(
                files.map((f) => ({
                    name: f.name,
                    size: f.size,
                    type: f.type,
                }))
            );
            setPendingFiles(files);

            const formData = new FormData();
            for (const file of files) {
                formData.append("files", file);
            }

            try {
                const response = await fetch(
                    "/api/admin/resi-scan",
                    { method: "POST", body: formData }
                );
                const result = await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(
                        result.message ||
                            "Gagal memindai dokumen."
                    );
                }

                setResults(result.data.results);
                setSummary(result.data.summary);
                toast.success(
                    "Pemindaian selesai. Tinjau hasil sebelum menerapkan."
                );
            } catch (error) {
                setScanError(
                    error instanceof Error
                        ? error.message
                        : "Gagal memindai dokumen."
                );
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Gagal memindai dokumen."
                );
            } finally {
                setScanning(false);
                if (inputRef.current) {
                    inputRef.current.value = "";
                }
            }
        },
        []
    );

    const handleScan = useCallback(
        (fileList: FileList | null) => {
            void runScan(Array.from(fileList ?? []));
        },
        [runScan]
    );

    const handleRetry = useCallback(() => {
        if (pendingFiles.length === 0) return;
        void runScan(pendingFiles);
    }, [pendingFiles, runScan]);

    const handleDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            if (scanning) return;
            void runScan(
                Array.from(
                    event.dataTransfer?.files ?? []
                )
            );
        },
        [runScan, scanning]
    );

    /* ==========================================
     * APPLY (unchanged logic)
     * ========================================== */

    const applyItem = useCallback(
        async (
            result: ScanDocumentResult,
            explicitConfirm = true
        ) => {
            const ready =
                result.status === "MATCHED_READY" ||
                result.status === "NEEDS_REVIEW";

            if (!ready || !result.resolution.orderId) {
                toast.error(
                    "Item ini tidak dapat diterapkan."
                );
                return;
            }

            if (explicitConfirm) {
                const ok = await dialog.confirm({
                    title: "Terapkan Nomor Resi",
                    message: `Terapkan resi ${result.trackingNumber ?? "-"} ke order ${result.resolution.orderNumber ?? result.resolution.orderId}?`,
                    variant: "info",
                    confirmText: "Ya, Terapkan",
                });

                if (!ok) return;
            }

            setApplyingIds((prev) => {
                const next = new Set(prev);
                next.add(
                    `${result.resolution.orderId}:${result.trackingNumber}`
                );
                return next;
            });

            try {
                const response = await fetch(
                    "/api/admin/resi-scan/apply",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        body: JSON.stringify({
                            items: [
                                {
                                    orderId:
                                        result.resolution
                                            .orderId,
                                    orderNumber:
                                        result.resolution
                                            .orderNumber,
                                    reference:
                                        result.orderReference,
                                    trackingNumber:
                                        result.trackingNumber,
                                    courier: null,
                                    source: result.source,
                                    confidence:
                                        result.confidence,
                                    fileName:
                                        result.fileName,
                                },
                            ],
                        }),
                    }
                );
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(
                        data.message ||
                            "Gagal menerapkan resi."
                    );
                }

                const item = data.data.results?.[0];
                if (item?.status === "APPLIED") {
                    toast.success(
                        `Resi diterapkan ke order ${item.orderNumber}.`
                    );
                    setResults((prev) =>
                        prev.filter(
                            (r) =>
                                r.index !== result.index
                        )
                    );
                    setDetail(null);
                } else {
                    toast.error(
                        item?.message ||
                            "Tidak dapat menerapkan resi."
                    );
                }
            } catch (error) {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : "Gagal menerapkan resi."
                );
            } finally {
                setApplyingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(
                        `${result.resolution.orderId}:${result.trackingNumber}`
                    );
                    return next;
                });
            }
        },
        [dialog]
    );

    const applyAllMatched = useCallback(async () => {
        const matched = results.filter(
            (r) => r.status === "MATCHED_READY"
        );

        if (matched.length === 0) {
            toast.error(
                "Tidak ada hasil yang siap diterapkan otomatis."
            );
            return;
        }

        const ok = await dialog.confirm({
            title: "Terapkan Semua Resi Matched",
            message: `Terapkan ${matched.length} resi ber-keyakinan tinggi (HIGH) sekaligus?`,
            variant: "warning",
            confirmText: "Ya, Terapkan",
        });

        if (!ok) return;

        try {
            const response = await fetch(
                "/api/admin/resi-scan/apply",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        items: matched.map((r) => ({
                            orderId:
                                r.resolution.orderId,
                            orderNumber:
                                r.resolution.orderNumber,
                            reference: r.orderReference,
                            trackingNumber: r.trackingNumber,
                            courier: null,
                            source: r.source,
                            confidence: r.confidence,
                            fileName: r.fileName,
                        })),
                    }),
                }
            );
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(
                    data.message ||
                        "Gagal menerapkan resi."
                );
            }

            const appliedIds = new Set(
                data.data.results
                    .filter(
                        (item: { status: string }) =>
                            item.status === "APPLIED"
                    )
                    .map((item: { orderId: number }) =>
                        String(item.orderId)
                    )
            );

            const failedSome =
                data.data.results.some(
                    (item: { status: string }) =>
                        item.status !== "APPLIED"
                );

            setResults((prev) =>
                prev.filter(
                    (r) =>
                        !appliedIds.has(
                            String(r.resolution.orderId)
                        )
                )
            );

            toast.success(
                `${data.data.summary.applied} resi berhasil diterapkan.`
            );
            if (failedSome) {
                toast.error(
                    "Beberapa item tidak dapat diterapkan. Periksa status."
                );
            }
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal menerapkan resi."
            );
        }
    }, [results, dialog]);

    /*
     * UI convenience only: runs the exact same
     * single-item apply the operator could click
     * one by one. No new payload, no new endpoint.
     */
    const applyAllApplicable = useCallback(async () => {
        const applicable = results.filter(isApplicable);

        if (applicable.length === 0) {
            toast.error(
                "Tidak ada hasil yang dapat diterapkan."
            );
            return;
        }

        const readyCount = applicable.filter(
            (r) => r.status === "MATCHED_READY"
        ).length;
        const reviewCount =
            applicable.length - readyCount;

        const ok = await dialog.confirm({
            title: "Terapkan Semua Resi",
            message:
                reviewCount > 0
                    ? `Terapkan ${applicable.length} resi? ${readyCount} siap diterapkan dan ${reviewCount} perlu ditinjau akan diproses satu per satu.`
                    : `Terapkan ${applicable.length} resi sekaligus?`,
            variant: "warning",
            confirmText: "Ya, Terapkan Semua",
        });

        if (!ok) return;

        setApplyingAll(true);
        try {
            for (const item of applicable) {
                await applyItem(item, false);
            }
        } finally {
            setApplyingAll(false);
        }
    }, [results, dialog, applyItem]);

    const handleApplyMatchedClick =
        useCallback(async () => {
            setApplyingAll(true);
            try {
                await applyAllMatched();
            } finally {
                setApplyingAll(false);
            }
        }, [applyAllMatched]);

    const removeFromList = useCallback(
        (result: ScanDocumentResult) => {
            setResults((prev) =>
                prev.filter((r) => r.index !== result.index)
            );
            setDetail(null);
        },
        []
    );

    /* ==========================================
     * DERIVED
     * ========================================== */

    const counts = useMemo(() => {
        const matched = results.filter(
            (r) => r.status === "MATCHED_READY"
        ).length;
        const review = results.filter(
            (r) => r.status === "NEEDS_REVIEW"
        ).length;

        return {
            matched,
            review,
            applicable: matched + review,
        };
    }, [results]);

    const anyApplicable = counts.applicable > 0;
    const busy = scanning || applyingAll;
    const showEmptyState =
        !scanning &&
        !scanError &&
        results.length === 0;

    const summaryCards = summary
        ? [
              {
                  key: "total",
                  label: "Total dokumen",
                  value: summary.total,
                  tone: "text-gray-900 bg-gray-100",
                  icon: FiFileText,
              },
              {
                  key: "matched",
                  label: "Siap diterapkan",
                  value: summary.matched,
                  tone: "text-emerald-600 bg-emerald-50",
                  icon: FiCheckCircle,
              },
              {
                  key: "review",
                  label: "Perlu ditinjau",
                  value: summary.review,
                  tone: "text-amber-600 bg-amber-50",
                  icon: FiAlertTriangle,
              },
              {
                  key: "conflict",
                  label: "Konflik",
                  value: summary.conflict,
                  tone: "text-rose-600 bg-rose-50",
                  icon: FiX,
              },
              {
                  key: "skipped",
                  label: "Sudah ada",
                  value: summary.skipped,
                  tone: "text-sky-600 bg-sky-50",
                  icon: FiInfo,
              },
              {
                  key: "failed",
                  label: "Tidak cocok",
                  value: summary.failed,
                  tone: "text-gray-600 bg-gray-100",
                  icon: FiAlertTriangle,
              },
          ]
        : [];

    /* ==========================================
     * RENDER
     * ========================================== */

    return (
        <div className="min-h-full bg-gray-50/70 p-4 md:p-6 lg:p-8">
            <div className="mx-auto max-w-[1500px] space-y-6">
                {/* ============ HEADER ============ */}
                <div>
                    <div className="mb-2 flex items-center gap-2 text-xs text-gray-400">
                        <span>Admin</span>
                        <span aria-hidden>/</span>
                        <span className="text-gray-600">
                            Scan Resi
                        </span>
                    </div>

                    <h1 className="text-2xl font-bold tracking-tight text-gray-950">
                        Scan Resi
                    </h1>

                    <p className="mt-1 text-sm text-gray-500">
                        Upload dokumen dan cocokkan nomor
                        resi dengan order secara otomatis.
                    </p>

                    <p className="mt-4 flex max-w-3xl items-start gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs leading-relaxed text-gray-500">
                        <FiInfo
                            aria-hidden
                            className="mt-0.5 shrink-0 text-gray-400"
                            size={14}
                        />
                        <span>
                            Upload PDF atau gambar yang
                            berisi Order ID dan nomor resi.
                            Periksa hasil pencocokan
                            sebelum menerapkan perubahan.
                        </span>
                    </p>
                </div>

                {/* ============ UPLOAD (FOCAL) ============ */}
                <section
                    aria-labelledby="scan-resi-upload-title"
                    className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6"
                >
                    <div
                        onDragEnter={(e) => {
                            e.preventDefault();
                            if (!scanning) setDragging(true);
                        }}
                        onDragOver={(e) => {
                            e.preventDefault();
                            if (!scanning) setDragging(true);
                        }}
                        onDragLeave={(e) => {
                            e.preventDefault();
                            setDragging(false);
                        }}
                        onDrop={handleDrop}
                        className={`group flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition-all duration-200 focus-within:ring-2 focus-within:ring-gray-900/10 sm:py-11 ${
                            dragging
                                ? "border-gray-900 bg-gray-50"
                                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/60"
                        } ${scanning ? "opacity-60" : ""}`}
                    >
                        <span
                            className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-transform duration-200 ${
                                dragging
                                    ? "scale-105 bg-gray-900 text-white"
                                    : "bg-gray-100 text-gray-500 group-hover:scale-[1.03]"
                            }`}
                        >
                            <FiUploadCloud
                                aria-hidden
                                size={26}
                            />
                        </span>

                        <p
                            id="scan-resi-upload-title"
                            className="mt-4 text-base font-semibold text-gray-950"
                        >
                            Upload dokumen resi
                        </p>
                        <p className="mt-1 text-sm text-gray-500">
                            Tarik file ke sini atau pilih dari
                            perangkat
                        </p>

                        <label
                            htmlFor="scan-resi-file-input"
                            className="sr-only"
                        >
                            Pilih dokumen resi (PDF atau
                            gambar)
                        </label>
                        <input
                            id="scan-resi-file-input"
                            ref={inputRef}
                            type="file"
                            accept={ACCEPTED}
                            multiple
                            disabled={scanning}
                            aria-describedby="scan-resi-file-help"
                            onChange={(e) =>
                                handleScan(e.target.files)
                            }
                            className="sr-only"
                        />

                        <button
                            type="button"
                            onClick={() =>
                                inputRef.current?.click()
                            }
                            disabled={scanning}
                            className="mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-gray-950 px-5 text-sm font-semibold text-white transition hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <FiUploadCloud
                                aria-hidden
                                size={16}
                            />
                            Pilih File
                        </button>

                        <p
                            id="scan-resi-file-help"
                            className="mt-3 text-xs text-gray-400"
                        >
                            PDF, JPG, PNG, WEBP · Maks. 8
                            MB/file · Maks. {MAX_FILES_HINT}{" "}
                            file per proses
                        </p>
                    </div>
                </section>

                {/* ============ PROCESSING ============ */}
                {scanning && (
                    <section
                        role="status"
                        aria-live="polite"
                        className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6"
                    >
                        <div className="flex items-start gap-3">
                            <span
                                aria-hidden
                                className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900"
                            />
                            <div>
                                <p className="text-sm font-semibold text-gray-950">
                                    Memproses dokumen...
                                </p>
                                <p className="mt-1 text-sm text-gray-500">
                                    Mengekstrak Order ID dan
                                    nomor resi. Dokumen hasil
                                    scan (OCR) membutuhkan
                                    waktu lebih lama.
                                </p>
                            </div>
                        </div>

                        {queuedFiles.length > 0 && (
                            <ul className="mt-4 space-y-2">
                                {queuedFiles.map((file, i) => {
                                    const Icon =
                                        fileIcon(file.name);
                                    return (
                                        <li
                                            key={`${file.name}-${i}`}
                                            className="scan-resi-enter flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3"
                                        >
                                            <span className="flex min-w-0 items-center gap-3">
                                                <Icon
                                                    aria-hidden
                                                    className="shrink-0 text-gray-400"
                                                    size={16}
                                                />
                                                <span className="min-w-0">
                                                    <span className="block truncate text-sm font-medium text-gray-800">
                                                        {file.name}
                                                    </span>
                                                    <span className="block text-xs text-gray-400">
                                                        {formatFileSize(
                                                            file.size
                                                        )}
                                                    </span>
                                                </span>
                                            </span>
                                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600">
                                                <FiLoader
                                                    aria-hidden
                                                    className="animate-spin"
                                                    size={12}
                                                />
                                                Memproses
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                )}

                {/* ============ ERROR ============ */}
                {scanError && !scanning && (
                    <section
                        role="alert"
                        className="rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-sm sm:p-6"
                    >
                        <div className="flex items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
                                <FiAlertTriangle
                                    aria-hidden
                                    size={18}
                                />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-rose-900">
                                    Tidak dapat memproses
                                    dokumen
                                </p>
                                <p className="mt-1 text-sm break-words text-rose-700">
                                    {scanError}
                                </p>

                                {pendingFiles.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={handleRetry}
                                        className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
                                    >
                                        <FiRefreshCw
                                            aria-hidden
                                            size={14}
                                        />
                                        Coba Lagi
                                    </button>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                {/* ============ EMPTY ============ */}
                {showEmptyState && (
                    <section className="rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-10 text-center">
                        <p className="text-sm font-semibold text-gray-900">
                            Belum ada dokumen
                        </p>
                        <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
                            Upload PDF atau gambar untuk mulai
                            mencocokkan Order ID dan nomor
                            resi. Hasil pencocokan akan
                            muncul di sini.
                        </p>
                    </section>
                )}

                {/* ============ SUMMARY ============ */}
                {summary && results.length > 0 && (
                    <section
                        aria-label="Ringkasan hasil scan"
                        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
                    >
                        {summaryCards.map((card) => {
                            const Icon = card.icon;
                            return (
                                <div
                                    key={card.key}
                                    className="scan-resi-enter rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                                >
                                    <span
                                        aria-hidden
                                        className={`flex h-8 w-8 items-center justify-center rounded-lg ${card.tone}`}
                                    >
                                        <Icon size={15} />
                                    </span>
                                    <p className="mt-3 text-2xl font-bold tracking-tight text-gray-950">
                                        {card.value}
                                    </p>
                                    <p className="text-xs font-medium text-gray-500">
                                        {card.label}
                                    </p>
                                </div>
                            );
                        })}
                    </section>
                )}

                {/* ============ ACTION BAR ============ */}
                {results.length > 0 && (
                    <section
                        aria-label="Aksi penerapan resi"
                        className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="text-sm text-gray-500">
                            <span className="font-semibold text-gray-950">
                                {results.length} hasil scan
                            </span>
                            <span className="mx-2 text-gray-300">
                                •
                            </span>
                            {counts.matched} siap diterapkan
                            <span className="mx-2 text-gray-300">
                                •
                            </span>
                            {counts.review} perlu ditinjau
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row">
                            <button
                                type="button"
                                onClick={
                                    handleApplyMatchedClick
                                }
                                disabled={
                                    busy ||
                                    counts.matched === 0
                                }
                                aria-busy={
                                    applyingAll &&
                                    counts.matched > 0
                                }
                                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-gray-950 px-5 text-sm font-semibold text-white transition hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {applyingAll && (
                                    <span
                                        aria-hidden
                                        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                                    />
                                )}
                                {applyingAll
                                    ? "Menerapkan..."
                                    : `Terapkan yang Siap (${counts.matched})`}
                            </button>

                            <button
                                type="button"
                                onClick={applyAllApplicable}
                                disabled={busy || !anyApplicable}
                                aria-busy={applyingAll}
                                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Terapkan Semua (
                                {counts.applicable})
                            </button>
                        </div>
                    </section>
                )}

                {/* ============ RESULTS — DESKTOP ============ */}
                {results.length > 0 && (
                    <section className="hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:block">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-4">
                            <div>
                                <h2 className="text-sm font-semibold text-gray-950">
                                    Hasil pencocokan
                                </h2>
                                <p className="mt-0.5 text-xs text-gray-400">
                                    {results.length} dokumen ·
                                    periksa sebelum menerapkan
                                </p>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[900px] text-left">
                                <caption className="sr-only">
                                    Hasil pencocokan nomor resi
                                    per dokumen
                                </caption>
                                <thead>
                                    <tr className="border-b border-gray-200 bg-gray-50/80">
                                        <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            File
                                        </th>
                                        <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            Order
                                        </th>
                                        <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            Nomor Resi
                                        </th>
                                        <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            Confidence
                                        </th>
                                        <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            Status
                                        </th>
                                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                                            Aksi
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {results.map((result) => {
                                        const Icon = fileIcon(
                                            result.fileName
                                        );
                                        const ready =
                                            isApplicable(result);
                                        const applying =
                                            result.resolution
                                                .orderId !==
                                                null &&
                                            applyingIds.has(
                                                resultKey(
                                                    result
                                                )
                                            );

                                        return (
                                            <tr
                                                key={result.index}
                                                className="scan-resi-enter align-top transition-colors hover:bg-gray-50/70"
                                            >
                                                <td className="max-w-[240px] px-5 py-4">
                                                    <div className="flex items-start gap-3">
                                                        <Icon
                                                            aria-hidden
                                                            className="mt-0.5 shrink-0 text-gray-400"
                                                            size={16}
                                                        />
                                                        <div className="min-w-0">
                                                            <p
                                                                className="truncate text-sm font-semibold text-gray-900"
                                                                title={
                                                                    result.fileName
                                                                }
                                                            >
                                                                {
                                                                    result.fileName
                                                                }
                                                            </p>
                                                            <p className="mt-0.5 text-xs text-gray-400">
                                                                {formatFileSize(
                                                                    result.fileSize
                                                                )}{" "}
                                                                ·{" "}
                                                                {sourceLabel(
                                                                    result.source
                                                                )}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </td>

                                                <td className="px-5 py-4">
                                                    <p className="text-sm font-medium text-gray-900">
                                                        {result
                                                            .resolution
                                                            .orderNumber ??
                                                            result.orderReference ??
                                                            "—"}
                                                    </p>
                                                    {result
                                                        .resolution
                                                        .orderStatus && (
                                                        <p className="mt-0.5 text-xs text-gray-400">
                                                            {
                                                                result
                                                                    .resolution
                                                                    .orderStatus
                                                            }
                                                        </p>
                                                    )}
                                                </td>

                                                <td className="px-5 py-4">
                                                    <span className="font-mono text-sm text-gray-900">
                                                        {result.trackingNumber ??
                                                            "—"}
                                                    </span>
                                                </td>

                                                <td className="px-5 py-4">
                                                    <ConfidenceBadge
                                                        confidence={
                                                            result.confidence
                                                        }
                                                        showScore
                                                    />
                                                </td>

                                                <td className="px-5 py-4">
                                                    <StatusBadge
                                                        status={
                                                            result.status
                                                        }
                                                    />
                                                    {result
                                                        .warnings
                                                        .length >
                                                        0 && (
                                                        <p
                                                            className="mt-1 max-w-[230px] truncate text-[11px] text-amber-700"
                                                            title={result.warnings.join(
                                                                " "
                                                            )}
                                                        >
                                                            {
                                                                result
                                                                    .warnings[0]
                                                            }
                                                        </p>
                                                    )}
                                                </td>

                                                <td className="px-5 py-4">
                                                    <div className="flex justify-end gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setDetail(
                                                                    result
                                                                )
                                                            }
                                                            className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                                                        >
                                                            Detail
                                                        </button>

                                                        {ready && (
                                                            <button
                                                                type="button"
                                                                onClick={() =>
                                                                    applyItem(
                                                                        result
                                                                    )
                                                                }
                                                                disabled={
                                                                    applying
                                                                }
                                                                aria-busy={
                                                                    applying
                                                                }
                                                                className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 ${
                                                                    result.status ===
                                                                    "MATCHED_READY"
                                                                        ? "bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-600"
                                                                        : "bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-600"
                                                                }`}
                                                            >
                                                                {applying && (
                                                                    <span
                                                                        aria-hidden
                                                                        className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
                                                                    />
                                                                )}
                                                                {applying
                                                                    ? "Menerapkan..."
                                                                    : result.status ===
                                                                        "MATCHED_READY"
                                                                      ? "Terapkan"
                                                                      : "Tinjau & Terapkan"}
                                                            </button>
                                                        )}

                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                removeFromList(
                                                                    result
                                                                )
                                                            }
                                                            aria-label={`Hapus ${result.fileName} dari daftar hasil`}
                                                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 transition hover:bg-gray-50 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                                                        >
                                                            <FiTrash2
                                                                aria-hidden
                                                                size={14}
                                                            />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}

                {/* ============ RESULTS — MOBILE ============ */}
                {results.length > 0 && (
                    <div className="space-y-3 md:hidden">
                        {results.map((result) => {
                            const Icon = fileIcon(
                                result.fileName
                            );
                            const ready =
                                isApplicable(result);
                            const applying =
                                result.resolution.orderId !==
                                    null &&
                                applyingIds.has(
                                    resultKey(result)
                                );

                            return (
                                <article
                                    key={result.index}
                                    className="scan-resi-enter rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                                >
                                    <div className="flex items-start gap-3">
                                        <Icon
                                            aria-hidden
                                            className="mt-0.5 shrink-0 text-gray-400"
                                            size={16}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className="truncate text-sm font-semibold text-gray-900"
                                                title={
                                                    result.fileName
                                                }
                                            >
                                                {
                                                    result.fileName
                                                }
                                            </p>
                                            <p className="mt-0.5 text-xs text-gray-400">
                                                {formatFileSize(
                                                    result.fileSize
                                                )}{" "}
                                                ·{" "}
                                                {sourceLabel(
                                                    result.source
                                                )}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                removeFromList(
                                                    result
                                                )
                                            }
                                            aria-label={`Hapus ${result.fileName} dari daftar hasil`}
                                            className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                                        >
                                            <FiTrash2
                                                aria-hidden
                                                size={14}
                                            />
                                        </button>
                                    </div>

                                    <dl className="mt-4 space-y-2 border-t border-gray-100 pt-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <dt className="text-xs font-medium text-gray-400">
                                                Order
                                            </dt>
                                            <dd className="min-w-0 text-right text-sm font-semibold break-words text-gray-900">
                                                {result
                                                    .resolution
                                                    .orderNumber ??
                                                    result.orderReference ??
                                                    "—"}
                                            </dd>
                                        </div>
                                        <div className="flex items-start justify-between gap-3">
                                            <dt className="text-xs font-medium text-gray-400">
                                                Nomor Resi
                                            </dt>
                                            <dd className="min-w-0 text-right font-mono text-sm break-words text-gray-900">
                                                {result.trackingNumber ??
                                                    "—"}
                                            </dd>
                                        </div>
                                    </dl>

                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <ConfidenceBadge
                                            confidence={
                                                result.confidence
                                            }
                                            showScore
                                        />
                                        <StatusBadge
                                            status={result.status}
                                        />
                                    </div>

                                    {result.warnings.length >
                                        0 && (
                                        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                                            {result.warnings[0]}
                                        </p>
                                    )}

                                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setDetail(result)
                                            }
                                            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 sm:flex-1"
                                        >
                                            Lihat Detail
                                        </button>

                                        {ready && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    applyItem(result)
                                                }
                                                disabled={applying}
                                                aria-busy={
                                                    applying
                                                }
                                                className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 sm:flex-1 ${
                                                    result.status ===
                                                    "MATCHED_READY"
                                                        ? "bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-600"
                                                        : "bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-600"
                                                }`}
                                            >
                                                {applying && (
                                                    <span
                                                        aria-hidden
                                                        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                                                    />
                                                )}
                                                {applying
                                                    ? "Menerapkan..."
                                                    : result.status ===
                                                        "MATCHED_READY"
                                                      ? "Terapkan"
                                                      : "Tinjau & Terapkan"}
                                            </button>
                                        )}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}

                {/* ============ DETAIL PANEL ============ */}
                {detail && (
                    <ScanResiDetailPanel
                        result={detail}
                        applying={
                            detail.resolution.orderId !==
                                null &&
                            applyingIds.has(
                                resultKey(detail)
                            )
                        }
                        canApply={isApplicable(detail)}
                        onApply={() => applyItem(detail)}
                        onClose={() => setDetail(null)}
                    />
                )}
            </div>
        </div>
    );
}
