import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
    createCheckoutOrder,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";

import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { rateLimiters } from "@/lib/rate-limit";
import { readOrderAttribution } from "@/lib/analytics/attribution-server";

export const dynamic = "force-dynamic";

type PaymentMethod =
    | "COD"
    | "BANK_TRANSFER"
    | "E_WALLET"
    | "QRIS";

type ShippingPayload = {
    courier?: string;
    code?: string;
    service?: string;
    service_name?: string;
    etd?: string;
    estimation?: string;
    cost?: number;
    price?: number;
    shipping_cost?: number;
};

type BuyNowPostBody = {
    productId: number;
    variantId: number;
    quantity: number;
    addressId: string;
    shipping: ShippingPayload;
    paymentMethod: PaymentMethod;
    voucherCode?: string | null;
    spinWheelSpinId?: number | null;
};

function jsonError(
    message: string,
    status = 400
) {
    return NextResponse.json(
        {
            success: false,
            message,
        },
        { status }
    );
}

function jsonSuccess(
    data: unknown,
    status = 200
) {
    return NextResponse.json(
        {
            success: true,
            data,
        },
        { status }
    );
}

function decimalToNumber(
    value: Prisma.Decimal | number | null | undefined
) {
    if (value === null || value === undefined) {
        return 0;
    }

    return Number(value.toString());
}

function normalizeVoucherCode(
    value: unknown
): string | null {
    if (
        typeof value !== "string"
    ) {
        return null;
    }

    const code =
        value.trim().toUpperCase();

    return code || null;
}

function getShippingCost(
    shipping: ShippingPayload
) {
    const candidates = [
        shipping.cost,
        shipping.price,
        shipping.shipping_cost,
    ];

    for (const value of candidates) {
        const number =
            Number(value);

        if (
            Number.isFinite(number) &&
            number >= 0
        ) {
            return Math.round(number);
        }
    }

    return 0;
}

function getShippingCourier(
    shipping: ShippingPayload
) {
    return (
        shipping.courier ||
        shipping.code ||
        null
    );
}

function getShippingService(
    shipping: ShippingPayload
) {
    return (
        shipping.service ||
        shipping.service_name ||
        null
    );
}

async function getCurrentUser() {
    const session =
        await auth();

    if (!session?.user?.id) {
        return null;
    }

    return session.user;
}

/*
 * ============================================================
 * GET /api/buy-now
 * ============================================================
 *
 * Dipakai oleh halaman Buy Now untuk mengambil:
 *
 * - product
 * - variant
 * - quantity
 * - subtotal
 * - totalWeight
 * - addresses
 * - store
 *
 * Harga selalu berasal dari database.
 */
export async function GET(
    request: NextRequest
) {
    try {
        const user =
            await getCurrentUser();

        if (!user) {
            return jsonError(
                "Anda harus login terlebih dahulu.",
                401
            );
        }

        const searchParams =
            request.nextUrl.searchParams;

        const productId =
            Number(
                searchParams.get(
                    "productId"
                )
            );

        const variantId =
            Number(
                searchParams.get(
                    "variantId"
                )
            );

        const quantity =
            Number(
                searchParams.get(
                    "quantity"
                )
            );

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return jsonError(
                "Product ID tidak valid."
            );
        }

        if (
            !Number.isInteger(variantId) ||
            variantId <= 0
        ) {
            return jsonError(
                "Variant ID tidak valid."
            );
        }

        if (
            !Number.isInteger(quantity) ||
            quantity <= 0 ||
            quantity > 100
        ) {
            return jsonError(
                "Quantity tidak valid."
            );
        }

        const [
            product,
            addresses,
            store,
        ] =
            await Promise.all([
                prisma.product.findUnique({
                    where: {
                        id: productId,
                    },
                    include: {
                        variants: {
                            where: {
                                id: variantId,
                            },
                            take: 1,
                        },
                    },
                }),

                prisma.userAddress.findMany({
                    where: {
                        userId: user.id,
                    },
                    orderBy: [
                        {
                            isDefault:
                                "desc",
                        },
                        {
                            createdAt:
                                "desc",
                        },
                    ],
                }),

                prisma.storeSetting.findUnique({
                    where: {
                        id: 1,
                    },
                    /*
                     * Explicit select: only the store identity fields
                     * this route uses. Avoids pulling server-only
                     * settings (incl. the TikTok Access Token) into
                     * memory.
                     */
                    select: {
                        id: true,
                        storeName: true,
                        rajaOngkirDestinationId: true,
                    },
                }),
            ]);

        if (!product) {
            return jsonError(
                "Produk tidak ditemukan.",
                404
            );
        }

        const variant =
            product.variants[0];

        if (!variant) {
            return jsonError(
                "Variant produk tidak ditemukan.",
                404
            );
        }

        // ==========================================
        // MARKETING PRICING
        // ==========================================

        const rawPrice =
            decimalToNumber(
                variant.price
            );

        const [pricing] =
            await resolveBatchPrices([
                {
                    productId,
                    variantId,
                    originalPrice: rawPrice,
                    quantity,
                    category: product.category,
                },
            ]);

        const price =
            pricing?.effectivePrice ?? rawPrice;

        const subtotal =
            price * quantity;

        const totalWeight =
            Math.max(
                1,
                Number(
                    variant.weight
                ) * quantity
            );

        if (!store) {
            return jsonError(
                "Pengaturan toko belum tersedia.",
                500
            );
        }

        return jsonSuccess({
            product: {
                id: product.id,
                name: product.name,
                slug: product.slug,
                image: product.image,
            },

            variant: {
                id: variant.id,
                name: variant.name,
                image: variant.image,
                price,
                originalPrice:
                    pricing?.originalPrice ?? rawPrice,
                discount:
                    pricing?.discountAmount ?? 0,
                hasDiscount:
                    (pricing?.discountAmount ?? 0) > 0,
                priceSource:
                    pricing?.source ?? "ORIGINAL",
                flashSaleName:
                    pricing?.flashSaleName ?? null,
                flashSaleEndAt:
                    pricing?.flashSaleEndAt?.toISOString() ?? null,
                weight:
                    variant.weight,
                stock:
                    variant.stock,
            },

            quantity,

            subtotal,

            totalWeight,

            addresses:
                addresses.map(
                    (address) => ({
                        id: address.id,
                        label:
                            address.label,
                        recipientName:
                            address.recipientName,
                        phone:
                            address.phone,
                        address:
                            address.address,
                        province:
                            address.province,
                        city:
                            address.city,
                        district:
                            address.district,
                        subdistrict:
                            address.subdistrict,
                        postalCode:
                            address.postalCode,
                        provinceId:
                            address.provinceId,
                        regencyId:
                            address.regencyId,
                        districtId:
                            address.districtId,
                        villageId:
                            address.villageId,
                        rajaOngkirDestinationId:
                            address.rajaOngkirDestinationId,
                        latitude:
                            address.latitude?.toString() ??
                            null,
                        longitude:
                            address.longitude?.toString() ??
                            null,
                        isDefault:
                            address.isDefault,
                    })
                ),

            store: {
                id: store.id,
                storeName:
                    store.storeName,
                rajaOngkirDestinationId:
                    store.rajaOngkirDestinationId,
            },
        });
    } catch (error) {
        console.error(
            "GET /api/buy-now ERROR:",
            error
        );

        return jsonError(
            "Gagal mengambil data Buy Now.",
            500
        );
    }
}

