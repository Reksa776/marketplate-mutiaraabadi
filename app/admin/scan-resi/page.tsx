"use client";

import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useDialog } from "@/components/ui/Dialog";

type ScanStatus =
    | "MATCHED_READY"
    | "NEEDS_REVIEW"
    | "CONFLICT"
    | "NOT_FOUND"
    | "INVALID"
    | "DUPLICATE_SAME"
    | "EXTRACTION_FAILED";

type ScanResult = {
    index: number;
    fileName: string;
    fileSize: number;
    source: "pdf-text" | "ocr" | null;
    orderReference: string | null;
    trackingNumber: string | null;
    warnings: string[];
    confidence: number;
    status: ScanStatus;
    resolution: {
        orderId: number | null;
        orderNumber: string | null;
        orderStatus: string | null;
        orderExists: boolean;
        alreadyHasTracking: boolean;
        existingTracking: string | null;
        trackingInUseByOtherOrder: boolean;
        trackingValid: boolean;
    };
};

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

const STATUS_META: Record<
    ScanStatus,
    { label: string; className: string }
> = {
    MATCHED_READY: {
        label: "Matched — Siap Terapkan",
        className: "bg-green-100 text-green-700",
    },
    NEEDS_REVIEW: {
        label: "Perlu Tinjauan",
        className: "bg-amber-100 text-amber-700",
    },
    CONFLICT: {
        label: "Konflik",
        className: "bg-red-100 text-red-700",
    },
    NOT_FOUND: {
        label: "Order Tidak Ditemukan",
        className: "bg-slate-200 text-slate-600",
    },
    INVALID: {
        label: "Resi Tidak Valid",
        className: "bg-slate-200 text-slate-600",
    },
    DUPLICATE_SAME: {
        label: "Resi Sudah Ada (sama)",
        className: "bg-blue-100 text-blue-700",
    },
    EXTRACTION_FAILED: {
        label: "Gagal Dibaca",
        className: "bg-slate-200 text-slate-600",
    },
};

function confidencePercent(value: number) {
    return `${Math.round((value || 0) * 100)}%`;
}

