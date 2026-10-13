import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listGuestAccessibleOrderIds } from "@/lib/guest-order-access";
import {
    ownerKeyForGuest,
    ownerKeyForUser,
} from "@/lib/guest-identity";

/**
 * ==========================================
 * SPIN WHEEL OWNER SCOPE (session OR guest)
 * ==========================================
 *
 * Spin eligibility is EARNED BY SPENDING, so the scope a spin is
 * attributed to must be the SAME scope the buyer's PAID orders are
 * attributed to:
 *
 *   signed-in (admin/affiliate/legacy) → "user:<userId>"
 *   guest                             → "guest:<guestIdentityKey>"
 *
 * WHY THE GUEST SCOPE IS DERIVED FROM THE ORDER TOKENS, NOT FROM INPUT
 * -------------------------------------------------------------------
 * A guest never types an email/phone on the spin page, and asking for
 * one would let anybody claim another buyer's spin balance. Instead the
 * scope is derived from the orders THIS BROWSER can already prove it
 * owns: every `gos_<orderId>` cookie is verified against the stored
 * token hash (see lib/guest-order-access.ts), and the hashed identity is
 * read from those verified orders.
 *
 * So a guest gets spins for exactly the identity they actually checked
 * out with, on exactly the browser that placed the order — and no
 * contact value is ever requested, stored or echoed back.
 *
 * The `guestIdentityKey` returned here is a server-side abuse-control
 * hash and is NEVER serialized into a response.
 */

export type SpinScope = {
    userId: string | null;
    guestIdentityKey: string | null;
    ownerKey: string | null;
    /** true when the caller is a guest with NO provable order history */
    anonymous: boolean;
};

/**
 * Resolve the spin scope for the current request.
 *
 * Never throws: an unresolvable scope returns `ownerKey: null` so the
 * caller can answer 401 instead of creating an unattributable spin.
 */
export async function resolveSpinScope(): Promise<SpinScope> {
    const session = await auth();

    if (session?.user?.id) {
        return {
            userId: session.user.id,
            guestIdentityKey: null,
            ownerKey: ownerKeyForUser(session.user.id),
            anonymous: false,
        };
    }

    const accessibleOrderIds =
        await listGuestAccessibleOrderIds();

    if (accessibleOrderIds.length === 0) {
        return {
            userId: null,
            guestIdentityKey: null,
            ownerKey: null,
            anonymous: true,
        };
    }

    /*
     * Only orders that actually carry a guest identity can scope a
     * spin. Newest first, so the most recent identity wins when a
     * browser holds tokens for orders placed with different contacts.
     */
    const order = await prisma.order.findFirst({
        where: {
            id: { in: accessibleOrderIds },
            guestIdentityKey: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { guestIdentityKey: true },
    });

    const guestIdentityKey =
        order?.guestIdentityKey ?? null;

    if (!guestIdentityKey) {
        return {
            userId: null,
            guestIdentityKey: null,
            ownerKey: null,
            anonymous: true,
        };
    }

    return {
        userId: null,
        guestIdentityKey,
        ownerKey: ownerKeyForGuest(guestIdentityKey),
        anonymous: false,
    };
}
