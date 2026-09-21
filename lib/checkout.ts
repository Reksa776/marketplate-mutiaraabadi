import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import {
    incrementVoucherUsage,
    incrementVoucherUserUsage,
    validateAndCalculateVoucherEnhanced,
    type VoucherValidationItem,
} from "@/lib/voucher";
import {
    recordFlashSalePurchase,
    hasReachedFlashSaleLimit,
} from "./marketing/flash-sale";
import {
    resolveBatchPrices,
    resolveOrderCampaignId,
} from "./marketing/batch-pricing";
import {
    calculateShippingDiscount,
    reserveShippingDiscountUsage,
} from "./marketing/shipping-discount";
import {
    calculateDomesticCost,
} from "./rajaongkir";
import {
    calculateSpinRewardDiscount,
} from "./spin-wheel";
import { formatProductName } from "./payment/ipaymu";
import { PAYMENT_EXPIRY_GRACE_MS } from "./payment/order-payment";

export type CheckoutMode =
    | "CART"
    | "BUY_NOW";

export type CheckoutPaymentMethod =
    | "COD"
    | "BANK_TRANSFER"
    | "E_WALLET"
    | "QRIS";

export type ShippingOption = {
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

export type CheckoutItem = {
    productId: number;
    variantId: number;
    productName: string;
    variantName: string;
    price: number;
    quantity: number;
    subtotal: number;
};

export type MidtransItem = {
    id: string;
    price: number;
    quantity: number;
    name: string;
};

export type CreateCheckoutInput = {
    userId: string;

    mode?: CheckoutMode;

    addressId: string;

    shipping: ShippingOption;

    paymentMethod: CheckoutPaymentMethod;

    voucherCode?: string | null;

    /**
     * Affiliate referral code from cookie.
     * Server validates and resolves — never
     * trust affiliateId from client.
     */
    affiliateCode?: string | null;

    /**
     * Spin wheel reward spin ID.
     * Server validates ownership and eligibility.
     */
    spinWheelSpinId?: number | null;

    productId?: unknown;
    variantId?: unknown;
    quantity?: unknown;

    /**
     * Selected cart item IDs for selective checkout.
     * Only cart items whose IDs are in this array
     * will be processed. If not provided, all cart
     * items are processed (backward compatible).
     */
    selectedCartItemIds?: number[];
};

export type CreatedCheckout = {
    order: any;

    checkoutItems: CheckoutItem[];

    itemDetails: MidtransItem[];

    subtotal: number;

    shippingCost: number;

    discount: number;

    spinWheelDiscount: number;

    grossAmount: number;

    cartId: number | null;
};

/*
 * ==========================================
 * SHIPPING COST
 * ==========================================
 */

export function getShippingCost(
    shipping: ShippingOption
): number {
    const value = Number(
        shipping.cost ??
            shipping.price ??
            shipping.shipping_cost ??
            0
    );

    return Number.isFinite(value) &&
        value >= 0
        ? Math.round(value)
        : NaN;
}

/*
 * ==========================================
 * SERVER-SIDE SHIPPING COST VERIFICATION
 * ==========================================
 *
 * Verifies shipping cost against RajaOngkir
 * API using server-authoritative data:
 * - origin from StoreSetting.rajaOngkirDestinationId
 * - destination from UserAddress.rajaOngkirDestinationId
 * - weight from ProductVariant.weight × quantity
 *
 * Client-provided shipping.cost is IGNORED.
 * Server determines the correct cost.
 */
export async function verifyShippingCost({
    origin,
    destination,
    totalWeight,
    courier,
    service,
}: {
    origin: number;
    destination: number;
    totalWeight: number;
    courier: string;
    service: string;
}): Promise<number> {
    if (
        !Number.isInteger(origin) ||
        origin <= 0
    ) {
        throw new Error(
            "Origin pengiriman tidak valid."
        );
    }

    if (
        !Number.isInteger(destination) ||
        destination <= 0
    ) {
        throw new Error(
            "Destination pengiriman tidak valid."
        );
    }

    if (
        !Number.isFinite(totalWeight) ||
        totalWeight <= 0
    ) {
        throw new Error(
            "Berat paket tidak valid."
        );
    }

    if (
        !courier ||
        typeof courier !== "string"
    ) {
        throw new Error(
            "Kurir tidak valid."
        );
    }

    if (
        !service ||
        typeof service !== "string"
    ) {
        throw new Error(
            "Layanan pengiriman tidak valid."
        );
    }

    try {
        const result =
            await calculateDomesticCost({
                origin,
                destination,
                weight: Math.ceil(totalWeight),
                courier: courier.toLowerCase(),
            });

        const shippingOptions =
            Array.isArray(result)
                ? result
                : [];

        const matchedOption =
            shippingOptions.find(
                (opt: any) =>
                    String(opt.code ?? "")
                        .toLowerCase() ===
                        courier.toLowerCase() &&
                    String(opt.service ?? "")
                        .toUpperCase() ===
                        service.toUpperCase()
            );

        if (
            !matchedOption
        ) {
            throw new Error(
                `Layanan ${courier.toUpperCase()} ${service} tidak tersedia untuk pengiriman ini. Silakan pilih ulang layanan pengiriman.`
            );
        }

        const verifiedCost =
            Number(matchedOption.cost);

        if (
            !Number.isFinite(verifiedCost) ||
            verifiedCost < 0
        ) {
            throw new Error(
                "Biaya pengiriman dari provider tidak valid."
            );
        }

        return Math.round(verifiedCost);
    } catch (error: any) {
        if (
            error.message?.includes(
                "tidak tersedia"
            ) ||
            error.message?.includes(
                "tidak valid"
            )
        ) {
            throw error;
        }

        throw new Error(
            "Gagal memverifikasi biaya pengiriman. Silakan coba lagi."
        );
    }
}

/*
 * ==========================================
 * MIDTRANS ENABLED PAYMENTS
 * ==========================================
 */

export function getEnabledPayments(
    paymentMethod: Exclude<
        CheckoutPaymentMethod,
        "COD"
    >
) {
    switch (paymentMethod) {
        case "BANK_TRANSFER":
            return [
                "bca_va",
                "bni_va",
                "bri_va",
                "permata_va",
            ];

        case "E_WALLET":
            return [
                "gopay",
                "shopeepay",
            ];

        case "QRIS":
            return ["qris"];

        default:
            return [];
    }
}

/*
 * ==========================================
 * ORDER NUMBER
 * ==========================================
 */

function makeOrderNumber(
    paymentMethod: CheckoutPaymentMethod,
    mode: CheckoutMode
) {
    const prefix =
        paymentMethod === "COD"
            ? "ORD"
            : mode === "BUY_NOW"
                ? "PAY-BN"
                : "PAY-CART";

    /*
     * Use crypto.randomUUID() for uniqueness.
     * First 8 hex chars = 4.2B possibilities per millisecond.
     * Format: {prefix}-{timestamp}-{8-char hex}
     */
    const uniqueSuffix = crypto
        .randomUUID()
        .replace(/-/g, "")
        .substring(0, 8);

    return `${prefix}-${Date.now()}-${uniqueSuffix}`;
}

/*
 * ==========================================
 * PARSE INTEGER
 * ==========================================
 */

function parsePositiveInteger(
    value: unknown
): number | null {
    const number = Number(value);

    if (
        !Number.isInteger(number) ||
        number <= 0
    ) {
        return null;
    }

    return number;
}

/*
 * ==========================================
 * BATCH MARKETING PRICING
 * ==========================================
 *
 * Resolves marketing prices for checkout items
 * using batch queries instead of per-item queries.
 *
 * Pricing priority (Phase 3 rules):
 * 1. FLASH_SALE — highest, overrides all
 * 2. PRODUCT_DISCOUNT — per-product/variant
 * 3. CAMPAIGN_DISCOUNT — campaign-wide
 * 4. ORIGINAL — raw variant.price
 *
 * Fixes E4: Pricing N+1 from Phase 4 audit.
 * Instead of N*4 queries, uses 4 batch queries
 * regardless of item count.
 */
async function resolveBatchMarketingPricing(
    items: CheckoutItem[]
) {
    if (items.length === 0) return;

    const results = await resolveBatchPrices(
        items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            originalPrice: i.price,
            quantity: i.quantity,
        }))
    );

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const pricing = results[idx];
        if (!pricing) continue;

        item.price = pricing.effectivePrice;
        item.subtotal = pricing.effectivePrice * item.quantity;

        if (pricing.flashSaleId) {
            (item as any).flashSaleId = pricing.flashSaleId;
        }
    }
}

