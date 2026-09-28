import type { Metadata } from "next";
import Link from "next/link";

import { pageMetadata } from "@/lib/site-metadata";

/**
 * Branded 404. Also the metadata source for the
 * `notFound()` calls in the product detail and order routes.
 */
export const metadata: Metadata = pageMetadata({
    title: "Halaman Tidak Ditemukan",
    description:
        "Alamat yang Anda buka tidak tersedia di Mutiara Abadi. Kembali ke beranda untuk melihat produk pilihan kami.",
    noindex: true,
});

export default function NotFound() {
    return (
        <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-rose-50 via-white to-white px-5 py-16 text-center">
            <p className="text-6xl font-extrabold tracking-tight text-rose-600">
                404
            </p>

            <h1 className="mt-4 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
                Halaman Tidak Ditemukan
            </h1>

            <p className="mt-3 max-w-md text-sm leading-6 text-gray-500">
                Alamat yang Anda buka tidak tersedia atau sudah
                dipindahkan. Silakan kembali ke halaman utama.
            </p>

            <Link
                href="/"
                className="mt-7 inline-block rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-700"
            >
                Kembali ke Beranda
            </Link>
        </main>
    );
}
