import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";
import { pageMetadata, toMetaText } from "@/lib/site-metadata";

import ProductDetail from "@/components/products/ProductDetail";
import BottomNavbar from "@/components/products/BottomNavbar";

type Props = {
    params: Promise<{
        slug: string;
    }>;
};

/**
 * ==========================================
 * DYNAMIC PRODUCT METADATA
 * ==========================================
 *
 * Derives the tab title from the real product name so each
 * product page is identifiable in the browser history and
 * in search results. Only public catalog fields are read —
 * no pricing, stock or margin data reaches the head.
 *
 * An unknown/archived slug falls back to the generic
 * "Produk" title instead of echoing the slug back.
 */
export async function generateMetadata({
    params,
}: Props): Promise<Metadata> {
    const { slug } = await params;

    const product = await prisma.product.findFirst({
        where: {
            slug,
            isArchived: false,
        },

        select: {
            name: true,
            description: true,
            category: true,
        },
    });

    if (!product) {
        return pageMetadata({ title: "Produk" });
    }

    const name = toMetaText(product.name, 70);
    const description = toMetaText(product.description, 160);

    return pageMetadata({
        title: name,
        ...(description ? { description } : null),
        url: `/products/${slug}`,
    });
}

export default async function ProductDetailPage({
    params,
}: Props) {
    const session = await auth();

    const { slug } = await params;

    /*
     * Product detail is public: guests may browse any non-archived
     * product. Purchasing actions (add to cart / buy now) remain
     * protected server-side by their own API routes.
     *
     * Session is read only to decide whether the BottomNavbar is
     * shown (authenticated only); it does NOT gate the page.
     */
    const product =
        await prisma.product.findFirst({
            where: {
                slug,
                isArchived: false,
            },

            include: {
                variants: {
                    orderBy: {
                        id: "asc",
                    },
                },
            },
        });

    if (!product) {
        notFound();
    }

    // ==========================================
    // BATCH MARKETING PRICING
    // ==========================================

    const pricingResults =
        await resolveBatchPrices(
            product.variants.map((v) => ({
                productId: product.id,
                variantId: v.id,
                originalPrice: Number(v.price),
                quantity: 1,
                category: product.category,
            }))
        );

    const pricingMap = new Map(
        pricingResults.map((r) => [
            r.variantId,
            r,
        ])
    );

    // ==========================================
    // SERIALIZE WITH MARKETING PRICES
    // ==========================================

    const serializedProduct = {
        id: product.id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        image: product.image,
        category: product.category,
        rating: Number(product.rating),
        sold: product.sold,
        bestseller: product.bestseller,

        variants: product.variants.map(
            (variant) => {
                const pricing =
                    pricingMap.get(variant.id);

                const rawPrice = Number(
                    variant.price
                );

                return {
                    id: variant.id,
                    name: variant.name,
                    price: rawPrice,
                    // DISPLAY-ONLY (never charged).
                    comparePrice:
                        variant.comparePrice != null
                            ? Number(
                                  variant.comparePrice
                              )
                            : null,
                    effectivePrice:
                        pricing
                            ?.effectivePrice ??
                        rawPrice,
                    originalPrice:
                        pricing
                            ?.originalPrice ??
                        rawPrice,
                    discount:
                        pricing
                            ?.discountAmount ??
                        0,
                    hasDiscount:
                        (pricing
                            ?.discountAmount ??
                            0) > 0,
                    priceSource:
                        pricing
                            ?.source ??
                        "ORIGINAL",
                    flashSaleName:
                        pricing
                            ?.flashSaleName ??
                        null,
                    flashSaleEndAt:
                        pricing
                            ?.flashSaleEndAt
                            ?.toISOString() ??
                        null,
                    stock: variant.stock,
                    image: variant.image,
                };
            }
        ),
    };

    return (
        <main className="min-h-screen bg-gray-50 pb-24">
            <ProductDetail
                product={serializedProduct}
            />

            {session?.user && <BottomNavbar />}
        </main>
    );
}
