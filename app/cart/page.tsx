import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import CartPage from "@/components/cart/CartPage";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";

export const metadata: Metadata = pageMetadata({
    title: "Keranjang",
    description:
        "Keranjang belanja Anda di Mutiara Abadi. Periksa produk yang dipilih sebelum melanjutkan ke checkout.",
});

export default async function Cart() {
    const session = await auth();
    return (
        <ProductProvider>
            {session?.user && (
            <><CartPage /><BottomNavbar /></>
            )}

        </ProductProvider>
    );
}