import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveBatchPrices } from "@/lib/marketing/batch-pricing";
import type { CartStockStatus } from "@/lib/cart-validation";
import {
    applyCartCookie,
    findCartForScope,
    getOrCreateCartForScope,
    resolveCartScope,
    type CartScope,
} from "@/lib/cart-scope";
import {
    getClientIp,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import { rejectCrossSite } from "@/lib/checkout-idempotency";
import { promoVisitorHashFromCookieHeader } from "@/lib/promo-claim";

/**
 * ==========================================
 * CART API — CUSTOMER LOGIN IS NOT REQUIRED
 * ==========================================
 *
 * The cart may belong to:
 *   - an authenticated customer (legacy), or
 *   - an anonymous guest, scoped by an httpOnly cart cookie.
 *
 * Security notes:
 *  - A cart is a CART SCOPE, not a verified identity. Every price and
 *    stock level shown here is display data; checkout re-derives the
 *    authoritative values server-side (lib/checkout.ts). A tampered
 *    cart cookie cannot change what is charged.
 *  - Item lookups are always filtered by the resolved scope, so one
 *    guest can never read or mutate another guest's cart items.
 *  - Guest mutations are rate limited by IP.
 */

/**
 * Prisma `where` fragment identifying carts owned by this scope.
 * Returns null for a guest that has no cookie yet.
 */
function cartScopeFilter(
    scope: CartScope
):
    | { userId: string }
    | { guestTokenHash: string }
    | null {
    if (scope.userId) {
        return { userId: scope.userId };
    }

    if (scope.guestTokenHash) {
        return {
            guestTokenHash: scope.guestTokenHash,
        };
    }

    return null;
}

/**
 * ==========================================
 * SHARED CART FORMATTER
 * ==========================================
 *
 * Formats cart items with marketing prices.
 * Used by GET, PATCH, and DELETE to ensure
 * consistent response structure.
 *
 * Returns flat items matching the CartItem type
 * used by CartPage.tsx.
 */
async function formatCartResponse(
    cartData: {
        id: number | null;
        userId: string | null;
        items: Array<{
            id: number;
            productId: number;
            variantId: number;
            quantity: number;
            product: { id: number; name: string; slug: string; image: string | null; category: string | null };
            variant: { id: number; name: string; price: any; comparePrice: any; stock: number; image: string | null; weight: number };
        }>;
    } | null,
    promoClaimVisitorKeyHash?: string | null
) {
    if (!cartData) {
        return { cart: null };
    }

    const cartItems = cartData.items;

    const pricingResults = await resolveBatchPrices(
        cartItems.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            originalPrice: Number(item.variant.price),
            quantity: Number(item.quantity),
            category: item.product.category,
        })),
        new Date(),
        promoClaimVisitorKeyHash
    );

    const pricingMap = new Map(
        pricingResults.map((r) => [r.variantId, r])
    );

    // ==========================================
    // BATCH: Flash sale stock for all variants
    // ==========================================
    const variantIds = [
        ...new Set(cartItems.map((item) => item.variantId)),
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

    const formattedItems = cartItems.map((item) => {
        const pricing = pricingMap.get(item.variantId);
        const rawPrice = Number(item.variant.price);
        const effectivePrice = pricing?.effectivePrice ?? rawPrice;

        // ==========================================
        // STOCK STATUS
        // ==========================================
        // Flash sale items: authoritative stock is saleStock
        // Regular items: authoritative stock is variant.stock
        const flashSale = flashSaleStockMap.get(item.variantId);
        const availableStock = flashSale
            ? flashSale.saleStock
            : item.variant.stock;

        let stockStatus: CartStockStatus = "OK";
        if (availableStock <= 0) {
            stockStatus = "OUT_OF_STOCK";
        } else if (item.quantity > availableStock) {
            stockStatus = "INSUFFICIENT_STOCK";
        }

        return {
            id: item.id,
            productId: item.productId,
            variantId: item.variantId,
            productName: item.product.name,
            productSlug: item.product.slug,
            variantName: item.variant.name,
            image: item.variant.image || item.product.image || null,
            price: effectivePrice,
            // DISPLAY-ONLY (never charged).
            comparePrice:
                item.variant.comparePrice != null
                    ? Number(item.variant.comparePrice)
                    : null,
            originalPrice: pricing?.originalPrice ?? rawPrice,
            discount: pricing?.discountAmount ?? 0,
            hasDiscount: (pricing?.discountAmount ?? 0) > 0,
            priceSource: pricing?.source ?? "ORIGINAL",
            flashSaleName: pricing?.flashSaleName ?? null,
            bulkDiscountName: pricing?.bulkDiscountName ?? null,
            quantity: Number(item.quantity),
            stock: item.variant.stock,
            availableStock,
            stockStatus,
            flashSaleId: flashSale?.id ?? null,
            weight: Number(item.variant.weight),
        };
    });

    const invalidCount = formattedItems.filter(
        (item) => item.stockStatus !== "OK"
    ).length;

    return {
        cart: {
            id: cartData.id,
            userId: cartData.userId,
            items: formattedItems,
            invalidCount,
        },
    };
}

