import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import TrackingLookup from "@/components/orders/TrackingLookup";
import ResiLookup from "@/components/orders/ResiLookup";
import { sanitizeOrderNumberParam } from "@/lib/tracking/tracking-page";

export const metadata: Metadata = pageMetadata({
    title: "Lacak Pesanan",
    description:
        "Lacak status pengiriman pesanan Mutiara Abadi: kurir, nomor resi, dan riwayat perjalanan paket.",
    noindex: true,
});

type Props = {
    searchParams: Promise<{
        pesanan?: string;
    }>;
};

/**
 * ==========================================
 * /lacak — PUBLIC TRACKING PAGE
 * ==========================================
 *
 * The page the WhatsApp auto-reply links to. Public (guests shop without
 * an account), mobile-first and READ-ONLY.
 *
 * TWO WAYS IN, ONE PAGE:
 *
 *   1. `ResiLookup` — the waybill box the WhatsApp menu points customers
 *      at. No login, no order number: `GET /api/tracking/resi` is
 *      read-only and returns shipment facts only.
 *   2. `TrackingLookup` — the pre-existing order-number path, INCLUDING
 *      the two-phase OTP recovery. It is kept as-is (never replaced):
 *      a customer who lost the chat link can still recover their order
 *      here.
 *
 *   * `?pesanan=` is a prefill HINT, not authorization: the page only
 *     ever renders an order the browser is already entitled to see
 *     (guest access token cookie) or one restored through the two-phase
 *     OTP recovery. `sanitizeOrderNumberParam` keeps a hostile value from
 *     being reflected anywhere.
 *   * `noindex` — a link that arrives in a chat must never be indexed by
 *     a search engine.
 *   * No address, e-mail, phone, item, total, payment instruction, VA,
 *     QRIS or token is rendered here: this page shows shipment facts
 *     only. Those fields stay on `/orders/[id]`, which is reached
 *     through the customer's own navigation.
 */
export default async function LacakPage({
    searchParams,
}: Props) {
    const params = await searchParams;

    const orderNumber = sanitizeOrderNumberParam(
        params.pesanan
    );

    return (
        <main className="min-h-screen bg-[#f7f7f8] px-4 py-7 sm:px-6">
            <div className="mx-auto w-full max-w-xl">
                <header className="mb-5">
                    <h1 className="text-xl font-bold tracking-tight text-gray-900">
                        Lacak Pesanan
                    </h1>

                    <p className="mt-1.5 text-sm leading-6 text-gray-500">
                        Pantau status pengiriman paket kamu
                        di Mutiara Abadi.
                    </p>
                </header>

                {/* 1. Lacak dengan nomor resi (tanpa login) */}

                <ResiLookup />

                {/* 2. Lacak dengan nomor pesanan (mekanisme lama) */}

                <div className="mt-7">
                    <h2 className="text-sm font-bold text-gray-900">
                        Punya nomor pesanan?
                    </h2>

                    <p className="mt-1 text-xs leading-5 text-gray-500">
                        Kamu juga bisa membuka pengiriman
                        berdasarkan nomor pesanan. Untuk data
                        pesanan yang lebih lengkap, akses
                        dipulihkan dengan kode verifikasi.
                    </p>
                </div>

                <div className="mt-4">
                    <TrackingLookup
                        initialOrderNumber={orderNumber}
                    />
                </div>

                <p className="mt-6 text-center text-xs leading-5 text-gray-400">
                    Untuk kendala pengiriman, balas{" "}
                    <span className="font-semibold text-gray-500">
                        3
                    </span>{" "}
                    di chat WhatsApp Mutiara Abadi dan admin
                    kami akan membantu.
                </p>
            </div>
        </main>
    );
}
