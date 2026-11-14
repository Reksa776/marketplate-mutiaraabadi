"use client";

import { useEffect, useState } from "react";
import { FaArrowLeft } from "react-icons/fa";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    signIn,
    getSession,
} from "next-auth/react";
import toast from "react-hot-toast";

import {
    FaLock,
    FaEye,
    FaEyeSlash,
    FaGoogle,
    FaPhone,
    FaEnvelope,
} from "react-icons/fa";

export default function LoginForm({
    returnToCart = false,
    adminMode = false,
}: {
    returnToCart?: boolean;
    adminMode?: boolean;
}) {
    const router = useRouter();

    const [identifier, setIdentifier] =
        useState("");

    const [password, setPassword] =
        useState("");

    const [loading, setLoading] =
        useState(false);

    const [checkingSession, setCheckingSession] =
        useState(true);

    const [showPassword, setShowPassword] =
        useState(false);

    const customerRedirect = returnToCart ? "/cart" : "/home";

    async function handleGoogleLogin() {
        setLoading(true);
        try {
            await signIn("google", { redirectTo: customerRedirect });
        } catch (error) {
            console.error("GOOGLE LOGIN ERROR:", error);
            toast.error("Login Google gagal. Silakan coba lagi.");
            setLoading(false);
        }
    }

    /*
     * ==========================================
     * CEK SESSION SAAT HALAMAN LOGIN DIBUKA
     * ==========================================
     */

    useEffect(() => {
        let mounted = true;

        async function checkSession() {
            try {
                const session =
                    await getSession();

                console.log(
                    "LOGIN PAGE SESSION:",
                    session
                );

                if (!mounted) {
                    return;
                }

                /*
                 * BELUM LOGIN
                 */

                if (
                    !session?.user
                ) {
                    setCheckingSession(
                        false
                    );

                    return;
                }

                /*
                 * SUDAH LOGIN
                 */

                const role =
                    (session.user as {
                        role?: string;
                    }).role;

                if (role === "ADMIN") {
                    router.replace(
                        "/admin"
                    );
                } else if (adminMode) {
                    router.replace("/products");
                } else if (returnToCart) {
                    router.replace("/cart");
                } else {
                    router.replace(
                        "/home"
                    );
                }
            } catch (error) {
                console.error(
                    "CHECK SESSION ERROR:",
                    error
                );

                if (mounted) {
                    setCheckingSession(
                        false
                    );
                }
            }
        }

        checkSession();

        return () => {
            mounted = false;
        };
    }, [router, returnToCart, adminMode]);
    async function handleLogin(
        e: React.FormEvent<HTMLFormElement>
    ) {
        e.preventDefault();

        if (!identifier || !password) {
            toast.error("Semua field wajib diisi.");
            return;
        }

        setLoading(true);

        try {
            const result = await signIn("credentials", {
                identifier,
                password,
                loginMode: adminMode ? "admin" : "customer",
                redirect: false,
            });

            if (result?.error) {
                toast.error(adminMode
                    ? "Email admin atau password salah."
                    : "Nomor WhatsApp atau password salah.");

                setLoading(false);
                return;
            }

            // Ambil session setelah login
            const session = await getSession();

            console.log("SESSION:", session);

            const role = session?.user?.role;

            toast.success("Login berhasil 🎉");

            // Redirect berdasarkan role
            if (role === "ADMIN") {
                router.replace("/admin");
            } else if (adminMode) {
                toast.error("Akun ini tidak memiliki akses admin.");
                setLoading(false);
                return;
            } else if (returnToCart) {
                router.replace("/cart");
            } else {
                router.replace("/home");
            }

            router.refresh();
        } catch (error) {
            console.error("Login error:", error);

            toast.error(
                "Terjadi kesalahan saat login."
            );
        } finally {
            setLoading(false);
        }
    }

    /*
 * ==========================================
 * CEK SESSION
 * ==========================================
 */

    if (checkingSession) {
        return (
            <section className="flex min-h-screen items-center justify-center bg-gradient-to-br from-rose-50 via-white to-rose-100 px-5 py-10">
                <div className="rounded-2xl bg-white px-8 py-6 text-center shadow-xl">
                    <p className="font-medium text-gray-900">
                        Memeriksa sesi login...
                    </p>

                    <p className="mt-1 text-sm text-gray-500">
                        Tunggu sebentar.
                    </p>
                </div>
            </section>
        );
    }

    return (
        <section className="flex min-h-screen items-center justify-center bg-gradient-to-br from-rose-50 via-white to-rose-100 px-5 py-10">
            <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">

                {/* BACK */}
                <Link
                    href="/"
                    className="mb-6 inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100"
                >
                    <FaArrowLeft className="text-xs" />
                    Kembali ke Beranda
                </Link>

                {/* HEADER */}
                <div className="mb-8 text-center">

                    <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-100 text-3xl">
                        🛍️
                    </div>

                    <h1 className="text-3xl font-bold text-gray-900">
                        {adminMode ? "Login Admin" : "Selamat Datang"}
                    </h1>

                    <p className="mt-2 text-sm text-gray-600">
                        {adminMode ? "Masuk ke panel pengelolaan Mutiara Abadi Snack." : "Login untuk mulai berbelanja."}
                    </p>

                </div>

                {/* FORM */}
                <form
                    onSubmit={handleLogin}
                    className="space-y-5"
                >

                        {/* WHATSAPP NUMBER */}
                    <div>

                        <label className="mb-2 block text-sm font-semibold text-gray-700">
                            {adminMode ? "Email admin" : "Nomor WhatsApp"}
                        </label>

                        <div className="relative">

                            {adminMode ? <FaEnvelope
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            /> : <FaPhone
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            />}

                            <input
                                type="text"
                                value={identifier}
                                onChange={(e) =>
                                    setIdentifier(
                                        e.target.value
                                    )
                                }
                                placeholder={adminMode ? "admin@email.com" : "Contoh: 081234567890"}
                                disabled={loading}
                                autoComplete="username"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-4 text-[15px] text-black placeholder:text-gray-400 focus:border-rose-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-100"
                            />

                        </div>

                    </div>

                    {/* PASSWORD */}
                    <div>

                        <label className="mb-2 block text-sm font-semibold text-gray-700">
                            Password
                        </label>

                        <div className="relative">

                            <FaLock
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            />

                            <input
                                type={
                                    showPassword
                                        ? "text"
                                        : "password"
                                }
                                value={password}
                                onChange={(e) =>
                                    setPassword(
                                        e.target.value
                                    )
                                }
                                placeholder="Masukkan password"
                                disabled={loading}
                                autoComplete="current-password"
                                className="h-12 w-full rounded-xl border border-gray-300 bg-white pl-11 pr-12 text-[15px] text-black placeholder:text-gray-400 focus:border-rose-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-100"
                            />

                            <button
                                type="button"
                                onClick={() =>
                                    setShowPassword(
                                        !showPassword
                                    )
                                }
                                disabled={loading}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 transition hover:text-rose-600 disabled:cursor-not-allowed"
                            >
                                {showPassword ? (
                                    <FaEyeSlash />
                                ) : (
                                    <FaEye />
                                )}
                            </button>

                        </div>

                    </div>

                    {/* LOGIN BUTTON */}
                    <button
                        type="submit"
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center rounded-xl bg-rose-600 font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading
                            ? "Memproses..."
                            : adminMode ? "Masuk sebagai Admin" : "Login dengan WhatsApp"}
                    </button>

                    {!adminMode && <>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="h-px flex-1 bg-gray-200" />
                        atau
                        <span className="h-px flex-1 bg-gray-200" />
                    </div>

                    <button
                        type="button"
                        onClick={handleGoogleLogin}
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white font-semibold text-gray-800 transition hover:bg-gray-50 disabled:opacity-60"
                    >
                        <FaGoogle className="text-rose-600" />
                        Lanjutkan dengan Google
                    </button>

                    <p className="text-center text-sm text-gray-600">
                        Belum punya akun?{" "}
                        <Link
                            href={`/register?callbackUrl=${returnToCart ? "%2Fcart" : "%2Fhome"}`}
                            className="font-semibold text-rose-600 hover:underline"
                        >
                            Daftar di sini
                        </Link>
                    </p>
                    </>}

                </form>

            </div>
        </section>
    );
}
