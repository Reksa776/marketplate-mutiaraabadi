import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { CartScope } from "@/lib/cart-scope";
import { cartScopeWhere } from "@/lib/cart-scope";

/* ==========================================
 * CART STOCK VALIDATION
 * ==========================================
 *
 * Centralized helper for validating cart items
 * against current database stock. Used by:
 *   - Cart API GET (display warnings)
 *   - Checkout API GET (block checkout)
 *   - Checkout order creation (pre-validation)
 *
 * Supports the anonymous guest cart scope as well as the legacy
 * logged-in cart: pass a `CartScope` (preferred) or a bare userId
 * string. A guest scope resolves via the hashed cart cookie token.
 *
 * DOES NOT mutate stock — read-only check.
 */

export type CartStockStatus =
    | "OK"
    | "OUT_OF_STOCK"
    | "INSUFFICIENT_STOCK"
    | "VARIANT_NOT_FOUND";

export type CartItemStockValidation = {
    cartItemId: number;
    productId: number;
    variantId: number;
    productName: string;
    variantName: string;
    requestedQuantity: number;
    availableStock: number;
    stockSource: "VARIANT" | "FLASH_SALE";
    flashSaleId: number | null;
    status: CartStockStatus;
};

export type CartStockValidationResult = {
    valid: boolean;
    items: CartItemStockValidation[];
    invalidCount: number;
};

/**
 * Validate stock for all items in a user's cart.
 *
 * For each cart item:
 * 1. Check if variant still exists (defense in depth)
 * 2. Check if this is an active flash sale item
 * 3. Compare requested quantity against available stock
 *    (FlashSale.saleStock for flash sale, ProductVariant.stock for regular)
 *
 * Returns validation result without mutating any data.
 */
export async function validateCartStock(
    scope: CartScope | string,
    tx?: Prisma.TransactionClient
): Promise<CartStockValidationResult> {
    const client = tx ?? prisma;

    const resolved: CartScope =
        typeof scope === "string"
            ? { userId: scope, guestTokenHash: null }
            : scope;

    const where = cartScopeWhere(resolved);

    const cart = where
        ? await client.cart.findFirst({
              where,
              include: {
                  items: {
                      include: {
                          product: true,
                          variant: true,
                      },
                  },
              },
          })
        : null;

    if (!cart || cart.items.length === 0) {
        return {
            valid: true,
            items: [],
            invalidCount: 0,
        };
    }

    // ==========================================
    // BATCH: Flash sales for all variant IDs
    // ==========================================
    const variantIds = [
        ...new Set(cart.items.map((item) => item.variantId)),
    ];

    const flashSales = await client.flashSale.findMany({
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

    const flashSaleMap = new Map(
        flashSales.map((fs) => [fs.variantId, fs])
    );

    // ==========================================
    // VALIDATE EACH ITEM
    // ==========================================
    const items: CartItemStockValidation[] =
        cart.items.map((item) => {
            // Defense in depth: variant deleted
            // (shouldn't happen due to onDelete: Cascade,
            // but handle gracefully)
            if (!item.variant) {
                return {
                    cartItemId: item.id,
                    productId: item.productId,
                    variantId: item.variantId,
                    productName:
                        item.product?.name ??
                        "Produk tidak dikenal",
                    variantName: "Varian tidak dikenal",
                    requestedQuantity: item.quantity,
                    availableStock: 0,
                    stockSource: "VARIANT",
                    flashSaleId: null,
                    status: "VARIANT_NOT_FOUND" as const,
                };
            }

            // Flash sale item: check saleStock
            const flashSale = flashSaleMap.get(
                item.variantId
            );

            if (flashSale) {
                const available = flashSale.saleStock;
                let status: CartStockStatus = "OK";

                if (available <= 0) {
                    status = "OUT_OF_STOCK";
                } else if (item.quantity > available) {
                    status = "INSUFFICIENT_STOCK";
                }

                return {
                    cartItemId: item.id,
                    productId: item.productId,
                    variantId: item.variantId,
                    productName: item.product.name,
                    variantName: item.variant.name,
                    requestedQuantity: item.quantity,
                    availableStock: available,
                    stockSource: "FLASH_SALE",
                    flashSaleId: flashSale.id,
                    status,
                };
            }

            // Regular item: check ProductVariant.stock
            const available = item.variant.stock;
            let status: CartStockStatus = "OK";

            if (available <= 0) {
                status = "OUT_OF_STOCK";
            } else if (item.quantity > available) {
                status = "INSUFFICIENT_STOCK";
            }

            return {
                cartItemId: item.id,
                productId: item.productId,
                variantId: item.variantId,
                productName: item.product.name,
                variantName: item.variant.name,
                requestedQuantity: item.quantity,
                availableStock: available,
                stockSource: "VARIANT",
                flashSaleId: null,
                status,
            };
        });

    const invalidCount = items.filter(
        (item) => item.status !== "OK"
    ).length;

    return {
        valid: invalidCount === 0,
        items,
        invalidCount,
    };
}
