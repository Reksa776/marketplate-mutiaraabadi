import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * CART SCOPE (logged-in OR anonymous guest)
 * ==========================================
 *
 * Customers no longer have to sign in to shop, so the server cart must
 * work without a session.
 *
 * SCOPE MODEL
 * -----------
 *  - Authenticated request  → Cart.userId scope (unchanged behaviour,
 *                             so an existing logged-in cart keeps working).
 *  - Anonymous request       → Cart.guestTokenHash scope, where the hash is
 *                             SHA-256 of a random 32-byte token stored in an
 *                             httpOnly cookie.
 *
 * SECURITY NOTES
 * --------------
 *  1. The RAW cart token is never persisted — only its hash — so a
 *     database leak cannot be replayed as a cookie.
 *  2. The cookie is httpOnly + SameSite=Lax (+ Secure on HTTPS), so it
 *     is not reachable from JavaScript.
 *  3. A cart is a CART SCOPE, never a verified customer identity. Every
 *     price, stock level and shipping quote is re-derived server-side at
 *     checkout from the database (see lib/checkout.ts). Nothing the cart
 *     cookie references is trusted as an amount.
 *  4. A guest cart is never merged into another scope implicitly.
 */

export const GUEST_CART_COOKIE = "cart_token";

/** 30 days. */
export const GUEST_CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function hashCartToken(token: string): string {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

export function generateCartToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

/**
 * Read the raw guest cart token straight from a `Cookie` request
 * header. Used by route handlers that must hash the cart scope while
 * also being able to run without the `next/headers` cookie store.
 */
export function readCartTokenFromCookieHeader(
    cookieHeader: string | null
): string | null {
    if (!cookieHeader) {
        return null;
    }

    for (const part of cookieHeader.split(";")) {
        const separator = part.indexOf("=");

        if (separator === -1) {
            continue;
        }

        if (
            part.slice(0, separator).trim() ===
            GUEST_CART_COOKIE
        ) {
            try {
                return decodeURIComponent(
                    part.slice(separator + 1).trim()
                );
            } catch {
                return null;
            }
        }
    }

    return null;
}

export type CartScope = {
    /**
     * Authenticated owner. Mutually exclusive with `guestTokenHash`.
     */
    userId: string | null;
    /**
     * Hash of the guest cart cookie token, when one was presented.
     */
    guestTokenHash: string | null;
};

/**
 * Resolve the cart scope for the current request.
 *
 * Returns auth scope when a session exists, otherwise the guest cookie
 * scope when present. Returns a scope with both fields null when a
 * guest has no cart cookie yet (i.e. their first visit).
 */
export async function resolveCartScope(): Promise<CartScope> {
    const session = await auth();

    if (session?.user?.id) {
        return {
            userId: session.user.id,
            guestTokenHash: null,
        };
    }

    const cookieStore = await cookies();
    const rawToken = cookieStore.get(
        GUEST_CART_COOKIE
    )?.value;

    if (!rawToken) {
        return { userId: null, guestTokenHash: null };
    }

    return {
        userId: null,
        guestTokenHash: hashCartToken(rawToken),
    };
}

/**
 * Prisma `where` for looking up the cart owned by this scope.
 * Returns null when there is nothing to look up yet.
 */
export function cartScopeWhere(scope: CartScope) {
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
 * Find the cart for a scope (no creation).
 */
export async function findCartForScope(
    scope: CartScope
) {
    const where = cartScopeWhere(scope);

    if (!where) {
        return null;
    }

    return prisma.cart.findFirst({ where });
}

/**
 * Find-or-create the cart for a scope.
 *
 * For a guest with no cookie yet, a fresh token is minted and its hash
 * is stored; the RAW token is returned as `issuedToken` so the caller
 * can set the cookie on the response.
 */
export async function getOrCreateCartForScope(
    scope: CartScope
): Promise<{
    cart: { id: number; userId: string | null };
    issuedToken: string | null;
}> {
    const existing = await findCartForScope(scope);

    if (existing) {
        return {
            cart: {
                id: existing.id,
                userId: existing.userId,
            },
            issuedToken: null,
        };
    }

    if (scope.userId) {
        const cart = await prisma.cart.create({
            data: { userId: scope.userId },
        });

        return {
            cart: { id: cart.id, userId: cart.userId },
            issuedToken: null,
        };
    }

    /*
     * Guest: mint a new cart token. The hash is stored; the raw value
     * only travels in the httpOnly cookie.
     */
    const rawToken = generateCartToken();

    const cart = await prisma.cart.create({
        data: {
            guestTokenHash: hashCartToken(rawToken),
        },
    });

    return {
        cart: { id: cart.id, userId: null },
        issuedToken: rawToken,
    };
}

/**
 * Attach a freshly minted guest cart cookie to an outgoing response.
 * No-op when there is nothing new to issue.
 */
export function applyCartCookie(
    response: NextResponse,
    issuedToken: string | null
): NextResponse {
    if (!issuedToken) {
        return response;
    }

    response.cookies.set(
        GUEST_CART_COOKIE,
        issuedToken,
        {
            httpOnly: true,
            secure:
                process.env.NODE_ENV ===
                "production",
            sameSite: "lax",
            path: "/",
            maxAge: GUEST_CART_COOKIE_MAX_AGE,
        }
    );

    return response;
}
