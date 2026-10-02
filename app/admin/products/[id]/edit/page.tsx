"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
    FiArrowLeft,
    FiPlus,
    FiTrash2,
    FiSave,
} from "react-icons/fi";
import {
    parseComparePrice,
    resolvePriceDisplay,
} from "@/lib/price-display";

type Variant = {
    id?: number;
    name: string;
    price: string;
    comparePrice: string;
    stock: string;
    weight: string;
    image: string;
};

type Product = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    category: string | null;
    image: string | null;
    bestseller: boolean;
    variants: Variant[];
};

export default function EditProductPage() {
    const params = useParams();
    const router = useRouter();

    const id = params.id as string;

    const [loading, setLoading] =
        useState(true);

    const [saving, setSaving] =
        useState(false);

    const [error, setError] =
        useState("");

    const [form, setForm] = useState({
        name: "",
        slug: "",
        description: "",
        category: "",
        image: "",
        bestseller: false,
    });

    const [variants, setVariants] =
        useState<Variant[]>([]);

    useEffect(() => {
        loadProduct();
    }, [id]);

    async function loadProduct() {
        try {
            setLoading(true);
            setError("");

            const response = await fetch(
                `/api/admin/products/${id}`,
                {
                    cache: "no-store",
                }
            );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal mengambil produk."
                );
            }

            const product: Product =
                data.product;

            setForm({
                name: product.name || "",
                slug: product.slug || "",
                description:
                    product.description || "",
                category:
                    product.category || "",
                image: product.image || "",
                bestseller:
                    Boolean(
                        product.bestseller
                    ),
            });

            setVariants(
                product.variants.map(
                    (variant) => ({
                        id: variant.id,
                        name:
                            variant.name || "",
                        price: String(
                            variant.price
                        ),
                        comparePrice:
                            variant.comparePrice !=
                            null
                                ? String(
                                      variant.comparePrice
                                  )
                                : "",
                        stock: String(
                            variant.stock
                        ),
                        weight: String(
                            variant.weight
                        ),
                        image:
                            variant.image || "",
                    })
                )
            );
        } catch (error) {
            console.error(
                "LOAD PRODUCT ERROR:",
                error
            );

            setError(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil produk."
            );
        } finally {
            setLoading(false);
        }
    }

    function updateVariant(
        index: number,
        field: keyof Variant,
        value: string
    ) {
        setVariants((current) =>
            current.map(
                (variant, variantIndex) =>
                    variantIndex === index
                        ? {
                              ...variant,
                              [field]: value,
                          }
                        : variant
            )
        );
    }

    function addVariant() {
        setVariants((current) => [
            ...current,
            {
                name: "",
                price: "",
                comparePrice: "",
                stock: "",
                weight: "",
                image: "",
            },
        ]);
    }

    function removeVariant(index: number) {
        if (variants.length <= 1) {
            toast.error("Produk minimal harus memiliki satu variant.");

            return;
        }

        setVariants((current) =>
            current.filter(
                (_, i) => i !== index
            )
        );
    }

    async function handleSubmit(
        event: React.FormEvent
    ) {
        event.preventDefault();

        /*
         * Harga Coret (comparePrice) is DISPLAY-ONLY. Validate
         * (server re-validates) so it can never be persisted wrong.
         */
        const invalidCompare = variants.some((variant) => {
            const raw = variant.comparePrice.trim();
            if (!raw) return false;
            return !parseComparePrice(raw, Number(variant.price)).ok;
        });

        if (invalidCompare) {
            toast.error(
                "Harga coret harus angka bulat dan tidak boleh lebih kecil dari harga normal."
            );
            return;
        }

        try {
            setSaving(true);
            setError("");

            const payload = {
                ...form,

                variants: variants.map(
                    (variant) => ({
                        id: variant.id,
                        name: variant.name,
                        price: Number(
                            variant.price
                        ),
                        comparePrice:
                            variant.comparePrice.trim() ===
                            ""
                                ? null
                                : Number(
                                      variant.comparePrice
                                  ),
                        stock: Number(
                            variant.stock
                        ),
                        weight: Number(
                            variant.weight
                        ),
                        image:
                            variant.image ||
                            null,
                    })
                ),
            };

            const response = await fetch(
                `/api/admin/products/${id}`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify(
                        payload
                    ),
                }
            );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal memperbarui produk."
                );
            }

            toast.success(data.message || "Produk berhasil diperbarui.");

            router.push(
                "/admin/products"
            );

            router.refresh();
        } catch (error) {
            console.error(
                "UPDATE PRODUCT ERROR:",
                error
            );

            setError(
                error instanceof Error
                    ? error.message
                    : "Gagal memperbarui produk."
            );
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <main className="min-h-screen bg-[#f7f7f8] px-4 py-8 sm:px-6">
                <div className="mx-auto max-w-4xl">
                    <div className="h-5 w-20 animate-pulse rounded bg-gray-200" />

                    <div className="mt-5 h-7 w-40 animate-pulse rounded bg-gray-200" />

                    <div className="mt-2 h-4 w-64 animate-pulse rounded bg-gray-100" />

                    <div className="mt-7 space-y-4">
                        <div className="h-72 animate-pulse rounded-xl border border-gray-200 bg-white" />

                        <div className="h-64 animate-pulse rounded-xl border border-gray-200 bg-white" />
                    </div>
                </div>
            </main>
        );
    }

    if (error && !form.name) {
        return (
            <main className="min-h-screen bg-[#f7f7f8] px-4 py-8 sm:px-6">
                <div className="mx-auto max-w-4xl">
                    <div className="border-l-4 border-red-500 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </div>

                    <Link
                        href="/admin/products"
                        className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900"
                    >
                        <FiArrowLeft
                            size={16}
                        />

                        Kembali ke Produk
                    </Link>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-[#f7f7f8] px-4 py-7 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-4xl">

                {/* HEADER */}

                <div className="mb-7">
                    <Link
                        href="/admin/products"
                        className="inline-flex items-center gap-2 text-sm text-gray-500 transition hover:text-gray-900"
                    >
                        <FiArrowLeft
                            size={16}
                        />

                        Produk
                    </Link>

                    <div className="mt-4">
                        <h1 className="text-[22px] font-semibold tracking-tight text-gray-900 sm:text-2xl">
                            Edit Produk
                        </h1>

                        <p className="mt-1 text-sm text-gray-500">
                            Perbarui informasi produk
                            dan variant yang tersedia.
                        </p>
                    </div>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="space-y-4"
                >
                    {/* ERROR */}

                    {error && (
                        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            <span className="mt-0.5 font-semibold">
                                !
                            </span>

                            <span>
                                {error}
                            </span>
                        </div>
                    )}

                    {/* PRODUCT INFO */}

                    <section className="border border-gray-200 bg-white">
                        <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
                            <h2 className="text-sm font-semibold text-gray-900">
                                Informasi Produk
                            </h2>

                            <p className="mt-1 text-xs text-gray-500">
                                Informasi utama yang
                                digunakan pada halaman
                                produk.
                            </p>
                        </div>

                        <div className="space-y-5 p-5 sm:p-6">

                            {/* NAME */}

                            <div>
                                <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                                    Nama Produk
                                </label>

                                <input
                                    value={
                                        form.name
                                    }
                                    onChange={(e) =>
                                        setForm(
                                            {
                                                ...form,
                                                name: e
                                                    .target
                                                    .value,
                                            }
                                        )
                                    }
                                    required
                                    className="h-10 w-full border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-900"
                                />
                            </div>

                            {/* SLUG + CATEGORY */}

                            <div className="grid gap-5 sm:grid-cols-2">
                                <div>
                                    <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                                        Slug
                                    </label>

                                    <input
                                        value={
                                            form.slug
                                        }
                                        onChange={(
                                            e
                                        ) =>
                                            setForm(
                                                {
                                                    ...form,
                                                    slug: e
                                                        .target
                                                        .value,
                                                }
                                            )
                                        }
                                        required
                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-gray-900"
                                    />

                                    <p className="mt-1.5 text-[11px] text-gray-400">
                                        Digunakan pada
                                        URL produk.
                                    </p>
                                </div>

                                <div>
                                    <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                                        Kategori
                                    </label>

                                    <input
                                        value={
                                            form.category
                                        }
                                        onChange={(
                                            e
                                        ) =>
                                            setForm(
                                                {
                                                    ...form,
                                                    category:
                                                        e
                                                            .target
                                                            .value,
                                                }
                                            )
                                        }
                                        required
                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-gray-900"
                                    />
                                </div>
                            </div>

                            {/* IMAGE */}

                            <div>
                                <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                                    URL / Path Image
                                </label>

                                <input
                                    value={
                                        form.image
                                    }
                                    onChange={(e) =>
                                        setForm(
                                            {
                                                ...form,
                                                image: e
                                                    .target
                                                    .value,
                                            }
                                        )
                                    }
                                    placeholder="/uploads/products/..."
                                    className="h-10 w-full border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-900"
                                />
                            </div>

                            {/* DESCRIPTION */}

                            <div>
                                <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                                    Deskripsi
                                </label>

                                <textarea
                                    value={
                                        form.description
                                    }
                                    onChange={(e) =>
                                        setForm(
                                            {
                                                ...form,
                                                description:
                                                    e
                                                        .target
                                                        .value,
                                            }
                                        )
                                    }
                                    rows={7}
                                    className="w-full resize-y border border-gray-300 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none transition focus:border-gray-900"
                                />
                            </div>

                            {/* BESTSELLER */}

                            <label className="flex cursor-pointer items-start gap-3 border border-gray-200 px-4 py-3.5 transition hover:bg-gray-50">
                                <input
                                    type="checkbox"
                                    checked={
                                        form.bestseller
                                    }
                                    onChange={(e) =>
                                        setForm(
                                            {
                                                ...form,
                                                bestseller:
                                                    e
                                                        .target
                                                        .checked,
                                            }
                                        )
                                    }
                                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-rose-600 focus:ring-rose-500"
                                />

                                <div>
                                    <p className="text-sm font-medium text-gray-800">
                                        Tandai sebagai
                                        Bestseller
                                    </p>

                                    <p className="mt-0.5 text-xs text-gray-500">
                                        Produk akan
                                        ditampilkan sebagai
                                        produk terlaris.
                                    </p>
                                </div>
                            </label>
                        </div>
                    </section>

                    {/* VARIANTS */}

                    <section className="border border-gray-200 bg-white">
                        <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Variant
                                </h2>

                                <p className="mt-1 text-xs text-gray-500">
                                    Berat digunakan untuk
                                    perhitungan pengiriman.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={
                                    addVariant
                                }
                                className="inline-flex h-9 items-center justify-center gap-2 self-start border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 sm:self-auto"
                            >
                                <FiPlus
                                    size={15}
                                />

                                Tambah Variant
                            </button>
                        </div>

                        <div className="p-5 sm:p-6">
                            <div className="space-y-3">
                                {variants.map(
                                    (
                                        variant,
                                        index
                                    ) => (
                                        <div
                                            key={
                                                variant.id ??
                                                `new-${index}`
                                            }
                                            className="border border-gray-200"
                                        >
                                            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50/60 px-4 py-3">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-semibold text-gray-900">
                                                        Variant{" "}
                                                        {index +
                                                            1}
                                                    </span>

                                                    {variant.id && (
                                                        <span className="text-[10px] text-gray-400">
                                                            ID #
                                                            {
                                                                variant.id
                                                            }
                                                        </span>
                                                    )}
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        removeVariant(
                                                            index
                                                        )
                                                    }
                                                    className="inline-flex h-7 w-7 items-center justify-center text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                                                    title="Hapus variant"
                                                >
                                                    <FiTrash2
                                                        size={
                                                            15
                                                        }
                                                    />
                                                </button>
                                            </div>

                                            <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5">
                                                {/* NAME */}

                                                <div>
                                                    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                        Nama
                                                    </label>

                                                    <input
                                                        value={
                                                            variant.name
                                                        }
                                                        onChange={(
                                                            e
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "name",
                                                                e
                                                                    .target
                                                                    .value
                                                            )
                                                        }
                                                        required
                                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-gray-900"
                                                    />
                                                </div>

                                                {/* PRICE */}

                                                <div>
                                                    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                        Harga Normal
                                                        <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-gray-400">
                                                            (dasar transaksi)
                                                        </span>
                                                    </label>

                                                    <input
                                                        type="number"
                                                        min="1"
                                                        max="9999999999"
                                                        value={
                                                            variant.price
                                                        }
                                                        onChange={(
                                                            e
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "price",
                                                                e
                                                                    .target
                                                                    .value
                                                            )
                                                        }
                                                        required
                                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-gray-900"
                                                    />
                                                </div>

                                                {/* HARGA CORET (comparePrice, display-only) */}

                                                <div>
                                                    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                        Harga Coret
                                                    </label>

                                                    <input
                                                        type="number"
                                                        min="0"
                                                        value={
                                                            variant.comparePrice
                                                        }
                                                        onChange={(
                                                            e
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "comparePrice",
                                                                e
                                                                    .target
                                                                    .value
                                                            )
                                                        }
                                                        placeholder="Kosongkan bila tidak ada"
                                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-gray-900"
                                                    />

                                                    {(() => {
                                                        const display =
                                                            resolvePriceDisplay(
                                                                {
                                                                    effectivePrice:
                                                                        Number(
                                                                            variant.price
                                                                        ) ||
                                                                        0,
                                                                    originalPrice:
                                                                        Number(
                                                                            variant.price
                                                                        ) ||
                                                                        0,
                                                                    comparePrice:
                                                                        variant.comparePrice.trim() ===
                                                                        ""
                                                                            ? null
                                                                            : Number(
                                                                                  variant.comparePrice
                                                                              ),
                                                                }
                                                            );

                                                        return (
                                                            <p className="mt-1 text-[11px] text-gray-500">
                                                                Preview:{" "}
                                                                <span className="font-semibold text-gray-900">
                                                                    Rp{" "}
                                                                    {display.price.toLocaleString(
                                                                        "id-ID"
                                                                    )}
                                                                </span>
                                                                {display.strikethrough !=
                                                                    null && (
                                                                    <span className="ml-1 text-gray-400 line-through">
                                                                        Rp{" "}
                                                                        {display.strikethrough.toLocaleString(
                                                                            "id-ID"
                                                                        )}
                                                                    </span>
                                                                )}
                                                            </p>
                                                        );
                                                    })()}
                                                </div>

                                                {/* STOCK */}

                                                <div>
                                                    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                        Stok
                                                    </label>

                                                    <input
                                                        type="number"
                                                        min="0"
                                                        value={
                                                            variant.stock
                                                        }
                                                        onChange={(
                                                            e
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "stock",
                                                                e
                                                                    .target
                                                                    .value
                                                            )
                                                        }
                                                        required
                                                        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-gray-900"
                                                    />
                                                </div>

                                                {/* WEIGHT */}

                                                <div>
                                                    <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                        Berat
                                                    </label>

                                                    <div className="relative">
                                                        <input
                                                            type="number"
                                                            min="1"
                                                            value={
                                                                variant.weight
                                                            }
                                                            onChange={(
                                                                e
                                                            ) =>
                                                                updateVariant(
                                                                    index,
                                                                    "weight",
                                                                    e
                                                                        .target
                                                                        .value
                                                                )
                                                            }
                                                            required
                                                            className="h-10 w-full border border-gray-300 bg-white px-3 pr-14 text-sm outline-none transition focus:border-gray-900"
                                                        />

                                                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-gray-400">
                                                            gram
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                )}
                            </div>
                        </div>
                    </section>

                    {/* ACTION */}

                    <div className="flex flex-col-reverse gap-2 border-t border-gray-200 pt-5 sm:flex-row sm:justify-end">
                        <Link
                            href="/admin/products"
                            className="flex h-10 items-center justify-center border border-gray-300 bg-white px-5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                        >
                            Batal
                        </Link>

                        <button
                            type="submit"
                            disabled={saving}
                            className="flex h-10 items-center justify-center gap-2 bg-gray-900 px-5 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <FiSave
                                size={16}
                            />

                            {saving
                                ? "Menyimpan..."
                                : "Simpan Perubahan"}
                        </button>
                    </div>
                </form>
            </div>
        </main>
    );
}