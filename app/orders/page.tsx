import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import OrdersPage from "@/components/orders/OrdersPage";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";

export const metadata: Metadata = pageMetadata({
    title: "Pesanan Saya",
    description:
        "Daftar pesanan Anda di Mutiara Abadi. Pantau status pembayaran, pengiriman, dan ajukan pengembalian dana.",
    noindex: true,
});

/**
 * ==========================================
 * ORDERS — GUEST ORDER HISTORY
 * ==========================================
 *
 * Customers have no accounts, so this page is public and lists the
 * orders THIS BROWSER is allowed to see.
 *
 * Ownership is never decided here: `/api/orders` returns only the
 * orders whose guest access token cookie verifies against the stored
 * hash (plus, for legacy orders, the session owner). A visitor with no
 * valid token simply gets an empty list, and can restore access with
 * the recovery form (order number + the email/phone used at checkout).
 */
export default function Orders() {
    return (
        <ProductProvider>
            <OrdersPage />
            <BottomNavbar />
        </ProductProvider>
    );
}