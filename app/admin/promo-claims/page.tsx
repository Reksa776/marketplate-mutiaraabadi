"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { FiGift, FiExternalLink, FiPlus, FiRefreshCw } from "react-icons/fi";

type Product = {
    id: number;
    name: string;
    slug: string;
    variants: { id: number; name: string; price: number | string }[];
};
type Promo = {
    id: number;
    slug: string;
    title: string;
    description: string | null;
    productId: number | null;
    productName: string | null;
    productSlug: string | null;
    variantId: number | null;
    variantName: string | null;
    regularPrice: number | null;
    promoPrice: number | null;
    dailyQuota: number;
    claimedToday: number;
    startAt: string;
    endAt: string;
    isActive: boolean;
};

type FormState = {
    slug: string;
    title: string;
    description: string;
    productId: string;
    variantId: string;
    promoPrice: string;
    dailyQuota: string;
    startAt: string;
    endAt: string;
    isActive: boolean;
};

const emptyForm: FormState = {
    slug: "",
    title: "",
    description: "",
    productId: "",
    variantId: "",
    promoPrice: "",
    dailyQuota: "20",
    startAt: "",
    endAt: "",
    isActive: true,
};

function localDateTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function dateTimeWibToIso(value: string) {
    return new Date(`${value}:00+07:00`).toISOString();
}

function readableDate(value: string) {
    return new Date(value).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Jakarta",
    });
}