/*
 * ============================================================
 * POST /api/buy-now
 * ============================================================
 *
 * Khusus COD.
 *
 * Untuk payment non-COD, frontend menggunakan:
 *
 * /api/buy-now/ipaymu
 */
export async function POST(
    request: NextRequest
) {
    try {
        const user =
            await getCurrentUser();

        if (!user) {
            return jsonError(
                "Anda harus login terlebih dahulu.",
                401
            );
        }

        // Rate limiting for order creation
        const rateLimit = rateLimiters.orderCreation(user.id!);
        if (!rateLimit.allowed) {
            return jsonError(
                "Terlalu banyak permintaan. Coba lagi nanti.",
                429
            );
        }

        let body: BuyNowPostBody;

        try {
            body =
                await request.json();
        } catch {
            return jsonError(
                "Body request tidak valid."
            );
        }

        const productId =
            Number(body.productId);

        const variantId =
            Number(body.variantId);

        const quantity =
            Number(body.quantity);

        const addressId =
            String(
                body.addressId || ""
            );

        const paymentMethod =
            body.paymentMethod;

        const voucherCode =
            normalizeVoucherCode(
                body.voucherCode
            );

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return jsonError(
                "Product ID tidak valid."
            );
        }

        if (
            !Number.isInteger(variantId) ||
            variantId <= 0
        ) {
            return jsonError(
                "Variant ID tidak valid."
            );
        }

        if (
            !Number.isInteger(quantity) ||
            quantity <= 0 ||
            quantity > 100
        ) {
            return jsonError(
                "Quantity tidak valid."
            );
        }

        if (!addressId) {
            return jsonError(
                "Alamat pengiriman wajib dipilih."
            );
        }

        if (
            paymentMethod !==
            "COD"
        ) {
            return jsonError(
                "Gunakan endpoint iPaymu untuk pembayaran non-COD."
            );
        }

        if (
            !body.shipping ||
            typeof body.shipping !==
            "object"
        ) {
            return jsonError(
                "Pengiriman wajib dipilih."
            );
        }

        const shippingCost =
            getShippingCost(
                body.shipping
            );

        const shippingCourier =
            getShippingCourier(
                body.shipping
            );

        const shippingService =
            getShippingService(
                body.shipping
            );        const affiliateCode =
            getReferralCode(
                request.headers.get("cookie")
            );

        const result =
            await createCheckoutOrder({
                userId: user.id,
                mode: "BUY_NOW",
                addressId,
                shipping: body.shipping,
                paymentMethod: "COD",
                voucherCode: voucherCode ?? undefined,
                productId,
                variantId,
                quantity,
                affiliateCode,
                spinWheelSpinId: typeof body.spinWheelSpinId === "number" ? body.spinWheelSpinId : null,
                attribution: readOrderAttribution(request),
            });

        return jsonSuccess(
            {
                id: result.order.id,

                orderNumber:
                    result.order.orderNumber,

                status:
                    result.order.status,

                paymentStatus:
                    result.order.paymentStatus,

                paymentMethod:
                    result.order.paymentMethod,

                subtotal: result.subtotal,
                shippingCost: result.shippingCost,
                discount: result.discount,
                total: result.grossAmount,
            },
            201
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "BUY_NOW_COD",
                message: error instanceof Error ? error.message : "Unknown error",
                timestamp: new Date().toISOString(),
            })
        );

        return jsonError("Gagal membuat pesanan.", 400);
    }
}