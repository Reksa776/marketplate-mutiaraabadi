import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import OrdersPage from "@/components/orders/OrdersPage";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";

export const metadata: Metadata = pageMetadata({
    title: "Pesanan Saya",
    description:
        "Daftar pesanan Anda di Mutiara Abadi. Pantau status pembayaran, pengiriman, dan ajukan pengembalian dana.",
    noindex: true,
});

export default async function Orders() {
    const session = await auth();
    return (
        <ProductProvider>
            {session?.user && (
            <><OrdersPage /><BottomNavbar /></>
            )}
        </ProductProvider>
    );
}   