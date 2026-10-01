import type { Metadata } from "next";
import Link from "next/link";

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

/**
 * ==========================================
 * GUEST SOFT-LOGIN STATE
 * ==========================================
 *
 * Guests may open /orders (the page is no longer behind the
 * proxy page-guard), but they can never read order data:
 * `OrdersPage` is NOT rendered, so no `/api/orders` request is
 * made, and the API itself still returns 401 for guests.
 */
function GuestOrdersGate() {
    return (
        <main className="min-h-screen bg-[#f7f7f8] pb-24">
            <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
                <header className="mb-7">
                    <h1 className="text-[22px] font-bold tracking-tight text-gray-900">
                        Pesanan Saya
                    </h1>

                    <p className="mt-1.5 text-sm text-gray-500">
                        Silakan masuk untuk melihat riwayat pesanan Anda.
                    </p>
                </header>

                <div className="border border-gray-200 bg-white px-6 py-16 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-2xl">
                        🔐
                    </div>

                    <h2 className="mt-5 text-base font-bold text-gray-900">
                        Masuk untuk melihat pesanan
                    </h2>

                    <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-gray-500">
                        Riwayat dan status pesanan Anda hanya
                        tersedia setelah Anda masuk.
                    </p>

                    <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                        <Link
                            href="/login?callbackUrl=/orders"
                            className="inline-flex h-10 items-center justify-center rounded-lg bg-gray-900 px-6 text-sm font-semibold text-white transition hover:bg-gray-800"
                        >
                            Masuk
                        </Link>

                        <Link
                            href="/register"
                            className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-6 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
                        >
                            Daftar
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}

export default async function Orders() {
    const session = await auth();

    return (
        <ProductProvider>
            {session?.user ? (
                <>
                    <OrdersPage />
                    <BottomNavbar />
                </>
            ) : (
                /*
                 * Guest sees only the soft-login state. No OrdersPage
                 * (so no /api/orders request) and no BottomNavbar.
                 */
                <GuestOrdersGate />
            )}
        </ProductProvider>
    );
}
