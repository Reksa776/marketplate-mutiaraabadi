import type { Metadata } from "next";

import { SITE_NAME } from "@/lib/site-metadata";
import {
    getPublicStoreSetting,
    formatFullAddress,
} from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Kontak Kami",
    description:
        "Hubungi kami melalui email atau telepon. Kami siap membantu Anda mengenai pesanan, produk, dan layanan lainnya.",
    openGraph: {
        siteName: SITE_NAME,
        locale: "id_ID",
        title: "Kontak Kami",
        description:
            "Hubungi kami melalui email atau telepon. Kami siap membantu Anda.",
    },
};

export default async function KontakPage() {
    const setting = await getPublicStoreSetting();
    const fullAddress = formatFullAddress(setting);

    return (
        <main className="min-h-screen bg-gray-50">
            <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                {/* HEADER */}
                <div className="mb-8 text-center">
                    <span className="inline-flex items-center rounded-full bg-rose-100 px-4 py-1.5 text-sm font-semibold text-rose-600">
                        📞 Hubungi Kami
                    </span>

                    <h1 className="mt-4 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                        Kontak Kami
                    </h1>

                    <p className="mt-3 text-base text-gray-500">
                        Kami siap membantu Anda. Jangan
                        ragu untuk menghubungi kami melalui
                        informasi di bawah ini.
                    </p>
                </div>

                {/* CONTACT CARDS */}
                <div className="space-y-4">
                    {/* NAMA BISNIS */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-2xl">
                                🏪
                            </div>

                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Nama Bisnis
                                </h2>

                                <p className="mt-1 text-base font-medium text-gray-700">
                                    {setting.storeName}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* EMAIL BISNIS */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-2xl">
                                ✉️
                            </div>

                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Email Bisnis
                                </h2>

                                {setting.email ? (
                                    <a
                                        href={`mailto:${setting.email}`}
                                        className="mt-1 block text-base font-medium text-rose-600 hover:underline"
                                    >
                                        {setting.email}
                                    </a>
                                ) : (
                                    <p className="mt-1 text-base text-gray-400">
                                        Belum tersedia
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* NOMOR TELEPON */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-green-50 text-2xl">
                                📞
                            </div>

                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Nomor Telepon
                                </h2>

                                {setting.phone ? (
                                    <a
                                        href={`tel:${setting.phone}`}
                                        className="mt-1 block text-base font-medium text-rose-600 hover:underline"
                                    >
                                        {setting.phone}
                                    </a>
                                ) : (
                                    <p className="mt-1 text-base text-gray-400">
                                        Belum tersedia
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ALAMAT BISNIS */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-6">
                        <div className="flex items-start gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-2xl">
                                📍
                            </div>

                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Alamat Usaha
                                </h2>

                                <p className="mt-1 text-base leading-7 text-gray-700">
                                    {fullAddress || (
                                        <span className="text-gray-400">
                                            Belum tersedia
                                        </span>
                                    )}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ADDITIONAL INFO */}
                <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-6">
                    <h2 className="text-lg font-bold text-gray-900">
                        Informasi Tambahan
                    </h2>

                    <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                        <p>
                            Untuk pertanyaan mengenai pesanan,
                            produk, atau layanan kami, silakan
                            hubungi melalui email atau nomor
                            telepon di atas. Kami akan berusaha
                            merespons sesegera mungkin.
                        </p>

                        <p>
                            Pastikan Anda mencantumkan nomor
                            pesanan (jika ada) agar kami dapat
                            membantu dengan lebih cepat.
                        </p>
                    </div>
                </div>
            </div>
        </main>
    );
}
