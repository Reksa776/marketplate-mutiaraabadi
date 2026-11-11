import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import RegisterForm from "@/components/auth/RegisterForm";

export const metadata: Metadata = pageMetadata({
    title: "Daftar Akun Pembeli",
    description: "Buat akun pembeli dengan nomor WhatsApp atau Google.",
    noindex: true,
});

export default async function RegisterPage({
    searchParams,
}: {
    searchParams: Promise<{ callbackUrl?: string }>;
}) {
    const params = await searchParams;
    const returnToCart = params.callbackUrl === "/cart";
    return <RegisterForm returnToCart={returnToCart} />;
}
