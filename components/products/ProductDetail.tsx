"use client";

import Link from "next/link";
import { trackTikTokEvent } from "@/lib/analytics/tiktok";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";
import { buildTikTokProductProperties } from "@/lib/analytics/tiktok-catalog";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { resolvePriceDisplay } from "@/lib/price-display";
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
    /** DISPLAY-ONLY "Harga Coret" (never charged). */
    comparePrice?: number | null;
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
    promoSlug?: string;
    promoVariantId?: number;
    promoLate?: boolean;
};

export default function ProductDetail({
    product,
    promoSlug,
    promoVariantId,
    promoLate = false,
}: Props) {
    const router = useRouter();

    /*
     * NO AUTH GATE HERE.
     *
     * Customers shop as guests, so "add to cart" and "beli sekarang"
     * are anonymous-safe operations: the cart is scoped by the guest
     * cookie (lib/cart-scope.ts) and Buy Now collects the buyer
     * identity inline. The session is intentionally NOT consulted to
     * decide whether an action is allowed.
     */

    /*
    |--------------------------------------------------------------------------
    | STATE
    |--------------------------------------------------------------------------
    */

    const [selectedVariant, setSelectedVariant] =
        useState<ProductVariant | null>(
            product.variants.find((variant) => variant.id === promoVariantId) ??
                (product.variants.length > 0 ? product.variants[0] : null)
        );

    const [quantity, setQuantity] =
        useState(1);

    const [loading, setLoading] =
        useState(false);

    const [checkingPromo, setCheckingPromo] =
        useState(false);

    const [showPromoLateDialog, setShowPromoLateDialog] =
        useState(promoLate);
    const [promoUnavailable, setPromoUnavailable] =
        useState(promoLate);

    useEffect(() => {
        if (promoLate) {
            setPromoUnavailable(true);
            setShowPromoLateDialog(true);
        }
    }, [promoLate]);

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

    const showRegularPrice =
        promoUnavailable && selectedVariant?.priceSource === "PROMO_LANDING";

    const price = showRegularPrice
        ? selectedVariant?.price ?? 0
        : selectedVariant?.effectivePrice ?? selectedVariant?.price ?? 0;

    const originalPrice = showRegularPrice
        ? price
        : selectedVariant?.originalPrice ?? selectedVariant?.price ?? 0;

    const [animatedPrice, setAnimatedPrice] = useState(price);
    const animatedPriceRef = useRef(price);

    useEffect(() => {
        const from = animatedPriceRef.current;
        const to = price;
        if (from === to) return;

        const startedAt = performance.now();
        const durationMs = 650;
        let frameId = 0;

        const animate = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / durationMs);
            const easedProgress = 1 - Math.pow(1 - progress, 3);
            const nextPrice = Math.round(from + (to - from) * easedProgress);
            animatedPriceRef.current = nextPrice;
            setAnimatedPrice(nextPrice);

            if (progress < 1) {
                frameId = window.requestAnimationFrame(animate);
            }
        };

        frameId = window.requestAnimationFrame(animate);
        return () => window.cancelAnimationFrame(frameId);
    }, [price]);

    /*
     * Single shared display rule (lib/price-display): the explicit
     * comparePrice wins when higher than the actual price, otherwise
     * fall back to the existing marketing strikethrough. At most ONE
     * struck price is ever rendered.
     */
    const priceDisplay = resolvePriceDisplay({
        effectivePrice: price,
        originalPrice,
        comparePrice:
            selectedVariant?.comparePrice == null
                ? null
                : Number(selectedVariant.comparePrice),
    });

    const hasDiscount =
        priceDisplay.strikethrough !== null;

    const strikethroughPrice =
        priceDisplay.strikethrough;

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
         * GUESTS ADD TO CART DIRECTLY.
         *
         * Customers shop without an account, so there is no login
         * gate here. An anonymous request is scoped to the guest cart
         * cookie by /api/cart (see lib/cart-scope.ts); the session is
         * only used to keep an existing logged-in cart working.
         */

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
             * Cart API error (429 rate limit, 400 invalid variant, ...).
             * There is no customer login to fall back to anymore.
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
    const handleBuyNow = async () => {
        if (!selectedVariant) return;

        if (quantity > selectedVariant.stock) {
            return;
        }

        if (promoSlug) {
            setCheckingPromo(true);
            try {
                const response = await fetch(
                    `/api/promos/${encodeURIComponent(promoSlug)}/claim`,
                    { cache: "no-store" }
                );
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.message || "Status promo tidak bisa diperiksa.");
                }

                const promoStatus = result.data;
                if (!promoStatus.active || promoStatus.remaining <= 0) {
                    setPromoUnavailable(true);
                    setShowPromoLateDialog(true);
                    return;
                }
                if (!promoStatus.claimed) {
                    router.push(`/promo/${encodeURIComponent(promoSlug)}`);
                    return;
                }
                if (promoStatus.variantId !== selectedVariant.id) {
                    toast.error("Promo ini hanya berlaku untuk varian yang dipilih di halaman promo.");
                    return;
                }
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Status promo tidak bisa diperiksa.");
                return;
            } finally {
                setCheckingPromo(false);
            }
        }

        /*
         * Guest Buy Now: straight to the page. No login step — the
         * page and /api/buy-now are guest-capable, and the buyer
         * identity is collected inside the Buy Now flow.
         */
        router.push(
            `/buy-now?productId=${product.id}` +
            `&variantId=${selectedVariant.id}` +
            `&quantity=${quantity}` +
            (promoSlug ? `&promo=${encodeURIComponent(promoSlug)}&promoVariantId=${selectedVariant.id}` : "")
        );
    };

    /*
    |--------------------------------------------------------------------------
    | RENDER
    |--------------------------------------------------------------------------
    */

    return (
        <main className="min-h-screen bg-gray-50 pb-28">

            {showPromoLateDialog && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4 py-8" role="presentation">
                    <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="promo-late-title"
                        className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl"
                    >
                        <h2 id="promo-late-title" className="text-2xl font-black text-gray-950">Kamu terlambat</h2>
                        <p className="mt-3 text-sm leading-6 text-gray-600">
                            Kuota promo hari ini sudah habis atau periodenya telah berakhir. Lihat promo menarik lainnya di menu produk.
                        </p>
                        <Link
                            href="/products"
                            onClick={() => setShowPromoLateDialog(false)}
                            className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-rose-600 px-5 text-sm font-bold text-white transition hover:bg-rose-700"
                        >
                            Lihat promo lainnya
                        </Link>
                        <button
                            type="button"
                            onClick={() => setShowPromoLateDialog(false)}
                            className="mt-3 text-sm font-medium text-gray-500 hover:text-gray-800"
                        >
                            Tutup
                        </button>
                    </section>
                </div>
            )}

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
                                        Rp {formatPrice(strikethroughPrice ?? 0)}
                                    </p>
                                    <p className={`text-3xl font-bold transition-colors duration-500 ${showRegularPrice ? "text-gray-900" : "text-rose-600"}`}>
                                        Rp {formatPrice(animatedPrice)}
                                    </p>
                                    {flashSaleName && (
                                        <p className="mt-1 text-xs font-medium text-rose-500">
                                            🔥 {flashSaleName}
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p className="text-3xl font-bold text-gray-900 transition-colors duration-500">
                                    Rp {formatPrice(animatedPrice)}
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
                                                                promoUnavailable && variant.priceSource === "PROMO_LANDING"
                                                                    ? variant.price
                                                                    : variant.effectivePrice ?? variant.price
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
                                disabled={checkingPromo}
                                className="w-full rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700"
                            >
                                {checkingPromo ? "Memeriksa kuota promo..." : "Beli Sekarang"}
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
