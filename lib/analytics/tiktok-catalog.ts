/**
 * ==========================================
 * TIKTOK PRODUCT CATALOG SIGNALS
 * ==========================================
 *
 * Single source of truth for the PRODUCT / CATALOG parameters the
 * storefront sends to TikTok (browser Pixel and server Events API
 * alike), so both channels always describe the same product the
 * same way and TikTok can match the event against a catalog.
 *
 * This module is intentionally NOT `server-only`: the browser Pixel
 * and the server Events API must agree byte-for-byte.
 *
 * ------------------------------------------------------------------
 * WHICH ID IS `content_id`? (audited, see the task report)
 * ------------------------------------------------------------------
 *
 * The database has NO SKU column: `product`, `productvariant`,
 * `cartitem` and `orderitem` expose only autoincrement ids, a slug
 * and a name (verified: zero occurrences of "sku" in the schema).
 *
 * TikTok requires `content_id` to be the SAME identifier the
 * merchant later publishes as the catalog item id / SKU. Changing
 * that identifier later splits the history, so it has to be the
 * most stable product-level identity the application already owns.
 *
 * Resolution order (first usable value wins):
 *
 *   1. `sku`                      — used the moment a real SKU
 *                                   column/feed value exists.
 *                                   Nothing in the codebase needs
 *                                   to change except passing it in.
 *   2. `productId`                — the FINAL identity used today.
 *                                   Stable (never reused), numeric,
 *                                   present on every product, cart
 *                                   item and order item, and already
 *                                   the product identity the
 *                                   storefront routes by.
 *   3. `variantId`                — last-resort fallback for the
 *                                   rare order item whose product
 *                                   row was deleted (`onDelete:
 *                                   SetNull` leaves productId null).
 *
 * Deliberately NOT used:
 *   - product slug      (mutable marketing text — renaming a
 *                        product would break the catalog match)
 *   - order id / order number / payment reference (order-level
 *     identity is not a product identity)
 *   - a synthetic random value
 *
 * The catalog the merchant creates in TikTok Catalog Manager MUST
 * use these exact values as its item ids (see the manual steps in
 * the task report). No migration is required or performed.
 */

/** Single currency source of truth for the whole storefront. */
export const TIKTOK_CURRENCY = "IDR";

/** TikTok content type for a physical/variant product. */
export const TIKTOK_CONTENT_TYPE_PRODUCT = "product";

/**
 * One entry of the TikTok `properties.contents[]` array.
 *
 * `content_id` is the only required field; every other key is
 * omitted when the caller does not have a real value.
 */
export type TikTokCatalogContent = {
    content_id: string;
    content_type?: string;
    content_name?: string;
    quantity?: number;
    price?: number;
};

export type TikTokCatalogItemInput = {
    /** Product identity — the catalog id used today. */
    productId?: number | string | null;
    /** Variant identity — fallback only. */
    variantId?: number | null;
    /**
     * Real SKU, when the caller has one. Highest priority so a
     * future SKU column / catalog feed drops in without touching
     * any event payload builder.
     */
    sku?: string | null;
    productName?: string | null;
    variantName?: string | null;
    /** Accepts a Prisma Int, a number, or a numeric string. */
    quantity?: unknown;
    /** UNIT price (not the line subtotal) — Prisma Decimal included. */
    price?: unknown;
};

/**
 * Resolve the catalog `content_id` for one product.
 *
 * Returns null when there is nothing usable, so callers can skip
 * the item instead of sending an empty or fabricated id.
 */
export function resolveTikTokContentId(input: {
    productId?: number | string | null;
    variantId?: number | null;
    sku?: string | null;
}): string | null {
    const sku =
        typeof input.sku === "string"
            ? input.sku.trim()
            : "";

    if (sku) {
        return sku;
    }

    if (
        input.productId !== null &&
        input.productId !== undefined
    ) {
        const productId = String(
            input.productId
        ).trim();

        if (productId) {
            return productId;
        }
    }

    if (
        input.variantId !== null &&
        input.variantId !== undefined
    ) {
        const variantId = String(
            input.variantId
        ).trim();

        if (variantId) {
            return variantId;
        }
    }

    return null;
}

/**
 * Coerce a database money value (Prisma `Decimal`, number, or
 * numeric string) into a finite number.
 *
 * Rounded to 2 decimals only to remove binary floating point
 * artefacts (e.g. 45000.000000000004) — it never changes the
 * authoritative amount, which always comes from the database.
 */
export function toTikTokAmount(
    value: unknown
): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }

    const amount = Number(value);

    if (!Number.isFinite(amount) || amount < 0) {
        return undefined;
    }

    return Math.round(amount * 100) / 100;
}

/**
 * Coerce a quantity into a positive integer.
 *
 * A missing quantity is omitted rather than defaulted to 1: the
 * payload must describe what actually happened.
 */
export function toTikTokQuantity(
    value: unknown
): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }

    const quantity = Number(value);

    if (!Number.isFinite(quantity)) {
        return undefined;
    }

    const rounded = Math.round(quantity);

    return rounded > 0 ? rounded : undefined;
}

