"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiTag, FiClock, FiCheck, FiX } from "react-icons/fi";

type Reward = {
    id: number;
    name: string;
    type: string;
    value: number;
    maxDiscount: number | null;
};

type SpinRecord = {
    id: number;
    status: string;
    createdAt: string;
    expiresAt: string | null;
    usedAt: string | null;
    orderId: number | null;
    reward: Reward;
    campaign: { name: string };
};

function formatRupiah(value: number) {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

function formatDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function rewardTypeLabel(type: string) {
    switch (type) {
        case "PERCENTAGE":
            return "Persen";
        case "FIXED":
            return "Diskon";
        case "FREE_SHIPPING":
            return "Gratis Ongkir";
        case "CASHBACK":
            return "Cashback";
        case "ZONK":
            return "Coba Lagi";
        default:
            return type;
    }
}

function rewardValueLabel(reward: Reward) {
    switch (reward.type) {
        case "PERCENTAGE":
            return `Diskon ${reward.value}%${reward.maxDiscount ? ` (maks ${formatRupiah(reward.maxDiscount)})` : ""}`;
        case "FIXED":
            return `${formatRupiah(reward.value)} OFF`;
        case "FREE_SHIPPING":
            return "Gratis Ongkir";
        case "CASHBACK":
            return `Cashback ${formatRupiah(reward.value)}`;
        case "ZONK":
            return "Coba Lagi";
        default:
            return reward.name;
    }
}

function statusBadge(status: string) {
    switch (status) {
        case "AVAILABLE":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                    <FiCheck size={10} /> Tersedia
                </span>
            );
        case "USED":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-500">
                    <FiCheck size={10} /> Terpakai
                </span>
            );
        case "EXPIRED":
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600">
                    <FiClock size={10} /> Kedaluwarsa
                </span>
            );
        default:
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-500">
                    {status}
                </span>
            );
    }
}

export default function PromosPage() {
    const router = useRouter();
    const [rewards, setRewards] = useState<SpinRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string>("ALL");

    /*
     * NO LOGIN GATE.
     *
     * Guests earn spins by ordering, so this page loads for everyone:
     * /api/spin-wheel/my-rewards resolves the caller's scope from the
     * session or from the guest order tokens, and returns an empty list
     * when there is nothing to show yet.
     */
    useEffect(() => {
        loadRewards();
    }, []);

    async function loadRewards() {
        try {
            setLoading(true);
            const response = await fetch("/api/spin-wheel/my-rewards", {
                cache: "no-store",
            });
            const result = await response.json();
            if (result.success) {
                setRewards(result.data ?? []);
            }
        } catch {
            // Silently handle
        } finally {
            setLoading(false);
        }
    }

    const filtered = rewards.filter(
        (r) => filter === "ALL" || r.status === filter
    );

    const availableCount = rewards.filter(
        (r) => r.status === "AVAILABLE"
    ).length;

    if (loading) {
        return (
            <main className="mx-auto min-h-screen max-w-lg bg-white p-5">
                <div className="flex min-h-[400px] items-center justify-center">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-800" />
                </div>
            </main>
        );
    }

    return (
        <main className="mx-auto min-h-screen max-w-lg bg-white">
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
                <button
                    type="button"
                    onClick={() => router.back()}
                    className="flex h-9 w-9 items-center justify-center rounded-xl transition hover:bg-gray-100"
                >
                    <FiArrowLeft size={18} />
                </button>
                <div>
                    <h1 className="text-base font-semibold text-gray-900">
                        Promo Saya
                    </h1>
                    <p className="text-xs text-gray-400">
                        {availableCount} reward tersedia
                    </p>
                </div>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2 border-b border-gray-100 px-5 py-3">
                {[
                    { value: "ALL", label: "Semua" },
                    { value: "AVAILABLE", label: "Tersedia" },
                    { value: "USED", label: "Terpakai" },
                    { value: "EXPIRED", label: "Kedaluwarsa" },
                ].map((tab) => (
                    <button
                        key={tab.value}
                        type="button"
                        onClick={() => setFilter(tab.value)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                            filter === tab.value
                                ? "bg-rose-600 text-white"
                                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Rewards list */}
            <div className="px-5 py-4">
                {loading ? (
                    <div className="flex min-h-[200px] items-center justify-center">
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-800" />
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex min-h-[200px] flex-col items-center justify-center text-center">
                        <FiTag size={32} className="text-gray-300" />
                        <p className="mt-3 text-sm font-medium text-gray-500">
                            {filter === "ALL"
                                ? "Belum ada promo"
                                : filter === "AVAILABLE"
                                  ? "Tidak ada reward tersedia"
                                  : "Tidak ada reward"}
                        </p>
                        {filter === "ALL" && (
                            <Link
                                href="/"
                                className="mt-3 text-xs font-semibold text-rose-600 underline underline-offset-2"
                            >
                                Kembali ke beranda
                            </Link>
                        )}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filtered.map((spin) => (
                            <div
                                key={spin.id}
                                className={`rounded-xl border p-4 ${
                                    spin.status === "AVAILABLE"
                                        ? "border-rose-200 bg-rose-50/50"
                                        : "border-gray-200 bg-gray-50/50"
                                }`}
                            >
                                <div className="flex items-start justify-between">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg">
                                                {spin.reward.type === "ZONK"
                                                    ? "😢"
                                                    : spin.reward.type ===
                                                        "FREE_SHIPPING"
                                                      ? "🚚"
                                                      : spin.reward.type ===
                                                          "CASHBACK"
                                                        ? "💰"
                                                        : "🎉"}
                                            </span>
                                            <p
                                                className={`text-sm font-bold ${
                                                    spin.status === "AVAILABLE"
                                                        ? "text-rose-700"
                                                        : "text-gray-700"
                                                }`}
                                            >
                                                {rewardValueLabel(spin.reward)}
                                            </p>
                                        </div>
                                        <p className="mt-1 text-xs text-gray-500">
                                            {spin.campaign.name} ·{" "}
                                            {rewardTypeLabel(spin.reward.type)}
                                        </p>
                                        {spin.expiresAt && (
                                            <p className="mt-1 text-[11px] text-gray-400">
                                                Berlaku hingga{" "}
                                                {formatDate(spin.expiresAt)}
                                            </p>
                                        )}
                                    </div>
                                    {statusBadge(spin.status)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