/*
 * ==========================================
 * MIDTRANS ITEMS
 * ==========================================
 */

function createMidtransItemDetails(
    checkoutItems: CheckoutItem[],
    shippingCost: number,
    discount: number,
    voucherId: number | null,
    voucherCode: string | null,
    spinWheelDiscount: number = 0
): MidtransItem[] {
    const itemDetails =
        checkoutItems.map(
            (item) => ({
                id:
                    `PRODUCT-${item.productId}-VARIANT-${item.variantId}`,

                price:
                    item.price,

                quantity:
                    item.quantity,

                name:
                    formatProductName(
                        item.productName,
                        item.variantName
                    ).substring(0, 50),
            })
        );

    if (shippingCost > 0) {
        itemDetails.push({
            id: "SHIPPING",

            price:
                shippingCost,

            quantity: 1,

            name:
                "Biaya Pengiriman",
        });
    }

    if (
        discount > 0 &&
        voucherId !== null
    ) {
        itemDetails.push({
            id:
                `VOUCHER-${voucherId}`,

            price:
                -discount,

            quantity: 1,

            name:
                `Voucher ${voucherCode ?? ""}`.substring(
                    0,
                    50
                ),
        });
    }

    // Spin wheel reward discount as negative price item
    if (spinWheelDiscount > 0) {
        itemDetails.push({
            id: "SPIN_WHEEL_REWARD",

            price: -spinWheelDiscount,

            quantity: 1,

            name: "Reward Spin Wheel",
        });
    }

    return itemDetails;
}

/*
 * ==========================================
 * VALIDATE MIDTRANS TOTAL
 * ==========================================
 */

function validateItemDetailsTotal(
    itemDetails: MidtransItem[],
    grossAmount: number
) {
    const itemDetailsTotal =
        itemDetails.reduce(
            (sum, item) =>
                sum +
                item.price *
                    item.quantity,
            0
        );

    if (
        itemDetailsTotal !==
        grossAmount
    ) {
        throw new Error(
            "Total item Midtrans tidak sesuai dengan gross amount."
        );
    }
}

/*
 * ==========================================
 * CLEANUP OLD MIDTRANS ATTEMPTS
 * ==========================================
 *
 * Dipanggil sebelum membuat payment
 * attempt baru.
 *
 * Contoh:
 *
 * BANK TRANSFER
 *      ↓
 * user X
 *      ↓
 * E-WALLET
 *
 * Order sebelumnya dibatalkan.
 *
 * STOCK dikembalikan.
 * VOUCHER dikembalikan.
 *
 * CART TIDAK disentuh.
 *
 * Ini penting karena cart memang
 * sengaja tetap berisi barang selama
 * pembayaran belum berhasil.
 */

/**
 * A pending provider order is still payable while its provider
 * expiry window (plus grace) is open. Orders with no recorded expiry
 * but a real instruction (paymentNo/paymentUrl) are treated as
 * payable too: we must never cancel something the customer can still
 * pay, otherwise a late payment becomes a paid-but-cancelled order.
 */
export function isPendingOrderStillPayable(
    order: {
        paymentNo: string | null;
        paymentUrl: string | null;
        paymentExpiresAt: Date | null;
    },
    now: number = Date.now()
): boolean {
    if (!order.paymentExpiresAt) {
        return Boolean(order.paymentNo || order.paymentUrl);
    }

    return (
        order.paymentExpiresAt.getTime() +
            PAYMENT_EXPIRY_GRACE_MS >
        now
    );
}

export async function cleanupPendingCheckoutOrders(
    userId: string
) {
    const pendingOrders =
        await prisma.order.findMany({
            where: {
                userId,

                paymentMethod: {
                    in: [
                        "BANK_TRANSFER",
                        "E_WALLET",
                        "QRIS",
                    ],
                },

                status: "PENDING",

                paymentStatus: "PENDING",
            },

            select: {
                id: true,
                orderNumber: true,
                paymentNo: true,
                paymentUrl: true,
                paymentExpiresAt: true,
            },

            orderBy: {
                createdAt: "asc",
            },

            take: 10,
        });

    const now = Date.now();

    for (const order of pendingOrders) {
        /*
         * Only cancel orders whose payment window has actually
         * closed. A still-payable instruction is left PENDING so a
         * late (valid) payment is not rejected as paid-but-cancelled
         * just because the customer started another checkout.
         */
        if (isPendingOrderStillPayable(order, now)) {
            continue;
        }

        try {
            await rollbackCheckoutOrder(
                order.id,
                {
                    restoreCart: false,
                }
            );
        } catch (error) {
            console.error(
                `CLEANUP PENDING ORDER FAILED: orderNumber=${order.orderNumber} orderId=${order.id}`,
                error
            );
        }
    }
}

/*
 * ==========================================
 * CREATE CHECKOUT ORDER
 * ==========================================
 */

/*
 * ==========================================
 * STRUCTURED LOGGING (OBSERVABILITY)
 * ==========================================
 *
 * Logs checkout events for debugging.
 * Never logs secrets, tokens, or payment credentials.
 */
function logCheckoutEvent(
    event: string,
    data: Record<string, unknown>
) {
    console.log(
        `[CHECKOUT] ${event}`,
        JSON.stringify(data)
    );
}

