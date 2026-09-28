import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";
import {
    FiArrowRight,
    FiShoppingBag,
    FiStar,
} from "react-icons/fi";
import BannerSlider from "@/components/products/BannerSlider";
import { ProductProvider } from "@/components/products/ProductContext";
import { auth } from "@/auth";
import BottomNavbar from "@/components/products/BottomNavbar";
import { getActivePromotions } from "@/lib/marketing/promotion";
import SpinWheelContainer from "@/components/SpinWheelContainer";

export const metadata: Metadata = pageMetadata({
    title: "Beranda",
    description:
        "Beranda Mutiara Abadi — jelajahi produk pilihan, promo terbaru, dan penawaran menarik yang sedang berlangsung.",
});

type ProductWithVariant = {
    bestseller: boolean;
    id: number;
    name: string;
    slug: string;
    image: string | null;
    sold: number;
    rating: number;
    category: string | null;
    variants: {
        id: number;
        name: string;
        price: number;
        effectivePrice: number;
        discount: number;
        hasDiscount: boolean;
        priceSource: string;
        flashSaleName: string | null;
        image: string | null;
    }[];
};

function formatRupiah(value: number) {
    return `Rp ${value.toLocaleString("id-ID")}`;
}

function getProductPrice(product: ProductWithVariant) {
    if (!product.variants.length) {
        return 0;
    }

    return Math.min(
        ...product.variants.map((variant) =>
            variant.effectivePrice
        )
    );
}

function getProductOriginalPrice(product: ProductWithVariant) {
    if (!product.variants.length) {
        return 0;
    }

    return Math.min(
        ...product.variants.map((variant) =>
            variant.price
        )
    );
}

function getProductImage(product: ProductWithVariant) {
    if (product.image) {
        return product.image;
    }

    return (
        product.variants.find(
            (variant) => variant.image
        )?.image ?? null
    );
}

/**
 * Contoh tier.
 *
 * Nanti bagian ini bisa kamu ganti berdasarkan:
 * - total transaksi
 * - total belanja
 * - jumlah referral
 * - total komisi
 *
 * Untuk sementara dibuat statis Bronze.
 */
function getUserTier() {
    return {
        name: "Bronze",
        description: "Terus belanja untuk naik ke tier berikutnya.",
        nextTier: "Silver",
        progress: 35,
    };
}

async function getProducts() {
    const [bestSeller, latest] =
        await Promise.all([
            prisma.product.findMany({
                where: {
                    bestseller: true,
                    isArchived: false,
                },
                orderBy: [
                    {
                        sold: "desc",
                    },
                    {
                        rating: "desc",
                    },
                ],
                take: 8,
                include: {
                    variants: {
                        orderBy: {
                            price: "asc",
                        },
                        take: 1,
                    },
                },
            }),

            prisma.product.findMany({
                where: {
                    isArchived: false,
                },
                orderBy: {
                    createdAt: "desc",
                },
                take: 8,
                include: {
                    variants: {
                        orderBy: {
                            price: "asc",
                        },
                        take: 1,
                    },
                },
            }),
        ]);

    // ==========================================
    // BATCH MARKETING PRICING
    // ==========================================
    const allProducts = [...bestSeller, ...latest];

    const allVariantInputs = allProducts.flatMap((product) =>
        product.variants.map((v) => ({
            productId: product.id,
            variantId: v.id,
            originalPrice: Number(v.price),
            quantity: 1,
            category: product.category,
        }))
    );

    const pricingResults = await resolveBatchPrices(allVariantInputs);

    const pricingMap = new Map(
        pricingResults.map((r) => [r.variantId, r])
    );

    // ==========================================
    // SERIALIZE WITH MARKETING PRICES
    // ==========================================
    function serializeProducts(products: typeof bestSeller): ProductWithVariant[] {
        return products.map((product) => ({
            ...product,
            variants: product.variants.map((variant) => {
                const pricing = pricingMap.get(variant.id);
                const rawPrice = Number(variant.price);

                return {
                    id: variant.id,
                    name: variant.name,
                    price: rawPrice,
                    effectivePrice: pricing?.effectivePrice ?? rawPrice,
                    discount: pricing?.discountAmount ?? 0,
                    hasDiscount: (pricing?.discountAmount ?? 0) > 0,
                    priceSource: pricing?.source ?? "ORIGINAL",
                    flashSaleName: pricing?.flashSaleName ?? null,
                    image: variant.image,
                };
            }),
        }));
    }

    return {
        bestSeller: serializeProducts(bestSeller),
        latest: serializeProducts(latest),
    };
}

