/**
 * GUEST CATALOG & ORDERS — REGRESSION TESTS
 *
 * Verifies the guest-only shopping model:
 *   - /api/products returns the full non-archived catalog to guests
 *     (no bestseller-only restriction) while keeping stock hidden.
 *   - /products/[slug] is public (no guest redirect / guestProduct).
 *   - ProductGrid no longer shows a guest login wall.
 *   - /orders is public and lists the orders THIS BROWSER owns
 *     (guest access tokens), never a login wall.
 *   - /api/orders is guest-scoped and never returns another buyer's
 *     orders.
 *   - ProductDetail adds to cart / buys now WITHOUT a login gate.
 *
 * These are source-level invariants: the behavioural coverage for
 * guest order access lives in
 * __tests__/security/guest-order-access.test.ts and the COD choke
 * points in __tests__/security/cod-protection.test.ts.
 */

import * as fs from "fs";
import * as path from "path";

function readFile(relPath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

function fileExists(relPath: string): boolean {
    return fs.existsSync(path.resolve(process.cwd(), relPath));
}

const productsApiCode = readFile("app/api/products/route.ts");
const productDetailCode = readFile("app/products/[slug]/page.tsx");
const productGridCode = readFile("components/products/ProductGrid.tsx");
const productsPageCode = readFile("app/products/page.tsx");
const ordersPageCode = readFile("app/orders/page.tsx");
const ordersApiCode = readFile("app/api/orders/route.ts");
const proxyCode = readFile("proxy.ts");
const productDetailComponentCode = readFile(
    "components/products/ProductDetail.tsx"
);
const buyNowClientCode = readFile("app/buy-now/BuyNowPage.tsx");
const checkoutPageCode = readFile("app/checkout/page.tsx");
const buyNowPageCode = readFile("app/buy-now/page.tsx");

describe("Guest catalog visibility", () => {
    test("product API no longer restricts guests to bestsellers", () => {
        expect(productsApiCode).not.toMatch(/bestseller:\s*true/);
    });

    test("product API still filters archived products", () => {
        expect(productsApiCode).toMatch(/isArchived:\s*false/);
    });

    test("product API keeps stock hidden from guests", () => {
        // `stock: authenticated ? variant.stock : undefined`
        expect(productsApiCode).toMatch(
            /authenticated\s*\?\s*variant\.stock\s*:\s*undefined/
        );
    });

    test("product API response stays field-whitelisted", () => {
        // No cost/HPP or other internal fields leak into the payload.
        expect(productsApiCode).not.toMatch(/\bcost\b/i);
        expect(productsApiCode).not.toMatch(/\bhpp\b/i);
        expect(productsApiCode).not.toMatch(/password/i);
    });

    test("product detail page no longer redirects guests", () => {
        expect(productDetailCode).not.toMatch(/guestProduct/);
        expect(productDetailCode).not.toMatch(/\bredirect\(/);
    });

    test("product detail still 404s missing/archived products", () => {
        expect(productDetailCode).toMatch(/notFound\(\)/);
        expect(productDetailCode).toMatch(/isArchived:\s*false/);
    });

    test("ProductGrid drops the guest login wall", () => {
        expect(productGridCode).not.toMatch(/Ingin melihat semua produk/);
        expect(productGridCode).not.toMatch(/melihat produk\s*\n?\s*terlaris/);
    });

    test("ProductGrid header is a neutral catalog heading", () => {
        expect(productGridCode).toMatch(/Semua Produk/);
    });

    test("/products page no longer handles the guestProduct dialog", () => {
        expect(productsPageCode).not.toMatch(/guestProduct/);
        expect(productsPageCode).not.toMatch(/GuestProductDialog/);
    });
});

describe("Guest Add to Cart — no login gate", () => {
    test("no session-based guard blocks add to cart", () => {
        expect(productDetailComponentCode).not.toMatch(
            /Silakan login terlebih dahulu untuk/
        );
        expect(productDetailComponentCode).not.toMatch(
            /sessionStatus === "unauthenticated"/
        );
    });

    test("the cart API is still called with the selected variant", () => {
        expect(productDetailComponentCode).toMatch(/\/api\/cart/);
        expect(productDetailComponentCode).toMatch(
            /variantId:[\s\S]{0,40}selectedVariant\.id/
        );
        expect(productDetailComponentCode).toMatch(
            /Produk ditambahkan ke keranjang/
        );
    });

    test("no login prompt modal remains in the product detail", () => {
        expect(productDetailComponentCode).not.toMatch(/showLoginPrompt/);
        expect(productDetailComponentCode).not.toMatch(/Login diperlukan/);
    });
});

describe("Guest Buy Now — no login gate", () => {
    test("Buy Now navigates straight to the buy-now page", () => {
        expect(productDetailComponentCode).toMatch(
            /\/buy-now\?productId=/
        );
        expect(productDetailComponentCode).not.toMatch(
            /\/login\?callbackUrl=/
        );
    });

    test("Buy Now client never redirects to login", () => {
        expect(buyNowClientCode).not.toMatch(/router\.push\(["'`]\/login/);
        expect(buyNowClientCode).not.toMatch(
            /window\.location[\s\S]{0,20}\/login/
        );
    });

    test("/buy-now page renders for guests", () => {
        expect(buyNowPageCode).not.toMatch(/redirect\(\s*["'`]\/login/);
        expect(buyNowPageCode).not.toMatch(/session\?\.user/);
    });
});

describe("Guest checkout entry", () => {
    test("/checkout no longer redirects to login", () => {
        expect(checkoutPageCode).not.toMatch(/redirect\(\s*["'`]\/login/);
        expect(checkoutPageCode).not.toMatch(/await auth\(\)/);
    });
});

describe("Orders page — public, token-scoped", () => {
    test("orders page renders the order list for guests", () => {
        expect(ordersPageCode).toMatch(/<OrdersPage \/>/);
        expect(ordersPageCode).not.toMatch(/GuestOrdersGate/);
        expect(ordersPageCode).not.toMatch(/Silakan masuk untuk melihat/);
    });

    test("orders page offers no login or register CTA", () => {
        expect(ordersPageCode).not.toMatch(/\/login\?callbackUrl/);
        expect(ordersPageCode).not.toMatch(/href="\/register"/);
    });

    test("orders page offers order recovery instead", () => {
        const ordersListCode = readFile(
            "components/orders/OrdersPage.tsx"
        );
        expect(ordersListCode).toMatch(/OrderRecovery/);
        expect(fileExists("components/orders/OrderRecovery.tsx")).toBe(
            true
        );
    });
});

describe("Orders API — guest scoped, never login gated", () => {
    test("proxy does NOT force /api/orders behind a session", () => {
        const apiPrefixes = proxyCode.substring(
            proxyCode.indexOf("PROTECTED_API_PREFIXES"),
            proxyCode.indexOf("PAGE-LEVEL PROTECTED ROUTES")
        );
        expect(apiPrefixes).not.toMatch(/"\/api\/orders"/);
    });

    test("proxy no longer forces the /orders page behind login", () => {
        expect(proxyCode).not.toMatch(/\/orders\/:path\*/);

        const pageRoutes = proxyCode.substring(
            proxyCode.indexOf("const PROTECTED_PAGE_ROUTES"),
            proxyCode.indexOf("function isPublicApiRoute")
        );
        expect(pageRoutes).not.toMatch(/"\/orders"/);
    });

    test("GET /api/orders does not require a session", () => {
        const getSection = ordersApiCode.substring(
            ordersApiCode.indexOf("export async function GET")
        );
        expect(getSection).not.toMatch(/status:\s*401/);
    });

    test("GET /api/orders is scoped to the caller", () => {
        const getSection = ordersApiCode.substring(
            ordersApiCode.indexOf("export async function GET")
        );
        // Session owner scope OR the verified guest token set.
        expect(getSection).toMatch(
            /listGuestAccessibleOrderIds|userId:\s*session\.user\.id/
        );
    });
});

describe("No customer account surface remains", () => {
    test.each([
        "app/register/page.tsx",
        "app/api/auth/register/route.ts",
        "components/auth/RegisterForm.tsx",
        "app/profile/page.tsx",
        "app/api/profile/route.ts",
        "app/addresses/page.tsx",
    ])("%s is deleted", (file) => {
        expect(fileExists(file)).toBe(false);
    });

    test("/login is kept for admin/affiliate dashboards", () => {
        expect(fileExists("app/login/page.tsx")).toBe(true);
        expect(fileExists("app/api/auth/[...nextauth]/route.ts")).toBe(
            true
        );
    });
});

/**
 * The affiliate programme needs a PUBLIC entry point again, without
 * resurrecting any customer account surface. The footer is the right
 * place: it is marketing navigation rendered by the root layout on every
 * page, while the affiliate page keeps its own (affiliate) login.
 */
describe("Public affiliate entry point", () => {
    const footerCode = readFile("components/Footer.tsx");
    const layoutCode = readFile("app/layout.tsx");
    const affiliatePageCode = readFile(
        "app/affiliate/page.tsx"
    );

    test("the footer links to the affiliate programme", () => {
        expect(footerCode).toMatch(/href="\/affiliate"/);
        expect(footerCode).toMatch(/Program Affiliate/);
    });

    test("the footer renders on every public page", () => {
        expect(layoutCode).toMatch(/<Footer \/>/);
    });

    test("the footer stays guest-only — no customer account links", () => {
        expect(footerCode).not.toMatch(/href="\/login"/);
        expect(footerCode).not.toMatch(/href="\/register"/);
        expect(footerCode).not.toMatch(/href="\/profile"/);
        expect(footerCode).not.toMatch(/href="\/addresses"/);
    });

    test("the affiliate entry page keeps its own affiliate login", () => {
        expect(affiliatePageCode).toMatch(/await auth\(\)/);
        expect(affiliatePageCode).toMatch(/redirect\("\/login"\)/);
    });

    test.each([
        "app/affiliate/AffiliateContent.tsx",
        "app/affiliate/dashboard/page.tsx",
        "app/affiliate/payouts/page.tsx",
        "app/api/affiliate/application/route.ts",
        "app/api/affiliate/dashboard/route.ts",
        "app/api/affiliate/referral/route.ts",
    ])("%s still exists", (file) => {
        expect(fileExists(file)).toBe(true);
    });
});