export default function PromoClaimsAdminPage() {
    const [items, setItems] = useState<Promo[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    async function loadData() {
        setLoading(true);
        setError("");
        try {
            const [promoResponse, productResponse] = await Promise.all([
                fetch("/api/admin/promo-claims", { cache: "no-store" }),
                fetch("/api/admin/products?limit=100&archived=false", { cache: "no-store" }),
            ]);
            const [promoResult, productResult] = await Promise.all([
                promoResponse.json(),
                productResponse.json(),
            ]);
            if (!promoResponse.ok || !promoResult.success) {
                throw new Error(promoResult.message || "Gagal memuat promo.");
            }
            if (!productResponse.ok || !productResult.success) {
                throw new Error(productResult.message || "Gagal memuat produk.");
            }
            setItems(promoResult.data ?? []);
            setProducts(productResult.data?.items ?? []);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Gagal memuat data.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        void loadData();
    }, []);

    function editPromo(item: Promo) {
        setEditingId(item.id);
        setForm({
            slug: item.slug,
            title: item.title,
            description: item.description ?? "",
            productId: item.productId === null ? "" : String(item.productId),
            variantId: item.variantId === null ? "" : String(item.variantId),
            promoPrice: item.promoPrice === null ? "" : String(item.promoPrice),
            dailyQuota: String(item.dailyQuota),
            startAt: localDateTime(item.startAt),
            endAt: localDateTime(item.endAt),
            isActive: item.isActive,
        });
        setSuccess("");
        setError("");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function resetForm() {
        setEditingId(null);
        setForm(emptyForm);
        setError("");
        setSuccess("");
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSaving(true);
        setError("");
        setSuccess("");
        try {
            const payload = {
                ...form,
                productId: Number(form.productId),
                variantId: Number(form.variantId),
                promoPrice: Number(form.promoPrice),
                dailyQuota: Number(form.dailyQuota),
                startAt: dateTimeWibToIso(form.startAt),
                endAt: dateTimeWibToIso(form.endAt),
            };
            const response = await fetch(
                editingId
                    ? `/api/admin/promo-claims/${editingId}`
                    : "/api/admin/promo-claims",
                {
                    method: editingId ? "PATCH" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }
            );
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Gagal menyimpan promo.");
            }
            setSuccess(editingId ? "Promo berhasil diperbarui." : "Promo berhasil dibuat.");
            setEditingId(null);
            setForm(emptyForm);
            await loadData();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Gagal menyimpan promo.");
        } finally {
            setSaving(false);
        }
    }

    async function removePromo(item: Promo) {
        if (!window.confirm(`Hapus promo ${item.title}? Klaim dan kuota hariannya juga ikut dihapus.`)) return;
        const response = await fetch(`/api/admin/promo-claims/${item.id}`, { method: "DELETE" });
        const result = await response.json();
        if (!response.ok || !result.success) {
            setError(result.message || "Gagal menghapus promo.");
            return;
        }
        await loadData();
    }

    return (
        <div className="min-h-full bg-gray-50/70 p-4 md:p-7">
            <div className="mx-auto max-w-6xl space-y-6">
                <header>
                    <div className="mb-2 text-xs text-gray-400">Admin / Marketing / Promo Klaim Harian</div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-950">
                        <FiGift /> Promo Klaim Harian
                    </h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Atur harga promo produk dan batas klaim per hari. Setelah klaim, harga promo otomatis berlaku di checkout pada browser yang sama. Kuota direset pukul 00.00 WIB.
                    </p>
                </header>

                {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
                {success && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{success}</div>}

                <form onSubmit={save} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between">
                        <h2 className="font-semibold text-gray-900">{editingId ? "Edit promo" : "Buat promo klaim"}</h2>
                        {editingId && <button type="button" onClick={resetForm} className="text-sm text-gray-500 underline">Batal edit</button>}
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-sm font-medium text-gray-700">
                            Judul promo
                            <input required maxLength={191} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" placeholder="Promo spesial hari ini" />
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Bagian link (slug)
                            <div className="mt-1 flex h-10 items-center rounded-lg border border-gray-300 px-3 text-sm">
                                <span className="text-gray-400">/promo/</span>
                                <input required value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} className="min-w-0 flex-1 outline-none" placeholder="promo-hari-ini" />
                            </div>
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Produk promo
                            <select required value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value, variantId: "", promoPrice: "" })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3">
                                <option value="">Pilih satu produk</option>
                                {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                            </select>
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Varian sasaran
                            <select required value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3">
                                <option value="">Pilih varian</option>
                                {(products.find((item) => item.id === Number(form.productId))?.variants ?? []).map((variant) => <option key={variant.id} value={variant.id}>{variant.name} — Rp {Number(variant.price).toLocaleString("id-ID")}</option>)}
                            </select>
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Harga promo (Rp)
                            <input required type="number" min="1" step="1" value={form.promoPrice} onChange={(e) => setForm({ ...form, promoPrice: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" placeholder="Harga setelah diskon" />
                            <span className="mt-1 block text-xs font-normal text-gray-500">Harga normal varian akan dicoret otomatis; harga promo ini diterapkan di katalog dan checkout selama periode aktif.</span>
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Kuota klaim per hari
                            <input required type="number" min="1" max="1000000" value={form.dailyQuota} onChange={(e) => setForm({ ...form, dailyQuota: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" />
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Mulai (WIB)
                            <input required type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" />
                        </label>
                        <label className="text-sm font-medium text-gray-700">
                            Berakhir (WIB)
                            <input required type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" />
                        </label>
                    </div>
                    <label className="block text-sm font-medium text-gray-700">
                        Deskripsi untuk halaman promo
                        <textarea maxLength={5000} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="Isi deskripsi singkat promo (opsional)" />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                        Promo aktif
                    </label>
                    <button disabled={saving || products.length === 0} className="inline-flex h-10 items-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
                        {saving ? <FiRefreshCw className="animate-spin" /> : <FiPlus />}
                        {saving ? "Menyimpan..." : editingId ? "Simpan perubahan" : "Buat promo"}
                    </button>
                </form>

                <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="flex items-center justify-between border-b border-gray-100 p-5">
                        <div>
                            <h2 className="font-semibold text-gray-900">Daftar promo</h2>
                            <p className="mt-1 text-xs text-gray-500">Pemakaian kuota yang tampil adalah klaim hari ini (WIB).</p>
                        </div>
                        <button type="button" onClick={() => void loadData()} className="rounded-lg border p-2 text-gray-600" aria-label="Muat ulang"><FiRefreshCw /></button>
                    </div>
                    {loading ? <div className="p-8 text-center text-sm text-gray-500">Memuat promo...</div> : items.length === 0 ? <div className="p-8 text-center text-sm text-gray-500">Belum ada promo klaim.</div> : (
                        <div className="divide-y divide-gray-100">
                            {items.map((item) => (
                                <article key={item.id} className="grid gap-3 p-5 md:grid-cols-[1fr_auto] md:items-center">
                                    <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="font-semibold text-gray-900">{item.title}</h3>
                                            <span className={`rounded-full px-2 py-0.5 text-xs ${item.isActive ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{item.isActive ? "Aktif" : "Nonaktif"}</span>
                                        </div>
                                        <p className="mt-1 text-sm text-gray-600">Checkout promo hari ini <strong>{item.claimedToday}/{item.dailyQuota}</strong></p>
                                        <p className="mt-1 text-sm text-gray-600">Produk: <strong>{item.productName ? `${item.productName} / ${item.variantName ?? ""}` : "Belum disetel"}</strong>{item.promoPrice !== null && item.regularPrice !== null ? <> · Rp {item.promoPrice.toLocaleString("id-ID")} <span className="text-gray-400 line-through">Rp {item.regularPrice.toLocaleString("id-ID")}</span></> : null}</p>
                                        <p className="mt-1 text-xs text-gray-400">{readableDate(item.startAt)} — {readableDate(item.endAt)}</p>
                                        <Link href={`/promo/${item.slug}`} target="_blank" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700 underline">
                                            /promo/{item.slug} <FiExternalLink />
                                        </Link>
                                        {item.productSlug && (
                                            <Link href={`/products/${item.productSlug}?promo=${encodeURIComponent(item.slug)}&promoVariantId=${item.variantId ?? ""}`} target="_blank" className="ml-3 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 underline">
                                                Tujuan setelah klaim: /products/{item.productSlug} <FiExternalLink />
                                            </Link>
                                        )}
                                    </div>
                                    <div className="flex gap-2">
                                        <button type="button" onClick={() => editPromo(item)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium">Edit</button>
                                        <button type="button" onClick={() => void removePromo(item)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700">Hapus</button>
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
