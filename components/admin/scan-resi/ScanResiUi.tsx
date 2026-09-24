"use client";

/* ==========================================
 * SCAN RESI — SHARED UI PIECES
 * ==========================================
 *
 * Presentation only. Status semantics, tiers
 * and labels are derived from the existing
 * backend contract (lib/resi-scan/types.ts)
 * and the existing confidence helper
 * (lib/resi-scan/confidence.ts) so the UI can
 * never drift from the pipeline.
 *
 * No data fetching, no business logic.
 */

import { useEffect, useId, useRef } from "react";
import type { IconType } from "react-icons";
import {
    FiAlertCircle,
    FiAlertOctagon,
    FiAlertTriangle,
    FiCheckCircle,
    FiCopy,
    FiFileText,
    FiHash,
    FiImage,
    FiInfo,
    FiSearch,
    FiSlash,
    FiTag,
    FiX,
    FiXCircle,
} from "react-icons/fi";

import {
    classifyConfidence,
    HIGH_CONFIDENCE,
    type ConfidenceTier,
} from "@/lib/resi-scan/confidence";
import type {
    ScanDocumentResult,
    ScanSource,
    ScanStatus,
} from "@/lib/resi-scan/types";

/* ==========================================
 * TONES
 * ========================================== */

export type Tone =
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "neutral";

const TONE_BADGE: Record<Tone, string> = {
    success:
        "border-emerald-200 bg-emerald-50 text-emerald-700",
    warning:
        "border-amber-200 bg-amber-50 text-amber-700",
    danger: "border-rose-200 bg-rose-50 text-rose-700",
    info: "border-sky-200 bg-sky-50 text-sky-700",
    neutral:
        "border-gray-200 bg-gray-50 text-gray-600",
};

/* ==========================================
 * STATUS
 * ==========================================
 *
 * Labels follow the backend meaning (an INVALID
 * status is an invalid *tracking number*, not an
 * invalid file) so the UI never shows a message
 * the pipeline does not actually mean.
 */

export const STATUS_META: Record<
    ScanStatus,
    {
        label: string;
        tone: Tone;
        icon: IconType;
        hint: string;
    }
> = {
    MATCHED_READY: {
        label: "Siap diterapkan",
        tone: "success",
        icon: FiCheckCircle,
        hint: "Order ditemukan, resi valid, tidak ada konflik.",
    },
    NEEDS_REVIEW: {
        label: "Perlu ditinjau",
        tone: "warning",
        icon: FiAlertTriangle,
        hint: "Keyakinan sedang — periksa dulu sebelum menerapkan.",
    },
    CONFLICT: {
        label: "Konflik",
        tone: "danger",
        icon: FiAlertOctagon,
        hint: "Order sudah punya resi lain, resi dipakai order lain, atau status order memblokir.",
    },
    NOT_FOUND: {
        label: "Order tidak ditemukan",
        tone: "neutral",
        icon: FiSearch,
        hint: "Referensi order pada dokumen tidak cocok dengan order mana pun.",
    },
    INVALID: {
        label: "Resi tidak valid",
        tone: "neutral",
        icon: FiXCircle,
        hint: "Format nomor resi tidak lolos validasi.",
    },
    DUPLICATE_SAME: {
        label: "Resi sudah ada",
        tone: "info",
        icon: FiCopy,
        hint: "Order sudah memiliki nomor resi yang sama.",
    },
    EXTRACTION_FAILED: {
        label: "Gagal diekstrak",
        tone: "neutral",
        icon: FiSlash,
        hint: "Data order/resi tidak berhasil diekstrak dari dokumen.",
    },
};

