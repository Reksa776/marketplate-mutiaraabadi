import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
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
    }>;
};

export default async function BuyNow(
    { searchParams }: Props
) {
    const session = await auth();

    if (!session?.user) {
        redirect(
            "/login?callbackUrl=/buy-now"
        );
    }

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
        />
    );
}