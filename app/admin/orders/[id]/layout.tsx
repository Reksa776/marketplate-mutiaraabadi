import type { Metadata } from "next";
import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { adminPageMetadata, toMetaText } from "@/lib/site-metadata";

type Props = {
    params: Promise<{ id: string }>;
};

/**
 * ==========================================
 * DYNAMIC ADMIN ORDER METADATA
 * ==========================================
 *
 * `app/admin/orders/[id]/page.tsx` is a Client Component and
 * therefore cannot export metadata, so this colocated layout
 * owns the title.
 *
 * The parent `app/admin/layout.tsx` already rejects
 * non-admins (and the whole segment is `robots: noindex`),
 * so the order reference needs no extra scoping here. Only
 * `orderNumber` is read — no customer PII, no totals, no
 * payment references.
 */
export async function generateMetadata({
    params,
}: Props,
): Promise<Metadata> {
    const fallback: Metadata = adminPageMetadata("Detail Pesanan");

    const { id } = await params;
    const orderId = Number(id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return fallback;
    }

    const order = await prisma.order.findUnique({
        where: { id: orderId },

        select: {
            orderNumber: true,
        },
    });

    if (!order) {
        return fallback;
    }

    return adminPageMetadata(
        `Pesanan #${toMetaText(order.orderNumber, 40)}`
    );
}

export default function AdminOrderDetailLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
