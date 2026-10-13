import { auth } from "@/auth";

/**
 * ==========================================
 * PROXY (ex-middleware) — ROUTE GUARDS
 * ==========================================
 *
 * CUSTOMER SHOPPING IS GUEST-ONLY.
 *
 * Shopping, cart, checkout, payment, order history and tracking all
 * work without a session, so those routes are deliberately NOT gated
 * here. What remains gated is the STAFF surface:
 *
 *   /admin/**            → ADMIN dashboard + /api/admin/**
 *   /api/affiliate/**    → affiliate dashboard, payouts, commissions
 *   /api/uploads/affiliate/**
 *
 * NOTE: this proxy is defense-in-depth only. Every admin/affiliate API
 * route still performs its own `requireAdmin()` / role check, and the
 * guest-facing routes enforce OWNERSHIP (session scope or guest access
 * token). Nothing here is the sole authorization layer.
 */

/**
 * ==========================================
 * PUBLIC API ROUTES
 * ==========================================
 *
 * Checked BEFORE protected API routes.
 */
const PUBLIC_API_PREFIXES = [
    "/api/auth/",
    "/api/products",
    "/api/flash-sales",
    "/api/affiliate/referral",
    "/api/affiliate/resolve",
    "/api/uploads/products/",
    "/api/payment/ipaymu/notification",
    "/api/payment/midtrans/notification",
    "/api/payment/payout/webhook",
    "/api/bulk-discounts",
    "/api/campaigns/",
    "/api/promotions/",
    "/api/shipping/",
    "/api/rajaongkir/",
    /*
     * Mengantar estimate is a server-only proxy (the browser key is
     * never exposed). Guests need it to see shipping quotes before
     * checkout, and the authoritative price is re-verified
     * server-side at checkout regardless of what this returns.
     */
    "/api/mengantar/estimate",
    // Mengantar shipment-status webhook: called by Mengantar, not by a
    // logged-in user. Authenticated by HMAC-SHA256 signature inside the
    // handler (fail-closed), so it must bypass session auth. This is
    // checked BEFORE the protected `/api/mengantar/` prefix below.
    "/api/mengantar/webhook",
];

/**
 * ==========================================
 * PROTECTED API ROUTES
 * ==========================================
 *
 * STAFF ONLY. Customer-facing APIs (cart, checkout, orders, buy-now,
 * payment, voucher, spin wheel) are intentionally absent: they must be
 * reachable without a login, and they authorize per-request instead.
 */
const PROTECTED_API_PREFIXES = [
    "/api/admin/",
    "/api/affiliate/dashboard",
    "/api/affiliate/payouts",
    "/api/affiliate/commissions",
    "/api/affiliate/application",
    "/api/affiliate/upload",
    "/api/uploads/affiliate/",
];

/**
 * ==========================================
 * PAGE-LEVEL PROTECTED ROUTES
 * ==========================================
 *
 * These page routes redirect to /login if the user is not
 * authenticated. Customer shopping pages are NOT listed.
 */
/*
 * NOTE: `/orders` is intentionally NOT listed here. The orders PAGE is
 * public: a guest sees their own orders (token-scoped) and the
 * "find my order" form, never a forced login.
 */
const PROTECTED_PAGE_ROUTES = [
    "/admin",
    "/dashboard",
    "/seller",
    "/affiliate",
];

function isPublicApiRoute(pathname: string): boolean {
    return PUBLIC_API_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix)
    );
}

function isProtectedApiRoute(pathname: string): boolean {
    return PROTECTED_API_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix)
    );
}

function isProtectedPageRoute(pathname: string): boolean {
    return PROTECTED_PAGE_ROUTES.some((route) =>
        pathname.startsWith(route)
    );
}

export default auth((req) => {
    const isLoggedIn = !!req.auth;
    const pathname = req.nextUrl.pathname;

    // ==========================================
    // API ROUTE PROTECTION
    // ==========================================
    // Defense-in-depth: check auth for protected
    // API routes. Route-level auth() remains
    // the primary authorization layer.

    if (pathname.startsWith("/api/")) {
        // Public API routes: skip auth check
        if (isPublicApiRoute(pathname)) {
            return;
        }

        // Protected API routes: require authentication
        if (isProtectedApiRoute(pathname)) {
            if (!isLoggedIn) {
                return new Response(
                    JSON.stringify({
                        success: false,
                        message: "Silakan login terlebih dahulu.",
                    }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    }
                );
            }
            // Cookie present — route handler does full auth() validation
            return;
        }

        // Unknown API routes: pass through
        return;
    }

    // ==========================================
    // PAGE ROUTE PROTECTION
    // ==========================================
    // Redirect unauthenticated users to login
    // for protected (staff) pages.

    if (!isLoggedIn && isProtectedPageRoute(pathname)) {
        const loginUrl = new URL("/login", req.url);
        loginUrl.searchParams.set("callbackUrl", pathname);
        return Response.redirect(loginUrl);
    }
});

export const config = {
    matcher: [
        // API routes
        "/api/:path*",
        // Staff page routes that need an auth redirect
        "/admin/:path*",
        "/dashboard/:path*",
        "/seller/:path*",
        "/affiliate/:path*",
        // /products is public but needs session context for auth-aware rendering
        "/products/:path*",
    ],
};
