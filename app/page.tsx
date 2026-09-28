import type { Metadata } from "next";

import Image from "next/image";
import Link from "next/link";
import { FiLogIn, FiShoppingBag } from "react-icons/fi";
import ReferralTracker from "./ReferralTracker";
import {
    SITE_DEFAULT_TITLE,
    SITE_DESCRIPTION,
    pageMetadata,
} from "@/lib/site-metadata";

/**
 * `absolute` (not a string) so the storefront template is
 * bypassed: the homepage keeps the brand-led title instead
 * of rendering "Mutiara Abadi — Belanja Produk Pilihan |
 * Mutiara Abadi".
 */
export const metadata: Metadata = pageMetadata({
    title: SITE_DEFAULT_TITLE,
    description: SITE_DESCRIPTION,
    absolute: true,
});

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-rose-50 via-white to-white">
      <ReferralTracker />
      <section className="mx-auto flex min-h-screen max-w-7xl items-center px-6 py-10">
        <div className="grid w-full items-center gap-12 lg:grid-cols-2">
          {/* ================= Banner ================= */}
          <div className="relative order-1 flex justify-center lg:order-2">
            <Image
              src="/images/banner-marketplace1.png"
              alt="Marketplace Banner"
              width={650}
              height={650}
              priority
              className="h-auto w-full max-w-sm md:max-w-md lg:max-w-xl"
            />

            {/* Promo Card */}
            {/* <div className="absolute left-3 top-3 rounded-xl bg-white px-4 py-3 shadow-xl">
              <p className="text-xs text-gray-500 md:text-sm">
                Promo Hari Ini
              </p>

              <p className="text-lg font-bold text-rose-600 md:text-2xl">
                Diskon Hingga 70%
              </p>
            </div> */}

            {/* Product Card */}
            <div className="absolute bottom-3 right-3 rounded-xl bg-white px-4 py-3 shadow-xl">
              <p className="text-xs text-gray-500 md:text-sm">
                Produk
              </p>

              <p className="text-lg font-bold text-slate-900 md:text-2xl">
                1Jt+
              </p>
            </div>
          </div>

          {/* ================= Content ================= */}
          <div className="order-2 text-center lg:order-1 lg:text-left">
            {/* Badge */}
            <span className="inline-flex items-center rounded-full bg-rose-100 px-4 py-2 text-sm font-semibold text-rose-600">
              🛍️ Marketplace Indonesia
            </span>

            {/* Desktop Title */}
            <h1 className="mt-6 hidden text-5xl font-extrabold leading-tight text-slate-900 lg:block lg:text-6xl">
              Belanja Lebih
              <br />
              Mudah &
              <span className="text-rose-600"> Terpercaya.</span>
            </h1>

            {/* Description */}
            <p className="mt-6 max-w-lg text-base leading-8 text-gray-600 md:mx-auto md:text-lg md:leading-9 lg:mx-0">
              Temukan ribuan produk pilihan dari berbagai kategori.
              Nikmati promo terbaik, voucher eksklusif, cashback,
              dan pengalaman belanja yang cepat, aman,
              serta nyaman untuk memenuhi kebutuhan Anda.
            </p>

            {/* Button */}
            <div className="mt-8 flex w-full gap-4">
              <Link
                href="/login"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-rose-600 px-6 py-4 font-semibold text-white shadow-lg transition-all duration-300 hover:-translate-y-1 hover:bg-rose-700"
              >
                <FiLogIn size={20} />
                Login
              </Link>

              <Link
                href="/products"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border-2 border-rose-600 px-6 py-4 font-semibold text-rose-600 transition-all duration-300 hover:bg-rose-50"
              >
                <FiShoppingBag size={20} />
                Lihat Produk
              </Link>
            </div>

            {/* Register */}
            <p className="mt-8 text-gray-600">
              Belum punya akun?{" "}
              <Link
                href="/register"
                className="font-semibold text-rose-600 hover:underline"
              >
                Buat Akun
              </Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}