function ProductCard({
    product,
}: {
    product: ProductWithVariant;
}) {
    const image = getProductImage(product);
    const price = getProductPrice(product);
    const originalPrice = getProductOriginalPrice(product);
    const hasDiscount = price < originalPrice;

    /*
     * Discount percentage — calculated from
     * original vs effective price.
     */
    const discountPercent =
        hasDiscount && originalPrice > 0
            ? Math.round(
                  ((originalPrice - price) / originalPrice) * 100
              )
            : 0;

    return (
        <Link
            href={`/products/${product.slug}`}
            className="group overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:-translate-y-1 hover:shadow-lg"
        >
            <div className="relative aspect-square overflow-hidden bg-gray-100">
                {image ? (
                    <img
                        src={image}
                        alt={product.name}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                ) : (
                    <div className="flex h-full items-center justify-center text-gray-400">
                        <FiShoppingBag size={40} />
                    </div>
                )}

                {product.bestseller && (
                    <span className="absolute left-3 top-3 rounded-full bg-rose-600 px-3 py-1 text-[11px] font-bold text-white">
                        BEST SELLER
                    </span>
                )}

                {hasDiscount && discountPercent > 0 && (
                    <span className="absolute right-3 top-3 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
                        -{discountPercent}%
                    </span>
                )}
            </div>

            <div className="p-4">
                <h3 className="line-clamp-2 min-h-[48px] text-sm font-semibold text-gray-900">
                    {product.name}
                </h3>

                <div className="mt-3">
                    {hasDiscount ? (
                        <div>
                            <p className="text-[11px] text-gray-400 line-through">
                                {formatRupiah(originalPrice)}
                            </p>
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-base font-bold text-rose-600">
                                    {formatRupiah(price)}
                                </span>

                                <span className="text-xs text-gray-400">
                                    {product.sold} terjual
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-base font-bold text-gray-900">
                                {formatRupiah(price)}
                            </span>

                            <span className="text-xs text-gray-400">
                                {product.sold} terjual
                            </span>
                        </div>
                    )}
                </div>

                {product.rating > 0 && (
                    <div className="mt-2 text-xs text-yellow-500">
                        ★ {product.rating.toFixed(1)}
                    </div>
                )}
            </div>
        </Link>
    );
}

function ProductSection({
    title,
    subtitle,
    products,
}: {
    title: string;
    subtitle: string;
    products: ProductWithVariant[];
}) {
    return (
        <section>
            <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                        {title}
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                        {subtitle}
                    </p>
                </div>

                <Link
                    href="/products"
                    className="hidden items-center gap-2 text-sm font-semibold text-rose-600 hover:text-rose-700 sm:flex"
                >
                    Lihat Semua
                    <FiArrowRight size={16} />
                </Link>
            </div>

            {products.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
                    <p className="font-semibold text-gray-900">
                        Belum ada produk.
                    </p>

                    <p className="mt-1 text-sm text-gray-500">
                        Produk akan muncul di sini.
                    </p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                        {products.map((product) => (
                            <ProductCard
                                key={product.id}
                                product={product}
                            />
                        ))}
                    </div>

                    <div className="mt-5 sm:hidden">
                        <Link
                            href="/products"
                            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700"
                        >
                            Lihat Semua Produk
                            <FiArrowRight size={16} />
                        </Link>
                    </div>
                </>
            )}
        </section>
    );
}

function WelcomeCard({
    name,
}: {
    name?: string | null;
}) {
    const tier = getUserTier();

    const displayName =
        name?.trim() || "Customer";

    return (
        <section className="mb-7">
            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                    {/* GREETING */}
                    <div>
                        <p className="text-sm text-gray-500">
                            Selamat datang kembali 👋
                        </p>

                        <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
                            {displayName}
                        </h1>

                        <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
                            Temukan produk favoritmu dan nikmati
                            berbagai keuntungan dari akunmu.
                        </p>
                    </div>

                    {/* TIER */}
                    <div className="w-full sm:max-w-sm">
                        <div className="rounded-xl bg-gray-50 p-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-sm">
                                        <FiStar
                                            size={18}
                                            className="text-amber-500"
                                        />
                                    </div>

                                    <div>
                                        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
                                            Member Tier
                                        </p>

                                        <p className="text-sm font-bold text-gray-900">
                                            {tier.name}
                                        </p>
                                    </div>
                                </div>

                                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-600 shadow-sm">
                                    {tier.nextTier}
                                </span>
                            </div>

                            <div className="mt-4">
                                <div className="mb-2 flex items-center justify-between text-[11px] text-gray-400">
                                    <span>
                                        Progress menuju{" "}
                                        {tier.nextTier}
                                    </span>

                                    <span>
                                        {tier.progress}%
                                    </span>
                                </div>

                                <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
                                    <div
                                        className="h-full rounded-full bg-gray-900 transition-all"
                                        style={{
                                            width: `${tier.progress}%`,
                                        }}
                                    />
                                </div>
                            </div>

                            <p className="mt-3 text-xs text-gray-400">
                                {tier.description}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

async function getHomepageBanners() {
    const now = new Date();
    const promotions = await getActivePromotions("HOMEPAGE", now);
    return promotions.map((p) => ({
        id: p.id,
        imageUrl: p.imageUrl,
        title: p.title,
        link: p.link,
    }));
}

export default async function HomePage() {
    const [{ bestSeller, latest }, banners, session] =
        await Promise.all([getProducts(), getHomepageBanners(), auth()]);

    if (!session?.user) {
        return (
            <main className="min-h-screen bg-gray-50" />
        );
    }

    return (
        <ProductProvider>
            <SpinWheelContainer />
            <main className="min-h-screen bg-gray-50 pb-20">
                <div className="mx-auto max-w-7xl px-4 pt-5 mb-9 sm:px-6 sm:pt-7 lg:px-8">

                    {/* WELCOME + TIER */}
                    <WelcomeCard
                        name={session.user.name}
                    />

                    {/* BANNER DI BAWAH */}
                    <section className="mb-10 overflow-hidden rounded-2xl">
                        <BannerSlider banners={banners} />
                    </section>

                    <div className="space-y-12">
                        {/* BEST SELLER */}
                        <ProductSection
                            title="Best Seller"
                            subtitle="Produk yang paling banyak dibeli customer."
                            products={bestSeller}
                        />

                        {/* TERBARU */}
                        <ProductSection
                            title="Produk Terbaru"
                            subtitle="Produk terbaru yang baru ditambahkan."
                            products={latest}
                        />
                    </div>
                </div>

                <BottomNavbar />
            </main>
        </ProductProvider>
    );
}