export function StatusBadge({
    status,
    size = "md",
}: {
    status: ScanStatus;
    size?: "sm" | "md";
}) {
    const meta = STATUS_META[status];
    const Icon = meta.icon;

    return (
        <span
            title={meta.hint}
            className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${TONE_BADGE[meta.tone]} ${
                size === "sm"
                    ? "px-2 py-0.5 text-[11px]"
                    : "px-2.5 py-1 text-xs"
            }`}
        >
            <Icon aria-hidden className="shrink-0" size={13} />
            {meta.label}
        </span>
    );
}

/* ==========================================
 * CONFIDENCE
 * ========================================== */

const CONFIDENCE_META: Record<
    ConfidenceTier,
    { label: string; tone: Tone; icon: IconType }
> = {
    HIGH: {
        label: "Tinggi",
        tone: "success",
        icon: FiCheckCircle,
    },
    MEDIUM: {
        label: "Sedang",
        tone: "warning",
        icon: FiAlertTriangle,
    },
    LOW: {
        label: "Rendah",
        tone: "danger",
        icon: FiAlertCircle,
    },
};

export function confidenceTier(
    score: number
): ConfidenceTier {
    return classifyConfidence(score);
}

export function ConfidenceBadge({
    confidence,
    showScore = false,
}: {
    confidence: number;
    showScore?: boolean;
}) {
    const tier = classifyConfidence(confidence);
    const meta = CONFIDENCE_META[tier];
    const Icon = meta.icon;

    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            <span
                title={`Keyakinan otomatis ${confidencePercent(confidence)}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_BADGE[meta.tone]}`}
            >
                <Icon aria-hidden className="shrink-0" size={13} />
                {meta.label}
            </span>
            {showScore && (
                <span className="text-[11px] text-gray-400">
                    {confidencePercent(confidence)}
                </span>
            )}
        </span>
    );
}

export function confidencePercent(value: number) {
    return `${Math.round((value || 0) * 100)}%`;
}

/* ==========================================
 * FORMATTERS
 * ========================================== */

export function formatFileSize(bytes: number) {
    if (!bytes || bytes <= 0) return "—";
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function sourceLabel(
    source: ScanSource | null
) {
    if (source === "pdf-text") return "PDF Text";
    if (source === "ocr") return "OCR";
    return "—";
}

/** PDF vs image icon for a file name. */
export function fileIcon(fileName: string) {
    return fileName.toLowerCase().endsWith(".pdf")
        ? FiFileText
        : FiImage;
}

/* ==========================================
 * DETAIL PANEL
 * ========================================== */

function DetailRow({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-start justify-between gap-4 px-5 py-3">
            <dt className="text-xs font-medium text-gray-400">
                {label}
            </dt>
            <dd className="min-w-0 text-right text-sm font-semibold break-words text-gray-900">
                {children}
            </dd>
        </div>
    );
}

export function ScanResiDetailPanel({
    result,
    applying,
    canApply,
    onApply,
    onClose,
}: {
    result: ScanDocumentResult;
    applying: boolean;
    canApply: boolean;
    onApply: () => void;
    onClose: () => void;
}) {
    const titleId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const tier = classifyConfidence(result.confidence);

    /* Escape to close + body scroll lock, same
     * pattern as the other modals in the app. */
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        document.addEventListener("keydown", handleKeyDown);
        return () =>
            document.removeEventListener(
                "keydown",
                handleKeyDown
            );
    }, [onClose]);

    useEffect(() => {
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = "";
        };
    }, []);

    useEffect(() => {
        closeRef.current?.focus();
    }, []);

    const orderDisplay =
        result.resolution.orderNumber ??
        result.orderReference ??
        "—";

    return (
        <div
            /*
             * z-index stays BELOW the shared confirm
             * dialog (z-[9998]) so "Terapkan Resi" can
             * open the confirmation on top of this panel.
             */
            className="fixed inset-0 z-[9990] flex items-end justify-center bg-gray-950/40 backdrop-blur-[2px] sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
        >
            <div
                aria-hidden
                className="absolute inset-0 cursor-default"
                onClick={onClose}
            />

            <div className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:max-w-xl sm:rounded-2xl">
                {/* HEADER */}
                <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 sm:px-6">
                    <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                            Detail Hasil Scan
                        </p>
                        <h2
                            id={titleId}
                            className="mt-1 truncate text-base font-bold tracking-tight text-gray-950"
                        >
                            {result.fileName}
                        </h2>
                    </div>

                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Tutup detail"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                    >
                        <FiX aria-hidden size={18} />
                    </button>
                </div>

                {/* STATUS */}
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-5 py-3 sm:px-6">
                    <StatusBadge status={result.status} />
                    <ConfidenceBadge
                        confidence={result.confidence}
                        showScore
                    />
                </div>

                {/* VALUES */}
                <dl className="divide-y divide-gray-100">
                    <DetailRow label="File">
                        {result.fileName}
                    </DetailRow>
                    <DetailRow label="Ukuran">
                        {formatFileSize(result.fileSize)}
                    </DetailRow>
                    <DetailRow label="Order">
                        {orderDisplay}
                    </DetailRow>
                    <DetailRow label="Nomor Resi">
                        <span className="font-mono text-[13px]">
                            {result.trackingNumber ?? "—"}
                        </span>
                    </DetailRow>
                    <DetailRow label="Sumber">
                        {sourceLabel(result.source)}
                    </DetailRow>
                    <DetailRow label="Keyakinan">
                        {CONFIDENCE_META[tier].label}{" "}
                        <span className="text-[11px] font-normal text-gray-400">
                            ({confidencePercent(result.confidence)} · ambang {Math.round(HIGH_CONFIDENCE * 100)}%)
                        </span>
                    </DetailRow>
                </dl>

                {/* MATCHING DETAILS (existing resolution data) */}
                <div className="border-t border-gray-100 px-5 py-4 sm:px-6">
                    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                        <FiInfo aria-hidden size={13} />
                        Detail pencocokan
                    </p>

                    <ul className="mt-3 space-y-2 text-xs text-gray-600">
                        <li className="flex items-start gap-2">
                            <FiTag
                                aria-hidden
                                className="mt-0.5 shrink-0 text-gray-300"
                                size={13}
                            />
                            <span>
                                Status order:{" "}
                                <strong className="font-semibold text-gray-800">
                                    {result.resolution
                                        .orderStatus ?? "—"}
                                </strong>
                            </span>
                        </li>
                        <li className="flex items-start gap-2">
                            <FiHash
                                aria-hidden
                                className="mt-0.5 shrink-0 text-gray-300"
                                size={13}
                            />
                            <span>
                                Resi tersimpan pada order:{" "}
                                <strong className="font-mono font-semibold text-gray-800">
                                    {result.resolution
                                        .existingTracking ??
                                        "belum ada"}
                                </strong>
                            </span>
                        </li>
                    </ul>
                </div>

                {/* NOTES — backend messages as-is */}
                {result.warnings.length > 0 && (
                    <div className="border-t border-gray-100 px-5 py-4 sm:px-6">
                        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                            <FiAlertTriangle
                                aria-hidden
                                size={13}
                            />
                            Catatan
                        </p>

                        <ul className="mt-3 space-y-2">
                            {result.warnings.map((w, i) => (
                                <li
                                    key={i}
                                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                                >
                                    {w}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* FOOTER */}
                <div className="flex flex-col gap-2 border-t border-gray-200 bg-gray-50/60 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                    >
                        Tutup
                    </button>

                    {canApply && (
                        <button
                            type="button"
                            onClick={onApply}
                            disabled={applying}
                            aria-busy={applying}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-gray-950 px-5 text-sm font-semibold text-white transition hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {applying && (
                                <span
                                    aria-hidden
                                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                                />
                            )}
                            {applying
                                ? "Menerapkan..."
                                : "Terapkan Resi"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
