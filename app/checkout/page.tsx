import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import CheckoutPage from "./CheckoutPage";

export const metadata: Metadata = pageMetadata({
    title: "Checkout",
    description:
        "Selesaikan pesanan Anda di Mutiara Abadi: isi alamat pengiriman, pilih metode pengiriman, lalu lanjutkan ke pembayaran.",
    noindex: true,
});

/*
 * ==========================================
 * CHECKOUT — GUEST ACCESSIBLE
 * ==========================================
 *
 * Customers check out as guests: there is no account and no login
 * step, so this page must never redirect to /login. The buyer identity
 * (name, phone, email, address) is collected INLINE by CheckoutPage and
 * validated server-side in lib/guest-address.ts — the page itself holds
 * no privileges, and every price/stock/shipping value is re-derived by
 * the API.
 */
export default function Checkout() {
    return <CheckoutPage />;
}