function formatFileSize(bytes: number) {
    if (!bytes) return "-";
    return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function AdminScanResiPage() {
    const inputRef = useRef<HTMLInputElement>(null);
    const dialog = useDialog();

    const [scanning, setScanning] = useState(false);
    const [results, setResults] = useState<
        ScanResult[]
    >([]);
    const [summary, setSummary] =
        useState<Summary | null>(null);
    const [applyingIds, setApplyingIds] = useState<
        Set<string>
    >(new Set());

    const handleScan = useCallback(
        async (fileList: FileList | null) => {
            const files = Array.from(fileList ?? []);
            if (files.length === 0) return;

            setScanning(true);
            setResults([]);
            setSummary(null);

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

    const applyItem = useCallback(
        async (
            result: ScanResult,
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
                            trackingNumber:
                                r.trackingNumber,
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

    const canApplyAny =
        results.some(
            (r) =>
                r.status === "MATCHED_READY" ||
                r.status === "NEEDS_REVIEW"
        );

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-800">
                    Scan Resi (Resi Otomatis)
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                    Upload PDF atau foto bukti pengiriman
                    untuk mendeteksi nomor order & nomor
                    resi. Hasil dengan keyakinan tinggi
                    bisa diterapkan otomatis; hasil lain
                    wajib ditinjau admin. Data hanya
                    disimpan setelah Anda menerapkan.
                </p>
            </div>

            {/* UPLOAD */}
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6">
                <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPTED}
                    multiple
                    className="block w-full text-sm text-slate-600 file:mr-4 file:cursor-pointer file:rounded-xl file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:font-semibold file:text-indigo-600 hover:file:bg-indigo-100"
                    onChange={(e) =>
                        handleScan(e.target.files)
                    }
                />
                <p className="mt-3 text-xs text-slate-400">
                    Format: PDF, JPG, JPEG, PNG, WEBP.
                    Maks 8MB/file, 10 file/batch.
                </p>
                {scanning && (
                    <p className="mt-3 text-sm font-medium text-indigo-600">
                        Memindai dokumen... (OCR pada
                        dokumen terscan mungkin butuh
                        beberapa saat)
                    </p>
                )}
            </div>

            {canApplyAny && results.length > 0 && (
                <button
                    type="button"
                    onClick={applyAllMatched}
                    disabled={scanning}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    Terapkan Semua ({summary?.matched ?? 0})
                    Matched
                </button>
            )}

            {summary && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                    <SummaryChip
                        label="Total"
                        value={summary.total}
                        className="bg-slate-100 text-slate-700"
                    />
                    <SummaryChip
                        label="Matched (HIGH)"
                        value={summary.matched}
                        className="bg-green-100 text-green-700"
                    />
                    <SummaryChip
                        label="Perlu Tinjauan"
                        value={summary.review}
                        className="bg-amber-100 text-amber-700"
                    />
                    <SummaryChip
                        label="Konflik"
                        value={summary.conflict}
                        className="bg-red-100 text-red-700"
                    />
                    <SummaryChip
                        label="Sudah Ada"
                        value={summary.skipped}
                        className="bg-blue-100 text-blue-700"
                    />
                    <SummaryChip
                        label="Gagal"
                        value={summary.failed}
                        className="bg-stone-200 text-stone-600"
                    />
                </div>
            )}

            {/* RESULTS */}
            {results.length > 0 && (
                <div className="space-y-3">
                    {results.map((result) => {
                        const meta =
                            STATUS_META[
                                result.status
                            ];
                        const ready =
                            result.status ===
                                "MATCHED_READY" ||
                            result.status ===
                                "NEEDS_REVIEW";
                        const applying =
                            result.resolution.orderId !==
                                null &&
                            applyingIds.has(
                                `${result.resolution.orderId}:${result.trackingNumber}`
                            );

                        return (
                            <div
                                key={result.index}
                                className="rounded-2xl border border-slate-200 bg-white p-4"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate font-semibold text-slate-800">
                                            {result.fileName}{" "}
                                            <span className="ml-1 text-xs font-normal text-slate-400">
                                                ({formatFileSize(
                                                    result.fileSize
                                                )})
                                            </span>
                                        </p>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                                            <span>
                                                Order:{" "}
                                                <strong>
                                                    {result.resolution
                                                        .orderNumber ??
                                                        result
                                                            .orderReference ??
                                                        "-"}
                                                </strong>
                                            </span>
                                            <span>•</span>
                                            <span>
                                                Resi:{" "}
                                                <strong className="font-mono">
                                                    {result.trackingNumber ??
                                                        "-"}
                                                </strong>
                                            </span>
                                            <span>•</span>
                                            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                                                {result.source ===
                                                "pdf-text"
                                                    ? "PDF Text"
                                                    : result.source ===
                                                        "ocr"
                                                      ? "OCR"
                                                      : "—"}
                                            </span>
                                            <span>•</span>
                                            <span
                                                title={`Keyakinan otomatis ${confidencePercent(
                                                    result.confidence
                                                )}`}
                                            >
                                                Confidence:{" "}
                                                {confidencePercent(
                                                    result.confidence
                                                )}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`rounded-full px-3 py-1 text-xs font-semibold ${meta.className}`}
                                        >
                                            {meta.label}
                                        </span>

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
                                                className={`rounded-xl px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 ${
                                                    result.status ===
                                                    "MATCHED_READY"
                                                        ? "bg-green-600 hover:bg-green-700"
                                                        : "bg-amber-600 hover:bg-amber-700"
                                                }`}
                                            >
                                                {applying
                                                    ? "Menerapkan..."
                                                    : result.status ===
                                                        "MATCHED_READY"
                                                      ? "Terapkan"
                                                      : "Tinjau & Terapkan"}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {result.warnings.length >
                                    0 && (
                                    <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
                                        {result.warnings.map(
                                            (w, i) => (
                                                <li
                                                    key={
                                                        i
                                                    }
                                                >
                                                    ⚠ {w}
                                                </li>
                                            )
                                        )}
                                    </ul>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function SummaryChip({
    label,
    value,
    className,
}: {
    label: string;
    value: number;
    className: string;
}) {
    return (
        <div
            className={`rounded-2xl p-3 text-center ${className}`}
        >
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs font-medium">{label}</p>
        </div>
    );
}