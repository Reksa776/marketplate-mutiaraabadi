import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { Suspense } from "react";
import RegisterForm from "@/components/auth/RegisterForm";

export const metadata: Metadata = pageMetadata({
    title: "Daftar",
    description:
        "Daftar akun Mutiara Abadi untuk mulai berbelanja camilan pilihan, menyimpan alamat, dan melacak pesanan Anda.",
});

export default function RegisterPage() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-5">
      <Suspense fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-sm text-gray-500">Memuat...</p>
        </div>
      }>
        <RegisterForm />
      </Suspense>
    </main>
  );
}