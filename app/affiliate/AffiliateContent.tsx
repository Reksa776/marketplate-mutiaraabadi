"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import toast from "react-hot-toast";
import Link from "next/link";
import {
    FiArrowLeft,
    FiUpload,
    FiCheck,
    FiX,
    FiClock,
    FiCreditCard,
    FiImage,
    FiAlertCircle,
} from "react-icons/fi";

/* ==========================================
 * TYPES
 * ========================================== */

type Application = {
    id: number;
    status: string;
    affiliateCode: string | null;
    rejectionReason: string | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
    kyc: {
        bankName: string | null;
        bankAccountName: string | null;
        socialMediaPlatform: string | null;
        socialMediaUsername: string | null;
    } | null;
};

type UploadResult = {
    url: string;
    fileName: string;
};

/* ==========================================
 * STATUS HELPERS
 * ========================================== */

function statusConfig(status: string) {
    switch (status) {
        case "PENDING":
            return {
                label: "Menunggu Review",
                icon: FiClock,
                color: "text-amber-600",
                bg: "bg-amber-50",
                border: "border-amber-200",
            };
        case "APPROVED":
            return {
                label: "Disetujui",
                icon: FiCheck,
                color: "text-emerald-600",
                bg: "bg-emerald-50",
                border: "border-emerald-200",
            };
        case "REJECTED":
            return {
                label: "Ditolak",
                icon: FiX,
                color: "text-red-600",
                bg: "bg-red-50",
                border: "border-red-200",
            };
        default:
            return {
                label: status,
                icon: FiClock,
                color: "text-gray-600",
                bg: "bg-gray-50",
                border: "border-gray-200",
            };
    }
}

function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString(
        "id-ID",
        {
            day: "2-digit",
            month: "long",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }
    );
}

/* ==========================================
 * MAIN COMPONENT
 * ========================================== */

