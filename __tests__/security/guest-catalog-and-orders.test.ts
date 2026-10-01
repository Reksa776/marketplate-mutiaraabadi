/**
 * GUEST CATALOG & ORDERS NAVIGATION — REGRESSION TESTS
 *
 * Verifies the guest-visibility change without a database:
 *   - /api/products returns the full non-archived catalog to guests
 *     (no bestseller-only restriction) while keeping stock hidden.
 *   - /products/[slug] is public (no guest redirect / guestProduct).
 *   - ProductGrid no longer shows a guest login wall.
 *   - The /orders PAGE is public with a soft-login state, but the
 *     /api/orders API remains authenticated and ownership-scoped.
 */

import * as fs from "fs";
import * as path from "path";

function readFile(relPath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
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

describe("Orders page — guest soft-login", () => {
    test("orders page renders a soft-login state for guests", () => {
        expect(ordersPageCode).toMatch(
            /Silakan masuk untuk melihat riwayat pesanan/
        );
        expect(ordersPageCode).toMatch(/GuestOrdersGate/);
    });

    test("orders page offers Masuk and Daftar actions for guests", () => {
        expect(ordersPageCode).toMatch(/href="\/login\?callbackUrl=\/orders"/);
        expect(ordersPageCode).toMatch(/href="\/register"/);
    });

    test("OrdersPage (which fetches /api/orders) is gated behind a session", () => {
        const gateIndex = ordersPageCode.indexOf("session?.user ? (");
        const ordersPageIndex = ordersPageCode.indexOf("<OrdersPage />");

        expect(gateIndex).toBeGreaterThan(-1);
        expect(ordersPageIndex).toBeGreaterThan(-1);
        // The authenticated branch comes first, so a guest never
        // reaches the component that requests /api/orders.
        expect(ordersPageIndex).toBeGreaterThan(gateIndex);
    });
});

describe("Orders API stays protected", () => {
    test("proxy keeps /api/orders in the protected API prefixes", () => {
        const apiPrefixes = proxyCode.substring(
            proxyCode.indexOf("PROTECTED_API_PREFIXES"),
            proxyCode.indexOf("PAGE-LEVEL PROTECTED ROUTES")
        );
        expect(apiPrefixes).toMatch(/"\/api\/orders"/);
    });

    test("proxy no longer forces the /orders page behind login", () => {
        expect(proxyCode).not.toMatch(/\/orders\/:path\*/);

        const pageRoutes = proxyCode.substring(
            proxyCode.indexOf("const PROTECTED_PAGE_ROUTES"),
            proxyCode.indexOf("function isPublicApiRoute")
        );
        expect(pageRoutes).not.toMatch(/"\/orders"/);
    });

    test("GET /api/orders requires a session", () => {
        const getSection = ordersApiCode.substring(
            ordersApiCode.indexOf("export async function GET")
        );
        expect(getSection).toMatch(/const session\s*=\s*await auth\(\)/);
        expect(getSection).toMatch(/!session\?\.user\?\.id/);
        expect(getSection).toMatch(/status:\s*401/);
    });

    test("GET /api/orders is scoped to the authenticated user", () => {
        const getSection = ordersApiCode.substring(
            ordersApiCode.indexOf("export async function GET")
        );
        expect(getSection).toMatch(/where:\s*\{[\s\S]{0,80}userId:[\s\S]{0,40}session\.user\.id/);
    });
});

describe("BottomNavbar — authenticated only", () => {
    test("guests get no navbar on /products", () => {
        expect(productsPageCode).toMatch(/session\?\.user && <BottomNavbar \/>/);
    });

    test("guests get no navbar on product detail", () => {
        expect(productDetailCode).toMatch(/session\?\.user && <BottomNavbar \/>/);
    });

    test("guest orders soft-login state renders no navbar", () => {
        const gateStart = ordersPageCode.indexOf("function GuestOrdersGate");
        const gateEnd = ordersPageCode.indexOf(
            "export default async function Orders"
        );

        expect(gateStart).toBeGreaterThan(-1);
        expect(gateEnd).toBeGreaterThan(gateStart);
        expect(ordersPageCode.substring(gateStart, gateEnd)).not.toMatch(
            /BottomNavbar/
        );
    });

    test("authenticated orders branch still renders the navbar", () => {
        const authIndex = ordersPageCode.indexOf("session?.user ? (");
        const navbarIndex = ordersPageCode.indexOf("<BottomNavbar />");
        expect(authIndex).toBeGreaterThan(-1);
        expect(navbarIndex).toBeGreaterThan(authIndex);
    });
});

describe("Guest Add to Cart", () => {
    test("uses the existing session mechanism and a login prompt", () => {
        expect(productDetailComponentCode).toMatch(
            /from "next-auth\/react"/
        );
        expect(productDetailComponentCode).toMatch(
            /Silakan login terlebih dahulu untuk[\s\S]{0,40}menambahkan produk ke keranjang/
        );
    });

    test("guest guard runs before the cart API request", () => {
        const guardIndex = productDetailComponentCode.indexOf(
            'sessionStatus === "unauthenticated"'
        );
        const cartApiIndex = productDetailComponentCode.indexOf("/api/cart");

        expect(guardIndex).toBeGreaterThan(-1);
        expect(cartApiIndex).toBeGreaterThan(-1);
        expect(guardIndex).toBeLessThan(cartApiIndex);
    });

    test("authenticated add-to-cart flow is unchanged", () => {
        expect(productDetailComponentCode).toMatch(
            /Produk ditambahkan ke keranjang/
        );
        expect(productDetailComponentCode).toMatch(
            /variantId:[\s\S]{0,40}selectedVariant\.id/
        );
    });
});

describe("Guest Buy Now", () => {
    test("redirects to login with a safe, encoded internal callback", () => {
        expect(productDetailComponentCode).toMatch(
            /router\.push\(`\/login\?callbackUrl=\$\{loginCallback\}`\)/
        );
        expect(productDetailComponentCode).toMatch(
            /encodeURIComponent\(productPath\)/
        );
        expect(productDetailComponentCode).toMatch(
            /const productPath = `\/products\/\$\{product\.slug\}`/
        );
    });

    test("Buy Now client never sends non-auth errors to login", () => {
        expect(buyNowClientCode).not.toMatch(/router\.push\(["'`]\/login/);
        expect(buyNowClientCode).not.toMatch(/window\.location[\s\S]{0,20}\/login/);
    });
});
