"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";

import {
    FiArrowLeft,
    FiPlus,
    FiTrash2,
} from "react-icons/fi";

import ProductImageUpload from "@/components/admin/ProductImageUpload";
import {
    parseComparePrice,
    resolvePriceDisplay,
} from "@/lib/price-display";

type Variant = {
    name: string;
    price: string;
    comparePrice: string;
    stock: string;
    weight: string;
};

function createSlug(value: string) {
    return value
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
}

export default function NewProductPage() {
    const router = useRouter();

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [description, setDescription] =
        useState("");
    const [category, setCategory] =
        useState("");

    const [image, setImage] = useState("");

    const [bestseller, setBestseller] =
        useState(false);

    const [variants, setVariants] =
        useState<Variant[]>([
            {
                name: "",
                price: "",
                comparePrice: "",
                stock: "",
                weight: "",
            },
        ]);

    const [loading, setLoading] =
        useState(false);

    function handleNameChange(
        value: string
    ) {
        setName(value);
        setSlug(createSlug(value));
    }

    function updateVariant(
        index: number,
        field: keyof Variant,
        value: string
    ) {
        setVariants((current) =>
            current.map((variant, variantIndex) =>
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
            },
        ]);
    }

    function removeVariant(index: number) {
        if (variants.length === 1) {
            return;
        }

        setVariants((current) =>
            current.filter(
                (_, variantIndex) =>
                    variantIndex !== index
            )
        );
    }

    async function handleSubmit(
        event: React.FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        if (!name.trim()) {
            toast.error(
                "Nama produk wajib diisi."
            );
            return;
        }

        if (!slug.trim()) {
            toast.error(
                "Slug produk wajib diisi."
            );
            return;
        }

        if (!category.trim()) {
            toast.error(
                "Kategori wajib diisi."
            );
            return;
        }

        if (variants.length === 0) {
            toast.error(
                "Produk minimal memiliki satu variant."
            );
            return;
        }

        const invalidVariant =
            variants.some(
                (variant) =>
                    !variant.name.trim() ||
                    !variant.price ||
                    !variant.stock ||
                    !variant.weight
            );

        if (invalidVariant) {
            toast.error(
                "Lengkapi nama, harga, stok, dan berat semua variant."
            );
            return;
        }

        /*
         * Harga Normal (comparePrice) is DISPLAY-ONLY. Validate
         * (server re-validates) so it can never be persisted wrong.
         */
        const invalidCompare = variants.some((variant) => {
            const raw = variant.comparePrice.trim();
            if (!raw) return false;
            return !parseComparePrice(raw, Number(variant.price)).ok;
        });

        if (invalidCompare) {
            toast.error(
                "Harga normal harus angka bulat dan tidak boleh lebih kecil dari harga jual."
            );
            return;
        }

        try {
            setLoading(true);

            const response = await fetch(
                "/api/admin/products",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        name: name.trim(),
                        slug: slug.trim(),
                        description:
                            description.trim() ||
                            null,
                        category:
                            category.trim(),
                        image:
                            image.trim() ||
                            null,
                        bestseller,
                        variants:
                            variants.map(
                                (variant) => ({
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
                                })
                            ),
                    }),
                }
            );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal membuat produk."
                );
            }

            toast.success(
                "Produk berhasil dibuat."
            );

            router.push(
                "/admin/products"
            );

            router.refresh();
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal membuat produk."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-5xl">

                {/* HEADER */}

                <div className="mb-7">
                    <Link
                        href="/admin/products"
                        className="mb-4 inline-flex items-center gap-2 text-sm text-gray-500 transition hover:text-gray-900"
                    >
                        <FiArrowLeft size={15} />
                        Kembali ke Produk
                    </Link>

                    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                                Tambah Produk
                            </h1>

                            <p className="mt-1 text-sm text-gray-500">
                                Isi informasi produk dan
                                variant yang akan dijual.
                            </p>
                        </div>
                    </div>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="space-y-5"
                >

                    {/* INFORMASI PRODUK */}

                    <section className="border-y border-gray-200 bg-white sm:rounded-xl sm:border">
                        <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
                            <h2 className="text-sm font-semibold text-gray-900">
                                Informasi Produk
                            </h2>

                            <p className="mt-1 text-xs text-gray-500">
                                Informasi dasar yang akan
                                digunakan pada halaman produk.
                            </p>
                        </div>

                        <div className="space-y-5 px-5 py-5 sm:px-6">

                            {/* NAME */}

                            <div>
                                <label
                                    htmlFor="name"
                                    className="mb-1.5 block text-sm font-medium text-gray-700"
                                >
                                    Nama Produk
                                </label>

                                <input
                                    id="name"
                                    value={name}
                                    onChange={(event) =>
                                        handleNameChange(
                                            event.target.value
                                        )
                                    }
                                    placeholder="Contoh: Keripik Singkong Bumbu Rujak"
                                    className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                />
                            </div>

                            {/* SLUG + CATEGORY */}

                            <div className="grid gap-5 md:grid-cols-2">

                                <div>
                                    <label
                                        htmlFor="slug"
                                        className="mb-1.5 block text-sm font-medium text-gray-700"
                                    >
                                        Slug
                                    </label>

                                    <input
                                        id="slug"
                                        value={slug}
                                        onChange={(event) =>
                                            setSlug(
                                                event.target.value
                                            )
                                        }
                                        placeholder="keripik-singkong-bumbu-rujak"
                                        className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                    />

                                    <p className="mt-1.5 text-xs text-gray-400">
                                        Digunakan sebagai URL produk.
                                    </p>
                                </div>

                                <div>
                                    <label
                                        htmlFor="category"
                                        className="mb-1.5 block text-sm font-medium text-gray-700"
                                    >
                                        Kategori
                                    </label>

                                    <input
                                        id="category"
                                        value={category}
                                        onChange={(event) =>
                                            setCategory(
                                                event.target.value
                                            )
                                        }
                                        placeholder="Contoh: Keripik"
                                        className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                    />
                                </div>

                            </div>

                            {/* DESCRIPTION */}

                            <div>
                                <label
                                    htmlFor="description"
                                    className="mb-1.5 block text-sm font-medium text-gray-700"
                                >
                                    Deskripsi Produk
                                </label>

                                <textarea
                                    id="description"
                                    value={description}
                                    onChange={(event) =>
                                        setDescription(
                                            event.target.value
                                        )
                                    }
                                    rows={5}
                                    placeholder="Jelaskan detail produk, bahan, ukuran, rasa, dan informasi lainnya..."
                                    className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3.5 py-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                />
                            </div>

                            {/* BESTSELLER */}

                            <label className="flex cursor-pointer items-start gap-3 border-t border-gray-100 pt-5">
                                <input
                                    type="checkbox"
                                    checked={bestseller}
                                    onChange={(event) =>
                                        setBestseller(
                                            event.target.checked
                                        )
                                    }
                                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-rose-600 focus:ring-rose-500"
                                />

                                <div>
                                    <p className="text-sm font-medium text-gray-800">
                                        Tandai sebagai Best Seller
                                    </p>

                                    <p className="mt-0.5 text-xs text-gray-500">
                                        Produk akan ditampilkan
                                        sebagai produk terlaris.
                                    </p>
                                </div>
                            </label>

                        </div>
                    </section>

                    {/* GAMBAR */}

                    <section className="border-y border-gray-200 bg-white sm:rounded-xl sm:border">
                        <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
                            <h2 className="text-sm font-semibold text-gray-900">
                                Gambar Produk
                            </h2>

                            <p className="mt-1 text-xs text-gray-500">
                                Gunakan gambar utama produk.
                            </p>
                        </div>

                        <div className="px-5 py-5 sm:px-6">
                            <ProductImageUpload
                                value={image}
                                onChange={setImage}
                            />
                        </div>
                    </section>

                    {/* VARIANTS */}

                    <section className="border-y border-gray-200 bg-white sm:rounded-xl sm:border">
                        <div className="flex flex-col gap-4 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Variant Produk
                                </h2>

                                <p className="mt-1 text-xs text-gray-500">
                                    Atur harga, stok, dan berat
                                    untuk setiap variant.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={addVariant}
                                className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-lg bg-gray-900 px-3.5 text-xs font-medium text-white transition hover:bg-gray-800"
                            >
                                <FiPlus size={15} />
                                Tambah Variant
                            </button>
                        </div>

                        <div className="divide-y divide-gray-100">
                            {variants.map(
                                (variant, index) => (
                                    <div
                                        key={index}
                                        className="px-5 py-5 sm:px-6"
                                    >
                                        <div className="mb-4 flex items-center justify-between">
                                            <p className="text-sm font-medium text-gray-800">
                                                Variant{" "}
                                                {index + 1}
                                            </p>

                                            {variants.length >
                                                1 && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        removeVariant(
                                                            index
                                                        )
                                                    }
                                                    className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-red-500"
                                                >
                                                    <FiTrash2
                                                        size={
                                                            14
                                                        }
                                                    />
                                                    Hapus
                                                </button>
                                            )}
                                        </div>

                                        <div className="grid gap-4 md:grid-cols-4">

                                            {/* VARIANT NAME */}

                                            <div>
                                                <label className="mb-1.5 block text-xs font-medium text-gray-600">
                                                    Nama Variant
                                                </label>

                                                <input
                                                    value={
                                                        variant.name
                                                    }
                                                    onChange={(
                                                        event
                                                    ) =>
                                                        updateVariant(
                                                            index,
                                                            "name",
                                                            event.target.value
                                                        )
                                                    }
                                                    placeholder="Contoh: 1 Kg"
                                                    className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                                />
                                            </div>

                                            {/* PRICE */}

                                            <div>
                                                <label className="mb-1.5 block text-xs font-medium text-gray-600">
                                                    Harga Jual
                                                </label>

                                                <div className="relative">
                                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                                                        Rp
                                                    </span>

                                                    <input
                                                        type="number"
                                                        min="0"
                                                        value={
                                                            variant.price
                                                        }
                                                        onChange={(
                                                            event
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "price",
                                                                event.target.value
                                                            )
                                                        }
                                                        placeholder="28900"
                                                        className="h-10 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                                    />
                                                </div>
                                            </div>

                                            {/* HARGA NORMAL (comparePrice, display-only) */}

                                            <div>
                                                <label className="mb-1.5 block text-xs font-medium text-gray-600">
                                                    Harga Normal
                                                    <span className="ml-1 text-[10px] font-normal text-gray-400">
                                                        (opsional, harga coret)
                                                    </span>
                                                </label>

                                                <div className="relative">
                                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                                                        Rp
                                                    </span>

                                                    <input
                                                        type="number"
                                                        min="0"
                                                        value={
                                                            variant.comparePrice
                                                        }
                                                        onChange={(
                                                            event
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "comparePrice",
                                                                event.target.value
                                                            )
                                                        }
                                                        placeholder="65000"
                                                        className="h-10 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                                    />
                                                </div>

                                                {(() => {
                                                    const display =
                                                        resolvePriceDisplay({
                                                            effectivePrice:
                                                                Number(
                                                                    variant.price
                                                                ) || 0,
                                                            originalPrice:
                                                                Number(
                                                                    variant.price
                                                                ) || 0,
                                                            comparePrice:
                                                                variant.comparePrice.trim() ===
                                                                ""
                                                                    ? null
                                                                    : Number(
                                                                          variant.comparePrice
                                                                      ),
                                                        });

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
                                                <label className="mb-1.5 block text-xs font-medium text-gray-600">
                                                    Stok
                                                </label>

                                                <input
                                                    type="number"
                                                    min="0"
                                                    value={
                                                        variant.stock
                                                    }
                                                    onChange={(
                                                        event
                                                    ) =>
                                                        updateVariant(
                                                            index,
                                                            "stock",
                                                            event.target.value
                                                        )
                                                    }
                                                    placeholder="100"
                                                    className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                                />
                                            </div>

                                            {/* WEIGHT */}

                                            <div>
                                                <label className="mb-1.5 block text-xs font-medium text-gray-600">
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
                                                            event
                                                        ) =>
                                                            updateVariant(
                                                                index,
                                                                "weight",
                                                                event.target.value
                                                            )
                                                        }
                                                        placeholder="1000"
                                                        className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 pr-14 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                                                    />

                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                                                        gram
                                                    </span>
                                                </div>

                                                <p className="mt-1 text-[11px] text-gray-400">
                                                    1 Kg = 1000 gram
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    </section>

                    {/* ACTION */}

                    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                        <Link
                            href="/admin/products"
                            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                        >
                            Batal
                        </Link>

                        <button
                            type="submit"
                            disabled={loading}
                            className="inline-flex h-10 items-center justify-center rounded-lg bg-rose-600 px-6 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {loading
                                ? "Menyimpan..."
                                : "Simpan Produk"}
                        </button>
                    </div>

                </form>
            </div>
        </main>
    );
}