export async function createCheckoutOrder(
    input: CreateCheckoutInput
): Promise<CreatedCheckout> {
    const mode =
        input.mode ?? "CART";

    /*
     * ==========================================
     * VALIDATE MODE
     * ==========================================
     */

    if (
        mode !== "CART" &&
        mode !== "BUY_NOW"
    ) {
        throw new Error(
            "Mode checkout tidak valid."
        );
    }

    /*
     * ==========================================
     * VALIDATE SHIPPING
     * ==========================================
     */

    if (
        !input.shipping ||
        typeof input.shipping !==
            "object"
    ) {
        throw new Error(
            "Layanan pengiriman wajib dipilih."
        );
    }

    // ==========================================
    // SHIPPING INPUT VALIDATION
    // ==========================================
    //
    // Basic format check.
    // Actual cost is determined server-side via
    // RajaOngkir verification below.

    const clientShippingCost =
        getShippingCost(
            input.shipping
        );

    if (
        !Number.isFinite(
            clientShippingCost
        ) ||
        clientShippingCost < 0
    ) {
        throw new Error(
            "Biaya pengiriman tidak valid."
        );
    }

    /*
     * ==========================================
     * ADDRESS
     * ==========================================
     *
     * Server queries address from DB.
     * Client-provided address fields are ignored.
     */

    const address =
        await prisma.userAddress.findFirst(
            {
                where: {
                    id:
                        input.addressId,

                    userId:
                        input.userId,
                },
            }
        );

    if (!address) {
        const error =
            new Error(
                "Alamat tidak ditemukan."
            );

        (error as any).status =
            404;

        throw error;
    }

    if (
        !address.rajaOngkirDestinationId
    ) {
        throw new Error(
            "Alamat tidak memiliki data wilayah pengiriman."
        );
    }

    /*
     * ==========================================
     * BUY NOW PARAMETER
     * ==========================================
     */

    let productIdNumber:
        | number
        | null = null;

    let variantIdNumber:
        | number
        | null = null;

    let quantityNumber:
        | number
        | null = null;

    if (
        mode === "BUY_NOW"
    ) {
        productIdNumber =
            parsePositiveInteger(
                input.productId
            );

        variantIdNumber =
            parsePositiveInteger(
                input.variantId
            );

        quantityNumber =
            parsePositiveInteger(
                input.quantity
            );

        if (
            productIdNumber === null
        ) {
            throw new Error(
                "Produk tidak valid."
            );
        }

        if (
            variantIdNumber === null
        ) {
            throw new Error(
                "Variant tidak valid."
            );
        }

        if (
            quantityNumber === null
        ) {
            throw new Error(
                "Quantity tidak valid."
            );
        }
    }

    /*
     * ==========================================
     * SERVER-SIDE SHIPPING VERIFICATION
     * ==========================================
     *
     * Determine shipping cost from RajaOngkir
     * using server-authoritative data:
     * - origin: StoreSetting.rajaOngkirDestinationId
     * - destination: UserAddress.rajaOngkirDestinationId
     * - weight: ProductVariant.weight × quantity
     * - courier/service: from client (user's choice)
     *
     * Client-provided shipping.cost is IGNORED.
     */

    const storeSetting =
        await prisma.storeSetting.findUnique({
            where: { id: 1 },
            select: {
                rajaOngkirDestinationId: true,
            },
        });

    if (
        !storeSetting?.rajaOngkirDestinationId
    ) {
        throw new Error(
            "Pengaturan toko belum dikonfigurasi."
        );
    }

    let totalWeight = 0;

    if (
        mode === "BUY_NOW"
    ) {
        const variant =
            await prisma.productVariant.findUnique({
                where: {
                    id: variantIdNumber!,
                },
                select: {
                    weight: true,
                },
            });

        if (!variant) {
            throw new Error(
                "Produk tidak ditemukan."
            );
        }

        totalWeight =
            Math.round(Number(variant.weight)) *
            quantityNumber!;
    } else {
        const cartItems =
            await prisma.cartItem.findMany({
                where: {
                    cart: {
                        userId: input.userId,
                    },
                },
                select: {
                    quantity: true,
                    variant: {
                        select: {
                            weight: true,
                        },
                    },
                },
            });

        if (
            cartItems.length === 0
        ) {
            throw new Error(
                "Keranjang kosong."
            );
        }

        totalWeight = cartItems.reduce(
            (sum, item) =>
                sum +
                Math.round(
                    Number(item.variant.weight)
                ) *
                Number(item.quantity),
            0
        );
    }

    if (
        totalWeight <= 0
    ) {
        throw new Error(
            "Total berat paket tidak valid."
        );
    }

    const courier =
        input.shipping.courier ??
        input.shipping.code ??
        "";

    const service =
        input.shipping.service ??
        input.shipping.service_name ??
        "";

    const verifiedShippingCost =
        await verifyShippingCost({
            origin:
                storeSetting.rajaOngkirDestinationId,
            destination:
                address.rajaOngkirDestinationId,
            totalWeight,
            courier,
            service,
        });

    /*
     * ==========================================
     * IMPORTANT
     * ==========================================
     *
     * Cleanup pending attempt lama
     * SEBELUM membuat attempt baru.
     *
     * Cart tetap ada.
     */

    if (
        input.paymentMethod !==
        "COD"
    ) {
        await cleanupPendingCheckoutOrders(
            input.userId
        );
    }

    /*
     * ==========================================
     * ORDER NUMBER
     * ==========================================
     */

    const orderNumber =
        makeOrderNumber(
            input.paymentMethod,
            mode
        );

    /*
     * ==========================================
     * DATABASE TRANSACTION
     * ==========================================
     */

    return prisma.$transaction(
        async (tx) => {
            let checkoutItems:
                CheckoutItem[] = [];

            let cartId:
                | number
                | null = null;

            /*
             * ==========================================
             * BUY NOW
             * ==========================================
             */

            if (
                mode ===
                "BUY_NOW"
            ) {
                const variant =
                    await tx.productVariant.findFirst(
                        {
                            where: {
                                id:
                                    variantIdNumber!,

                                productId:
                                    productIdNumber!,
                            },

                            include: {
                                product:
                                    true,
                            },
                        }
                    );

                if (!variant) {
                    throw new Error(
                        "Produk atau variant tidak ditemukan."
                    );
                }

                if (
                    variant.stock <
                    quantityNumber!
                ) {
                    throw new Error(
                        `Stok ${variant.product.name} - ${variant.name} tidak mencukupi.`
                    );
                }

                const price =
                    Math.round(
                        Number(
                            variant.price
                        )
                    );

                if (
                    !Number.isFinite(
                        price
                    ) ||
                    price < 0
                ) {
                    throw new Error(
                        "Harga produk tidak valid."
                    );
                }

                checkoutItems = [
                    {
                        productId:
                            variant.productId,

                        variantId:
                            variant.id,

                        productName:
                            variant.product.name,

                        variantName:
                            variant.name,

                        price,

                        quantity:
                            quantityNumber!,

                        subtotal:
                            price *
                            quantityNumber!,
                    },
                ];
            }

            /*
             * ==========================================
             * CART
             * ==========================================
             */

            if (
                mode === "CART"
            ) {
                const cart =
                    await tx.cart.findUnique(
                        {
                            where: {
                                userId:
                                    input.userId,
                            },

                            include: {
                                items: {
                                    include: {
                                        product:
                                            true,

                                        variant:
                                            true,
                                    },
                                },
                            },
                        }
                    );

                if (
                    !cart ||
                    cart.items.length ===
                        0
                ) {
                    throw new Error(
                        "Keranjang kosong."
                    );
                }

                cartId =
                    cart.id;

                // ==========================================
                // SELECTIVE CHECKOUT FILTER
                // ==========================================
                // If selectedCartItemIds provided,
                // only process those items.
                // Validate ownership: selected IDs must
                // belong to this user's cart.

                let cartItemsToProcess = cart.items;

                if (
                    input.selectedCartItemIds &&
                    input.selectedCartItemIds.length > 0
                ) {
                    const selectedSet = new Set(
                        input.selectedCartItemIds
                    );

                    cartItemsToProcess = cart.items.filter(
                        (item) =>
                            selectedSet.has(item.id)
                    );

                    if (
                        cartItemsToProcess.length === 0
                    ) {
                        throw new Error(
                            "Tidak ada item keranjang yang dipilih atau item tidak valid."
                        );
                    }

                    if (
                        cartItemsToProcess.length !==
                        input.selectedCartItemIds.length
                    ) {
                        logCheckoutEvent(
                            "SELECTED_ITEMS_FILTERED",
                            {
                                requested:
                                    input.selectedCartItemIds.length,
                                matched:
                                    cartItemsToProcess.length,
                            }
                        );
                    }
                }

                for (
                    const item of
                        cartItemsToProcess
                ) {
                    const quantity =
                        Number(
                            item.quantity
                        );

                    if (
                        !Number.isInteger(
                            quantity
                        ) ||
                        quantity <= 0
                    ) {
                        throw new Error(
                            `Quantity ${item.product.name} - ${item.variant.name} tidak valid.`
                        );
                    }

                    const price =
                        Math.round(
                            Number(
                                item.variant
                                    .price
                            )
                        );

                    if (
                        !Number.isFinite(
                            price
                        ) ||
                        price < 0
                    ) {
                        throw new Error(
                            `Harga ${item.product.name} - ${item.variant.name} tidak valid.`
                        );
                    }

                    if (
                        quantity >
                        item.variant.stock
                    ) {
                        throw new Error(
                            `Stok ${item.product.name} - ${item.variant.name} tidak mencukupi.`
                        );
                    }

                    checkoutItems.push({
                        productId:
                            item.productId,

                        variantId:
                            item.variantId,

                        productName:
                            item.product.name,

                        variantName:
                            item.variant.name,

                        price,

                        quantity,

                        subtotal:
                            price *
                            quantity,
                    });
                }
            }

            /*
             * ==========================================
             * MARKETING PRICING (BATCH)
             * ==========================================
             *
             * Resolve marketing-adjusted prices for
             * all items using batch queries (fixes E4).
             *
             * Priority:
             * Flash Sale > Product Discount > Campaign > Original
             */
            await resolveBatchMarketingPricing(
                checkoutItems
            );

            /*
             * ==========================================
             * CAMPAIGN CONTEXT FOR VOUCHER
             * ==========================================
             *
             * Resolve which campaign applies to this
             * order. Needed for campaign-specific voucher
             * validation — vouchers with a campaignId
             * must be applied within the matching campaign.
             */
            const orderCampaignId = await resolveOrderCampaignId(
                checkoutItems.map((i) => ({
                    productId: i.productId,
                }))
            );

            /*
             * ==========================================
             * SUBTOTAL
             * ==========================================
             */

            const subtotal =
                checkoutItems.reduce(
                    (
                        sum,
                        item
                    ) =>
                        sum +
                        item.subtotal,
                    0
                );

            if (
                subtotal <= 0
            ) {
                throw new Error(
                    "Subtotal tidak valid."
                );
            }

            /*
             * ==========================================
             * MUTUAL EXCLUSION: VOUCHER XOR SPIN WHEEL
             * ==========================================
             *
             * Business rule: satu order hanya boleh
             * menggunakan SATU jenis reward:
             * - Regular Voucher
             * - Spin Wheel Reward
             *
             * Tidak boleh keduanya sekaligus.
             * Validasi ini wajib di server, bukan hanya UI.
             */

            const hasVoucher =
                typeof input.voucherCode === "string" &&
                input.voucherCode.trim().length > 0;

            const hasSpinWheel =
                typeof input.spinWheelSpinId === "number" &&
                input.spinWheelSpinId > 0;

            if (hasVoucher && hasSpinWheel) {
                throw new Error(
                    "Silakan pilih salah satu voucher atau reward Spin Wheel."
                );
            }

            /*
             * ==========================================
             * VOUCHER
             * ==========================================
             */

            let voucherId:
                | number
                | null = null;

            let appliedVoucherCode:
                | string
                | null = null;

            let discount = 0;

            if (
                typeof input.voucherCode ===
                    "string" &&
                input.voucherCode.trim()
            ) {
                /*
                 * ==========================================
                 * BUILD VOUCHER VALIDATION ITEMS
                 * ==========================================
                 *
                 * Fetch product categories for enhanced
                 * voucher validation (product/category
                 * restrictions, per-user limits).
                 */
                const productIds = [...new Set(
                    checkoutItems.map((i) => i.productId)
                )];
                const products = await tx.product.findMany({
                    where: { id: { in: productIds } },
                    select: { id: true, category: true },
                });
                const categoryMap = new Map(
                    products.map((p) => [p.id, p.category])
                );

                const voucherItems: VoucherValidationItem[] =
                    checkoutItems.map((i) => ({
                        productId: i.productId,
                        variantId: i.variantId,
                        quantity: i.quantity,
                        price: i.price,
                        category: categoryMap.get(i.productId) ?? null,
                    }));

                const voucherResult =
                    await validateAndCalculateVoucherEnhanced(
                        input.voucherCode,
                        subtotal,
                        voucherItems,
                        input.userId,
                        orderCampaignId,
                        tx
                    );

                if (
                    !voucherResult.valid
                ) {
                    throw new Error(
                        voucherResult.message
                    );
                }

                voucherId =
                    voucherResult
                        .voucher.id;

                appliedVoucherCode =
                    voucherResult
                        .voucher.code;

                discount =
                    voucherResult.discount;

                const voucherUsed =
                    await incrementVoucherUsage(
                        tx,
                        voucherId
                    );

                if (!voucherUsed) {
                    logCheckoutEvent(
                        "VOUCHER_QUOTA_EXHAUSTED",
                        {
                            voucherId,
                        }
                    );
                    throw new Error(
                        "Kuota voucher baru saja habis. Silakan gunakan kode voucher lain."
                    );
                }

                /*
                 * ==========================================
                 * VOUCHER PER-USER USAGE LIMIT
                 * ==========================================
                 *
                 * Record per-user usage after successful
                 * global quota increment. Uses atomic upsert.
                 *
                 * BUG FIX (P2-1): After increment, validate the
                 * returned count against maxUsagePerUser. This
                 * catches the race condition where two concurrent
                 * transactions both read stale usageCount.
                 */
                const newUsageCount = await incrementVoucherUserUsage(
                    tx,
                    voucherId,
                    input.userId
                );

                // Post-increment validation: fetch limit and check
                const voucherRecord = await tx.voucher.findUnique({
                    where: { id: voucherId },
                    select: { maxUsagePerUser: true },
                });

                if (
                    voucherRecord?.maxUsagePerUser &&
                    newUsageCount > voucherRecord.maxUsagePerUser
                ) {
                    throw new Error(
                        `Anda sudah mencapai batas penggunaan voucher ini (${voucherRecord.maxUsagePerUser}x).`
                    );
                }
            }

            /*
             * ==========================================
             * SHIPPING DISCOUNT
             * ==========================================
             */

            let finalShippingCost = verifiedShippingCost;
            let shippingDiscountAmount = 0;
            let shippingDiscountName: string | null = null;
            let shippingDiscountId: number | null = null;

            /*
             * ==========================================
             * F9: PROMO-CODE PRECEDENCE
             * ==========================================
             *
             * There is a single promo-code input. If that code was
             * already accepted as a VOUCHER (voucherId !== null),
             * it must NOT simultaneously activate a shipping
             * discount — otherwise one code yields two discounts.
             * Codes that are NOT valid vouchers may still act as
             * shipping-discount codes.
             */
            const shippingDiscountCode =
                voucherId !== null
                    ? null
                    : typeof input.voucherCode === "string" &&
                        input.voucherCode.trim()
                      ? input.voucherCode.trim()
                      : null;

            try {
                const shippingDiscountResult =
                    await calculateShippingDiscount(
                        verifiedShippingCost,
                        subtotal,
                        shippingDiscountCode
                    );

                if (shippingDiscountResult) {
                    /*
                     * F9: per-user usage cap (best-effort pre-check;
                     * the CAS below is authoritative for global quota
                     * and rolls back with the order).
                     */
                    let withinUserCap = true;
                    if (shippingDiscountResult.maxUsagePerUser) {
                        const usedByUser =
                            await tx.order.count({
                                where: {
                                    userId: input.userId,
                                    shippingDiscountId:
                                        shippingDiscountResult.shippingDiscountId,
                                    status: {
                                        notIn: [
                                            "CANCELLED",
                                            "REFUND_PENDING",
                                        ],
                                    },
                                },
                            });

                        withinUserCap =
                            usedByUser <
                            shippingDiscountResult.maxUsagePerUser;
                    }

                    if (withinUserCap) {
                        // Atomic global-quota reservation (CAS).
                        const reserved =
                            await reserveShippingDiscountUsage(
                                tx,
                                shippingDiscountResult.shippingDiscountId
                            );

                        if (reserved) {
                            shippingDiscountId =
                                shippingDiscountResult.shippingDiscountId;
                            finalShippingCost =
                                shippingDiscountResult.finalShippingCost;
                            shippingDiscountAmount =
                                shippingDiscountResult.discountAmount;
                            shippingDiscountName =
                                shippingDiscountResult.name;
                        }
                    }
                }
            } catch {
                // Shipping discount failure is non-fatal —
                // continue with original shipping cost
            }

            /*
             * ==========================================
             * SPIN WHEEL REWARD DISCOUNT
             * ==========================================
             *
             * If user applies a spin wheel reward, validate
             * server-side and calculate discount. Cannot be
             * combined with voucher discount.
             */

            let spinWheelDiscount = 0;
            let spinWheelSpinId: number | null = null;
            let spinWheelRewardType: string | null = null;
            let finalShippingCost2 = finalShippingCost;

            if (
                input.spinWheelSpinId &&
                typeof input.spinWheelSpinId === "number"
            ) {
                const spinRecord = await tx.spinWheelSpin.findUnique({
                    where: { id: input.spinWheelSpinId },
                    include: {
                        reward: true,
                        campaign: true,
                    },
                });

                if (
                    !spinRecord ||
                    spinRecord.userId !== input.userId
                ) {
                    throw new Error(
                        "Reward spin wheel tidak valid."
                    );
                }

                if (spinRecord.status !== "AVAILABLE") {
                    throw new Error(
                        "Reward spin wheel sudah digunakan atau kedaluwarsa."
                    );
                }

                if (
                    spinRecord.expiresAt &&
                    spinRecord.expiresAt < new Date()
                ) {
                    throw new Error(
                        "Reward spin wheel sudah kedaluwarsa."
                    );
                }

                const reward = spinRecord.reward;
                const rewardBase = subtotal - discount;

                if (reward.type === "FREE_SHIPPING") {
                    // Free shipping: set shipping to 0
                    finalShippingCost2 = 0;
                    spinWheelRewardType = "FREE_SHIPPING";
                } else if (
                    reward.type === "FIXED" ||
                    reward.type === "PERCENTAGE"
                ) {
                    spinWheelDiscount = calculateSpinRewardDiscount(
                        reward.type,
                        Number(reward.value),
                        reward.maxDiscount
                            ? Number(reward.maxDiscount)
                            : null,
                        rewardBase
                    );
                } else if (reward.type === "CASHBACK") {
                    // Cashback is not a direct discount
                    // at checkout time
                }

                spinWheelSpinId = spinRecord.id;

                // ==========================================
                // SAFE DIAGNOSTIC LOG (no secrets)
                // ==========================================
                logCheckoutEvent(
                    "SPIN_REWARD_CALC",
                    {
                        spinId: spinRecord.id,
                        rewardType: reward.type,
                        rewardValue: Number(reward.value),
                        rewardMaxDiscount: reward.maxDiscount ? Number(reward.maxDiscount) : null,
                        rewardBase,
                        spinWheelDiscount,
                        freeShipping: reward.type === "FREE_SHIPPING" ? finalShippingCost2 === 0 : false,
                        subtotal,
                        voucherDiscount: discount,
                    }
                );
            }

            finalShippingCost = finalShippingCost2;

            /*
             * ==========================================
             * TOTAL
             * ==========================================
             */

            const grossAmount =
                subtotal -
                discount -
                spinWheelDiscount +
                finalShippingCost;

            if (
                !Number.isInteger(
                    grossAmount
                ) ||
                grossAmount <= 0
            ) {
                throw new Error(
                    "Total pembayaran tidak valid."
                );
            }

            /*
             * ==========================================
             * MIDTRANS ITEM DETAILS
             * ==========================================
             */

            const itemDetails =
                createMidtransItemDetails(
                    checkoutItems,
                    finalShippingCost,
                    discount,
                    voucherId,
                    appliedVoucherCode,
                    spinWheelDiscount
                );

            if (
                input.paymentMethod !==
                "COD"
            ) {
                validateItemDetailsTotal(
                    itemDetails,
                    grossAmount
                );
            }

            /*
             * ==========================================
             * FLASH SALE STOCK RESERVATION
             * ==========================================
             *
             * Reserve flash sale stock atomically
             * BEFORE order creation. If insufficient,
             * transaction rolls back cleanly.
             */
            for (const item of
                checkoutItems) {
                const fsId = (item as any)
                    .flashSaleId as
                    number | undefined;
                if (fsId) {
                    const affectedRows =
                        await tx
                            .$executeRaw`
                            UPDATE flashsale
                            SET saleStock = saleStock - ${item.quantity},
                                soldCount = soldCount + ${item.quantity}
                            WHERE id = ${fsId}
                              AND isActive = true
                              AND saleStock >= ${item.quantity}
                        `;
                    if (affectedRows === 0) {
                        logCheckoutEvent(
                            "FLASH_SALE_STOCK_INSUFFICIENT",
                            {
                                flashSaleId: fsId,
                                variantId: item.variantId,
                                requested: item.quantity,
                            }
                        );
                        throw new Error(
                            `Stok flash sale ${item.productName} - ${item.variantName} tidak mencukupi. Silakan checkout ulang.`
                        );
                    }

                    /*
                     * ==========================================
                     * FLASH SALE PER-USER PURCHASE LIMIT
                     * ==========================================
                     *
                     * Record purchase and enforce per-user limit.
                     * This runs AFTER successful stock reservation.
                     * If limit exceeded, transaction rolls back.
                     */
                    await recordFlashSalePurchase(
                        tx,
                        fsId,
                        input.userId,
                        item.quantity
                    );

                    /*
                     * F5: Flash-sale items were skipped by the
                     * generic stock loop below (which `continue`s on
                     * flashSaleId), so Product.sold was NEVER
                     * incremented for flash purchases. Increment it
                     * here — once, in this branch only — so flash
                     * and non-flash items stay consistent.
                     */
                    if (item.productId != null) {
                        await tx.product.update({
                            where: {
                                id: item.productId,
                            },
                            data: {
                                sold: {
                                    increment:
                                        item.quantity,
                                },
                            },
                        });
                    }
                }
            }

            /*
             * ==========================================
             * CREATE ORDER
             * ==========================================
             */

            // Combine voucher discount + spin wheel discount
            const totalDiscount = discount + spinWheelDiscount;

            const order =
                await tx.order.create({
                    data: {
                        userId:
                            input.userId,

                        orderNumber,

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

                        postalCode:
                            address.postalCode,

                        latitude:
                            address.latitude ??
                            undefined,

                        longitude:
                            address.longitude ??
                            undefined,

                        subtotal,

                        shippingCost:
                            finalShippingCost,

                        total:
                            grossAmount,

                        discount: totalDiscount,

                        voucherId:
                            voucherId ??
                            undefined,

                        voucherCode:
                            appliedVoucherCode ??
                            undefined,

                        // F9: shipping-discount attribution
                        shippingDiscountId:
                            shippingDiscountId ??
                            undefined,

                        shippingDiscountName:
                            shippingDiscountName ??
                            undefined,

                        shippingDiscountAmount:
                            shippingDiscountAmount > 0
                                ? shippingDiscountAmount
                                : undefined,

                        // F18: keep the exact spin identity on the order
                        // (survives release-on-cancel, unlike spin.orderId)
                        originalSpinWheelSpinId:
                            spinWheelSpinId ??
                            undefined,

                        status:
                            "PENDING",

                        paymentMethod:
                            input.paymentMethod,

                        paymentStatus:
                            input.paymentMethod ===
                            "COD"
                                ? "UNPAID"
                                : "PENDING",

                        paymentReference:
                            orderNumber,

                        shippingCourier:
                            input.shipping
                                .courier ??
                            input.shipping
                                .code ??
                            null,

                        shippingService:
                            input.shipping
                                .service ??
                            input.shipping
                                .service_name ??
                            null,

                        items: {
                            create:
                                checkoutItems.map(
                                    (
                                        item
                                    ) => ({
                                        productId:
                                            item.productId,

                                        variantId:
                                            item.variantId,

                                        productName:
                                            item.productName,

                                        variantName:
                                            item.variantName,

                                        price:
                                            item.price,

                                        quantity:
                                            item.quantity,

                                        subtotal:
                                            item.subtotal,
                                    })
                                ),
                        },
                    },

                    include: {
                        items: true,
                    },
                });            /*
             * ==========================================
             * RESERVE STOCK
             * ==========================================
             *
             * Skip items that used flash sale —
             * flash sale stock was already reserved
             * atomically above.
             */

            for (
                const item of
                    checkoutItems
            ) {
                if ((item as any).flashSaleId) {
                    continue;
                }

                const stockUpdate =
                    await tx.productVariant.updateMany(
                        {
                            where: {
                                id:
                                    item.variantId,

                                stock: {
                                    gte:
                                        item.quantity,
                                },
                            },

                            data: {
                                stock: {
                                    decrement:
                                        item.quantity,
                                },
                            },
                        }
                    );

                if (
                    stockUpdate.count !==
                    1
                ) {
                    logCheckoutEvent(
                        "STOCK_INSUFFICIENT",
                        {
                            variantId:
                                item.variantId,
                            requested:
                                item.quantity,
                        }
                    );
                    throw new Error(
                        `Stok ${item.productName} - ${item.variantName} sudah berubah. Silakan checkout ulang.`
                    );
                }

                await tx.product.update({
                    where: {
                        id:
                            item.productId,
                    },

                    data: {
                        sold: {
                            increment:
                            item.quantity,
                        },
                    },
                });
            }

            /*
             * ==========================================
             * CART
             * ==========================================
             *
             * COD:
             * langsung kosong.
             *
             * MIDTRANS:
             * JANGAN kosongkan.
             *
             * Ini inti perbaikan bug:
             *
             * Bank Transfer
             * -> X
             * -> E-Wallet
             *
             * cart tetap tersedia.
             */

            if (
                input.paymentMethod ===
                    "COD" &&
                cartId !== null
            ) {
                // ==========================================
                // SELECTIVE CART CLEANUP
                // ==========================================
                // Only remove cart items that became
                // OrderItems. Unselected items stay.

                const processedVariantIds = new Set(
                    checkoutItems.map(
                        (item) => item.variantId
                    )
                );

                await tx.cartItem.deleteMany(
                    {
                        where: {
                            cartId,
                            variantId: {
                                in: Array.from(
                                    processedVariantIds
                                ),
                            },
                        },
                    }
                );
            }

            /*
             * ==========================================
             * AFFILIATE CONVERSION
             * ==========================================
             *
             * If customer came via referral,
             * create an AffiliateConversion record
             * linking this order to the affiliate.
             *
             * Commission is calculated on subtotal
             * (before shipping/discount) using the
             * rate snapshot from AffiliateProfile.
             */

            if (input.affiliateCode) {
                const affiliate =
                    await tx.affiliateProfile.findFirst(
                        {
                            where: {
                                affiliateCode:
                                    input.affiliateCode,
                                status: "APPROVED",
                            },
                            select: {
                                id: true,
                                userId: true,
                                affiliateCode: true,
                                commissionRate: true,
                            },
                        }
                    );

                /*
                 * SELF-REFERRAL PREVENTION:
                 * Affiliate cannot refer themselves.
                 * If affiliate.userId === order userId,
                 * skip commission entirely.
                 */
                if (affiliate && affiliate.userId === input.userId) {
                    logCheckoutEvent(
                        "SELF_REFERRAL_BLOCKED",
                        {
                            affiliateId: affiliate.id,
                            affiliateCode: affiliate.affiliateCode,
                            orderId: order.id,
                        }
                    );
                } else if (affiliate) {
                    /* ==========================================
                     * MONEY-SAFE COMMISSION CALCULATION
                     * ==========================================
                     *
                     * Uses calculateCommission() from commission.ts
                     * which performs Decimal arithmetic throughout.
                     * This ensures checkout and commission records
                     * produce exactly the same result.
                     */
                    const { calculateCommission } =
                        await import("@/lib/affiliate/commission");
                    const commissionResult = calculateCommission(
                        Number(subtotal),
                        Number(affiliate.commissionRate)
                    );

                    try {
                        await tx.affiliateConversion.create(
                            {
                                data: {
                                    affiliateId:
                                        affiliate.id,
                                    orderId:
                                        order.id,
                                    affiliateCode:
                                        affiliate.affiliateCode,
                                    orderSubtotal:
                                        commissionResult.orderSubtotal,
                                    commissionRate:
                                        commissionResult.commissionRate,
                                    commissionAmount:
                                        commissionResult.commissionAmount,
                                    status: "PENDING",
                                },
                            }
                        );

                        console.log(
                            `AFFILIATE_CONVERSION: Order ${order.id} linked to affiliate ${affiliate.affiliateCode}, commission ${commissionResult.commissionAmount}`
                        );
                    } catch (convError: any) {
                        // P2002 = already exists (idempotent)
                        if (
                            convError?.code ===
                            "P2002"
                        ) {
                            console.log(
                                `AFFILIATE_CONVERSION: Order ${order.id} already has conversion`
                            );
                        } else {
                            console.error(
                                "AFFILIATE_CONVERSION ERROR:",
                                convError
                            );
                        }
                    }
                }
            }

            /*
             * ==========================================
             * SPIN WHEEL REWARD: MARK AS USED
             * ==========================================
             *
             * Link the spin record to this order and
             * mark as USED so it cannot be used again.
             */

            if (spinWheelSpinId) {
                await tx.spinWheelSpin.update({
                    where: { id: spinWheelSpinId },
                    data: {
                        status: "USED",
                        usedAt: new Date(),
                        orderId: order.id,
                    },
                });

                logCheckoutEvent(
                    "SPIN_WHEEL_REWARD_APPLIED",
                    {
                        spinId: spinWheelSpinId,
                        orderId: order.id,
                        discount: spinWheelDiscount,
                    }
                );
            }

            return {
                order,

                checkoutItems,

                itemDetails,

                subtotal,

                shippingCost:
                    finalShippingCost,

                discount,

                spinWheelDiscount,

                grossAmount,

                cartId,
            };
        },
        {
            timeout: 15000,

            maxWait: 10000,
        }
    );
}

