import crypto from "crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
    incrementVoucherUsage,
    incrementVoucherUserUsage,
    validateAndCalculateVoucherEnhanced,
    type VoucherValidationItem,
} from "@/lib/voucher";
import {
    recordFlashSalePurchase,
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
    verifyMengantarShippingCost,
} from "./mengantar/shipping";
import {
    enqueueShipmentJobTx,
    scheduleShipmentProcessing,
} from "./mengantar/shipment-worker";
import {
    calculateSpinRewardDiscount,
} from "./spin-wheel";
import { formatProductName } from "./payment/ipaymu";
import { PAYMENT_EXPIRY_GRACE_MS } from "./payment/order-payment";
import type { OrderAttributionInput } from "@/lib/analytics/attribution";
import {
    buildGuestIdentityKey,
    contactFingerprints,
    generateGuestAccessToken,
    guestAccessTokenExpiry,
    hashGuestAccessToken,
    orderOwnerKey,
    resolveOwnerKey,
} from "./guest-identity";
import {
    resolveGuestAddress,
    type GuestAddressInput,
} from "./guest-address";
import {
    assessCodRisk,
    countActiveGuestCodOrders,
} from "./cod-policy";
import {
    findOrderByIdempotencyKey,
} from "./checkout-idempotency";

/*
 * ==========================================
 * MENGANTAR SHIPPING VERIFICATION (THROWS)
 * ==========================================
 *
 * Thin wrapper that turns a null Mengantar result into a clear error.
 * The authoritative price always comes from Mengantar itself — the
 * client-sent shipping.cost is ignored by the caller.
 */
/*
 * ==========================================
 * RAJAONGKIR SHIPPING VERIFICATION (THROWS)
 * ==========================================
 *
 * Legacy provider kept as the fallback when the selected option is
 * not a Mengantar option (existing orders, deployments without
 * Mengantar configured). Uses server-authoritative origin/destination
 * from StoreSetting / UserAddress.
 */
async function verifyRajaOngkirShippingCostOrThrow({
    storeSetting,
    address,
    totalWeight,
    courier,
    service,
}: {
    storeSetting: {
        rajaOngkirDestinationId: number | null;
    } | null;
    address: {
        rajaOngkirDestinationId: number | null;
    };
    totalWeight: number;
    courier: string;
    service: string;
}): Promise<number> {
    if (!storeSetting?.rajaOngkirDestinationId) {
        throw new Error(
            "Pengaturan toko belum dikonfigurasi."
        );
    }

    if (!address.rajaOngkirDestinationId) {
        throw new Error(
            "Alamat tidak memiliki data wilayah pengiriman."
        );
    }

    return verifyShippingCost({
        origin: storeSetting.rajaOngkirDestinationId,
        destination: address.rajaOngkirDestinationId,
        totalWeight,
        courier,
        service,
    });
}

async function verifyMengantarShippingCostOrThrow({
    address,
    weightGrams,
    courier,
}: {
    address: {
        id?: string;
        recipientName?: string | null;
        phone?: string | null;
        address?: string | null;
        province?: string | null;
        city?: string | null;
        district?: string | null;
        subdistrict?: string | null;
        postalCode?: string | null;
        mengantarDestinationAreaId?: string | null;
    };
    weightGrams: number;
    courier: string;
}): Promise<number> {
    if (!courier) {
        throw new Error(
            "Kurir pengiriman wajib dipilih."
        );
    }

    const cost = await verifyMengantarShippingCost({
        address,
        weightGrams,
        courier,
    });

    if (cost === null) {
        throw new Error(
            "Layanan pengiriman tidak tersedia. Silakan pilih ulang layanan pengiriman."
        );
    }

    return cost;
}

export type CheckoutMode =
    | "CART"
    | "BUY_NOW";

export type CheckoutPaymentMethod =
    | "COD"
    | "BANK_TRANSFER"
    | "E_WALLET"
    | "QRIS";

