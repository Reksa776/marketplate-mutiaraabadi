/**
 * ==========================================
 * TIKTOK `value` PARAMETER CONTRACT
 * ==========================================
 *
 * Pixel Helper warning under audit:
 *
 *   "Events shared are missing a 'value' parameter."
 *
 * TikTok's contract (PixelContent.md, tiktok-business-api-sdk):
 *
 *   price = "The price of the item. Note: Price is the price for a
 *            single item, and value is the total price of the order.
 *            For example, if you have two items each sold for $10,
 *            the price parameter would pass 10 and the value
 *            parameter would pass 20."
 *
 * So for an event about ONE unit (ViewContent) value === price, and
 * for an event about N units (AddToCart) value === price * N. The
 * value is always DERIVED from the authoritative application price;
 * it is never a constant and never re-formatted into a string.
 *
 * This suite pins that contract for every event that carries money.
 */

import {
    buildTikTokCartProperties,
    buildTikTokOrderProperties,
    buildTikTokProductProperties,
    TIKTOK_CONTENT_TYPE_PRODUCT,
    TIKTOK_CURRENCY,
} from "@/lib/analytics/tiktok-catalog";

/** Strip comments so source scans inspect code, not prose. */
function readCode(relativePath: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("fs");
    const { resolve } = require("path");

    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    )
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("ViewContent — the reported warning", () => {
    test("a Rp25.000 product produces value: 25000", () => {
        /*
         * The exact scenario from the Pixel Helper report:
         * content_id 304, price 25000, currency IDR.
         */
        const properties = buildTikTokProductProperties({
            productId: 304,
            productName: "produk",
            price: 25000,
        });

        expect(properties.value).toBe(25000);
    });

    test("every required ViewContent field is present together", () => {
        const properties = buildTikTokProductProperties({
            productId: 304,
            productName: "produk",
            price: 25000,
        });

        /* The full set the task requires. */
        expect(properties).toMatchObject({
            content_id: "304",
            content_name: "produk",
            content_type: TIKTOK_CONTENT_TYPE_PRODUCT,
            currency: TIKTOK_CURRENCY,
            price: 25000,
            value: 25000,
        });

        expect(properties.contents).toEqual([
            {
                content_id: "304",
                content_type: "product",
                content_name: "produk",
                price: 25000,
            },
        ]);
    });

    test("value is a JSON number, not a string or Rupiah text", () => {
        const properties = buildTikTokProductProperties({
            productId: 304,
            price: 25000,
        });

        expect(typeof properties.value).toBe("number");
        expect(Number.isNaN(properties.value)).toBe(false);

        /* The wire format must be unquoted. */
        const wire = JSON.stringify(properties);

        expect(wire).toContain('"value":25000');
        expect(wire).not.toContain('"value":"25000"');
        expect(wire).not.toContain("25.000");
        expect(wire).not.toContain("Rp");
    });

    test("value follows the real price, not a constant", () => {
        /*
         * Proves `value` is DERIVED. If any of these were a
         * hardcoded amount, a different price would not move it.
         */
        const prices = [1000, 25000, 49500, 123456, 1000000];

        for (const price of prices) {
            const properties =
                buildTikTokProductProperties({
                    productId: 304,
                    price,
                });

            expect(properties.value).toBe(price);
            expect(properties.price).toBe(price);
        }
    });

    test("value tracks a Prisma Decimal / string money value", () => {
        /*
         * The application hands over Decimal-like values; they must
         * still yield a clean number, not "25000.00".
         */
        const fromString = buildTikTokProductProperties({
            productId: 304,
            price: "25000.00",
        });

        const fromDecimal = buildTikTokProductProperties({
            productId: 304,
            price: { toString: () => "25000.00" },
        });

        expect(fromString.value).toBe(25000);
        expect(fromDecimal.value).toBe(25000);
        expect(typeof fromDecimal.value).toBe("number");
    });

    test("no hardcoded nominal in the ViewContent call site", () => {
        const code = readCode(
            "components/products/ProductDetail.tsx"
        );

        /* The builder must be called without a literal amount. */
        expect(code).toContain(
            "buildTikTokProductProperties"
        );
        expect(code).not.toMatch(
            /buildTikTokProductProperties\([^)]*\b(price|value)\s*:\s*\d/
        );
    });

    test("value is derived from the variant price the app charges", () => {
        /*
         * The ViewContent source must read the SAME effective unit
         * price the storefront displays and charges — not a separate
         * constant and not the undiscounted price.
         */
        const code = readCode(
            "components/products/ProductDetail.tsx"
        );

        expect(code).toContain("effectivePrice");
    });
});