/*
 * ==========================================
 * ROLLBACK CHECKOUT
 * ==========================================
 *
 * Default:
 * restoreCart = true
 *
 * Dipakai ketika order sudah dibuat lalu gagal.
 *
 * Cart tidak dihapus oleh payment API.
 * Menggunakan restoreCart: false.
 */

export async function rollbackCheckoutOrder(
    orderId: number,
    options?: {
        restoreCart?: boolean;
    }
) {
    const restoreCart =
        options?.restoreCart ?? true;

    return prisma.$transaction(
        async (tx) => {            /*
             * ==========================================
             * ATOMIC CAS: CANCEL ORDER (BUG #1/#4 FIX)
             * ==========================================
             *
             * Transition PENDING/PROCESSING -> CANCELLED
             * atomically. Only one concurrent caller will
             * see affectedRows === 1.
             *
             * If already CANCELLED/PAID/SHIPPED/COMPLETED,
             * affectedRows === 0 -> skip all restores.
             */
            const affectedRows =
                await tx.$executeRaw`
                UPDATE \`order\`
                SET status = 'CANCELLED',
                    paymentStatus = 'FAILED'
                WHERE id = ${orderId}
                  AND status IN ('PENDING', 'PROCESSING')
            `;

            if (affectedRows === 0) {
                return;
            }

            const order =
                await tx.order.findUnique({
                    where: {
                        id: orderId,
                    },

                    include: {
                        items: true,
                    },
                });

            if (!order) {
                return;
            }

            /*
             * ==========================================
             * RESTORE CART
             * ==========================================
             *
             * Hanya dilakukan untuk order
             * yang sebelumnya memang
             * menghapus cart.
             *
             * Midtrans sekarang TIDAK
             * menghapus cart.
             */

            if (
                restoreCart &&
                order.paymentMethod ===
                    "COD"
            ) {
                const cart =
                    await tx.cart.findUnique(
                        {
                            where: {
                                userId:
                                    order.userId,
                            },
                        }
                    );

                let targetCartId =
                    cart?.id ?? null;

                if (
                    !targetCartId
                ) {
                    const createdCart =
                        await tx.cart.create(
                            {
                                data: {
                                    userId:
                                        order.userId,
                                },
                            }
                        );

                    targetCartId =
                        createdCart.id;
                }

                for (
                    const item of
                        order.items
                ) {
                    if (
                        item.variantId ===
                        null
                    ) {
                        // Variant was deleted (onDelete: SetNull).
                        // Cannot restore to cart without a valid variantId.
                        // Stock was already released when variant was deleted.
                        continue;
                    }

                    if (
                        item.productId ===
                        null
                    ) {
                        // Product was deleted (onDelete: SetNull).
                        // Cannot restore to cart without a valid productId.
                        continue;
                    }

                    const existingCartItem =
                        await tx.cartItem.findFirst(
                            {
                                where: {
                                    cartId:
                                        targetCartId,

                                    productId:
                                        item.productId,

                                    variantId:
                                        item.variantId,
                                },
                            }
                        );

                    if (
                        existingCartItem
                    ) {
                        await tx.cartItem.update(
                            {
                                where: {
                                    id:
                                        existingCartItem.id,
                                },

                                data: {
                                    quantity: {
                                        increment:
                                            item.quantity,
                                    },
                                },
                            }
                        );
                    } else {
                        await tx.cartItem.create(
                            {
                                data: {
                                    cartId:
                                        targetCartId,

                                    productId:
                                        item.productId,

                                    variantId:
                                        item.variantId,

                                    quantity:
                                        item.quantity,
                                },
                            }
                        );
                    }
                }
            }

            /*
             * ==========================================
             * RESTORE STOCK + SOLD
             * ==========================================
             *
             * Flash-sale items: restore flash-sale
             * stock (saleStock / soldCount). Skip
             * regular ProductVariant.stock because
             * flash-sale items never reserved it.
             *
             * Regular items: restore ProductVariant
             * stock and Product.sold as before.
             *
             * We identify flash-sale items by checking
             * if a FlashSale record exists for the
             * variantId (unique constraint on variantId).
             * OrderItem has no flashSaleId field.
             */

            for (
                const item of
                    order.items
            ) {
                if (
                    item.variantId ===
                    null
                ) {
                    // Variant was deleted (onDelete: SetNull).
                    // Stock was already released when variant was deleted.
                    // Restore Product.sold only.
                    if (
                        item.productId !== null
                    ) {
                        await tx.$executeRaw`
                            UPDATE product
                            SET sold = GREATEST(0, sold - ${item.quantity})
                            WHERE id = ${item.productId}
                        `;
                    }
                    continue;
                }

                if (
                    item.productId ===
                    null
                ) {
                    // Product was deleted (onDelete: SetNull).
                    // Variant stock still needs restoration.
                    await tx.productVariant.update(
                        {
                            where: {
                                id:
                                    item.variantId,
                            },

                            data: {
                                stock: {
                                    increment:
                                        item.quantity,
                                },
                            },
                        }
                    );
                    continue;
                }

                /*
                 * Check if this variant has a flash sale.
                 * FlashSale has @@unique([variantId]) so
                 * at most one record per variant.
                 */
                const flashSale =
                    await tx.flashSale.findFirst({
                        where: {
                            variantId:
                                item.variantId,
                        },
                    });

                if (flashSale) {
                    /*
                     * FLASH SALE ITEM:
                     * Restore flash-sale stock atomically.
                     * Do NOT touch regular ProductVariant.stock.
                     *
                     * BUG #3 FIX: Use conditional update to prevent
                     * negative soldCount and saleStock inflation.
                     */
                    await tx.$executeRaw`
                        UPDATE flashsale
                        SET saleStock = saleStock + ${item.quantity},
                            soldCount = soldCount - ${item.quantity}
                        WHERE id = ${flashSale.id}
                          AND soldCount >= ${item.quantity}
                    `;

                    /*
                     * FLASH SALE PURCHASE CLEANUP (BUG T1-1 FIX):
                     * Delete FlashSalePurchase record so the user
                     * can re-attempt if they want to.
                     * Without this, the user is permanently blocked
                     * from buying this flash sale (purchaseLimit
                     * already consumed).
                     */
                    await tx.flashSalePurchase.deleteMany({
                        where: {
                            flashSaleId: flashSale.id,
                            userId: order.userId,
                        },
                    });
                } else {
                    /*
                     * REGULAR ITEM or FLASH SALE DELETED:
                     * Restore regular stock.
                     *
                     * If the flash sale was deleted before
                     * rollback, the item falls through to
                     * regular stock restoration. This is
                     * acceptable because deleteFlashSale
                     * now rejects deletion when pending
                     * orders exist (defense-in-depth).
                     */
                    await tx.productVariant.update(
                        {
                            where: {
                                id:
                                    item.variantId,
                            },

                            data: {
                                stock: {
                                    increment:
                                        item.quantity,
                                },
                            },
                        }
                    );
                }

                /*
                 * Restore sold count for both types.
                 * BUG #3 FIX: Use GREATEST to prevent negative sold.
                 */
                await tx.$executeRaw`
                    UPDATE product
                    SET sold = GREATEST(0, sold - ${item.quantity})
                    WHERE id = ${item.productId}
                `;
            }

            /*
             * ==========================================
             * RESTORE VOUCHER QUOTA
             * ==========================================
             */

            if (
                typeof order.voucherId ===
                "number"
            ) {
                /*
                 * Restore global usedCount
                 */
                await tx.voucher.updateMany(
                    {
                        where: {
                            id:
                                order.voucherId,

                            usedCount: {
                                gt: 0,
                            },
                        },

                        data: {
                            usedCount: {
                                decrement: 1,
                            },
                        },
                    }
                );

                /*
                 * Restore per-user usage count
                 */
                const userUsage =
                    await tx.voucherUserUsage.findUnique({
                        where: {
                            voucherId_userId: {
                                voucherId: order.voucherId,
                                userId: order.userId,
                            },
                        },
                    });

                if (
                    userUsage &&
                    userUsage.usageCount > 0
                ) {
                    await tx.voucherUserUsage.update({
                        where: {
                            id: userUsage.id,
                        },
                        data: {
                            usageCount: {
                                decrement: 1,
                            },
                        },
                    });
                }            }

            /*
             * ==========================================
             * RESTORE SPIN WHEEL REWARD
             * ==========================================
             *
             * If the order had a spin wheel reward applied,
             * restore it to AVAILABLE so the user can reuse it.
             */

            const spinRecord =
                await tx.spinWheelSpin.findUnique({
                    where: { orderId: order.id },
                });

            if (spinRecord) {
                await tx.spinWheelSpin.update({
                    where: { id: spinRecord.id },
                    data: {
                        status: "AVAILABLE",
                        usedAt: null,
                        orderId: null,
                    },
                });
            }

            /*
             * ==========================================
             * CANCEL ORDER
             * ==========================================
             */

            await tx.order.update({
                where: {
                    id: order.id,
                },
                data: {
                    status: "CANCELLED",
                    paymentStatus: "FAILED",
                },
            });

            /*
             * AFFILIATE COMMISSION CANCELLATION:
             * Cancel commission when checkout rollback.
             */
            const { cancelCommissionForOrder } =
                await import("@/lib/affiliate/cancel-commission");
            await cancelCommissionForOrder(
                tx,
                order.id,
                "ORDER_PAYMENT_FAILED"
            );
        },
        {
            timeout: 15000,

            maxWait: 10000,
        }
    );
}

