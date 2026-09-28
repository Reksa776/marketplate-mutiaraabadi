import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import CheckoutPage from "./CheckoutPage";

export const metadata: Metadata = pageMetadata({
    title: "Checkout",
    description:
        "Selesaikan pesanan Anda di Mutiara Abadi: isi alamat pengiriman, pilih metode pengiriman, lalu lanjutkan ke pembayaran.",
    noindex: true,
});

export default async function Checkout() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login?callbackUrl=/checkout");
    }

    return <CheckoutPage />;
}