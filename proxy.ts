import { auth } from "@/auth";

/**
 * ==========================================
 * PUBLIC API ROUTES
 * ==========================================
 *
 * These API routes do NOT require authentication.
 * They are checked BEFORE protected API routes.
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
];

/**
 * ==========================================
 * PROTECTED API ROUTES
 * ==========================================
 *
 * These API routes require authentication.
 * If the user is not logged in, return 401 JSON.
 */
const PROTECTED_API_PREFIXES = [
    "/api/admin/",
    "/api/orders",
    "/api/cart",
    "/api/checkout",
    "/api/profile",
    "/api/address",
    "/api/addresses",
    "/api/spin-wheel",
    "/api/affiliate/dashboard",
    "/api/affiliate/payouts",
    "/api/affiliate/commissions",
    "/api/affiliate/application",
    "/api/affiliate/upload",
    "/api/uploads/affiliate/",
    "/api/payment/ipaymu",
    "/api/buy-now",
    "/api/buy-now/shipping",
    "/api/voucher",
    "/api/rajaongkir",
];

/**
 * ==========================================
 * PAGE-LEVEL PROTECTED ROUTES
 * ==========================================
 *
 * These page routes redirect to /login
 * if the user is not authenticated.
 */
const PROTECTED_PAGE_ROUTES = [
    "/profile",
    "/wishlist",
    "/cart",
    "/checkout",
    "/buy-now",
    "/orders",
    "/address",
    "/addresses",
    "/admin",
    "/dashboard",
    "/seller",
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
    // for protected pages.

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
        // Page routes that need auth redirect
        "/profile/:path*",
        "/wishlist/:path*",
        "/cart/:path*",
        "/checkout/:path*",
        "/buy-now/:path*",
        "/orders/:path*",
        "/address/:path*",
        "/addresses/:path*",
        "/admin/:path*",
        "/dashboard/:path*",
        "/seller/:path*",
        // /products is public but needs session context for auth-aware rendering
        "/products/:path*",
    ],
};