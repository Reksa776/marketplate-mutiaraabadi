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
 * DYNAMIC PAYMENT METADATA
 * ==========================================
 *
 * `app/checkout/payment/[id]/page.tsx` is a Client Component
 * and therefore cannot export metadata, so this colocated
 * layout owns the title.
 *
 * PRIVACY: the order number is only read when the signed-in
 * user owns the order — the same `id` + `userId` ownership
 * scope enforced by `loadPaymentView()` in
 * `lib/payment/order-payment.ts`, which backs
 * `GET /api/orders/[id]/payment-status`. No VA number,
 * payment reference or QR payload is ever placed in the head.
 */
export async function generateMetadata({
    params,
}: Props,
): Promise<Metadata> {
    const fallback: Metadata = pageMetadata({ title: "Pembayaran" });

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
        title: `Pembayaran #${toMetaText(order.orderNumber, 40)}`,
        noindex: true,
    });
}

export default function PaymentLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
