import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";
import type { CartStockStatus } from "@/lib/cart-validation";

export async function GET(request: NextRequest) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Silakan login terlebih dahulu.",
                },
                {
                    status: 401,
                }
            );
        }

        const userId = session.user.id;

        // ==========================================
        // SELECTED CART ITEM IDs
        // ==========================================

        const selectedParam =
            request.nextUrl.searchParams.get(
                "selectedCartItemIds"
            );

        let selectedCartItemIds: number[] | null =
            null;

        if (selectedParam) {
            try {
                const parsed =
                    JSON.parse(selectedParam);
                if (
                    Array.isArray(parsed) &&
                    parsed.length > 0
                ) {
                    selectedCartItemIds = [
                        ...new Set(
                            parsed
                                .map(Number)
                                .filter(
                                    (n) =>
                                        Number.isInteger(n) &&
                                        n > 0
                                )
                        ),
                    ];
                }
            } catch {
                // Invalid JSON — treat as no selection
            }
        }

        // ==========================================
        // CART
        // ==========================================

        const cart =
            await prisma.cart.findUnique({
                where: {
                    userId,
                },
                include: {
                    items: {
                        orderBy: {
                            createdAt: "asc",
                        },
                        include: {
                            product: true,
                            variant: true,
                        },
                    },
                },
            });

        if (
            !cart ||
            cart.items.length === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Keranjang kosong.",
                },
                {
                    status: 400,
                }
            );
        }

        // ==========================================
        // ADDRESSES
        // ==========================================

        const addresses =
            await prisma.userAddress.findMany({
                where: {
                    userId,
                },
                orderBy: [
                    {
                        isDefault: "desc",
                    },
                    {
                        createdAt: "desc",
                    },
                ],
            });

        // ==========================================
        // STORE
        // ==========================================

        const store =
            await prisma.storeSetting.findUnique({
                where: {
                    id: 1,
                },
                select: {
                    id: true,
                    storeName: true,
                    rajaOngkirDestinationId: true,
                },
            });

        if (!store) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Data toko belum dikonfigurasi.",
                },
                {
                    status: 500,
                }
            );
        }

        if (
            !store.rajaOngkirDestinationId ||
            !Number.isInteger(
                Number(
                    store.rajaOngkirDestinationId
                )
            ) ||
            Number(
                store.rajaOngkirDestinationId
            ) <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Destination RajaOngkir toko belum dikonfigurasi.",
                },
                {
                    status: 500,
                }
            );
        }

        // ==========================================
        // FILTER BY SELECTED IDS
        // ==========================================

        let filteredItems = cart.items;

        if (selectedCartItemIds) {
            filteredItems = cart.items.filter(
                (item) =>
                    selectedCartItemIds!.includes(
                        item.id
                    )
            );

            if (
                filteredItems.length === 0
            ) {
                return NextResponse.json({
                    success: false,
                    message:
                        "Tidak ada item keranjang yang dipilih.",
                },
                    {
                        status: 400,
                    }
                );
            }
        }

        // ==========================================
        // BATCH MARKETING PRICING
        // ==========================================

        const pricingResults =
            await resolveBatchPrices(
                filteredItems.map((item) => ({
                    productId: item.productId,
                    variantId: item.variantId,
                    originalPrice: Number(
                        item.variant.price
                    ),
                    quantity: Number(
                        item.quantity
                    ),
                    category:
                        item.product.category,
                }))
            );

        const pricingMap = new Map(
            pricingResults.map((r) => [
                r.variantId,
                r,
            ])
        );

        // ==========================================
        // BATCH: Flash sale stock for all variants
        // ==========================================
    const variantIds = [
        ...new Set(filteredItems.map((item) => item.variantId)),
    ];

        const flashSales = await prisma.flashSale.findMany({
            where: {
                variantId: { in: variantIds },
                isActive: true,
            },
            select: {
                id: true,
                variantId: true,
                saleStock: true,
            },
        });

        const flashSaleStockMap = new Map(
            flashSales.map((fs) => [fs.variantId, fs])
        );

        // ==========================================
        // ITEMS (with marketing prices + stock status)
        // ==========================================

        const items = filteredItems.map(
            (item) => {
                const pricing =
                    pricingMap.get(
                        item.variantId
                    );

                const rawPrice = Number(
                    item.variant.price
                );

                const effectivePrice =
                    pricing
                        ?.effectivePrice ??
                    rawPrice;

                const rawWeight = Number(
                    item.variant.weight
                );

                const weight =
                    Number.isFinite(
                        rawWeight
                    ) && rawWeight >= 0
                        ? Math.round(rawWeight)
                        : 0;

                const rawQuantity = Number(
                    item.quantity
                );

                const quantity =
                    Number.isInteger(
                        rawQuantity
                    ) && rawQuantity > 0
                        ? rawQuantity
                        : 1;

                const subtotal =
                    effectivePrice * quantity;

                const totalWeight =
                    weight * quantity;

                // Stock status
                const flashSale = flashSaleStockMap.get(item.variantId);
                const availableStock = flashSale
                    ? flashSale.saleStock
                    : item.variant.stock;

                let stockStatus: CartStockStatus = "OK";
                if (availableStock <= 0) {
                    stockStatus = "OUT_OF_STOCK";
                } else if (quantity > availableStock) {
                    stockStatus = "INSUFFICIENT_STOCK";
                }

                return {
                    id: item.id,

                    productId:
                        item.productId,
                    variantId:
                        item.variantId,

                    productName:
                        item.product.name,
                    variantName:
                        item.variant.name,

                    image:
                        item.variant.image ||
                        item.product.image ||
                        null,

                    price: effectivePrice,
                    originalPrice:
                        pricing
                            ?.originalPrice ??
                        rawPrice,
                    // DISPLAY-ONLY (never charged).
                    comparePrice:
                        item.variant.comparePrice != null
                            ? Number(item.variant.comparePrice)
                            : null,
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

                    quantity,
                    availableStock,
                    stockStatus,

                    weight,
                    totalWeight,
                    subtotal,
                };
            }
        );

        // ==========================================
        // SUBTOTAL
        // ==========================================

        const subtotal = items.reduce(
            (total, item) =>
                total + item.subtotal,
            0
        );

        // ==========================================
        // TOTAL WEIGHT
        // ==========================================

        const totalWeight = items.reduce(
            (total, item) =>
                total + item.totalWeight,
            0
        );

        // ==========================================
        // STOCK VALIDATION
        // ==========================================

        const invalidCount = items.filter(
            (item) => item.stockStatus !== "OK"
        ).length;

        // ==========================================
        // RESPONSE
        // ==========================================

        return NextResponse.json({
            success: true,

            data: {
                items,

                subtotal,

                totalWeight,

                invalidCount,

                addresses,

                store: {
                    id: store.id,

                    storeName:
                        store.storeName,

                    rajaOngkirDestinationId:
                        store.rajaOngkirDestinationId,
                },
            },
        });
    } catch (error) {
        console.error(
            "CHECKOUT GET ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil data checkout.",
            },
            {
                status: 500,
            }
        );
    }
}