/*
 * ==========================================
 * USER-INITIATED PENDING ORDER CANCEL
 * ==========================================
 *
 * SOFT-CANCEL (P0 FIX C1):
 *
 * Previously this flow used prisma.order.delete()
 * which permanently destroyed the order while:
 *   - stock was never restored
 *   - flash-sale reservations were never released
 *   - voucher quota was never returned
 *   - an active Midtrans transaction remained payable
 *   - AffiliateConversion (FK Restrict) could make
 *     the delete fail with P2003
 *
 * Now it delegates to rollbackCheckoutOrder() which
 * already implements:
 *   - atomic CAS transition (PENDING/PROCESSING → CANCELLED)
 *   - stock restore (regular + flash-sale)
 *   - FlashSalePurchase cleanup
 *   - voucher quota + per-user usage restore
 *   - affiliate commission cancellation
 *
 * The order row is NEVER deleted, so order history
 * is preserved and a late settlement webhook cannot
 * find-and-resurrect a missing order.
 */

export async function cancelOwnPendingOrder(
    userId: string,
    orderId: number
): Promise<
    | { ok: true }
    | { ok: false; reason: "NOT_FOUND" | "NOT_CANCELLABLE" }
> {
    /*
     * Ownership check: user may only cancel
     * their own order.
     */
    const order = await prisma.order.findFirst({
        where: {
            id: orderId,
            userId,
        },
        select: {
            id: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
        },
    });

    if (!order) {
        return { ok: false, reason: "NOT_FOUND" };
    }

    /*
     * Only unpaid pending orders are cancellable
     * by the customer (same rule as before).
     */
    if (order.paymentStatus !== "PENDING") {
        return { ok: false, reason: "NOT_CANCELLABLE" };
    }

    /*
     * Atomic soft-cancel + full reservation release.
     * CAS inside rollbackCheckoutOrder guarantees a
     * concurrent webhook expire/fail/settlement cannot
     * interleave destructively.
     */
    await rollbackCheckoutOrder(order.id, {
        restoreCart: false,
    });

    return { ok: true };
}/*
 * ==========================================
 * CLEAR CART
 * ==========================================
 *
 * If orderId provided, only removes cart items
 * that became OrderItems (selective cleanup).
 * If no orderId, removes all cart items.
 */

export async function clearCart(
    userId: string,
    orderId?: number
) {
    const cart =
        await prisma.cart.findUnique(
            {
                where: {
                    userId,
                },
            }
        );

    if (!cart) {
        return;
    }

    if (orderId) {
        const orderItems = await prisma.orderItem.findMany({
            where: { orderId },
            select: { variantId: true },
        });
        const orderedVariantIds = orderItems
            .map((oi) => oi.variantId)
            .filter((v): v is number => v !== null);

        if (orderedVariantIds.length > 0) {
            await prisma.cartItem.deleteMany({
                where: {
                    cartId: cart.id,
                    variantId: { in: orderedVariantIds },
                },
            });
        }
    } else {
        await prisma.cartItem.deleteMany({
            where: {
                cartId: cart.id,
            },
        });
    }
}