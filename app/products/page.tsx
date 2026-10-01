import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import SearchBar from "@/components/products/SearchBar";
import ProductGrid from "@/components/products/ProductGrid";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";

export const metadata: Metadata = pageMetadata({
    title: "Produk",
    description:
        "Katalog produk Mutiara Abadi: keripik, kerupuk, dan kue pilihan. Cari dan temukan camilan favorit Anda.",
});

/**
 * ==========================================
 * PUBLIC PRODUCT CATALOG
 * ==========================================
 *
 * Guests and logged-in customers see the same non-archived
 * catalog. There is no login wall or guest-only dialog.
 *
 * The BottomNavbar is only rendered for authenticated users
 * (existing session mechanism); guests get no navbar but are
 * NOT redirected.
 */
export default async function ProductsPage() {
    const session = await auth();

    return (
        <ProductProvider>
            <main className="min-h-screen bg-gray-50">
                <SearchBar />

                <ProductGrid />

                {session?.user && <BottomNavbar />}
            </main>
        </ProductProvider>
    );
}
