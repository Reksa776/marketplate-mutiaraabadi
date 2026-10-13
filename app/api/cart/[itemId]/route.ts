import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
    resolveCartScope,
    type CartScope,
} from "@/lib/cart-scope";
import {
    getClientIp,
    guestIpKey,
    rateLimiters,
} from "@/lib/rate-limit";
import { rejectCrossSite } from "@/lib/checkout-idempotency";

type Params = {
    params: Promise<{
        itemId: string;
    }>;
};

/**
 * Cart item routes accept BOTH the logged-in cart scope and the
 * anonymous guest cart scope. The item is always resolved through the
 * caller's own scope, so a guest can never touch another scope's item
 * by guessing an item id.
 */
function scopeFilter(scope: CartScope) {
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

function guestLimited(
    request: Request,
    scope: CartScope
): boolean {
    if (scope.userId) {
        return false;
    }

    const ip = getClientIp(request);

    return !rateLimiters.guestCart(
        guestIpKey({ ip, scope: "cart-item" })
    ).allowed;
}

export async function PATCH(
    request: Request,
    { params }: Params
) {
    try {
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const scope = await resolveCartScope();

        if (guestLimited(request, scope)) {
            return NextResponse.json(
                {
                    message:
                        "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const filter = scopeFilter(scope);

        if (!filter) {
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

        const { itemId } =
            await params;

        const id = Number(itemId);

        const body =
            await request.json();

        const quantity = Number(
            body.quantity
        );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
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

        if (
            !Number.isInteger(
                quantity
            ) ||
            quantity <= 0
        ) {
            return NextResponse.json(
                {
                    message:
                        "Quantity tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const item =
            await prisma.cartItem.findFirst(
                {
                    where: {
                        id,

                        cart: filter,
                    },

                    include: {
                        variant: true,
                    },
                }
            );

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

        /*
         * Flash-aware stock ceiling: an active flash sale's saleStock
         * is the authoritative stock for that variant, so the cart can
         * never be sized beyond what checkout would accept.
         */
        const activeFlashSale =
            await prisma.flashSale.findFirst({
                where: {
                    variantId: item.variantId,
                    isActive: true,
                    startAt: { lte: new Date() },
                    endAt: { gte: new Date() },
                },
                select: { saleStock: true },
            });

        const availableLimit = activeFlashSale
            ? activeFlashSale.saleStock
            : item.variant.stock;

        if (quantity > availableLimit) {
            return NextResponse.json(
                {
                    message: `Stok tersedia hanya ${availableLimit}.`,
                },
                {
                    status: 400,
                }
            );
        }

        await prisma.cartItem.update(
            {
                where: {
                    id: item.id,
                },

                data: {
                    quantity,
                },
            }
        );

        return NextResponse.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "UPDATE CART ERROR:",
            error
        );

        return NextResponse.json(
            {
                message:
                    "Gagal mengubah quantity.",
            },
            {
                status: 500,
            }
        );
    }
}

export async function DELETE(
    request: Request,
    { params }: Params
) {
    try {
        const crossSite = rejectCrossSite(request);

        if (crossSite) {
            return crossSite;
        }

        const scope = await resolveCartScope();

        if (guestLimited(request, scope)) {
            return NextResponse.json(
                {
                    message:
                        "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const filter = scopeFilter(scope);

        if (!filter) {
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

        const { itemId } =
            await params;

        const id = Number(itemId);

        const item =
            await prisma.cartItem.findFirst(
                {
                    where: {
                        id,

                        cart: filter,
                    },
                }
            );

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
                id: item.id,
            },
        });

        return NextResponse.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "DELETE CART ERROR:",
            error
        );

        return NextResponse.json(
            {
                message:
                    "Gagal menghapus item.",
            },
            {
                status: 500,
            }
        );
    }
}
