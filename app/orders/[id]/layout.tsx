import type { Metadata } from "next";
import type { ReactNode } from "react";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pageMetadata, toMetaText } from "@/lib/site-metadata";

type Props = {
    params: Promise<{ id: string }>;
};

/**
 * ==========================================
 * DYNAMIC ORDER METADATA
 * ==========================================
 *
 * `app/orders/[id]/page.tsx` is a Client Component and
 * therefore cannot export metadata, so this colocated layout
 * owns the title.
 *
 * PRIVACY: the order number is only read when the signed-in
 * user actually owns the order — the same `id` + `userId`
 * ownership scope enforced by `GET /api/orders/[id]`. A
 * logged-out visitor (or someone guessing ids) only ever
 * receives the generic "Detail Pesanan" title, so no order
 * reference is leaked through the document head.
 */
export async function generateMetadata({
    params,
}: Props,
): Promise<Metadata> {
    const fallback: Metadata = pageMetadata({ title: "Detail Pesanan" });

    const { id } = await params;
    const orderId = Number(id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return fallback;
    }

    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
        return fallback;
    }

    const order = await prisma.order.findFirst({
        where: {
            id: orderId,
            userId,
        },

        select: {
            orderNumber: true,
        },
    });

    if (!order) {
        return fallback;
    }

    return pageMetadata({
        title: `Pesanan #${toMetaText(order.orderNumber, 40)}`,
        noindex: true,
    });
}

export default function OrderDetailLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
