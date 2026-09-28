import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { Suspense } from "react";
import PaymentFinishContent from "./payment-finish-content";

export const metadata: Metadata = pageMetadata({
    title: "Selesaikan Pembayaran",
    description:
        "Memproses pembayaran pesanan Anda di Mutiara Abadi. Status pembayaran diperbarui otomatis setelah pembayaran dikonfirmasi.",
    noindex: true,
});

/*
 * ==========================================
 * PAYMENT FINISH PAGE
 * ==========================================
 *
 * Halaman ini TIDAK menentukan status
 * pembayaran secara final. Status final
 * ditentukan oleh webhook
 * /api/payment/ipaymu/notification.
 *
 * Halaman ini hanya polling status order
 * dari database sampai webhook selesai
 * memproses (biasanya beberapa detik).
 */

export default function PaymentFinishPage() {
    return (
        <Suspense
            fallback={
                <main className="min-h-screen bg-gray-50 px-4 py-8">
                    <div className="mx-auto max-w-lg">
                        <div className="rounded-3xl border bg-white p-8 text-center">
                            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-rose-600 border-t-transparent" />
                            <h1 className="mt-5 text-xl font-bold">
                                Memuat...
                            </h1>
                        </div>
                    </div>
                </main>
            }
        >
            <PaymentFinishContent />
        </Suspense>
    );
}