/**
 * Load the scope's cart with items, for the formatted response.
 */
async function loadScopedCart(scope: CartScope) {
    const filter = cartScopeFilter(scope);

    if (!filter) {
        return null;
    }

    return prisma.cart.findFirst({
        where: filter,
        include: {
            items: {
                include: { product: true, variant: true },
                orderBy: { createdAt: "desc" },
            },
        },
    });
}

/**
 * Rate limit guest cart mutations. Logged-in traffic keeps the
 * pre-existing behaviour (no extra limiter).
 */
function guestCartRateLimited(
    request: Request,
    scope: CartScope
): boolean {
    if (scope.userId) {
        return false;
    }

    const ip = getClientIp(request);

    return !rateLimiters.guestCart(
        guestIpKey({ ip, scope: "cart" })
    ).allowed;
}

export async function GET(request: NextRequest) {
    try {
        const scope = await resolveCartScope();

        const cart = await loadScopedCart(scope);

        // ==========================================
        // FORMAT WITH MARKETING PRICES
        // ==========================================
        const result = await formatCartResponse(cart, promoVisitorHashFromCookieHeader(request.headers.get("cookie")));

        return NextResponse.json(result);
    } catch (error) {
        console.error("GET CART ERROR:", error);

        return NextResponse.json(
            {
                message: "Gagal mengambil keranjang.",
            },
            {
                status: 500,
            }
        );
    }
}

