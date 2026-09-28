import type { Metadata } from "next";

import { SITE_NAME } from "@/lib/site-metadata";
import Link from "next/link";
import { getPublicStoreSetting } from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Kebijakan Refund",
    description:
        "Kebijakan pengembalian dana (refund) untuk pembelian produk di toko kami. Baca syarat dan prosedur pengajuan refund.",
    openGraph: {
        siteName: SITE_NAME,
        locale: "id_ID",
        title: "Kebijakan Refund",
        description:
            "Kebijakan pengembalian dana (refund) untuk pembelian produk di toko kami.",
    },
};

export default async function RefundPolicyPage() {
    const setting = await getPublicStoreSetting();
    const storeName = setting.storeName;

    return (
        <main className="min-h-screen bg-gray-50">
            <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                {/* HEADER */}
                <div className="mb-8 text-center">
                    <span className="inline-flex items-center rounded-full bg-rose-100 px-4 py-1.5 text-sm font-semibold text-rose-600">
                        💰 Kebijakan Refund
                    </span>

                    <h1 className="mt-4 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                        Kebijakan Pengembalian Dana
                    </h1>

                    <p className="mt-3 text-sm text-gray-500">
                        Terakhir diperbarui:{" "}
                        {new Date().toLocaleDateString(
                            "id-ID",
                            {
                                day: "numeric",
                                month: "long",
                                year: "numeric",
                            }
                        )}
                    </p>
                </div>

                {/* CONTENT */}
                <div className="space-y-8">
                    {/* 1. KONDISI YANG DAPAT MENGAJUKAN REFUND */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            1. Kondisi Pengajuan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Anda dapat mengajukan
                                pengembalian dana (refund) dalam
                                kondisi sebagai berikut:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Produk yang diterima dalam
                                    kondisi rusak atau cacat
                                </li>

                                <li>
                                    Produk yang diterima tidak
                                    sesuai dengan pesanan (salah
                                    varian, salah jumlah, atau
                                    produk berbeda)
                                </li>

                                <li>
                                    Produk tidak sampai ke
                                    alamat pengiriman (hilang
                                    selama pengiriman)
                                </li>

                                <li>
                                    Pembayaran berhasil tetapi
                                    pesanan tidak diproses
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 2. PRODUK YANG DAPAT / TIDAK DAPAT DIREFUND */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            2. Produk yang Dapat dan Tidak Dapat
                            Direfund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                <strong>
                                    Dapat direfund:
                                </strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Produk dengan kondisi rusak
                                    atau cacat saat diterima
                                </li>

                                <li>
                                    Produk yang tidak sesuai
                                    deskripsi atau pesanan
                                </li>

                                <li>
                                    Produk yang tidak sampai
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>
                                    Tidak dapat direfund:
                                </strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Produk yang sudah digunakan,
                                    dicuci, atau dimodifikasi
                                </li>

                                <li>
                                    Produk dengan segel yang sudah
                                    dibuka (untuk produk tertentu)
                                </li>

                                <li>
                                    Produk yang dikembalikan
                                    dalam kondisi tidak utuh
                                </li>

                                <li>
                                    Pesanan yang dibatalkan
                                    sepihak oleh customer setelah
                                    pesanan diproses
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 3. PROSEDUR PENGAJUAN REFUND */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            3. Prosedur Pengajuan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Untuk mengajukan refund, silakan
                                ikuti langkah-langkah berikut:
                            </p>

                            <ol className="list-inside list-decimal space-y-2 pl-2">
                                <li>
                                    Hubungi customer service kami
                                    melalui email atau nomor telepon
                                    yang tersedia di halaman{" "}
                                    <Link
                                        href="/kontak"
                                        className="font-medium text-rose-600 hover:underline"
                                    >
                                        Kontak
                                    </Link>
                                </li>

                                <li>
                                    Sertakan informasi pesanan
                                    (nomor pesanan) dan alasan
                                    pengajuan refund
                                </li>

                                <li>
                                    Lampirkan foto atau bukti
                                    pendukung terkait kondisi
                                    produk (jika applicable)
                                </li>

                                <li>
                                    Tim kami akan meninjau
                                    pengajuan Anda dan menghubungi
                                    Anda untuk langkah selanjutnya
                                </li>
                            </ol>
                        </div>
                    </section>

                    {/* 4. INFORMASI YANG HARUS DIBERIKAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            4. Informasi yang Diperlukan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Saat mengajukan refund, mohon
                                sediakan informasi berikut:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Nomor pesanan (order number)
                                </li>

                                <li>
                                    Nama lengkap sesuai akun
                                </li>

                                <li>
                                    Alasan pengajuan refund
                                </li>

                                <li>
                                    Foto produk / bukti kondisi
                                    produk
                                </li>

                                <li>
                                    Metode pembayaran yang
                                    digunakan
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 5. PROSES PEMERIKSAAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            5. Proses Pemeriksaan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Setelah pengajuan diterima, tim
                                kami akan melakukan peninjauan
                                terhadap:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Keaslian dan validitas
                                    pengajuan
                                </li>

                                <li>
                                    Kondisi produk berdasarkan
                                    bukti yang diberikan
                                </li>

                                <li>
                                    Riwayat pesanan dan status
                                    pembayaran
                                </li>
                            </ul>

                            <p>
                                Proses refund akan ditinjau oleh
                                tim kami sesuai dengan kondisi
                                pesanan dan kebijakan yang
                                berlaku.
                            </p>
                        </div>
                    </section>

                    {/* 6. ESTIMASI PROSES REFUND */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            6. Estimasi Proses Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Proses refund akan ditinjau oleh
                                tim kami sesuai dengan kondisi
                                pesanan dan kebijakan yang
                                berlaku. Estimasi waktu dapat
                                bervariasi tergantung pada
                                kompleksitas kasus dan metode
                                pembayaran yang digunakan.
                            </p>

                            <p>
                                Kami akan menginformasikan
                                progress pengajuan refund Anda
                                melalui email atau WhatsApp.
                            </p>
                        </div>
                    </section>

                    {/* 7. METODE REFUND */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            7. Metode Pengembalian Dana
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Pengembalian dana akan dilakukan
                                melalui metode yang sesuai dengan
                                pembayaran awal:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    <strong>
                                        Transfer Bank:
                                    </strong>{" "}
                                    Refund ke rekening bank yang
                                    digunakan saat pembayaran
                                </li>

                                <li>
                                    <strong>E-Wallet:</strong>{" "}
                                    Refund ke saldo e-wallet
                                </li>

                                <li>
                                    <strong>QRIS:</strong>{" "}
                                    Refund ke rekening bank yang
                                    terdaftar
                                </li>

                                <li>
                                    <strong>COD:</strong>{" "}
                                    Refund dilakukan melalui
                                    transfer ke rekening bank
                                    yang Anda berikan
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 8. REFUND DITOLAK */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            8. Penolakan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Pengajuan refund dapat ditolak
                                dalam kondisi berikut:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Produk tidak memenuhi
                                    syarat refund seperti yang
                                    dijelaskan di atas
                                </li>

                                <li>
                                    Tidak ada bukti yang cukup
                                    untuk mendukung pengajuan
                                </li>

                                <li>
                                    Pengajuan dianggap tidak
                                    valid atau mencurigakan
                                </li>

                                <li>
                                    Pesanan sudah melewati batas
                                    waktu pengajuan
                                </li>
                            </ul>

                            <p>
                                Jika pengajuan Anda ditolak, tim
                                kami akan menjelaskan alasan
                                penolakannya.
                            </p>
                        </div>
                    </section>

                    {/* 9. HUBUNGI CUSTOMER SERVICE */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            9. Hubungi Customer Service
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Jika Anda memiliki pertanyaan
                                atau ingin mengajukan refund,
                                silakan hubungi kami:
                            </p>

                            <ul className="space-y-1 pl-2">
                                <li>
                                    📧 Email:{" "}
                                    {setting.email || (
                                        <span className="text-gray-400">
                                            Belum tersedia
                                        </span>
                                    )}
                                </li>

                                <li>
                                    📞 Telepon:{" "}
                                    {setting.phone || (
                                        <span className="text-gray-400">
                                            Belum tersedia
                                        </span>
                                    )}
                                </li>
                            </ul>

                            <p>
                                Atau kunjungi halaman{" "}
                                <Link
                                    href="/kontak"
                                    className="font-medium text-rose-600 hover:underline"
                                >
                                    Kontak Kami
                                </Link>{" "}
                                untuk informasi lebih lanjut.
                            </p>
                        </div>
                    </section>
                </div>
            </div>
        </main>
    );
}
