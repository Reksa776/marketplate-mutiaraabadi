import {
    NextRequest,
    NextResponse,
} from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

import {
    createCheckoutOrder,
    getShippingCost,
} from "@/lib/checkout";

import { getReferralCode } from "@/lib/affiliate/referral";

import {
    getClientIp,
    guestDeviceKey,
    guestIdentityKey as guestIdentityBucketKey,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import { readOrderAttribution } from "@/lib/analytics/attribution-server";
import {
    buildGuestIdentityKey,
    generateGuestAccessToken,
} from "@/lib/guest-identity";
import {
    issueGuestOrderAccessCookie,
    listGuestAccessibleOrderIds,
} from "@/lib/guest-order-access";
import {
    hashCartToken,
    readCartTokenFromCookieHeader,
} from "@/lib/cart-scope";
import {
    readIdempotencyKey,
    rejectCrossSite,
    scopeIdempotencyKey,
} from "@/lib/checkout-idempotency";

/*
 * ==========================================
 * POST /api/orders
 * ==========================================
 *
 * COD ONLY
 *
 * Flow:
 *
 * validate
 * ↓
 * create order
 * ↓
 * reserve stock
 * ↓
 * clear cart
 */

export async function POST(
    request: NextRequest
) {
    try {
        /*
         * CSRF defense-in-depth: a guest checkout is authorized by
         * cookies (cart token), so a cross-site POST is rejected.
         */
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        /*
         * ==========================================
         * BUYER (login is optional)
         * ==========================================
         */

        const session =
            await auth();

        const userId =
            session?.user?.id ?? null;

        /*
         * ==========================================
         * BODY
         * ==========================================
         */

        const body =
            await request.json();

        const {
            addressId,
            guestAddress,
            shipping,
            paymentMethod,
            voucherCode,
            spinWheelSpinId,
            selectedCartItemIds,
        } = body;

        /*
         * Guest identity scope (hashed email/phone). Used for the
         * per-identity COD limits and the dedupe of repeated checkout
         * attempts. Never returned to the browser.
         */
        const guestIdentity =
            buildGuestIdentityKey({
                email:
                    guestAddress?.email,
                phone:
                    guestAddress?.phone,
            });

        /*
         * ==========================================
         * RATE LIMIT
         * ==========================================
         *
         * Logged-in buyers keep the original per-user limiter. Guests are
         * limited on BOTH the device/IP bucket and the identity bucket so
         * neither a single client nor a single person rotating IPs can
         * spam COD orders.
         */

        const rawCartToken =
            readCartTokenFromCookieHeader(
                request.headers.get("cookie")
            );

        if (userId) {
            const rateLimit =
                rateLimiters.orderCreation(userId);

            if (!rateLimit.allowed) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Terlalu banyak permintaan. Coba lagi nanti.",
                    },
                    { status: 429 }
                );
            }
        } else {
            const ip = getClientIp(request);

            const allowed =
                rateLimiters.guestCodDevice(
                    guestDeviceKey({
                        ip,
                        scope: "cod",
                        deviceKey: rawCartToken
                            ? hashCartToken(rawCartToken)
                            : null,
                    }) ?? guestIpKey({ ip, scope: "cod" })
                ).allowed &&
                rateLimiters.guestCheckoutDevice(
                    guestIpKey({ ip, scope: "checkout" })
                ).allowed &&
                (guestIdentity
                    ? rateLimiters.guestCodIdentity(
                          guestIdentityBucketKey({
                              ip,
                              scope: "cod",
                              identityKey: guestIdentity,
                          })!
                      ).allowed
                    : true);

            if (!allowed) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Terlalu banyak permintaan COD. Silakan coba lagi nanti.",
                    },
                    { status: 429 }
                );
            }
        }

        /*
         * ==========================================
         * COD ONLY
         * ==========================================
         */

        if (
            paymentMethod !==
            "COD"
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Pembayaran non-COD harus melalui API iPaymu.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * ADDRESS
         * ==========================================
         *
         * Logged-in buyers may use a saved address id. Guests MUST send
         * the inline address, which is validated and resolved
         * server-side (region canonicalization + destination lookup) by
         * createCheckoutOrder → resolveGuestAddress.
         */

        const hasSavedAddress =
            typeof addressId === "string" &&
            addressId.trim().length > 0;

        const hasGuestAddress =
            guestAddress &&
            typeof guestAddress === "object";

        if (!userId && !hasGuestAddress) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Alamat pengiriman wajib diisi.",
                },
                {
                    status: 400,
                }
            );
        }

        if (userId && !hasSavedAddress && !hasGuestAddress) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Alamat pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * SHIPPING
         * ==========================================
         */

        if (
            !shipping ||
            typeof shipping !==
                "object"
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Layanan pengiriman wajib dipilih.",
                },
                {
                    status: 400,
                }
            );
        }

        const shippingCost =
            getShippingCost(
                shipping
            );

        if (
            !Number.isFinite(
                shippingCost
            )
        ) {
            return NextResponse.json(
                {
                    success: false,

                    message:
                        "Biaya pengiriman tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * ==========================================
         * CREATE COD ORDER
         * ==========================================
         */

        const affiliateCode =
            getReferralCode(
                request.headers.get("cookie")
            );

        /*
         * ==========================================
         * IDEMPOTENCY
         * ==========================================
         *
         * A double-submitted COD checkout must not create two orders.
         * The key is namespaced to the buyer scope so one guest cannot
         * replay another guest's key. Rate limiting still applies when
         * no key is supplied.
         */
        const rawIdempotencyKey =
            readIdempotencyKey(request, body);

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

        /*
         * ==========================================
         * GUEST ORDER ACCESS TOKEN (pre-generated)
         * ==========================================
         *
         * Generated here so the raw value can be returned EXACTLY ONCE
         * (httpOnly cookie). It is never logged.
         */
        const guestToken = userId
            ? null
            : generateGuestAccessToken();

        const result =
            await createCheckoutOrder(
                {
                    userId,

                    mode:
                        "CART",

                    addressId: hasSavedAddress
                        ? addressId
                        : undefined,

                    guestAddress: hasGuestAddress
                        ? guestAddress
                        : undefined,

                    cartGuestTokenHash:
                        rawCartToken
                            ? hashCartToken(
                                  rawCartToken
                              )
                            : null,

                    guestIdentityKey:
                        guestIdentity,

                    customerEmail:
                        session?.user?.email ??
                        null,

                    idempotencyKey,

                    shipping,

                    paymentMethod:
                        "COD",

                    voucherCode:
                        typeof voucherCode ===
                        "string"
                            ? voucherCode
                            : null,

                    affiliateCode,

                    spinWheelSpinId: typeof spinWheelSpinId === "number" ? spinWheelSpinId : null,

                    attribution: readOrderAttribution(request),

                    selectedCartItemIds: Array.isArray(selectedCartItemIds)
                        ? selectedCartItemIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
                        : undefined,
                }
            );

        const response = NextResponse.json(
            {
                success: true,

                message: result.requiresCodReview
                    ? "Pesanan berhasil dibuat dan sedang menunggu verifikasi."
                    : "Pesanan berhasil dibuat.",

                data: {
                    ...result.order,

                    subtotal:
                        result.subtotal,

                    shippingCost:
                        result.shippingCost,

                    discount:
                        result.discount,

                    total:
                        result.grossAmount,

                    /*
                     * Never expose the token in the body — only the
                     * order number, so the buyer can reference it. The
                     * token travels in the httpOnly cookie below.
                     */
                    requiresCodReview:
                        Boolean(
                            result.requiresCodReview
                        ),
                },
            },
            {
                status: 201,
            }
        );

        /*
         * Bind the guest order to this browser with an httpOnly cookie
         * so it can be tracked later without exposing the token.
         *
         * NOT on a replay: the stored hash is the ORIGINAL token's, so
         * issuing a fresh one here would overwrite the buyer's working
         * cookie with a value that no longer matches the order — locking
         * them out of their own order.
         */
        if (guestToken && !result.duplicate) {
            issueGuestOrderAccessCookie(
                response,
                result.order.id,
                guestToken
            );
        }

        return response;
    } catch (error: any) {
        console.error(
            JSON.stringify({
                event: "CHECKOUT_FAILURE",
                checkoutType: "CART_COD",
                message: error?.message ?? "Unknown error",
                timestamp: new Date().toISOString(),
            })
        );

        const status =
            Number.isInteger(
                error?.status
            )
                ? error.status
                : 500;

        return NextResponse.json(
            {
                success: false,

                message:
                    error?.message ??
                    "Gagal membuat pesanan.",
            },
            {
                status,
            }
        );
    }
}

/*
 * ==========================================
 * GET /api/orders
 * ==========================================
 */

/**
 * ==========================================
 * GET /api/orders
 * ==========================================
 *
 * LOGIN IS NOT REQUIRED.
 *
 *  - Logged-in buyer → their own orders (userId scope).
 *  - Guest            → ONLY the orders this browser holds a valid
 *                       access token for (verified against the stored
 *                       hash). There is no way to enumerate orders.
 */
export async function GET() {
    try {
        const session =
            await auth();

        const scopeWhere = session?.user?.id
            ? { userId: session.user.id }
            : await (async () => {
                  const ids =
                      await listGuestAccessibleOrderIds();

                  if (ids.length === 0) {
                      return null;
                  }

                  return { id: { in: ids } };
              })();

        if (!scopeWhere) {
            /*
             * A guest with no accessible order gets an empty list, not a
             * 401: browsing order history must not force a login.
             */
            return NextResponse.json({
                success: true,
                data: [],
            });
        }

        const orders =
            await prisma.order.findMany(
                {
                    where: scopeWhere,

                    orderBy: {
                        createdAt:
                            "desc",
                    },

                    include: {
                        voucher: {
                            select: {
                                id: true,
                                code: true,
                                type: true,
                                value: true,
                            },
                        },

                        items: {
                            take: 1,

                            include: {
                                product: {
                                    select: {
                                        id: true,
                                        name: true,
                                        slug: true,
                                        image: true,
                                    },
                                },

                                variant: {
                                    select: {
                                        id: true,
                                        name: true,
                                        image: true,
                                    },
                                },
                            },
                        },
                    },
                }
            );

        return NextResponse.json(
            {
                success: true,

                data:
                    orders,
            }
        );
    } catch (error) {
        console.error(
            "GET CUSTOMER ORDERS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,

                message:
                    "Gagal mengambil pesanan.",
            },
            {
                status: 500,
            }
        );
    }
}