/**
 * Build one `contents[]` entry for a product.
 *
 * Returns null when no catalog id can be resolved, so the caller
 * drops the item instead of sending a nameless, id-less entry.
 */
export function buildTikTokContent(
    input: TikTokCatalogItemInput
): TikTokCatalogContent | null {
    const contentId =
        resolveTikTokContentId(input);

    if (!contentId) {
        return null;
    }

    const content: TikTokCatalogContent = {
        content_id: contentId,
        content_type:
            TIKTOK_CONTENT_TYPE_PRODUCT,
    };

    const name =
        input.productName?.trim() ||
        input.variantName?.trim() ||
        "";

    if (name) {
        content.content_name = name;
    }

    const quantity =
        toTikTokQuantity(input.quantity);

    if (quantity !== undefined) {
        content.quantity = quantity;
    }

    const price = toTikTokAmount(
        input.price
    );

    if (price !== undefined) {
        content.price = price;
    }

    return content;
}

/**
 * Build the whole `contents[]` array for a cart / order / single
 * product page view. Multi-product carts produce multi-item
 * arrays; an order is never collapsed into one order-level id.
 */
export function buildTikTokContents(
    items: TikTokCatalogItemInput[] | null | undefined
): TikTokCatalogContent[] {
    const contents: TikTokCatalogContent[] =
        [];

    for (const item of items ?? []) {
        const content =
            buildTikTokContent(item);

        if (content) {
            contents.push(content);
        }
    }

    return contents;
}

/** A ready-to-send TikTok event property block. */
export type TikTokCatalogProperties = Record<
    string,
    unknown
>;

/**
 * Line total for a quantity of one product, in the store
 * currency. Rounded only to remove floating point artefacts.
 */
export function toTikTokLineValue(
    unitPrice: unknown,
    quantity: unknown
): number | undefined {
    const price = toTikTokAmount(unitPrice);
    const qty = toTikTokQuantity(quantity);

    if (price === undefined || qty === undefined) {
        return undefined;
    }

    return (
        Math.round(price * qty * 100) / 100
    );
}

/**
 * Standard TikTok properties for an event about ONE product
 * (ViewContent / AddToCart).
 *
 * Always carries the catalog identity (`content_id` + `contents[]`
 * + `content_type`) and the store currency. `quantity` + `value`
 * are added only when asked for, so ViewContent does not claim a
 * quantity it never had.
 */
export function buildTikTokProductProperties(
    item: TikTokCatalogItemInput,
    options: {
        /** Include `quantity` and the matching line `value`. */
        withQuantity?: boolean;
    } = {}
): TikTokCatalogProperties {
    const content = buildTikTokContent(item);

    const properties: TikTokCatalogProperties = {};

    if (content) {
        properties.content_id =
            content.content_id;
        properties.contents = [content];
    }

    properties.content_type =
        TIKTOK_CONTENT_TYPE_PRODUCT;

    if (content?.content_name) {
        properties.content_name =
            content.content_name;
    }

    if (content?.price !== undefined) {
        properties.price = content.price;
    }

    if (
        options.withQuantity &&
        content?.quantity !== undefined
    ) {
        properties.quantity = content.quantity;

        const value = toTikTokLineValue(
            item.price,
            content.quantity
        );

        if (value !== undefined) {
            properties.value = value;
        }
    }

    properties.currency = TIKTOK_CURRENCY;

    return properties;
}

/**
 * Standard TikTok properties for an event about a CART or ORDER
 * (InitiateCheckout / AddPaymentInfo), multi-product included.
 *
 * `value` is passed in by the caller from the authoritative
 * server-computed total — never recomputed here from line items.
 */
export function buildTikTokCartProperties(
    items: TikTokCatalogItemInput[] | null | undefined,
    options: {
        value?: unknown;
        /** Extra, already-validated properties (e.g. payment_method). */
        extra?: TikTokCatalogProperties;
    } = {}
): TikTokCatalogProperties {
    const contents = buildTikTokContents(items);

    const properties: TikTokCatalogProperties = {};

    if (contents.length > 0) {
        properties.contents = contents;
        properties.content_type =
            TIKTOK_CONTENT_TYPE_PRODUCT;
        properties.num_items = contents.length;
    }

    const value = toTikTokAmount(options.value);

    if (value !== undefined) {
        properties.value = value;
    }

    properties.currency = TIKTOK_CURRENCY;

    if (options.extra) {
        for (const [key, extraValue] of Object.entries(
            options.extra
        )) {
            if (
                extraValue !== undefined &&
                extraValue !== null
            ) {
                properties[key] = extraValue;
            }
        }
    }

    return properties;
}

/**
 * Standard TikTok properties for an ORDER (CompletePayment).
 *
 * `value` is the authoritative order total; `contents[]` describes
 * every order line. No `content_id` at the order level: an order
 * number is not a product identity.
 */
export function buildTikTokOrderProperties(
    items: TikTokCatalogItemInput[] | null | undefined,
    options: {
        value?: unknown;
        orderId?: string | null;
    } = {}
): TikTokCatalogProperties {
    const properties =
        buildTikTokCartProperties(items, {
            value: options.value,
        });

    delete properties.num_items;

    if (options.orderId) {
        properties.order_id = options.orderId;
    }

    return properties;
}
