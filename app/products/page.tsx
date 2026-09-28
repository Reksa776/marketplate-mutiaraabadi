import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import SearchBar from "@/components/products/SearchBar";
import ProductGrid from "@/components/products/ProductGrid";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";
import { auth } from "@/auth";

export const metadata: Metadata = pageMetadata({
    title: "Produk",
    description:
        "Katalog produk Mutiara Abadi: keripik, kerupuk, dan kue pilihan. Cari dan temukan camilan favorit Anda.",
});

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    guestProduct?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await auth();

  return (
    <ProductProvider>
      <main className="min-h-screen bg-gray-50">
        <SearchBar />

        <ProductGrid />

        {session?.user && (
          <BottomNavbar />
        )}

        {params.guestProduct && (
          <GuestProductDialog />
        )}
      </main>
    </ProductProvider>
  );
}

function GuestProductDialog() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-5">
      <div className="w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-2xl">
          🔐
        </div>

        <h2 className="mt-5 text-center text-xl font-bold text-gray-900">
          Login diperlukan
        </h2>

        <p className="mt-3 text-center text-sm leading-6 text-gray-500">
          Jika ingin melihat detail produk
          dan melakukan pembelian, segera
          login atau register terlebih dahulu.
        </p>

        <div className="mt-7 grid grid-cols-3 gap-3">
          <a
            href="/products"
            className="flex h-11 items-center justify-center rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </a>

          <a
            href="/register"
            className="flex h-11 items-center justify-center rounded-xl border border-rose-600 text-sm font-semibold text-rose-600 hover:bg-rose-50"
          >
            Register
          </a>

          <a
            href="/login"
            className="flex h-11 items-center justify-center rounded-xl bg-rose-600 text-sm font-semibold text-white hover:bg-rose-700"
          >
            Login
          </a>
        </div>
      </div>
    </div>
  );
}