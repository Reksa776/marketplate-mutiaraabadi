import type { Metadata } from "next";

import { SITE_NAME } from "@/lib/site-metadata";
import Link from "next/link";
import { getPublicStoreSetting } from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Syarat & Ketentuan",
    description:
        "Syarat dan ketentuan penggunaan layanan dan pembelian produk di toko kami. Baca dengan seksama sebelum melakukan transaksi.",
    openGraph: {
        siteName: SITE_NAME,
        locale: "id_ID",
        title: "Syarat & Ketentuan",
        description:
            "Syarat dan ketentuan penggunaan layanan dan pembelian produk di toko kami.",
    },
};

export default async function SyaratKetentuanPage() {
    const setting = await getPublicStoreSetting();
    const storeName = setting.storeName;

    return (
        <main className="min-h-screen bg-gray-50">
            <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                {/* HEADER */}
                <div className="mb-8 text-center">
                    <span className="inline-flex items-center rounded-full bg-rose-100 px-4 py-1.5 text-sm font-semibold text-rose-600">
                        📜 Legal
                    </span>

                    <h1 className="mt-4 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                        Syarat &amp; Ketentuan
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
                    {/* 1. KETENTUAN UMUM */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            1. Ketentuan Umum
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Syarat dan ketentuan ini berlaku
                                untuk seluruh pengguna layanan
                                dan pembelian produk di website
                                ini. Dengan mengakses atau
                                menggunakan layanan kami, Anda
                                setuju untuk terikat dengan
                                syarat dan ketentuan ini.
                            </p>

                            <p>
                                Kami berhak untuk mengubah syarat
                                dan ketentuan ini sewaktu-waktu
                                tanpa pemberitahuan terlebih
                                dahulu. Perubahan akan berlaku
                                segera setelah dipublikasikan
                                di halaman ini.
                            </p>
                        </div>
                    </section>

                    {/* 2. DEFINISI */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            2. Definisi
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                <strong>&quot;Kami&quot;</strong>{" "}
                                merujuk pada {storeName} selaku
                                pemilik dan pengelola website
                                ini.
                            </p>

                            <p>
                                <strong>
                                    &quot;Anda&quot;/&quot;Customer&quot;
                                </strong>{" "}
                                merujuk pada setiap individu
                                atau badan hukum yang mengakses
                                atau menggunakan layanan kami.
                            </p>

                            <p>
                                <strong>
                                    &quot;Produk&quot;
                                </strong>{" "}
                                merujuk pada barang atau jasa
                                yang tersedia untuk dibeli
                                melalui website ini.
                            </p>

                            <p>
                                <strong>
                                    &quot;Pesanan&quot;
                                </strong>{" "}
                                merujuk pada transaksi pembelian
                                produk yang dilakukan melalui
                                website ini.
                            </p>
                        </div>
                    </section>

                    {/* 3. AKUN CUSTOMER */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            3. Akun Customer
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Untuk melakukan pembelian, Anda
                                diwajibkan membuat akun dengan
                                informasi yang benar dan lengkap.
                                Anda bertanggung jawab untuk
                                menjaga kerahasiaan akun dan
                                kata sandi Anda.
                            </p>

                            <p>
                                Anda tidak diperkenankan
                                menggunakan akun orang lain
                                tanpa izin. Kami berhak
                                menangguhkan atau menghapus akun
                                jika ditemukan aktivitas yang
                                mencurigakan atau melanggar
                                ketentuan ini.
                            </p>
                        </div>
                    </section>

                    {/* 4. PRODUK DAN INFORMASI PRODUK */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            4. Produk dan Informasi Produk
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Kami berusaha menampilkan gambar
                                dan deskripsi produk seakurat
                                mungkin. Namun, warna, ukuran,
                                dan detail produk dapat sedikit
                                berbeda dengan yang ditampilkan
                                di layar karena perbedaan
                                pengaturan monitor atau perangkat
                                yang digunakan.
                            </p>

                            <p>
                                Ketersediaan produk dapat berubah
                                sewaktu-waktu tanpa pemberitahuan
                                terlebih dahulu.
                            </p>
                        </div>
                    </section>

                    {/* 5. HARGA DAN PEMBAYARAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            5. Harga dan Pembayaran
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Semua harga produk yang tercantum
                                di website ini sudah termasuk
                                Pajak Pertambahan Nilai (PPN)
                                jika berlaku. Harga belum termasuk
                                biaya pengiriman, yang akan
                                dihitung berdasarkan alamat
                                pengiriman dan kurir yang Anda
                                pilih.
                            </p>

                            <p>
                                Kami menerima beberapa metode
                                pembayaran, termasuk namun tidak
                                terbatas pada: COD (Bayar di
                                Tempat), Transfer Bank, E-Wallet,
                                dan QRIS.
                            </p>

                            <p>
                                Harga produk dapat berubah sewaktu-waktu
                                tanpa pemberitahuan terlebih
                                dahulu. Namun, perubahan harga
                                tidak berlaku untuk pesanan yang
                                sudah terkonfirmasi.
                            </p>
                        </div>
                    </section>

                    {/* 6. PESANAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            6. Pesanan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Pesanan dianggap sah setelah Anda
                                melakukan pembayaran dan
                                pembayaran berhasil dikonfirmasi
                                oleh sistem kami.
                            </p>

                            <p>
                                Kami berhak menolak atau membatalkan
                                pesanan jika ditemukan indikasi
                                penipuan, harga yang tidak wajar,
                                atau masalah lain yang terkait
                                dengan pesanan.
                            </p>
                        </div>
                    </section>

                    {/* 7. PENGIRIMAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            7. Pengiriman
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Pengiriman dilakukan melalui
                                kurir pilihan yang tersedia di
                                sistem kami. Estimasi waktu
                                pengiriman tergantung pada kurir
                                dan lokasi pengiriman.
                            </p>

                            <p>
                                Risiko kehilangan atau kerusakan
                                produk selama pengiriman menjadi
                                tanggung jawab kurir. Namun,
                                kami akan membantu Anda menyelesaikan
                                masalah yang terkait dengan
                                pengiriman.
                            </p>
                        </div>
                    </section>

                    {/* 8. PEMBATALAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            8. Pembatalan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Anda dapat membatalkan pesanan
                                selama status pesanan masih
                                &quot;Menunggu Pembayaran&quot;
                                atau sebelum pesanan diproses.
                            </p>

                            <p>
                                Pembatalan tidak dapat dilakukan
                                untuk pesanan yang sudah diproses
                                atau sudah dikirim. Untuk
                                pembatalan, silakan hubungi
                                customer service kami.
                            </p>
                        </div>
                    </section>

                    {/* 9. REFUND / RETUR */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            9. Pengembalian Dana (Refund)
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Pengembalian dana dapat diajukan
                                jika produk yang diterima dalam
                                kondisi rusak, cacat, atau tidak
                                sesuai dengan pesanan. Untuk
                                informasi lebih lengkap, silakan
                                kunjungi{" "}
                                <Link
                                    href="/refund-policy"
                                    className="font-medium text-rose-600 hover:underline"
                                >
                                    Kebijakan Refund
                                </Link>{" "}
                                kami.
                            </p>
                        </div>
                    </section>

                    {/* 10. PROMO / VOUCHER */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            10. Promo dan Voucher
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Promo dan voucher berlaku sesuai
                                dengan syarat dan ketentuan yang
                                tercantum pada masing-masing
                                promo. Kami berhak mengubah atau
                                menghentikan promo sewaktu-waktu
                                tanpa pemberitahuan terlebih
                                dahulu.
                            </p>

                            <p>
                                Voucher tidak dapat ditukarkan
                                dengan uang tunai dan tidak
                                dapat digabungkan dengan promo
                                lainnya kecuali dinyatakan
                                sebaliknya.
                            </p>
                        </div>
                    </section>

                    {/* 11. HAK DAN KEWAJIBAN PENGGUNA */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            11. Hak dan Kewajiban Pengguna
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                <strong>Hak Anda:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Mendapatkan produk sesuai
                                    dengan deskripsi dan pesanan
                                </li>

                                <li>
                                    Mendapatkan layanan customer
                                    service yang responsif
                                </li>

                                <li>
                                    Mengajukan pengembalian dana
                                    sesuai ketentuan yang berlaku
                                </li>

                                <li>
                                    Melindungi data pribadi sesuai
                                    kebijakan privasi kami
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>Kewajiban Anda:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Memberikan informasi yang
                                    benar dan lengkap saat
                                    melakukan pemesanan
                                </li>

                                <li>
                                    Melakukan pembayaran sesuai
                                    dengan total pesanan
                                </li>

                                <li>
                                    Menerima produk yang telah
                                    dipesan sesuai dengan ketentuan
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 12. HAK DAN KEWAJIBAN TOKO */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            12. Hak dan Kewajiban Toko
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                <strong>Hak Kami:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Menolak atau membatalkan
                                    pesanan yang mencurigakan
                                </li>

                                <li>
                                    Mengubah syarat dan ketentuan
                                    sewaktu-waktu
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>Kewajiban Kami:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Menyediakan produk sesuai
                                    dengan deskripsi
                                </li>

                                <li>
                                    Memproses pesanan tepat waktu
                                </li>

                                <li>
                                    Memberikan layanan customer
                                    service yang baik
                                </li>

                                <li>
                                    Melindungi data pribadi
                                    customer
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 13. PERUBAHAN KETENTUAN */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            13. Perubahan Ketentuan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Kami berhak mengubah syarat dan
                                ketentuan ini sewaktu-waktu.
                                Perubahan akan berlaku segera
                                setelah dipublikasikan di
                                halaman ini. Penggunaan layanan
                                kami setelah perubahan dipublikasikan
                                dianggap sebagai persetujuan
                                Anda terhadap perubahan tersebut.
                            </p>
                        </div>
                    </section>

                    {/* 14. KONTAK */}
                    <section className="rounded-2xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold text-gray-900">
                            14. Kontak
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600">
                            <p>
                                Jika Anda memiliki pertanyaan
                                mengenai syarat dan ketentuan
                                ini, silakan hubungi kami
                                melalui:
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
