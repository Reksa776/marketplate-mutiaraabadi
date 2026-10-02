"use client";

import Link from "next/link";
import Image from "next/image";

import {
    FiPlus,
    FiStar,
} from "react-icons/fi";
import { resolvePriceDisplay } from "@/lib/price-display";

type ProductVariant = {
    id: number;
    name: string;
    price: string | number;
    effectivePrice?: number;
    /** DISPLAY-ONLY "Harga Normal" (never charged). */
    comparePrice?: number | null;
    hasDiscount?: boolean;
    discount?: number;
    priceSource?: string;
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
    bestseller: boolean;
    variants: ProductVariant[];
};

type Props = {
    product: Product;
};

/**
 * Format number as Rupiah currency.
 */
function formatRupiah(value: number): string {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

/**
 * Calculate discount percentage from original and final price.
 * Returns a whole number percentage (e.g. 20 for 20%).
 * Returns 0 if no discount or invalid input.
 */
function calculateDiscountPercent(
    originalPrice: number,
    finalPrice: number
): number {
    if (
        originalPrice <= 0 ||
        finalPrice <= 0 ||
        finalPrice >= originalPrice
    ) {
        return 0;
    }

    return Math.round(
        ((originalPrice - finalPrice) / originalPrice) * 100
    );
}

export default function ProductCard({
    product,
}: Props) {
    /*
     * Safety guard.
     *
     * Kalau API lama / data lama belum mempunyai
     * variants, kita tetap anggap sebagai array kosong.
     */
    const variants = Array.isArray(
        product?.variants
    )
        ? product.variants
        : [];

    /*
     * Ambil harga dengan SATU aturan display bersama
     * (lib/price-display) agar ProductCard/cart/detail
     * tidak pernah divergen dan tidak pernah ada dua
     * harga tercoret sekaligus.
     */
    const displays = variants.map((variant) =>
        resolvePriceDisplay({
            effectivePrice: Number(
                variant.effectivePrice ?? variant.price
            ),
            originalPrice: Number(variant.price),
            comparePrice:
                variant.comparePrice == null
                    ? null
                    : Number(variant.comparePrice),
        })
    );

    const prices = displays
        .map((display) => display.price)
        .filter((price) =>
            Number.isFinite(price)
        );

    /*
     * Strikethrough values come from the shared rule: either the
     * explicit comparePrice or the marketing original — never both.
     */
    const strikethroughs = displays
        .map((display) => display.strikethrough)
        .filter(
            (value): value is number =>
                value != null && Number.isFinite(value)
        );

    const lowestPrice =
        prices.length > 0
            ? Math.min(...prices)
            : 0;

    const highestPrice =
        prices.length > 0
            ? Math.max(...prices)
            : 0;

    const lowestOriginalPrice =
        strikethroughs.length > 0
            ? Math.min(...strikethroughs)
            : 0;

    const highestOriginalPrice =
        strikethroughs.length > 0
            ? Math.max(...strikethroughs)
            : 0;

    const hasPriceRange =
        lowestPrice !== highestPrice;

    /*
     * Discount percentage — lowest strikethrough vs lowest price.
     */
    const discountPercent =
        calculateDiscountPercent(
            lowestOriginalPrice,
            lowestPrice
        );

    /*
     * Show the strikethrough layout whenever the shared rule
     * produced exactly one struck price.
     */
    const showMarketingLayout =
        strikethroughs.length > 0;

    return (
        <Link
            href={`/products/${product.slug}`}
            className="group overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:border-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
        >
            {/* IMAGE */}
            <div className="relative aspect-square overflow-hidden bg-gray-100">
                {product.image ? (
                    <img
                        src={product.image}
                        alt={product.name}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-gray-400">
                        Tidak ada gambar
                    </div>
                )}

                {product.bestseller && (
                    <span className="absolute left-3 top-3 rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white">
                        Terlaris
                    </span>
                )}

                {showMarketingLayout &&
                    discountPercent > 0 && (
                        <span className="absolute right-3 top-3 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
                            -{discountPercent}%
                        </span>
                    )}
            </div>

            {/* CONTENT */}
            <div className="p-4">
                <h3 className="line-clamp-2 min-h-[2.75rem] text-sm font-medium text-gray-900">
                    {product.name}
                </h3>

                {/* RATING */}
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                    <FiStar
                        className="text-amber-500"
                        size={13}
                    />

                    <span>
                        5
                    </span>

                    <span className="text-gray-300">
                        ·
                    </span>

                    <span>
                        10rb+
                        terjual
                    </span>
                </div>

                {/* PRICE */}
                <div className="mt-4">
                    {prices.length === 0 ? (
                        <p className="text-sm font-medium text-gray-400">
                            Harga belum tersedia
                        </p>
                    ) : showMarketingLayout ? (
                        /*
                         * MARKETING PRICE LAYOUT
                         *
                         * Original price (strikethrough)
                         * + Effective price (rose, main)
                         * + Variant count
                         */
                        <div>
                            {hasPriceRange ? (
                                <div>
                                    <p className="text-[11px] text-gray-400 line-through">
                                        {formatRupiah(
                                            lowestOriginalPrice
                                        )}
                                        {lowestOriginalPrice !==
                                            highestOriginalPrice && (
                                            <>
                                                <span className="mx-0.5">
                                                    -
                                                </span>
                                                {formatRupiah(
                                                    highestOriginalPrice
                                                )}
                                            </>
                                        )}
                                    </p>
                                    <p className="mt-0.5 text-base font-semibold text-rose-600">
                                        {formatRupiah(
                                            lowestPrice
                                        )}
                                        <span className="mx-0.5 text-sm text-gray-400">
                                            -
                                        </span>
                                        {formatRupiah(
                                            highestPrice
                                        )}
                                    </p>
                                </div>
                            ) : (
                                <div>
                                    {lowestOriginalPrice >
                                        lowestPrice && (
                                        <p className="text-[11px] text-gray-400 line-through">
                                            {formatRupiah(
                                                lowestOriginalPrice
                                            )}
                                        </p>
                                    )}
                                    <p className="text-base font-semibold text-rose-600">
                                        {formatRupiah(
                                            lowestPrice
                                        )}
                                    </p>
                                </div>
                            )}

                            {variants.length >
                                0 && (
                                <p className="mt-1 text-[11px] text-gray-400">
                                    {
                                        variants.length
                                    }{" "}
                                    varian
                                </p>
                            )}
                        </div>
                    ) : hasPriceRange ? (
                        /*
                         * NO DISCOUNT — PRICE RANGE
                         */
                        <p className="text-sm font-semibold text-gray-900">
                            {formatRupiah(
                                lowestPrice
                            )}

                            <span className="mx-1 text-gray-400">
                                -
                            </span>

                            {formatRupiah(
                                highestPrice
                            )}
                        </p>
                    ) : (
                        /*
                         * NO DISCOUNT — SINGLE PRICE
                         */
                        <p className="text-base font-semibold text-gray-900">
                            {formatRupiah(
                                lowestPrice
                            )}
                        </p>
                    )}

                    {!showMarketingLayout &&
                        variants.length >
                            0 && (
                            <p className="mt-1 text-[11px] text-gray-400">
                                {
                                    variants.length
                                }{" "}
                                varian
                            </p>
                        )}
                </div>
            </div>
        </Link>
    );
}
