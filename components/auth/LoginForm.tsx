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
    FaEnvelope,
    FaLock,
    FaEye,
    FaEyeSlash,
} from "react-icons/fa";

export default function LoginForm() {
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
    }, [router]);
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
                redirect: false,
            });

            if (result?.error) {
                toast.error(
                    "Email / Nomor HP atau Password salah."
                );

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
                        Selamat Datang
                    </h1>

                    <p className="mt-2 text-sm text-gray-600">
                        Login untuk mulai berbelanja.
                    </p>

                </div>

                {/* FORM */}
                <form
                    onSubmit={handleLogin}
                    className="space-y-5"
                >

                    {/* EMAIL / PHONE */}
                    <div>

                        <label className="mb-2 block text-sm font-semibold text-gray-700">
                            Email / Nomor HP
                        </label>

                        <div className="relative">

                            <FaEnvelope
                                size={18}
                                className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                            />

                            <input
                                type="text"
                                value={identifier}
                                onChange={(e) =>
                                    setIdentifier(
                                        e.target.value
                                    )
                                }
                                placeholder="Masukkan email atau nomor HP"
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

                    {/* REMEMBER + FORGOT */}
                    <div className="flex items-center justify-between text-sm">

                        <label className="flex items-center gap-2 text-gray-700">

                            <input
                                type="checkbox"
                                disabled={loading}
                                className="h-4 w-4 accent-rose-600"
                            />

                            Ingat Saya

                        </label>

                        <Link
                            href="/forgot-password"
                            className="font-medium text-rose-600 hover:underline"
                        >
                            Lupa Password?
                        </Link>

                    </div>

                    {/* LOGIN BUTTON */}
                    <button
                        type="submit"
                        disabled={loading}
                        className="flex h-12 w-full items-center justify-center rounded-xl bg-rose-600 font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading
                            ? "Memproses..."
                            : "Login"}
                    </button>

                    {/*
                     * The Google provider and the self-serve
                     * registration link were removed together with the
                     * customer account area. This form now exists only
                     * for the ADMIN / AFFILIATE dashboards, which
                     * authenticate with the credentials provider.
                     */}

                </form>

            </div>
        </section>
    );
}