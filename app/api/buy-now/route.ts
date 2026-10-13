import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
    createCheckoutOrder,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";

import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import {
    getClientIp,
    guestDeviceKey,
    guestIdentityKey as guestIdentityBucketKey,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import { readOrderAttribution } from "@/lib/analytics/attribution-server";
import { buildGuestIdentityKey } from "@/lib/guest-identity";
import { issueGuestOrderAccessCookie } from "@/lib/guest-order-access";
import {
    readIdempotencyKey,
    rejectCrossSite,
    scopeIdempotencyKey,
} from "@/lib/checkout-idempotency";

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
    /** Logged-in buyers: a saved address id. */
    addressId?: string;
    /** Guests: the inline shipping address (validated server-side). */
    guestAddress?: Record<string, unknown>;
    shipping: ShippingPayload;
    paymentMethod: PaymentMethod;
    voucherCode?: string | null;
    spinWheelSpinId?: number | null;
    idempotencyKey?: string | null;
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

/**
 * Current session user, or null for a guest. Buy Now does NOT require
 * a login: guest checkout is the default customer path.
 */
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

                /*
                 * A guest has no address book — the UI shows an inline
                 * address form. Returning [] keeps the shape stable.
                 */
                user?.id
                    ? prisma.userAddress.findMany({
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
                      })
                    : Promise.resolve([]),

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
                // DISPLAY-ONLY (never charged).
                comparePrice:
                    variant.comparePrice != null
                        ? Number(
                              variant.comparePrice
                          )
                        : null,
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

            /*
             * The UI uses this to decide whether "save address" writes
             * to the address book or keeps the entry as a local guest
             * address for this buy-now flow only.
             */
            authenticated: Boolean(user?.id),

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
        /* CSRF defense-in-depth for cookie-authorized guest checkout. */
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const user =
            await getCurrentUser();

        const userId = user?.id ?? null;

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

        const guestAddress =
            body.guestAddress &&
            typeof body.guestAddress === "object"
                ? body.guestAddress
                : null;

        const paymentMethod =
            body.paymentMethod;

        const voucherCode =
            normalizeVoucherCode(
                body.voucherCode
            );

        /*
         * Guest identity scope + rate limiting.
         *
         * Logged-in buyers keep the original per-user limiter; guests are
         * limited on both a device/IP bucket and a hashed-identity
         * bucket so IP rotation cannot bypass the COD cap.
         */
        const guestIdentity =
            buildGuestIdentityKey({
                email: guestAddress?.email,
                phone: guestAddress?.phone,
            });

        if (userId) {
            // Rate limiting for order creation
            const rateLimit =
                rateLimiters.orderCreation(userId);

            if (!rateLimit.allowed) {
                return jsonError(
                    "Terlalu banyak permintaan. Coba lagi nanti.",
                    429
                );
            }
        } else {
            const ip = getClientIp(request);

            const allowed =
                rateLimiters.guestCheckoutDevice(
                    guestIpKey({ ip, scope: "buy-now" })
                ).allowed &&
                rateLimiters.guestCodDevice(
                    guestDeviceKey({
                        ip,
                        scope: "buy-now-cod",
                        deviceKey: null,
                    }) ??
                        guestIpKey({
                            ip,
                            scope: "buy-now-cod",
                        })
                ).allowed &&
                (guestIdentity
                    ? rateLimiters.guestCodIdentity(
                          guestIdentityBucketKey({
                              ip,
                              scope: "buy-now-cod",
                              identityKey: guestIdentity,
                          })!
                      ).allowed
                    : true);

            if (!allowed) {
                return jsonError(
                    "Terlalu banyak permintaan. Coba lagi nanti.",
                    429
                );
            }
        }

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

        if (!addressId && !guestAddress) {
            return jsonError(
                userId
                    ? "Alamat pengiriman wajib dipilih."
                    : "Alamat pengiriman wajib diisi."
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

        /*
         * Duplicate-submission guard, namespaced to the buyer scope so
         * one guest cannot replay another guest's key.
         */
        const rawIdempotencyKey =
            readIdempotencyKey(
                request,
                body as unknown as Record<
                    string,
                    unknown
                >
            );

        const idempotencyKey = rawIdempotencyKey
            ? scopeIdempotencyKey(
                  userId
                      ? `u:${userId}`
                      : guestIdentity
                        ? `g:${guestIdentity}`
                        : "anon",
                  rawIdempotencyKey
              )
            : null;

        const result =
            await createCheckoutOrder({
                userId,
                mode: "BUY_NOW",
                addressId: addressId || undefined,
                guestAddress:
                    guestAddress ?? undefined,
                guestIdentityKey: guestIdentity,
                customerEmail:
                    user?.email ?? null,
                idempotencyKey,
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

        const response = jsonSuccess(
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

                requiresCodReview: Boolean(
                    result.requiresCodReview
                ),
            },
            201
        );

        /*
         * The cookie MUST carry the same token whose hash the order
         * persisted (``result.guestAccessToken``); a separately minted
         * token would not match the stored hash and would lock the buyer
         * out of the order they just placed.
         *
         * Never re-issue the cookie for an idempotent REPLAY: the stored
         * hash belongs to the original token, so overwriting it here
         * would invalidate the buyer's working cookie.
         */
        if (result.guestAccessToken && !result.duplicate) {
            issueGuestOrderAccessCookie(
                response,
                result.order.id,
                result.guestAccessToken
            );
        }

        return response;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "BUY_NOW_COD",
                message: error instanceof Error ? error.message : "Unknown error",
                timestamp: new Date().toISOString(),
            })
        );

        return jsonError(
            error instanceof Error
                ? error.message
                : "Gagal membuat pesanan.",
            400
        );
    }
}