describe("value is never invented", () => {
    test("a product with no real price omits value (no fake 0)", () => {
        const properties = buildTikTokProductProperties({
            productId: 304,
            productName: "produk",
        });

        expect(properties).not.toHaveProperty("price");
        expect(properties).not.toHaveProperty("value");

        /* Catalog identity and currency are still sent. */
        expect(properties.content_id).toBe("304");
        expect(properties.currency).toBe(TIKTOK_CURRENCY);
    });

    test("a negative or unusable price omits value", () => {
        for (const price of [-1, NaN, "abc", {}]) {
            const properties =
                buildTikTokProductProperties({
                    productId: 304,
                    price,
                });

            expect(properties).not.toHaveProperty("value");
        }
    });

    test("a zero price is preserved, because zero is a real amount", () => {
        /*
         * Distinguishing "free product" from "unknown price" matters:
         * dropping a genuine Rp0 would under-report, while inventing
         * a 0 for an unknown price would corrupt the metric.
         */
        const properties = buildTikTokProductProperties({
            productId: 304,
            price: 0,
        });

        expect(properties.price).toBe(0);
        expect(properties.value).toBe(0);
    });
});

describe("AddToCart stays correct (no regression)", () => {
    test("value is price x quantity", () => {
        const properties = buildTikTokProductProperties(
            {
                productId: 42,
                productName: "Kaos",
                price: "15000.00",
                quantity: 2,
            },
            { withQuantity: true }
        );

        /* Unit price stays the unit price. */
        expect(properties.price).toBe(15000);

        /* Event total = 2 x 15000. */
        expect(properties.value).toBe(30000);
        expect(properties.quantity).toBe(2);
        expect(typeof properties.value).toBe("number");
    });

    test("value is price x quantity for a Rp25.000 product", () => {
        const properties = buildTikTokProductProperties(
            {
                productId: 304,
                price: 25000,
                quantity: 3,
            },
            { withQuantity: true }
        );

        expect(properties.value).toBe(75000);
        expect(properties.price).toBe(25000);
    });

    test("quantity 1 leaves value equal to price", () => {
        const properties = buildTikTokProductProperties(
            {
                productId: 304,
                price: 25000,
                quantity: 1,
            },
            { withQuantity: true }
        );

        expect(properties.value).toBe(25000);
    });
});

describe("checkout and payment events stay correct (no regression)", () => {
    test("InitiateCheckout uses the server subtotal", () => {
        const properties = buildTikTokCartProperties(
            [
                {
                    productId: 1,
                    variantId: 11,
                    productName: "Produk A",
                    quantity: 2,
                    price: 15000,
                },
            ],
            { value: 30000 }
        );

        expect(properties.value).toBe(30000);
        expect(typeof properties.value).toBe("number");
        expect(properties.currency).toBe(TIKTOK_CURRENCY);
        expect(properties.contents).toHaveLength(1);
    });

    test("AddPaymentInfo keeps value and payment_method", () => {
        const properties = buildTikTokCartProperties(
            [
                {
                    productId: 1,
                    quantity: 1,
                    price: 25000,
                },
            ],
            {
                value: 25000,
                extra: { payment_method: "qris" },
            }
        );

        expect(properties.value).toBe(25000);
        expect(properties.payment_method).toBe("qris");
    });

    test("CompletePayment uses the authoritative order total", () => {
        const properties = buildTikTokOrderProperties(
            [
                {
                    productId: 1,
                    quantity: 1,
                    price: 25000,
                },
            ],
            { value: 27000, orderId: "PAY-0001" }
        );

        expect(properties.value).toBe(27000);
        expect(properties.order_id).toBe("PAY-0001");
        expect(properties.num_items).toBeUndefined();
    });

    test("a multi-line cart keeps the caller's authoritative total", () => {
        /*
         * The caller owns the total (shipping/discount/tax are not
         * re-derived here), so `value` must be passed through, not
         * recomputed from the lines.
         */
        const properties = buildTikTokCartProperties(
            [
                { productId: 1, quantity: 2, price: 10000 },
                { productId: 2, quantity: 1, price: 5000 },
            ],
            { value: 27500 }
        );

        expect(properties.value).toBe(27500);
        expect(properties.contents).toHaveLength(2);
    });
});

describe("catalog / content_id mapping untouched", () => {
    test("content_id is still the product id", () => {
        const properties = buildTikTokProductProperties({
            productId: 304,
            price: 25000,
        });

        expect(properties.content_id).toBe("304");
        expect(
            (
                properties.contents as Array<{
                    content_id: string;
                }>
            )[0].content_id
        ).toBe("304");
    });

    test("a real SKU still wins over the product id", () => {
        const properties = buildTikTokProductProperties({
            productId: 304,
            sku: "SKU-ABC",
            price: 25000,
        });

        expect(properties.content_id).toBe("SKU-ABC");
        expect(properties.value).toBe(25000);
    });
});
