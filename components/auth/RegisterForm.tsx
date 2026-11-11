"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { FaArrowLeft, FaGoogle, FaLock, FaPhone } from "react-icons/fa";
import toast from "react-hot-toast";

export default function RegisterForm({
    returnToCart = false,
}: {
    returnToCart?: boolean;
}) {
    const router = useRouter();
    const [phone, setPhone] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const redirectTo = returnToCart ? "/cart" : "/home";

    async function handleRegister(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password !== confirmPassword) {
            toast.error("Konfirmasi password belum sama.");
            return;
        }

        setLoading(true);
        try {
            const response = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone, password, confirmPassword }),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message ?? "Registrasi gagal.");
            }

            const login = await signIn("credentials", {
                identifier: phone,
                password,
                redirect: false,
            });
            if (login?.error) {
                toast.success("Registrasi berhasil. Silakan login.");
                router.replace(`/login?callbackUrl=${returnToCart ? "%2Fcart" : "%2Fhome"}`);
                return;
            }

            toast.success("Akun berhasil dibuat.");
            router.replace(redirectTo);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Registrasi gagal.");
        } finally {
            setLoading(false);
        }
    }

    async function handleGoogleRegister() {
        setLoading(true);
        try {
            await signIn("google", { redirectTo });
        } catch (error) {
            console.error("GOOGLE REGISTRATION ERROR:", error);
            toast.error("Pendaftaran Google gagal. Silakan coba lagi.");
            setLoading(false);
        }
    }

    return (
        <section className="flex min-h-screen items-center justify-center bg-gradient-to-br from-rose-50 via-white to-rose-100 px-5 py-10">
            <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
                <Link href="/" className="mb-6 inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">
                    <FaArrowLeft className="text-xs" /> Kembali ke Beranda
                </Link>
                <div className="mb-8 text-center">
                    <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-100 text-3xl">🛍️</div>
                    <h1 className="text-3xl font-bold text-gray-900">Buat Akun Pembeli</h1>
                    <p className="mt-2 text-sm text-gray-600">Daftar dengan nomor WhatsApp dan password.</p>
                </div>

                <form onSubmit={handleRegister} className="space-y-5">
                    <label className="block text-sm font-semibold text-gray-700">
                        Nomor WhatsApp
                        <span className="relative mt-2 block">
                            <FaPhone size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
                            <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Contoh: 081234567890" autoComplete="tel" required disabled={loading} className="h-12 w-full rounded-xl border border-gray-300 pl-11 pr-4 text-[15px] text-black outline-none focus:border-rose-500 disabled:bg-gray-100" />
                        </span>
                    </label>
                    <label className="block text-sm font-semibold text-gray-700">
                        Password
                        <span className="relative mt-2 block">
                            <FaLock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
                            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={72} disabled={loading} placeholder="Minimal 8 karakter" className="h-12 w-full rounded-xl border border-gray-300 pl-11 pr-4 text-[15px] text-black outline-none focus:border-rose-500 disabled:bg-gray-100" />
                        </span>
                    </label>
                    <p className="-mt-3 text-xs text-gray-500">Gunakan huruf besar, huruf kecil, dan angka.</p>
                    <label className="block text-sm font-semibold text-gray-700">
                        Ulangi Password
                        <span className="relative mt-2 block">
                            <FaLock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
                            <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required disabled={loading} placeholder="Ulangi password" className="h-12 w-full rounded-xl border border-gray-300 pl-11 pr-4 text-[15px] text-black outline-none focus:border-rose-500 disabled:bg-gray-100" />
                        </span>
                    </label>
                    <button type="submit" disabled={loading} className="h-12 w-full rounded-xl bg-rose-600 font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
                        {loading ? "Memproses..." : "Daftar dengan WhatsApp"}
                    </button>
                </form>

                <div className="my-5 flex items-center gap-3 text-xs text-gray-400">
                    <span className="h-px flex-1 bg-gray-200" /> atau <span className="h-px flex-1 bg-gray-200" />
                </div>
                <button type="button" onClick={handleGoogleRegister} disabled={loading} className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-gray-300 font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-60">
                    <FaGoogle className="text-rose-600" /> Daftar dengan Google
                </button>
                <p className="mt-6 text-center text-sm text-gray-600">
                    Sudah punya akun? <Link href={`/login?callbackUrl=${returnToCart ? "%2Fcart" : "%2Fhome"}`} className="font-semibold text-rose-600 hover:underline">Login</Link>
                </p>
            </div>
        </section>
    );
}