export type ShippingOption = {
    /**
     * Shipping provider that produced this option. "MENGANTAR" routes
     * verification through the Mengantar estimate; anything else uses
     * the legacy RajaOngkir verification. NEVER trusted for pricing —
     * only for selecting which provider re-verifies the quote.
     */
    provider?: string;
    supportsCod?: boolean;
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
    /**
     * Authenticated customer id, or NULL for a guest checkout.
     * Guest checkout is the default customer path.
     */
    userId: string | null;

    mode?: CheckoutMode;

    /**
     * Legacy logged-in path: id of a `UserAddress` owned by `userId`.
     * Guests must use `guestAddress` instead.
     */
    addressId?: string;

    /**
     * GUEST path: the address supplied inline by the buyer. It is
     * UNTRUSTED input and is validated + resolved server-side
     * (see lib/guest-address.ts) before it becomes an order.
     */
    guestAddress?: GuestAddressInput;

    /**
     * GUEST cart scope: SHA-256 of the anonymous cart cookie token.
     * Null for a logged-in cart.
     */
    cartGuestTokenHash?: string | null;

    /** Hashed promo-claim visitor cookie; only the server may supply it. */
    promoClaimVisitorKeyHash?: string | null;

    /**
     * Hashed guest identity (normalized email + phone) used for the
     * per-identity abuse scopes (voucher / flash-sale / COD caps,
     * affiliate self-referral). Never sent to the browser.
     */
    guestIdentityKey?: string | null;

    /**
     * Duplicate-submission guard, already namespaced by the caller.
     */
    idempotencyKey?: string | null;

    /**
     * Authoritative order email for a LOGGED-IN buyer (the session
     * email). Guests are covered by `guestAddress.email`.
     */
    customerEmail?: string | null;

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

    /**
     * Phase 22: TikTok attribution captured at the CUSTOMER request
     * boundary. Every value is nullable.
     */
    attribution?: OrderAttributionInput;
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

    /**
     * RAW guest access token — present only for a guest order.
     *
     * The caller MUST put this in an httpOnly cookie / one-time token
     * link and MUST NEVER log it, store it in analytics, or return it
     * in a response body that is not the buyer's own.
     */
    guestAccessToken?: string | null;

    /**
     * true when the COD order was FLAGGED for admin review.
     *
     * INFORMATIONAL ONLY: the flag marks elevated risk for the admin
     * dashboard / audit trail. It NEVER holds fulfilment — a flagged COD
     * order still gets its ShipmentJob and is still shipped
     * automatically like every other COD + Mengantar order.
     */
    requiresCodReview?: boolean;

    /**
     * true when this result is a REPLAY of an earlier submission that
     * carried the same idempotency key — no new order was created.
     */
    duplicate?: boolean;
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
    items: CheckoutItem[],
    promoClaimVisitorKeyHash?: string | null
) {
    if (items.length === 0) return;

    const results = await resolveBatchPrices(
        items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            originalPrice: i.price,
            quantity: i.quantity,
        })),
        new Date(),
        promoClaimVisitorKeyHash
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
    scope:
        | string
        | {
              userId?: string | null;
              guestIdentityKey?: string | null;
          }
) {
    /*
     * Scope the sweep to the buyer. Guests have no userId, so their
     * identity scope (hashed email/phone) is used instead — this keeps
     * the "one live payment attempt" guarantee for guest checkout too,
     * instead of letting retried guest checkouts pile up payable
     * PENDING orders with no cleanup path.
     */
    const scopeWhere =
        typeof scope === "string"
            ? { userId: scope }
            : scope.userId
              ? { userId: scope.userId }
              : scope.guestIdentityKey
                ? {
                      guestIdentityKey:
                          scope.guestIdentityKey,
                  }
                : null;

    if (!scopeWhere) {
        return;
    }

    const pendingOrders =
        await prisma.order.findMany({
            where: {
                ...scopeWhere,

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

/**
 * Rebuild a checkout result from an order that already exists for the
 * same idempotency key.
 *
 * Nothing is recalculated from the CURRENT cart/prices: a replay must
 * return exactly the amounts the buyer already agreed to, and must not
 * reserve stock, a voucher or a flash-sale slot a second time.
 */
function buildIdempotentReplay(
    replay: Prisma.OrderGetPayload<{
        include: { items: true };
    }>
): CreatedCheckout {
    const replayItems = replay.items ?? [];

    return {
        order: replay,

        checkoutItems: replayItems.map((item) => ({
            productId: item.productId ?? 0,
            variantId: item.variantId ?? 0,
            productName: item.productName,
            variantName: item.variantName,
            price: Number(item.price),
            quantity: item.quantity,
            subtotal: Number(item.subtotal),
        })),

        itemDetails: replayItems.map((item) => ({
            id: String(item.variantId ?? item.productId),
            price: Number(item.price),
            quantity: item.quantity,
            name: formatProductName(
                item.productName,
                item.variantName
            ),
        })),

        subtotal: Number(replay.subtotal),
        shippingCost: Number(replay.shippingCost),
        discount: Number(replay.discount),
        spinWheelDiscount: 0,
        grossAmount: Number(replay.total),
        /*
         * The replay did not consume a cart (nothing was cleared), so
         * there is no cart to report to the caller.
         */
        cartId: null,
        guestAccessToken: null,
        requiresCodReview: replay.requiresCodReview,
        duplicate: true,
    };
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
     * IDEMPOTENCY — REPLAY A DUPLICATE SUBMISSION
     * ==========================================
     *
     * A double-clicked / retried checkout sends the SAME server-scoped
     * idempotency key. `Order.idempotencyKey` is UNIQUE, so the second
     * submission could never create a second order — but without this
     * lookup it would surface as a raw P2002/500 error even though the
     * first submission succeeded.
     *
     * Returning the ORIGINAL order makes the endpoint properly
     * idempotent: the buyer sees their order, no second stock/voucher
     * reservation is attempted, and no duplicate payment instruction is
     * created. The stored row is authoritative — nothing is recomputed
     * from the (possibly changed) cart.
     */
    if (input.idempotencyKey) {
        const replay = await findOrderByIdempotencyKey(
            input.idempotencyKey
        );

        if (replay) {
            return buildIdempotentReplay(replay);
        }
    }

    /*
     * ==========================================
     * BUYER SCOPE
     * ==========================================
     *
     * A customer no longer has to sign in, so every buyer resolves to
     * exactly one scope:
     *   logged-in → userId
     *   guest     → hashed contact identity (email/phone)
     *
     * `ownerKey` is the authoritative scope for the per-identity caps
     * (voucher maxUsagePerUser, flash-sale purchase limit, COD cap).
     * `resolveOwnerKey` fails loudly when neither is available, rather
     * than collapsing every anonymous buyer into one shared bucket.
     */
    const isGuest = !input.userId;

    const guestIdentityKey =
        input.guestIdentityKey ??
        (isGuest
            ? buildGuestIdentityKey({
                  email:
                      input.guestAddress?.email,
                  phone:
                      input.guestAddress?.phone,
              })
            : null);

    const ownerKey = resolveOwnerKey({
        userId: input.userId,
        guestIdentityKey,
    });

    /*
     * Cart scope for the CART mode: the authenticated cart or the
     * anonymous guest cart (hashed cookie token).
     */
    const cartWhere = input.userId
        ? { userId: input.userId }
        : input.cartGuestTokenHash
          ? {
                guestTokenHash:
                    input.cartGuestTokenHash,
            }
          : null;

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
    //
    // Provider selector only. Price is ALWAYS re-derived server-side
    // (Mengantar estimate or RajaOngkir) — never from the client.
    const shippingProvider =
        String(
            input.shipping.provider ?? ""
        ).toUpperCase() === "MENGANTAR"
            ? "MENGANTAR"
            : "RAJAONGKIR";
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

    /*
     * GUEST ORDERS have no UserAddress row. Their address arrives inline
     * and is validated + resolved server-side (region canonicalization,
     * Mengantar area resolution, verified RajaOngkir destination). The
     * resolved object intentionally has the SAME shape the rest of this
     * function already expects, so pricing/verification is unchanged.
     */
    const address =
        input.userId && input.addressId
            ? await prisma.userAddress.findFirst(
                  {
                      where: {
                          id: input.addressId,

                          userId: input.userId,
                      },
                  }
              )
            : input.guestAddress
              ? await resolveGuestAddress(
                    input.guestAddress
                )
              : null;

    if (!address) {
        const error =
            new Error(
                input.userId
                    ? "Alamat tidak ditemukan."
                    : "Alamat pengiriman wajib diisi."
            );

        (error as any).status =
            input.userId ? 404 : 400;

        throw error;
    }

    if (
        shippingProvider === "RAJAONGKIR" &&
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
        shippingProvider === "RAJAONGKIR" &&
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
        if (!cartWhere) {
            throw new Error(
                "Keranjang kosong."
            );
        }

        const cartItems =
            await prisma.cartItem.findMany({
                where: {
                    cart: cartWhere,
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
        shippingProvider === "MENGANTAR"
            ? await verifyMengantarShippingCostOrThrow({
                  address,
                  weightGrams: totalWeight,
                  courier:
                      input.shipping.courier ??
                      input.shipping.code ??
                      "",
              })
            : await verifyRajaOngkirShippingCostOrThrow({
                  storeSetting,
                  address,
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
        await cleanupPendingCheckoutOrders({
            userId: input.userId,
            guestIdentityKey,
        });
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
     * GUEST ORDER ACCESS TOKEN
     * ==========================================
     *
     * CRITICAL: an order id (sequential) or order number alone must
     * NEVER grant access to an order. A guest order therefore carries
     * a 256-bit CSPRNG token; only its SHA-256 HASH is persisted.
     *
     * The raw token is returned to the caller so it can be set as an
     * httpOnly cookie / one-time token link. It is never logged and
     * never included in analytics payloads.
     */
    const guestAccessToken = isGuest
        ? generateGuestAccessToken()
        : null;

    const guestAccessTokenHash = guestAccessToken
        ? hashGuestAccessToken(guestAccessToken)
        : null;

    /*
     * SERVER-SIDE expiry (30 days), always persisted WITH the
     * hash: resolveOrderAccess refuses a token whose window is
     * missing or past, so the two can never be written
     * separately.
     */
    const guestAccessTokenExpiresAt = guestAccessToken
        ? guestAccessTokenExpiry()
        : null;

    /*
     * Authoritative buyer email for this order: the guest's checkout
     * email, or the session email supplied by the route for a
     * logged-in buyer. Drives iPaymu buyerEmail (no session dependency
     * for guests).
     */
    const orderCustomerEmail =
        input.customerEmail ??
        (address as { email?: string | null })
            .email ??
        null;

    /*
     * ==========================================
     * DATABASE TRANSACTION
     * ==========================================
     */

    let result: CreatedCheckout;

    try {
        result = await prisma.$transaction(
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
                /*
                 * Cart lookup goes through the BUYER SCOPE (session cart
                 * OR anonymous guest cart), so the same handler serves
                 * both without ever reading another buyer's cart.
                 */
                const cart = cartWhere
                    ? await tx.cart.findUnique(
                          {
                              where: cartWhere,

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
                      )
                    : null;

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
                checkoutItems,
                input.promoClaimVisitorKeyHash
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
                        tx,
                        // Per-identity cap scope (user or hashed guest).
                        ownerKey
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
                    input.userId,
                    ownerKey
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
                                    ...(input.userId
                                        ? {
                                              userId:
                                                  input.userId,
                                          }
                                        : {
                                              guestIdentityKey:
                                                  guestIdentityKey ??
                                                  undefined,
                                          }),
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

                /*
                 * Ownership is checked against the SPIN SCOPE, so a
                 * guest reward can only be redeemed by the guest who won
                 * it (and a logged-in reward by its owner).
                 */
                if (
                    !spinRecord ||
                    spinRecord.ownerKey !== ownerKey
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
                        item.quantity,
                        // Purchase-limit scope: user id OR hashed guest
                        // identity. Without it the cap would be skipped.
                        ownerKey
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

            /*
             * ==========================================
             * COD ABUSE CONTROL (review gate)
             * ==========================================
             *
             * A high-risk COD order (high value, or a guest with too
             * many COD orders still open) is FLAGGED for admin review.
             *
             * THE FLAG IS INFORMATIONAL. It is a risk marker for the
             * admin dashboard and the audit trail, and it changes
             * NOTHING about fulfilment: the order is never auto-cancelled,
             * its paymentStatus stays UNPAID, and (below) it still gets
             * its ShipmentJob so Mengantar is still asked to create the
             * shipment/pickup automatically at checkout.
             */
            let requiresCodReview = false;
            let codReviewReasons: string[] = [];

            if (input.paymentMethod === "COD") {
                const activeCodOrders =
                    isGuest && guestIdentityKey
                        ? await countActiveGuestCodOrders(
                              tx,
                              guestIdentityKey
                          )
                        : 0;

                const codRisk = assessCodRisk({
                    total: grossAmount,
                    activeCodOrders,
                    isGuest,
                });

                requiresCodReview =
                    codRisk.requiresReview;
                codReviewReasons = codRisk.reasons;

                if (requiresCodReview) {
                    logCheckoutEvent(
                        "COD_REVIEW_REQUIRED",
                        {
                            orderNumber,
                            total: grossAmount,
                            activeCodOrders,
                            reasons: codReviewReasons,
                        }
                    );
                }
            }

            const order =
                await tx.order.create({
                    data: {
                        userId:
                            input.userId ??
                            null,

                        /*
                         * Guest buyer identity.
                         *
                         * customerEmail is the authoritative email for
                         * this order (used as the iPaymu buyerEmail when
                         * there is no session).
                         */
                        customerEmail:
                            orderCustomerEmail,

                        /*
                         * Only the HASH and its expiry window are
                         * persisted; the raw token never is.
                         */
                        guestAccessTokenHash:
                            guestAccessTokenHash ??
                            undefined,

                        guestAccessTokenExpiresAt:
                            guestAccessTokenExpiresAt ??
                            undefined,

                        guestIdentityKey:
                            guestIdentityKey ??
                            undefined,

                        idempotencyKey:
                            input.idempotencyKey ??
                            undefined,

                        requiresCodReview,

                        codReviewStatus:
                            requiresCodReview
                                ? "PENDING"
                                : null,

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

                        // Phase 22: TikTok attribution captured at the
                        // customer request boundary (nullable).
                        ttclid:
                            input.attribution?.ttclid ??
                            null,

                        ttp:
                            input.attribution?.ttp ??
                            null,

                        landingUrl:
                            input.attribution
                                ?.landingUrl ?? null,

                        referrer:
                            input.attribution?.referrer ??
                            null,

                        clientIp:
                            input.attribution?.clientIp ??
                            null,

                        clientUserAgent:
                            input.attribution
                                ?.clientUserAgent ?? null,

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

                        // ==========================================
                        // SHIPPING FULFILMENT PROVIDER (MENGANTAR)
                        // ==========================================
                        //
                        // Null for the legacy RajaOngkir path so existing
                        // orders are unaffected. shippingPaymentStatus is
                        // the SELLER's shipping payment to Mengantar and is
                        // deliberately separate from paymentStatus (the
                        // CUSTOMER's payment to the marketplace).
                        shippingProvider:
                            shippingProvider === "MENGANTAR"
                                ? "MENGANTAR"
                                : null,

                        providerCourier:
                            shippingProvider === "MENGANTAR"
                                ? input.shipping.courier ??
                                  input.shipping.code ??
                                  null
                                : null,

                        shippingPaymentStatus:
                            shippingProvider === "MENGANTAR"
                                ? input.paymentMethod === "COD"
                                    ? "NOT_APPLICABLE"
                                    : "UNPAID"
                                : null,

                        shipmentStatus:
                            shippingProvider === "MENGANTAR"
                                ? "NOT_CREATED"
                                : null,

                        // COD amount = goods value + shipping fee (the
                        // estimate's COD_AMOUNT semantics). Mengantar's own
                        // COD service fee is provider-side and is added when
                        // the shipment is actually created.
                        codAmount:
                            shippingProvider === "MENGANTAR" &&
                            input.paymentMethod === "COD"
                                ? grossAmount
                                : null,

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
                });

            /*
             * ==========================================
             * COD AUTO-SHIPMENT ENQUEUE
             * ==========================================
             *
             * COD has NO online-payment settlement event, so the
             * NON-COD settlement webhook (which enqueues the outbox)
             * never fires for it. Enqueue here, inside the SAME
             * transaction as the order create, so a COD + Mengantar
             * order always gets exactly one ShipmentJob.
             *
             * The customer paymentStatus is NOT touched: it stays
             * UNPAID for COD. Creating a shipment is never a customer
             * payment settlement.
             *
             * enqueueShipmentJobTx uses createMany + skipDuplicates
             * against the unique ShipmentJob.orderId, so a retried or
             * double-submitted checkout can never create two jobs.
             * Scoped to COD only - the NON-COD settlement trigger in
             * the payment webhooks is unchanged.
             *
             * COD REVIEW IS NOT A GATE: a FLAGGED order is enqueued
             * exactly like an unflagged one. The shipment/pickup must be
             * requested automatically once the checkout succeeded —
             * waiting for an admin click is what stranded production
             * order #985.
             *
             * NOTE: this only writes a ShipmentJob ROW inside the
             * checkout transaction. No provider call is ever made from
             * here; Mengantar is contacted later by the worker.
             */
            if (
                shippingProvider === "MENGANTAR" &&
                input.paymentMethod === "COD"
            ) {
                await enqueueShipmentJobTx(tx, order.id);
            }
            /*
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
                 * SELF-REFERRAL PREVENTION.
                 *
                 * The original guard compared `affiliate.userId` with
                 * `input.userId`, which is NULL for a guest buyer — so it
                 * silently stopped working the moment checkout became
                 * guest-capable and an affiliate could farm commission
                 * from their own guest purchases.
                 *
                 * Now the affiliate's OWN contact details are compared
                 * against the buyer's, using the same normalized + keyed
                 * hashes as the guest identity scope (lib/guest-identity):
                 *
                 *   1. session identity (legacy userId match), and
                 *   2. a shared email OR phone fingerprint between the
                 *      affiliate's account and the buyer's contact.
                 *
                 * Matching is by HASH only — raw contact values are never
                 * read into this comparison or logged.
                 */
                const buyerFingerprints =
                    contactFingerprints({
                        email: orderCustomerEmail,
                        phone: address.phone,
                    });

                let selfReferral = Boolean(
                    affiliate &&
                        input.userId &&
                        affiliate.userId === input.userId
                );

                if (
                    !selfReferral &&
                    affiliate &&
                    buyerFingerprints.length > 0
                ) {
                    const affiliateUser =
                        await tx.user.findUnique({
                            where: {
                                id: affiliate.userId,
                            },
                            select: {
                                email: true,
                                phone: true,
                            },
                        });

                    if (affiliateUser) {
                        const affiliateFingerprints =
                            contactFingerprints({
                                email: affiliateUser.email,
                                phone: affiliateUser.phone,
                            });

                        selfReferral =
                            affiliateFingerprints.some(
                                (fingerprint) =>
                                    buyerFingerprints.includes(
                                        fingerprint
                                    )
                            );
                    }
                }

                if (affiliate && selfReferral) {
                    logCheckoutEvent(
                        "SELF_REFERRAL_BLOCKED",
                        {
                            affiliateId: affiliate.id,
                            affiliateCode: affiliate.affiliateCode,
                            orderId: order.id,
                            guestOrder: isGuest,
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
                /*
                 * ATOMIC SINGLE-USE REDEMPTION (CAS).
                 *
                 * The availability check above is a plain read, so two
                 * CONCURRENT checkouts that present the same spin id
                 * would both pass it and both receive the discount
                 * (double-spending one reward) if this were a plain
                 * `update`. The conditional updateMany makes the state
                 * transition the guard: only the first transaction flips
                 * AVAILABLE → USED, and the loser is rejected — which
                 * rolls the whole checkout back, so no order, stock or
                 * discount is granted twice.
                 *
                 * `ownerKey` is re-asserted here so the CAS cannot be
                 * used to redeem a reward that belongs to someone else.
                 */
                const redeemed =
                    await tx.spinWheelSpin.updateMany({
                        where: {
                            id: spinWheelSpinId,
                            ownerKey,
                            status: "AVAILABLE",
                        },
                        data: {
                            status: "USED",
                            usedAt: new Date(),
                            orderId: order.id,
                        },
                    });

                if (redeemed.count === 0) {
                    throw new Error(
                        "Reward spin wheel sudah digunakan atau kedaluwarsa."
                    );
                }

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

                requiresCodReview,
            };
            },
            {
                timeout: 15000,

                maxWait: 10000,
            }
        );
    } catch (error) {
        /*
         * CONCURRENT DUPLICATE.
         *
         * Two requests with the SAME idempotency key can pass the
         * lookup above at the same instant. The unique index on
         * `Order.idempotencyKey` stops the second order from being
         * created (P2002), so the loser simply returns the winner's
         * order instead of a 500.
         */
        if (
            input.idempotencyKey &&
            (error as { code?: string })?.code ===
                "P2002"
        ) {
            const replay =
                await findOrderByIdempotencyKey(
                    input.idempotencyKey
                );

            if (replay) {
                return buildIdempotentReplay(replay);
            }
        }

        throw error;
    }

    /*
     * ==========================================
     * COD POST-RESPONSE SHIPMENT PROCESSING
     * ==========================================
     *
     * COD has NO online-payment settlement webhook, so the NON-COD
     * settlement trigger (which calls scheduleShipmentProcessing())
     * never fires for it. The ShipmentJob was enqueued inside the
     * transaction above; nudge the worker HERE, in the same request,
     * so the shipment is created right after this response is sent —
     * without waiting for an external cron sweep.
     *
     * scheduleShipmentProcessing() registers post-response work via
     * after(), so this checkout response is never blocked on a
     * Mengantar API call. Any failure is swallowed and the durable
     * PENDING job is retried by the existing sweeper. NON-COD orders
     * keep using their settlement webhook unchanged.
     *
     * This applies to FLAGGED COD orders too: `requiresCodReview` is a
     * risk marker, not a hold. The admin's review decision never gates
     * fulfilment (see lib/cod-review.ts for what REJECT may do).
     */
    if (
        shippingProvider === "MENGANTAR" &&
        input.paymentMethod === "COD"
    ) {
        await scheduleShipmentProcessing();
    }

    /*
     * Expose the RAW guest access token (never the hash) so the caller
     * can set the httpOnly cookie / build the one-time token link.
     */
    return {
        ...result,
        guestAccessToken,
        requiresCodReview: result.requiresCodReview,
    };
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

        /*
         * COD orders legitimately stay PENDING/UNPAID until the courier
         * collects the cash on delivery, so the AUTOMATIC expiry/cleanup
         * rollback must NEVER cancel one. Cancelling it here makes the
         * shipment worker cancel the order's ShipmentJob and strands a
         * live COD order. Only an EXPLICIT cancellation opts in.
         */
        allowCodCancellation?: boolean;
    }
) {
    const restoreCart =
        options?.restoreCart ?? true;

    const allowCodCancellation =
        options?.allowCodCancellation ?? false;

    return prisma.$transaction(
        (tx) =>
            cancelOrderForReservations(tx, orderId, {
                restoreCart,
                allowCodCancellation,
            }),
        {
            timeout: 15000,

            maxWait: 10000,
        }
    );
}

/*
 * ==========================================
 * ATOMIC ORDER CANCELLATION (SHARED PRIMITIVE)
 * ==========================================
 *
 * The safe-cancellation lifecycle, unchanged:
 *   1. CAS PENDING/PROCESSING -> CANCELLED (paymentStatus FAILED),
 *      which is both the idempotency guard and the atomicity
 *      guarantee — a second caller sees affectedRows === 0 and
 *      releases NOTHING,
 *   2. restore reserved stock (regular + flash-sale) and the
 *      flash-sale purchase record,
 *   3. restore voucher quota AND the per-scope usage bucket, so a
 *      guest and a logged-in buyer release exactly what they
 *      consumed,
 *   4. release the spin-wheel reward, and
 *   5. cancel the affiliate commission.
 *
 * It runs inside the CALLER's transaction so a flow that must make
 * its own state change atomic with the cancellation can include it in
 * the same commit (COD REJECT & CANCEL keeps the review decision and
 * the release in one transaction — there is no window in which an
 * order is rejected but still holds stock, or cancelled but still
 * pending review).
 *
 * @returns true when THIS call performed the cancellation.
 */
export async function cancelOrderForReservations(
    tx: Prisma.TransactionClient,
    orderId: number,
    options?: {
        /** Restore a logged-in COD buyer's cart (guest orders: no-op). */
        restoreCart?: boolean;
        /**
         * COD orders stay PENDING/UNPAID until the courier collects
         * the cash, so only an EXPLICIT cancellation opts in.
         */
        allowCodCancellation?: boolean;
    }
): Promise<boolean> {
    const restoreCart =
        options?.restoreCart ?? true;

    const allowCodCancellation =
        options?.allowCodCancellation ?? false;

                /*
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
                      AND (${allowCodCancellation ? 1 : 0} = 1 OR paymentMethod <> 'COD')
                `;

                if (affectedRows === 0) {
                    return false;
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
                    return false;
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

                /*
                 * GUEST ORDERS: an order placed by a guest has no server-side
                 * user cart to restore into (the guest cart is scoped by an
                 * anonymous cookie, not by the order), so this step is a
                 * no-op for them. Stock / voucher / spin release below still
                 * runs, which is what actually matters financially.
                 */
                if (
                    restoreCart &&
                    order.paymentMethod ===
                        "COD" &&
                    order.userId
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
                        /*
                         * GUEST-SAFE SCOPE (audit fix):
                         * purchase rows are keyed by (flashSaleId,
                         * ownerKey). A guest row has userId = NULL but a
                         * hashed guest ownerKey, so filtering by userId
                         * alone would delete EVERY guest's row for this
                         * sale and reset their purchase caps. Release the
                         * exact scope that consumed the reservation.
                         */
                        const flashSaleScope =
                            orderOwnerKey(order);

                        if (flashSaleScope) {
                            await tx.flashSalePurchase.deleteMany({
                                where: {
                                    flashSaleId: flashSale.id,
                                    ownerKey: flashSaleScope,
                                },
                            });
                        }
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
                     * Restore per-scope usage count.
                     *
                     * The scope is derived from the ORDER (userId for a
                     * logged-in buyer, hashed guest identity for a guest
                     * order) so the release always hits the same bucket that
                     * consumed it.
                     */
                    const rollbackScope = orderOwnerKey(order);

                    const userUsage = rollbackScope
                        ? await tx.voucherUserUsage.findUnique({
                              where: {
                                  voucherId_ownerKey: {
                                      voucherId: order.voucherId,
                                      ownerKey: rollbackScope,
                                  },
                              },
                          })
                        : null;

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

    /*
     * Reached only when the CAS above actually transitioned the
     * order, i.e. every reservation has just been released exactly
     * once.
     */
    return true;
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
    /**
     * Session user id. NULL means the caller is a GUEST whose ownership
     * of THIS order was already proven with a guest access token by the
     * route (see authorizeOrderRequest) — so it is not an unowned order.
     */
    userId: string | null,
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
        where: userId
            ? { id: orderId, userId }
            : { id: orderId },
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
        // An explicit customer cancellation may cancel a COD order.
        allowCodCancellation: true,
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
    scope:
        | string
        | {
              userId?: string | null;
              guestTokenHash?: string | null;
          },
    orderId?: number
) {
    /*
     * Works for both cart scopes: a logged-in cart (userId) and an
     * anonymous guest cart (hashed cookie token).
     */
    const where =
        typeof scope === "string"
            ? { userId: scope }
            : scope.userId
              ? { userId: scope.userId }
              : scope.guestTokenHash
                ? {
                      guestTokenHash:
                          scope.guestTokenHash,
                  }
                : null;

    if (!where) {
        return;
    }

    const cart =
        await prisma.cart.findFirst({
            where,
        });

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
