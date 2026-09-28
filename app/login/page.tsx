import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import LoginForm from "@/components/auth/LoginForm";

export const metadata: Metadata = pageMetadata({
    title: "Masuk",
    description:
        "Masuk ke akun Mutiara Abadi untuk melihat pesanan, melanjutkan checkout, dan mengelola alamat pengiriman.",
    noindex: true,
});

export default function LoginPage() {
    return (
        <main className="min-h-screen bg-gradient-to-b from-rose-50 via-white to-white">
            <LoginForm />
        </main>
    );
}