export default function AffiliateContent() {
    const [application, setApplication] =
        useState<Application | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] =
        useState(false);

    // ---- KTP State ----
    // blobUrl = local preview (createObjectURL)
    // serverUrl = uploaded file URL (from server)
    const [ktpBlobUrl, setKtpBlobUrl] =
        useState<string>("");
    const [ktpServerUrl, setKtpServerUrl] =
        useState<string>("");
    const [ktpUploading, setKtpUploading] =
        useState(false);
    const [ktpError, setKtpError] =
        useState<string>("");

    // ---- Social Media State ----
    const [socialBlobUrl, setSocialBlobUrl] =
        useState<string>("");
    const [
        socialServerUrl,
        setSocialServerUrl,
    ] = useState<string>("");
    const [socialUploading, setSocialUploading] =
        useState(false);
    const [socialError, setSocialError] =
        useState<string>("");

    // ---- Form State ----
    const [bankName, setBankName] = useState("");
    const [bankAccountName, setBankAccountName] =
        useState("");
    const [
        bankAccountNumber,
        setBankAccountNumber,
    ] = useState("");
    const [
        socialMediaPlatform,
        setSocialMediaPlatform,
    ] = useState("");
    const [
        socialMediaUsername,
        setSocialMediaUsername,
    ] = useState("");

    const ktpInputRef =
        useRef<HTMLInputElement>(null);
    const socialInputRef =
        useRef<HTMLInputElement>(null);

    /* ==========================================
     * CLEANUP: Revoke blob URLs on unmount
     * ========================================== */

    useEffect(() => {
        return () => {
            if (ktpBlobUrl)
                URL.revokeObjectURL(ktpBlobUrl);
            if (socialBlobUrl)
                URL.revokeObjectURL(socialBlobUrl);
        };
    }, [ktpBlobUrl, socialBlobUrl]);

    /* ==========================================
     * LOAD APPLICATION
     * ========================================== */

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch(
                    "/api/affiliate/application",
                    { cache: "no-store" }
                );
                const data = await res.json();

                if (data.success) {
                    setApplication(data.data);
                }
            } catch (err) {
                console.error(
                    "Load affiliate application error:",
                    err
                );
            } finally {
                setLoading(false);
            }
        }

        load();
    }, []);

    /* ==========================================
     * FILE UPLOAD HELPER
     * ========================================== */

    const uploadFile = useCallback(
        async (
            file: File,
            type: string
        ): Promise<UploadResult> => {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("type", type);

            const res = await fetch(
                "/api/affiliate/upload",
                {
                    method: "POST",
                    body: formData,
                }
            );

            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(
                    data.message ||
                        "Gagal mengupload file."
                );
            }

            return data.data;
        },
        []
    );

    /* ==========================================
     * CLIENT-SIDE FILE VALIDATION
     * ========================================== */

    function validateFile(
        file: File
    ): string | null {
        if (file.size === 0) {
            return "File kosong.";
        }

        if (file.size > 5 * 1024 * 1024) {
            return "Ukuran file maksimal 5MB.";
        }

        if (
            ![
                "image/jpeg",
                "image/png",
                "image/webp",
            ].includes(file.type)
        ) {
            return "Format harus JPG, PNG, atau WEBP.";
        }

        return null;
    }

    /* ==========================================
     * HANDLE KTP UPLOAD
     * ==========================================
     *
     * Flow:
     * 1. Validate file client-side
     * 2. Create blob URL for immediate preview
     * 3. Upload to server (async)
     * 4. On success: store server URL
     * 5. On failure: keep blob preview, show error
     */

    async function handleKtpChange(
        e: React.ChangeEvent<HTMLInputElement>
    ) {
        const file = e.target.files?.[0];
        if (!file) return;

        // 1. Validate
        const error = validateFile(file);
        if (error) {
            toast.error(error);
            // Reset input so same file can be re-selected
            if (ktpInputRef.current)
                ktpInputRef.current.value = "";
            return;
        }

        // 2. Revoke old blob URL
        if (ktpBlobUrl) {
            URL.revokeObjectURL(ktpBlobUrl);
        }

        // 3. Create new blob URL for immediate preview
        const blobUrl = URL.createObjectURL(file);
        setKtpBlobUrl(blobUrl);
        setKtpError("");

        // 4. Upload to server (preview stays visible)
        try {
            setKtpUploading(true);
            const result = await uploadFile(
                file,
                "ktp"
            );
            // Store server URL for submission
            setKtpServerUrl(result.url);
            setKtpError("");
        } catch (err) {
            // Upload failed: keep blob preview, show error
            const msg =
                err instanceof Error
                    ? err.message
                    : "Gagal upload KTP.";
            setKtpError(msg);
            setKtpServerUrl("");
            toast.error(msg);
        } finally {
            setKtpUploading(false);
        }
    }

    /* ==========================================
     * HANDLE SOCIAL MEDIA UPLOAD
     * ========================================== */

    async function handleSocialChange(
        e: React.ChangeEvent<HTMLInputElement>
    ) {
        const file = e.target.files?.[0];
        if (!file) return;

        // 1. Validate
        const error = validateFile(file);
        if (error) {
            toast.error(error);
            if (socialInputRef.current)
                socialInputRef.current.value = "";
            return;
        }

        // 2. Revoke old blob URL
        if (socialBlobUrl) {
            URL.revokeObjectURL(socialBlobUrl);
        }

        // 3. Create new blob URL for immediate preview
        const blobUrl = URL.createObjectURL(file);
        setSocialBlobUrl(blobUrl);
        setSocialError("");

        // 4. Upload to server
        try {
            setSocialUploading(true);
            const result = await uploadFile(
                file,
                "social"
            );
            setSocialServerUrl(result.url);
            setSocialError("");
        } catch (err) {
            const msg =
                err instanceof Error
                    ? err.message
                    : "Gagal upload foto sosial media.";
            setSocialError(msg);
            setSocialServerUrl("");
            toast.error(msg);
        } finally {
            setSocialUploading(false);
        }
    }

    /* ==========================================
     * REMOVE KTP
     * ========================================== */

    function removeKtp() {
        if (ktpBlobUrl) {
            URL.revokeObjectURL(ktpBlobUrl);
        }
        setKtpBlobUrl("");
        setKtpServerUrl("");
        setKtpError("");
        if (ktpInputRef.current) {
            ktpInputRef.current.value = "";
        }
    }

    /* ==========================================
     * REMOVE SOCIAL MEDIA
     * ========================================== */

    function removeSocial() {
        if (socialBlobUrl) {
            URL.revokeObjectURL(socialBlobUrl);
        }
        setSocialBlobUrl("");
        setSocialServerUrl("");
        setSocialError("");
        if (socialInputRef.current) {
            socialInputRef.current.value = "";
        }
    }

    /* ==========================================
     * SUBMIT APPLICATION
     * ==========================================
     *
     * Validates SERVER URLs, not blob URLs.
     * Ensures uploads completed successfully.
     */

    async function handleSubmit() {
        // Validate server URLs (not blob URLs)
        if (!ktpServerUrl) {
            toast.error(
                "Foto KTP belum berhasil diupload. Pastikan upload selesai."
            );
            return;
        }

        if (!socialServerUrl) {
            toast.error(
                "Foto sosial media belum berhasil diupload. Pastikan upload selesai."
            );
            return;
        }

        if (!bankName.trim()) {
            toast.error("Nama bank wajib diisi.");
            return;
        }

        if (!bankAccountName.trim()) {
            toast.error(
                "Nama pemilik rekening wajib diisi."
            );
            return;
        }

        if (!bankAccountNumber.trim()) {
            toast.error(
                "Nomor rekening wajib diisi."
            );
            return;
        }

        const cleanAccount =
            bankAccountNumber.replace(/\s/g, "");
        if (!/^\d{8,20}$/.test(cleanAccount)) {
            toast.error(
                "Nomor rekening harus 8-20 digit angka."
            );
            return;
        }

        try {
            setSubmitting(true);

            const res = await fetch(
                "/api/affiliate/application",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        ktpImageUrl: ktpServerUrl,
                        socialMediaImageUrl:
                            socialServerUrl,
                        bankName: bankName.trim(),
                        bankAccountName:
                            bankAccountName.trim(),
                        bankAccountNumber:
                            cleanAccount,
                        socialMediaPlatform:
                            socialMediaPlatform.trim() ||
                            null,
                        socialMediaUsername:
                            socialMediaUsername.trim() ||
                            null,
                    }),
                }
            );

            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(
                    data.message ||
                        "Gagal mengirim pengajuan."
                );
            }

            toast.success(
                "Pengajuan berhasil dikirim! Silakan tunggu review dari admin."
            );

            // Reload application status
            const statusRes = await fetch(
                "/api/affiliate/application",
                { cache: "no-store" }
            );
            const statusData =
                await statusRes.json();

            if (statusData.success) {
                setApplication(statusData.data);
            }
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Gagal mengirim pengajuan."
            );
        } finally {
            setSubmitting(false);
        }
    }

    /* ==========================================
     * LOADING STATE
     * ========================================== */

    if (loading) {
        return (
            <main className="mx-auto min-h-screen max-w-lg bg-white p-5">
                <div className="animate-pulse space-y-4">
                    <div className="h-6 w-40 rounded bg-gray-200" />
                    <div className="h-4 w-64 rounded bg-gray-100" />
                    <div className="mt-6 h-48 rounded-xl bg-gray-100" />
                </div>
            </main>
        );
    }

    /* ==========================================
     * STATUS VIEW (has existing application)
     * ========================================== */

    if (application) {
        const config = statusConfig(
            application.status
        );
        const StatusIcon = config.icon;

        return (
            <main className="mx-auto min-h-screen max-w-lg bg-white p-5">
                {/* HEADER */}
                <div className="mb-6">
                    <Link
                        href="/affiliate"
                        className="inline-flex items-center gap-1 text-sm text-gray-500 transition hover:text-gray-900"
                    >
                        <FiArrowLeft size={14} />
                        Kembali
                    </Link>

                    <h1 className="mt-4 text-xl font-semibold text-gray-900">
                        Affiliator
                    </h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Status pengajuan Anda
                    </p>
                </div>

                {/* STATUS CARD */}
                <div
                    className={`rounded-xl border ${config.border} ${config.bg} p-5`}
                >
                    <div className="flex items-center gap-3">
                        <div
                            className={`flex h-10 w-10 items-center justify-center rounded-full ${config.bg}`}
                        >
                            <StatusIcon
                                size={20}
                                className={
                                    config.color
                                }
                            />
                        </div>
                        <div>
                            <p
                                className={`text-sm font-semibold ${config.color}`}
                            >
                                {config.label}
                            </p>
                            <p className="mt-0.5 text-xs text-gray-500">
                                Diajukan:{" "}
                                {formatDate(
                                    application.createdAt
                                )}
                            </p>
                        </div>
                    </div>

                    {/* APPROVED INFO */}
                    {application.status ===
                        "APPROVED" &&
                        application.affiliateCode && (
                            <div className="mt-4 border-t border-emerald-200 pt-4">
                                <p className="text-xs text-emerald-600">
                                    Kode Affiliator:
                                </p>
                                <p className="mt-1 font-mono text-base font-bold text-emerald-700">
                                    {
                                        application.affiliateCode
                                    }
                                </p>

                                <p className="mt-3 text-xs text-emerald-600">
                                    Link Referral:
                                </p>
                                <div className="mt-1 flex items-center gap-2">
                                    <code className="flex-1 truncate rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                                        {typeof window !== "undefined"
                                            ? `${window.location.origin}/?ref=${application.affiliateCode}`
                                            : `/?ref=${application.affiliateCode}`}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const url = `${window.location.origin}/?ref=${application.affiliateCode}`;
                                            navigator.clipboard.writeText(url);
                                            toast.success("Link referral berhasil dicopy!");
                                        }}
                                        className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-700"
                                    >
                                        Copy
                                    </button>
                                </div>

                                <Link
                                    href="/affiliate/dashboard"
                                    className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50"
                                >
                                    Buka Dashboard Affiliator
                                </Link>
                            </div>
                        )}

                    {/* REJECTED REASON */}
                    {application.status ===
                        "REJECTED" &&
                        application.rejectionReason && (
                            <div className="mt-4 border-t border-red-200 pt-4">
                                <p className="text-xs font-medium text-red-600">
                                    Alasan Penolakan:
                                </p>
                                <p className="mt-1 text-sm text-red-700">
                                    {
                                        application.rejectionReason
                                    }
                                </p>
                            </div>
                        )}
                </div>

                {/* KYC INFO */}
                {application.kyc && (
                    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                        <p className="text-xs font-medium text-gray-500">
                            Informasi yang
                            dikirim:
                        </p>
                        <div className="mt-3 space-y-2">
                            <div className="flex items-center gap-2 text-sm">
                                <FiCreditCard
                                    size={14}
                                    className="text-gray-400"
                                />
                                <span className="text-gray-600">
                                    {application.kyc.bankName} - {application.kyc.bankAccountName}
                                </span>
                            </div>
                            {application.kyc
                                .socialMediaPlatform && (
                                <div className="flex items-center gap-2 text-sm">
                                    <FiImage
                                        size={14}
                                        className="text-gray-400"
                                    />
                                    <span className="text-gray-600">
                                        {
                                            application
                                                .kyc
                                                .socialMediaPlatform
                                        }
                                        {application
                                            .kyc
                                            .socialMediaUsername
                                            ? ` — ${application.kyc.socialMediaUsername}`
                                            : ""}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* RESUBMIT (only if REJECTED) */}
                {application.status ===
                    "REJECTED" && (
                    <div className="mt-6">
                        <button
                            type="button"
                            onClick={() =>
                                setApplication(null)
                            }
                            className="w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800"
                        >
                            Ajukan Ulang
                        </button>
                    </div>
                )}
            </main>
        );
    }

    /* ==========================================
     * FORM VIEW (no application or resubmit)
     * ========================================== */

    // PREVIEW: Always use blob URL for immediate display.
    // Server URL is only used for form submission.
    // The serving endpoint requires a DB record (AffiliateKyc)
    // which doesn't exist until after submit, so using
    // server URL for preview would cause 404/broken image.

    return (
        <main className="mx-auto min-h-screen max-w-lg bg-white p-5">
            {/* HEADER */}
            <div className="mb-6">
                <Link
                    href="/affiliate"
                    className="inline-flex items-center gap-1 text-sm text-gray-500 transition hover:text-gray-900"
                >
                    <FiArrowLeft size={14} />
                    Kembali
                </Link>

                <h1 className="mt-4 text-xl font-semibold text-gray-900">
                    Daftar Affiliator
                </h1>
                <p className="mt-1 text-sm text-gray-500">
                    Lengkapi data berikut untuk
                    mengajukan diri sebagai Affiliator.
                </p>
            </div>

            {/* FORM */}
            <div className="space-y-5">
                {/* KTP */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Foto KTP{" "}
                        <span className="text-red-500">
                            *
                        </span>
                    </label>
                    <p className="mt-0.5 text-xs text-gray-400">
                        Upload foto KTP yang jelas
                        dan terbaca.
                    </p>

                    <div className="mt-2">
                        <input
                            ref={ktpInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={
                                handleKtpChange
                            }
                            className="hidden"
                        />

                        {ktpBlobUrl ? (
                            <div className="relative">
                                <img
                                    src={
                                        ktpBlobUrl
                                    }
                                    alt="KTP"
                                    className="h-40 w-full rounded-xl border border-gray-200 object-cover"
                                />
                                {/* Upload spinner */}
                                {ktpUploading && (
                                    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/80">
                                        <p className="text-sm text-gray-500">
                                            Mengupload...
                                        </p>
                                    </div>
                                )}
                                {/* Upload error banner */}
                                {ktpError &&
                                    !ktpUploading && (
                                        <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 rounded-b-xl bg-red-50 px-3 py-1.5">
                                            <FiAlertCircle
                                                size={
                                                    12
                                                }
                                                className="text-red-500"
                                            />
                                            <span className="text-[11px] text-red-600">
                                                {
                                                    ktpError
                                                }
                                            </span>
                                        </div>
                                    )}
                                {/* Remove button */}
                                <button
                                    type="button"
                                    onClick={
                                        removeKtp
                                    }
                                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-gray-500 shadow-sm transition hover:bg-white hover:text-red-500"
                                >
                                    <FiX
                                        size={14}
                                    />
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() =>
                                    ktpInputRef.current?.click()
                                }
                                className="flex h-32 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 transition hover:border-gray-300 hover:bg-gray-50"
                            >
                                <FiUpload
                                    size={24}
                                    className="text-gray-300"
                                />
                                <p className="mt-2 text-xs text-gray-400">
                                    Klik untuk upload
                                    KTP
                                </p>
                                <p className="mt-0.5 text-[11px] text-gray-300">
                                    JPG, PNG, WEBP
                                    (maks 5MB)
                                </p>
                            </button>
                        )}
                    </div>
                </div>

                {/* BANK NAME */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Nama Bank{" "}
                        <span className="text-red-500">
                            *
                        </span>
                    </label>
                    <input
                        type="text"
                        value={bankName}
                        onChange={(e) =>
                            setBankName(
                                e.target.value
                            )
                        }
                        placeholder="Contoh: BCA, Mandiri, BRI"
                        className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                </div>

                {/* BANK ACCOUNT NAME */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Nama Pemilik Rekening{" "}
                        <span className="text-red-500">
                            *
                        </span>
                    </label>
                    <input
                        type="text"
                        value={bankAccountName}
                        onChange={(e) =>
                            setBankAccountName(
                                e.target.value
                            )
                        }
                        placeholder="Sesuai nama di rekening"
                        className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                </div>

                {/* BANK ACCOUNT NUMBER */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Nomor Rekening{" "}
                        <span className="text-red-500">
                            *
                        </span>
                    </label>
                    <input
                        type="text"
                        value={bankAccountNumber}
                        onChange={(e) =>
                            setBankAccountNumber(
                                e.target.value.replace(
                                    /[^\d\s]/g,
                                    ""
                                )
                            )
                        }
                        placeholder="8-20 digit angka"
                        className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                    <p className="mt-1 text-[11px] text-gray-400">
                        Nomor rekening hanya
                        digunakan untuk keperluan
                        internal.
                    </p>
                </div>

                {/* SOCIAL MEDIA PROOF */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Foto Bukti Akun Sosial
                        Media{" "}
                        <span className="text-red-500">
                            *
                        </span>
                    </label>
                    <p className="mt-0.5 text-xs text-gray-400">
                        Screenshot profil atau
                        dashboard akun sosial media
                        Anda.
                    </p>

                    <div className="mt-2">
                        <input
                            ref={socialInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={
                                handleSocialChange
                            }
                            className="hidden"
                        />

                        {socialBlobUrl ? (
                            <div className="relative">
                                <img
                                    src={
                                        socialBlobUrl
                                    }
                                    alt="Sosial Media"
                                    className="h-40 w-full rounded-xl border border-gray-200 object-cover"
                                />
                                {socialUploading && (
                                    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/80">
                                        <p className="text-sm text-gray-500">
                                            Mengupload...
                                        </p>
                                    </div>
                                )}
                                {socialError &&
                                    !socialUploading && (
                                        <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 rounded-b-xl bg-red-50 px-3 py-1.5">
                                            <FiAlertCircle
                                                size={
                                                    12
                                                }
                                                className="text-red-500"
                                            />
                                            <span className="text-[11px] text-red-600">
                                                {
                                                    socialError
                                                }
                                            </span>
                                        </div>
                                    )}
                                <button
                                    type="button"
                                    onClick={
                                        removeSocial
                                    }
                                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-gray-500 shadow-sm transition hover:bg-white hover:text-red-500"
                                >
                                    <FiX
                                        size={14}
                                    />
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() =>
                                    socialInputRef.current?.click()
                                }
                                className="flex h-32 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 transition hover:border-gray-300 hover:bg-gray-50"
                            >
                                <FiUpload
                                    size={24}
                                    className="text-gray-300"
                                />
                                <p className="mt-2 text-xs text-gray-400">
                                    Klik untuk upload
                                    foto
                                </p>
                                <p className="mt-0.5 text-[11px] text-gray-300">
                                    JPG, PNG, WEBP
                                    (maks 5MB)
                                </p>
                            </button>
                        )}
                    </div>
                </div>

                {/* SOCIAL MEDIA PLATFORM */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Platform Sosial Media
                        (opsional)
                    </label>
                    <input
                        type="text"
                        value={socialMediaPlatform}
                        onChange={(e) =>
                            setSocialMediaPlatform(
                                e.target.value
                            )
                        }
                        placeholder="Instagram, TikTok, YouTube, dll"
                        className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                </div>

                {/* SOCIAL MEDIA USERNAME */}
                <div>
                    <label className="text-sm font-medium text-gray-700">
                        Username Sosial Media
                        (opsional)
                    </label>
                    <input
                        type="text"
                        value={socialMediaUsername}
                        onChange={(e) =>
                            setSocialMediaUsername(
                                e.target.value
                            )
                        }
                        placeholder="@username"
                        className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                </div>

                {/* SUBMIT */}
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={
                        submitting ||
                        ktpUploading ||
                        socialUploading
                    }
                    className="h-12 w-full rounded-xl bg-gray-900 px-4 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {submitting
                        ? "Mengirim..."
                        : "Ajukan Affiliator"}
                </button>

                <p className="text-center text-[11px] leading-5 text-gray-400">
                    Pengajuan akan direview oleh
                    admin. Proses biasanya memakan
                    waktu 1-3 hari kerja.
                </p>
            </div>
        </main>
    );
}