export async function POST(
    request: Request
) {
    try {
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const scope = await resolveCartScope();

        if (guestCartRateLimited(request, scope)) {
            return NextResponse.json(
                {
                    message:
                        "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const body = await request.json();

        const variantId = Number(
            body.variantId
        );

        const quantity = Number(
            body.quantity ?? 1
        );

        if (
            !variantId ||
            !Number.isInteger(variantId)
        ) {
            return NextResponse.json(
                {
                    message: "Varian produk tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            !Number.isInteger(quantity) ||
            quantity < 1
        ) {
            return NextResponse.json(
                {
                    message: "Jumlah produk tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const variant =
            await prisma.productVariant.findUnique({
                where: {
                    id: variantId,
                },
            });

        if (!variant) {
            return NextResponse.json(
                {
                    message: "Varian produk tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        /*
         * F4: A variant under an ACTIVE flash sale uses flash
         * saleStock as its authoritative stock (checkout fully skips
         * variant.stock for flash items). Validate the cart against
         * saleStock, not variant.stock, so oversized carts are caught
         * here instead of failing at checkout.
         */
        const activeFlashSale =
            await prisma.flashSale.findFirst({
                where: {
                    variantId,
                    isActive: true,
                    startAt: { lte: new Date() },
                    endAt: { gte: new Date() },
                },
                select: { id: true, saleStock: true },
            });

        const availableLimit = activeFlashSale
            ? activeFlashSale.saleStock
            : variant.stock;

        if (activeFlashSale && activeFlashSale.saleStock <= 0) {
            return NextResponse.json(
                {
                    message: "Stok flash sale habis.",
                },
                {
                    status: 400,
                }
            );
        }

        if (!activeFlashSale && variant.stock <= 0) {
            return NextResponse.json(
                {
                    message: "Stok produk habis.",
                },
                {
                    status: 400,
                }
            );
        }

        if (quantity > availableLimit) {
            return NextResponse.json(
                {
                    message: activeFlashSale
                        ? `Stok flash sale hanya tersedia ${activeFlashSale.saleStock}.`
                        : `Stok hanya tersedia ${variant.stock}.`,
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * LOGGED-IN ONLY: verify the account still exists (deleted
         * accounts must not keep a cart). Guests have no account.
         */
        if (scope.userId) {
            const userExists = await prisma.user.findUnique({
                where: { id: scope.userId },
                select: { id: true },
            });

            if (!userExists) {
                return NextResponse.json(
                    {
                        message:
                            "Sesi tidak valid, silakan login ulang.",
                    },
                    { status: 401 }
                );
            }
        }

        /*
         * Find or create the cart for this scope. A guest with no
         * cookie yet gets a fresh token, returned so it can be set as
         * an httpOnly cookie on this response.
         */
        const { cart, issuedToken } =
            await getOrCreateCartForScope(scope);

        const scopeFilter = cartScopeFilter(scope);

        const existingItem =
            await prisma.cartItem.findUnique({
                where: {
                    cartId_variantId: {
                        cartId: cart.id,
                        variantId,
                    },
                },
            });

        if (existingItem) {
            // LOW-1 FIX: Use atomic increment to prevent TOCTOU race condition.
            // Atomic increment + stock check avoids the read→calculate→write gap
            // where two concurrent requests could both read the same quantity
            // and produce incorrect results.
            const updated = await prisma.cartItem.updateMany({
                where: {
                    id: existingItem.id,
                    cart: scopeFilter ?? { id: cart.id },
                },
                data: {
                    quantity: { increment: quantity },
                },
            });

            if (updated.count === 0) {
                return NextResponse.json(
                    { message: "Item keranjang tidak ditemukan." },
                    { status: 404 }
                );
            }

            // Verify stock after atomic increment (F4: flash-aware)
            const afterUpdate = await prisma.cartItem.findUnique({
                where: { id: existingItem.id },
                select: { quantity: true },
            });

            if (afterUpdate && afterUpdate.quantity > availableLimit) {
                // Rollback the increment
                await prisma.cartItem.updateMany({
                    where: {
                        id: existingItem.id,
                        cart: scopeFilter ?? { id: cart.id },
                    },
                    data: {
                        quantity: { decrement: quantity },
                    },
                });
                return NextResponse.json(
                    {
                        message: activeFlashSale
                            ? `Jumlah melebihi stok flash sale. Stok tersedia ${activeFlashSale.saleStock}.`
                            : `Jumlah melebihi stok. Stok tersedia ${variant.stock}.`,
                    },
                    {
                        status: 400,
                    }
                );
            }
        } else {
            await prisma.cartItem.create({
                data: {
                    cartId: cart.id,
                    productId: variant.productId,
                    variantId: variant.id,
                    quantity,
                },
            });
        }

        // Return formatted cart with marketing prices
        const updatedCart = await loadScopedCart({
            userId: scope.userId,
            guestTokenHash:
                scope.guestTokenHash ??
                null,
        });

        const result = await formatCartResponse(updatedCart, promoVisitorHashFromCookieHeader(request.headers.get("cookie")));

        const response = NextResponse.json(
            {
                message:
                    existingItem

                        ? "Keranjang berhasil diperbarui."
                        : "Produk berhasil ditambahkan ke keranjang.",
                ...result,
            },
            {
                status: existingItem ? 200 : 201,
            }
        );

        return applyCartCookie(response, issuedToken);
    } catch (error) {
        console.error(
            "POST CART ERROR:",
            error
        );

        return NextResponse.json(
            {
                message:
                    "Gagal menambahkan produk ke keranjang.",
            },
            {
                status: 500,
            }
        );
    }
}

export async function PATCH(
    request: Request
) {
    try {
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const scope = await resolveCartScope();

        if (guestCartRateLimited(request, scope)) {
            return NextResponse.json(
                {
                    message:
                        "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const scopeFilter = cartScopeFilter(scope);

        /*
         * A guest with no cart cookie has no cart, so there is nothing
         * of theirs to update (404, never another scope's item).
         */
        if (!scopeFilter) {
            return NextResponse.json(
                {
                    message:
                        "Item keranjang tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        const body = await request.json();

        const itemId = Number(body.itemId);
        const quantity = Number(body.quantity);

        if (
            !Number.isInteger(itemId) ||
            !Number.isInteger(quantity) ||
            quantity < 1
        ) {
            return NextResponse.json(
                {
                    message:
                        "Data quantity tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const item =
            await prisma.cartItem.findFirst({
                where: {
                    id: itemId,
                    cart: scopeFilter,
                },
                include: {
                    variant: true,
                },
            });

        if (!item) {
            return NextResponse.json(
                {
                    message:
                        "Item keranjang tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        // F4: flash-aware stock check for PATCH
        const activeFlashSale =
            await prisma.flashSale.findFirst({
                where: {
                    variantId: item.variantId,
                    isActive: true,
                    startAt: { lte: new Date() },
                    endAt: { gte: new Date() },
                },
                select: { id: true, saleStock: true },
            });

        const availableLimit = activeFlashSale
            ? activeFlashSale.saleStock
            : item.variant.stock;

        if (activeFlashSale && activeFlashSale.saleStock <= 0) {
            return NextResponse.json(
                {
                    message: "Stok flash sale habis.",
                },
                {
                    status: 400,
                }
            );
        }

        if (!activeFlashSale && item.variant.stock <= 0) {
            return NextResponse.json(
                {
                    message: "Stok produk habis.",
                },
                {
                    status: 400,
                }
            );
        }

        if (quantity > availableLimit) {
            return NextResponse.json(
                {
                    message: activeFlashSale
                        ? `Stok flash sale hanya tersedia ${activeFlashSale.saleStock}.`
                        : `Stok hanya tersedia ${item.variant.stock}.`,
                },
                {
                    status: 400,
                }
            );
        }

        await prisma.cartItem.update({
            where: {
                id: itemId,
            },
            data: {
                quantity,
            },
        });

        // Return formatted cart with marketing prices
        const cart = await loadScopedCart(scope);

        const result = await formatCartResponse(cart, promoVisitorHashFromCookieHeader(request.headers.get("cookie")));

        return NextResponse.json({
            message:
                "Keranjang berhasil diperbarui.",
            ...result,
        });
    } catch (error) {
        console.error(
            "PATCH CART ERROR:",
            error
        );

        return NextResponse.json(
            {
                message:
                    "Gagal memperbarui keranjang.",
            },
            {
                status: 500,
            }
        );
    }
}

export async function DELETE(
    request: Request
) {
    try {
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const scope = await resolveCartScope();

        if (guestCartRateLimited(request, scope)) {
            return NextResponse.json(
                {
                    message:
                        "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const scopeFilter = cartScopeFilter(scope);

        if (!scopeFilter) {
            return NextResponse.json(
                {
                    message:
                        "Item tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        const body = await request.json();

        const itemId = Number(body.itemId);

        if (!Number.isInteger(itemId)) {
            return NextResponse.json(
                {
                    message:
                        "Item tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const item =
            await prisma.cartItem.findFirst({
                where: {
                    id: itemId,
                    cart: scopeFilter,
                },
            });

        if (!item) {
            return NextResponse.json(
                {
                    message:
                        "Item tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        await prisma.cartItem.delete({
            where: {
                id: itemId,
            },
        });

        // Return formatted cart with marketing prices
        const cart = await loadScopedCart(scope);

        const result = await formatCartResponse(cart, promoVisitorHashFromCookieHeader(request.headers.get("cookie")));

        return NextResponse.json({
            message:
                "Produk berhasil dihapus.",
            ...result,
        });
    } catch (error) {
        console.error(
            "DELETE CART ERROR:",
            error
        );

        return NextResponse.json(
            {
                message:
                    "Gagal menghapus produk.",
            },
            {
                status: 500,
            }
        );
    }
}
