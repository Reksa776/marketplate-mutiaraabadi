import Link from "next/link";
import {
    getPublicStoreSetting,
    formatFullAddress,
} from "@/lib/store-settings";

export default async function Footer() {
    const setting = await getPublicStoreSetting();
    const fullAddress = formatFullAddress(setting);

    return (
        <footer className="border-t border-gray-200 bg-white">
            <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
                <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
                    {/* ========================
                        BRAND / ABOUT
                    ======================== */}
                    <div className="sm:col-span-2 lg:col-span-1">
                        <Link
                            href="/home"
                            className="text-lg font-bold text-gray-900"
                        >
                            {setting.storeName}
                        </Link>

                        <p className="mt-3 max-w-xs text-sm leading-6 text-gray-500">
                            Temukan produk favoritmu dan nikmati
                            berbagai keuntungan dari berbelanja
                            di toko kami.
                        </p>
                    </div>

                    {/* ========================
                        LEGAL LINKS
                    ======================== */}
                    <div>
                        <h3 className="text-sm font-semibold text-gray-900">
                            Informasi
                        </h3>

                        <ul className="mt-4 space-y-3">
                            {/*
                             * PUBLIC entry point to the affiliate
                             * programme. This is a marketing link, not
                             * an account surface: customers keep shopping
                             * as guests, and anyone who wants to join the
                             * programme signs in on the affiliate page's
                             * own (affiliate) login. Do NOT turn this into
                             * a customer profile/register/login wall.
                             */}
                            <li>
                                <Link
                                    href="/affiliate"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Program Affiliate
                                </Link>
                            </li>

                            <li>
                                <Link
                                    href="/faq"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    FAQ
                                </Link>
                            </li>

                            <li>
                                <Link
                                    href="/syarat-ketentuan"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Syarat &amp; Ketentuan
                                </Link>
                            </li>

                            <li>
                                <Link
                                    href="/refund-policy"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Kebijakan Refund
                                </Link>
                            </li>

                            <li>
                                <Link
                                    href="/kontak"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Hubungi Kami
                                </Link>
                            </li>
                        </ul>
                    </div>

                    {/* ========================
                        NAVIGASI
                    ======================== */}
                    <div>
                        <h3 className="text-sm font-semibold text-gray-900">
                            Navigasi
                        </h3>

                        <ul className="mt-4 space-y-3">
                            <li>
                                <Link
                                    href="/home"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Beranda
                                </Link>
                            </li>

                            <li>
                                <Link
                                    href="/products"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Produk
                                </Link>
                            </li>

                            {/*
                             * Customer accounts are gone: shopping and
                             * checkout are guest-only. "Lacak Pesanan"
                             * is the customer-facing replacement for the
                             * old Masuk/Daftar entries (order number +
                             * the contact used at checkout).
                             */}
                            <li>
                                <Link
                                    href="/orders"
                                    className="text-sm text-gray-500 transition hover:text-rose-600"
                                >
                                    Lacak Pesanan
                                </Link>
                            </li>
                        </ul>
                    </div>

                    {/* ========================
                        KONTAK BISNIS
                    ======================== */}
                    <div>
                        <h3 className="text-sm font-semibold text-gray-900">
                            Kontak Kami
                        </h3>

                        <ul className="mt-4 space-y-3">
                            {fullAddress && (
                                <li className="flex items-start gap-2">
                                    <span className="mt-0.5 text-gray-400">
                                        📍
                                    </span>
                                    <span className="text-sm text-gray-500">
                                        {fullAddress}
                                    </span>
                                </li>
                            )}

                            {setting.email && (
                                <li className="flex items-center gap-2">
                                    <span className="text-gray-400">
                                        ✉️
                                    </span>
                                    <a
                                        href={`mailto:${setting.email}`}
                                        className="text-sm text-gray-500 transition hover:text-rose-600"
                                    >
                                        {setting.email}
                                    </a>
                                </li>
                            )}

                            {setting.phone && (
                                <li className="flex items-center gap-2">
                                    <span className="text-gray-400">
                                        📞
                                    </span>
                                    <a
                                        href={`tel:${setting.phone}`}
                                        className="text-sm text-gray-500 transition hover:text-rose-600"
                                    >
                                        {setting.phone}
                                    </a>
                                </li>
                            )}
                        </ul>
                    </div>
                </div>

                {/* ========================
                    BOTTOM BAR
                ======================== */}
                <div className="mt-10 border-t border-gray-100 pt-6">
                    <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
                        <p className="text-xs text-gray-400">
                            &copy; {new Date().getFullYear()}{" "}
                            {setting.storeName}. Hak cipta
                            dilindungi.
                        </p>

                        <div className="flex gap-4">
                            <Link
                                href="/faq"
                                className="text-xs text-gray-400 transition hover:text-rose-600"
                            >
                                FAQ
                            </Link>

                            <Link
                                href="/syarat-ketentuan"
                                className="text-xs text-gray-400 transition hover:text-rose-600"
                            >
                                Syarat &amp; Ketentuan
                            </Link>

                            <Link
                                href="/refund-policy"
                                className="text-xs text-gray-400 transition hover:text-rose-600"
                            >
                                Kebijakan Refund
                            </Link>

                            <Link
                                href="/kontak"
                                className="text-xs text-gray-400 transition hover:text-rose-600"
                            >
                                Kontak
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </footer>
    );
}
