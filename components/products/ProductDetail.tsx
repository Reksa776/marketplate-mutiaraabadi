"use client";

import Link from "next/link";
import { trackTikTokEvent } from "@/lib/analytics/tiktok";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";
import { buildTikTokProductProperties } from "@/lib/analytics/tiktok-catalog";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
    FiChevronLeft,
    FiMinus,
    FiPlus,
    FiShoppingBag,
    FiStar,
} from "react-icons/fi";

type ProductVariant = {
    id: number;
    name: string;
    price: number;
    effectivePrice?: number;
    originalPrice?: number;
    discount?: number;
    hasDiscount?: boolean;
    priceSource?: string;
    flashSaleName?: string | null;
    flashSaleEndAt?: string | null;
    stock: number;
    image: string | null;
};

type Product = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    image: string | null;
    category: string | null;
    rating: number;
    sold: number;
    variants: ProductVariant[];
};

type Props = {
    product: Product;
};

export default function ProductDetail({
    product,
}: Props) {
    const router = useRouter();


    /*
    |--------------------------------------------------------------------------
    | STATE
    |--------------------------------------------------------------------------
    */

    const [selectedVariant, setSelectedVariant] =
        useState<ProductVariant | null>(
            product.variants.length > 0
                ? product.variants[0]
                : null
        );

    const [quantity, setQuantity] =
        useState(1);

    const [loading, setLoading] =
        useState(false);

    const [bulkTiers, setBulkTiers] =
        useState<Array<{
            id: number;
            name: string;
            minQuantity: number;
            type: string;
            value: number;
            maxDiscount: number | null;
        }>>([]);

    /*
|--------------------------------------------------------------------------
| LOAD BULK DISCOUNT TIERS
|--------------------------------------------------------------------------
*/

    useEffect(() => {
        if (!product.id) return;

        async function loadBulkTiers() {
            try {
                const params = new URLSearchParams({
                    productId: String(product.id),
                });
                if (selectedVariant) {
                    params.set("variantId", String(selectedVariant.id));
                }
                const res = await fetch(`/api/bulk-discounts?${params}`);
                const data = await res.json();
                if (data.success && Array.isArray(data.data)) {
                    setBulkTiers(data.data);
                }
            } catch {
                setBulkTiers([]);
            }
        }
        loadBulkTiers();
    }, [product.id, selectedVariant?.id]);

    /*
|--------------------------------------------------------------------------
| TIKTOK PIXEL - VIEW CONTENT
|--------------------------------------------------------------------------
*/

    const viewContentFiredRef = useRef(false);

    useEffect(() => {
        /*
         * Reset guard ketika product berubah.
         */
        viewContentFiredRef.current = false;

        const trackViewContent = () => {
            /*
             * Guard supaya tidak fire dua kali.
             * Terjadi kalau window.ttq sudah ada
             * DAN tiktok-pixel-ready juga ter-dispatch.
             */
            if (viewContentFiredRef.current) {
                return;
            }

            viewContentFiredRef.current = true;

            /*
             * Standard TikTok product parameters: catalog id
             * (content_id + contents[]), content_type, name and
             * the price actually charged for the selected variant.
             * No fake 0 price when no variant exists — the key is
             * simply omitted.
             */
            trackTikTokEvent(
                "ViewContent",
                buildTikTokProductProperties({
                    productId: product.id,
                    productName: product.name,
                    price:
                        selectedVariant?.effectivePrice ??
                        selectedVariant?.price,
                })
            );
        };

        /*
         * Pastikan event TIDAK hilang: base code Pixel dimuat
         * secara asinkron, jadi tunggu sampai window.ttq benar-benar
         * tersedia (event ready saja bisa terlewat karena layout
         * ter-mount lebih dulu). Guard di atas tetap memastikan
         * event hanya dikirim sekali per product.
         */
        return whenTikTokReadyForEvents(
            trackViewContent
        );

        // ViewContent hanya sekali
        // ketika product berubah.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [product.id]);

    /*
    |--------------------------------------------------------------------------
    | HARGA
    |--------------------------------------------------------------------------
    */

    const price =
        selectedVariant?.effectivePrice ??
        selectedVariant?.price ?? 0;

    const originalPrice =
        selectedVariant?.originalPrice ??
        selectedVariant?.price ?? 0;

    const hasDiscount =
        selectedVariant?.hasDiscount ?? false;

    const flashSaleName =
        selectedVariant?.flashSaleName ?? null;

    /*
    |--------------------------------------------------------------------------
    | STOCK
    |--------------------------------------------------------------------------
    */

    const stock =
        selectedVariant?.stock ?? 0;






    /*
    |--------------------------------------------------------------------------
    | FORMAT HARGA
    |--------------------------------------------------------------------------
    */

    function formatPrice(
        value: number
    ) {
        return value.toLocaleString(
            "id-ID"
        );
    }

    /*
    |--------------------------------------------------------------------------
    | PILIH VARIANT
    |--------------------------------------------------------------------------
    */

    function handleSelectVariant(
        variant: ProductVariant
    ) {
        setSelectedVariant(
            variant
        );

        /*
         * Reset quantity ketika
         * user mengganti varian.
         */
        setQuantity(1);
    }

    /*
    |--------------------------------------------------------------------------
    | TAMBAH QUANTITY
    |--------------------------------------------------------------------------
    */

    function handleIncreaseQuantity() {
        if (!selectedVariant) {
            return;
        }

        if (
            quantity >=
            selectedVariant.stock
        ) {
            return;
        }

        setQuantity(
            (current) =>
                current + 1
        );
    }

    /*
    |--------------------------------------------------------------------------
    | KURANGI QUANTITY
    |--------------------------------------------------------------------------
    */

    function handleDecreaseQuantity() {
        if (quantity <= 1) {
            return;
        }

        setQuantity(
            (current) =>
                current - 1
        );
    }

    /*
    |--------------------------------------------------------------------------
    | TAMBAH KE KERANJANG
    |--------------------------------------------------------------------------
    */

    async function handleAddToCart() {
        /*
         * Pastikan variant dipilih.
         */
        if (!selectedVariant) {
            toast.error(
                "Silakan pilih varian terlebih dahulu."
            );

            return;
        }

        /*
         * Pastikan stok tersedia.
         */
        if (stock <= 0) {
            toast.error(
                "Stok produk habis."
            );

            return;
        }

        /*
         * Pastikan quantity valid.
         */
        if (
            quantity <= 0 ||
            quantity > stock
        ) {
            toast.error(
                "Jumlah produk tidak valid."
            );

            return;
        }

        setLoading(true);

        try {
            const response =
                await fetch(
                    "/api/cart",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            variantId:
                                selectedVariant.id,

                            quantity,
                        }),
                    }
                );

            const data =
                await response.json();

            /*
             * Kalau user belum login.
             */
            if (
                response.status === 401
            ) {
                toast.error(
                    "Silakan login terlebih dahulu."
                );

                router.push(
                    `/login?callbackUrl=/products/${product.slug}`
                );

                return;
            }

            /*
             * Kalau API mengembalikan error.
             */
            if (!response.ok) {
                toast.error(
                    data.message ??
                    "Gagal menambahkan ke keranjang."
                );

                return;
            }
            /*
|--------------------------------------------------------------------------
| TIKTOK PIXEL - ADD TO CART
|--------------------------------------------------------------------------
*/

            whenTikTokReadyForEvents(() => {
                trackTikTokEvent(
                    "AddToCart",
                    buildTikTokProductProperties(
                        {
                            productId: product.id,
                            productName: product.name,
                            /* Effective (charged) unit price. */
                            price:
                                selectedVariant.effectivePrice ??
                                selectedVariant.price,
                            quantity,
                        },
                        /* Adds quantity + the matching line value. */
                        { withQuantity: true }
                    )
                );
            });

            /*
             * Berhasil.
             */
            toast.success(
                "Produk ditambahkan ke keranjang."
            );

        } catch (error) {
            console.error(
                "ADD TO CART ERROR:",
                error
            );

            toast.error(
                "Terjadi kesalahan saat menambahkan produk."
            );
        } finally {
            setLoading(false);
        }
    }
    const handleBuyNow = () => {
        if (!selectedVariant) return;

        if (quantity > selectedVariant.stock) {
            return;
        }

        router.push(
            `/buy-now?productId=${product.id}` +
            `&variantId=${selectedVariant.id}` +
            `&quantity=${quantity}`
        );
    };

    /*
    |--------------------------------------------------------------------------
    | RENDER
    |--------------------------------------------------------------------------
    */

    return (
        <main className="min-h-screen bg-gray-50 pb-28">

            {/* ========================================================= */}
            {/* TOP NAVIGATION */}
            {/* ========================================================= */}

            <div className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur">

                <div className="mx-auto flex h-14 max-w-7xl items-center px-4 sm:px-6 lg:px-8">

                    <Link
                        href="/products"
                        className="flex items-center gap-2 text-sm font-medium text-gray-700 transition hover:text-rose-600"
                    >
                        <FiChevronLeft
                            size={20}
                        />

                        Kembali
                    </Link>

                </div>

            </div>

            {/* ========================================================= */}
            {/* PRODUCT */}
            {/* ========================================================= */}

            <section className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">

                <div className="grid gap-5 lg:grid-cols-2 lg:gap-10">

                    {/* ================================================= */}
                    {/* PRODUCT IMAGE */}
                    {/* ================================================= */}

                    <div>

                        <div className="relative aspect-square overflow-hidden rounded-3xl bg-white">

                            {product.image ? (
                                <img
                                    src={product.image}
                                    alt={product.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="flex h-full items-center justify-center text-sm text-gray-400">
                                    Tidak ada gambar
                                </div>
                            )}

                        </div>

                    </div>

                    {/* ================================================= */}
                    {/* PRODUCT INFORMATION */}
                    {/* ================================================= */}

                    <div className="flex flex-col">

                        {/* CATEGORY */}

                        {product.category && (
                            <p className="text-sm font-medium text-rose-600">
                                {product.category}
                            </p>
                        )}

                        {/* NAME */}

                        <h1 className="mt-2 text-2xl font-bold leading-tight text-gray-900 sm:text-3xl">
                            {product.name}
                        </h1>

                        {/* RATING */}

                        <div className="mt-3 flex items-center gap-2">

                            <div className="flex items-center gap-1 text-amber-500">

                                <FiStar
                                    size={16}
                                    className="fill-current"
                                />

                                <span className="text-sm font-semibold">
                                    5
                                </span>

                            </div>

                            <span className="text-gray-300">
                                |
                            </span>

                            <span className="text-sm text-gray-500">
                                10rb+
                                terjual
                            </span>

                        </div>

                        {/* PRICE */}

                        <div className="mt-6">

                            {hasDiscount ? (
                                <>
                                    <p className="text-sm text-gray-400 line-through">
                                        Rp {formatPrice(originalPrice)}
                                    </p>
                                    <p className="text-3xl font-bold text-rose-600">
                                        Rp {formatPrice(price)}
                                    </p>
                                    {flashSaleName && (
                                        <p className="mt-1 text-xs font-medium text-rose-500">
                                            🔥 {flashSaleName}
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p className="text-3xl font-bold text-gray-900">
                                    Rp {formatPrice(price)}
                                </p>
                            )}

                            {selectedVariant && (
                                <p className="mt-1 text-sm text-gray-500">
                                    Varian:{" "}
                                    <span className="font-medium text-gray-700">
                                        {selectedVariant.name}
                                    </span>
                                </p>
                            )}

                        </div>

                        {/* ================================================= */}
                        {/* VARIANT */}
                        {/* ================================================= */}

                        {product.variants.length >
                            0 && (
                                <div className="mt-7">

                                    <div className="mb-3 flex items-center justify-between">

                                        <h2 className="text-sm font-semibold text-gray-900">
                                            Pilih Varian
                                        </h2>

                                        {selectedVariant && (
                                            <span className="text-xs text-gray-500">
                                                Stok:{" "}
                                                {
                                                    selectedVariant.stock
                                                }
                                            </span>
                                        )}

                                    </div>

                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">

                                        {product.variants.map(
                                            (
                                                variant
                                            ) => {

                                                const active =
                                                    selectedVariant?.id ===
                                                    variant.id;

                                                const outOfStock =
                                                    variant.stock <=
                                                    0;

                                                return (
                                                    <button
                                                        key={
                                                            variant.id
                                                        }
                                                        type="button"
                                                        disabled={
                                                            outOfStock
                                                        }
                                                        onClick={() =>
                                                            handleSelectVariant(
                                                                variant
                                                            )
                                                        }
                                                        className={`
                                                        rounded-xl
                                                        border
                                                        px-4
                                                        py-3
                                                        text-left
                                                        transition
                                                        ${active
                                                                ? "border-rose-600 bg-rose-50 text-rose-700"
                                                                : "border-gray-200 bg-white text-gray-700 hover:border-gray-400"
                                                            }
                                                        ${outOfStock
                                                                ? "cursor-not-allowed opacity-40"
                                                                : ""
                                                            }
                                                    `}
                                                    >

                                                        <p className="text-sm font-semibold">
                                                            {
                                                                variant.name
                                                            }
                                                        </p>

                                                        <p className="mt-1 text-xs text-gray-500">
                                                            Rp{" "}
                                                            {formatPrice(
                                                                variant.effectivePrice ?? variant.price
                                                            )}
                                                        </p>

                                                        {outOfStock && (
                                                            <p className="mt-1 text-xs font-medium text-red-500">
                                                                Habis
                                                            </p>
                                                        )}

                                                    </button>
                                                );
                                            }
                                        )}

                                    </div>

                                </div>
                            )}

                        {/* ================================================= */}
                        {/* QUANTITY */}
                        {/* ================================================= */}

                        <div className="mt-7">

                            <div className="mb-3 flex items-center justify-between">

                                <h2 className="text-sm font-semibold text-gray-900">
                                    Jumlah
                                </h2>

                                <span className="text-xs text-gray-500">
                                    Maks.{" "}
                                    {stock}{" "}
                                    item
                                </span>

                            </div>

                            <div className="flex h-12 w-fit items-center overflow-hidden rounded-xl border border-gray-200 bg-white">

                                <button
                                    type="button"
                                    onClick={
                                        handleDecreaseQuantity
                                    }
                                    disabled={
                                        quantity <=
                                        1
                                    }
                                    className="flex h-full w-12 items-center justify-center text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <FiMinus
                                        size={
                                            16
                                        }
                                    />
                                </button>

                                <span className="flex w-14 items-center justify-center text-sm font-semibold text-gray-900">
                                    {
                                        quantity
                                    }
                                </span>

                                <button
                                    type="button"
                                    onClick={
                                        handleIncreaseQuantity
                                    }
                                    disabled={
                                        !selectedVariant ||
                                        quantity >=
                                        stock
                                    }
                                    className="flex h-full w-12 items-center justify-center text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <FiPlus
                                        size={
                                            16
                                        }
                                    />
                                </button>

                            </div>

                        </div>

                        {/* ================================================= */}
                        {/* BULK DISCOUNT TIERS */}
                        {/* ================================================= */}

                        {bulkTiers.length > 0 && (
                            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                                <p className="text-xs font-semibold text-amber-700">
                                    🛒 Beli Banyak Lebih Hemat!
                                </p>
                                <div className="mt-2 space-y-1.5">
                                    {bulkTiers.map((tier) => {
                                        const originalPrice = selectedVariant?.price ?? 0;
                                        const savingsPerItem = tier.type === "PERCENTAGE"
                                            ? Math.round((originalPrice * tier.value) / 100)
                                            : tier.value;
                                        const finalPrice = Math.max(0, originalPrice - savingsPerItem);
                                        return (
                                            <div
                                                key={tier.id}
                                                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                                                    quantity >= tier.minQuantity
                                                        ? "bg-amber-100 font-semibold text-amber-800"
                                                        : "text-amber-600"
                                                }`}
                                            >
                                                <span>
                                                    Beli {tier.minQuantity}+ item
                                                </span>
                                                <div className="text-right">
                                                    <span>
                                                        {tier.type === "PERCENTAGE"
                                                            ? `Hemat Rp ${savingsPerItem.toLocaleString("id-ID")}/item`
                                                            : `Hemat Rp ${tier.value.toLocaleString("id-ID")}/item`}
                                                    </span>
                                                    <span className="block text-[10px] opacity-70">
                                                        Harga: Rp {finalPrice.toLocaleString("id-ID")}/item
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* ================================================= */}
                        {/* ACTION BUTTON */}
                        {/* ================================================= */}

                        <div className="mt-7 grid gap-3 sm:grid-cols-2">

                            {/* TAMBAH KERANJANG */}

                            <button
                                type="button"
                                disabled={
                                    !selectedVariant ||
                                    stock <= 0 ||
                                    loading
                                }
                                onClick={
                                    handleAddToCart
                                }
                                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-rose-600 bg-white px-4 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >

                                <FiShoppingBag
                                    size={18}
                                />

                                <span>
                                    {loading
                                        ? "Menambahkan..."
                                        : "Tambah ke Keranjang"}
                                </span>

                            </button>

                            {/* BELI SEKARANG */}

                            <button
                                type="button"
                                onClick={handleBuyNow}
                                className="w-full rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700"
                            >
                                Beli Sekarang
                            </button>

                        </div>

                    </div>

                </div>

                {/* ========================================================= */}
                {/* DESCRIPTION */}
                {/* ========================================================= */}

                <div className="mt-6 rounded-3xl bg-white p-5 sm:p-7">

                    <h2 className="text-lg font-bold text-gray-900">
                        Deskripsi Produk
                    </h2>

                    {product.description ? (
                        <div className="mt-4 whitespace-pre-line text-sm leading-7 text-gray-600">
                            {
                                product.description
                            }
                        </div>
                    ) : (
                        <p className="mt-4 text-sm text-gray-500">
                            Belum ada deskripsi
                            produk.
                        </p>
                    )}

                </div>

            </section>

        </main>
    );
}