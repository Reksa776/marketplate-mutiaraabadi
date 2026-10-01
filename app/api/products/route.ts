import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";

export async function GET() {
    try {
        const session = await auth();

        const authenticated = Boolean(
            session?.user?.id
        );

        /*
         * Guest and logged-in customers see the same public catalog:
         * every non-archived product. Guests are no longer limited to
         * bestsellers. Only the internal stock figure stays hidden from
         * guests (see the variant mapping below).
         */
        const products =
            await prisma.product.findMany({
                where: {
                    isArchived: false,
                },

                orderBy: [
                    {
                        bestseller: "desc",
                    },
                    {
                        createdAt: "desc",
                    },
                ],

                include: {
                    variants: {
                        orderBy: {
                            id: "asc",
                        },
                    },
                },
            });

        // ==========================================
        // BATCH MARKETING PRICING
        // ==========================================

        const allVariantInputs =
            products.flatMap((product) =>
                product.variants.map((v) => ({
                    productId: product.id,
                    variantId: v.id,
                    originalPrice: Number(v.price),
                    quantity: 1,
                    category: product.category,
                }))
            );

        const pricingResults =
            await resolveBatchPrices(
                allVariantInputs
            );

        // Build lookup: variantId → pricing result
        const pricingMap = new Map(
            pricingResults.map((r) => [
                r.variantId,
                r,
            ])
        );

        // ==========================================
        // FORMAT RESPONSE
        // ==========================================

        const formattedProducts =
            products.map((product) => ({
                id: product.id,
                slug: product.slug,
                name: product.name,
                description:
                    product.description,
                image: product.image,
                category:
                    product.category,
                rating: product.rating,
                sold: product.sold,
                bestseller:
                    product.bestseller,

                variants:
                    product.variants.map(
                        (variant) => {
                            const pricing =
                                pricingMap.get(
                                    variant.id
                                );

                            const rawPrice =
                                Number(
                                    variant.price
                                );

                            return {
                                id: variant.id,
                                productId:
                                    variant.productId,
                                name: variant.name,
                                price: rawPrice,
                                effectivePrice:
                                    pricing
                                        ?.effectivePrice ??
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
                                stock:
                                    authenticated
                                        ? variant.stock
                                        : undefined,
                                inStock:
                                    variant.stock > 0,
                                image:
                                    variant.image,
                            };
                        }
                    ),
            }));

        return NextResponse.json({
            success: true,
            authenticated,
            products:
                formattedProducts,
        });
    } catch (error) {
        console.error(
            "GET PRODUCTS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                authenticated: false,
                products: [],
                message:
                    "Gagal mengambil produk.",
            },
            {
                status: 500,
            }
        );
    }
}
