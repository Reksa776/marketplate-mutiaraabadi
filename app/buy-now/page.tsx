import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { redirect } from "next/navigation";
import BuyNowPage from "./BuyNowPage";

export const metadata: Metadata = pageMetadata({
    title: "Beli Sekarang",
    description: "Pesan produk Mutiara Abadi langsung tanpa masuk ke keranjang.",
    noindex: true,
});

type Props = {
    searchParams: Promise<{
        productId?: string;
        variantId?: string;
        quantity?: string;
        promo?: string | string[];
    }>;
};

/*
 * ==========================================
 * BUY NOW — GUEST ACCESSIBLE
 * ==========================================
 *
 * "Beli Sekarang" is the primary guest purchase path (no cart and no
 * account needed), so this page is intentionally public: it renders for
 * anonymous visitors and never redirects to /login. Only the product
 * parameters are validated here; price, stock and shipping are resolved
 * server-side by /api/buy-now.
 */
export default async function BuyNow(
    { searchParams }: Props
) {
    const params =
        await searchParams;

    if (
        !params.productId ||
        !params.variantId
    ) {
        redirect("/");
    }

    return (
        <BuyNowPage
            productId={params.productId}
            variantId={params.variantId}
            quantity={
                params.quantity ?? "1"
            }
            promoSlug={typeof params.promo === "string" ? params.promo : undefined}
        />
    );
}
