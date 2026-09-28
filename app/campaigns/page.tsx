import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import Link from "next/link";
import { auth } from "@/auth";
import BottomNavbar from "@/components/products/BottomNavbar";
import { ProductProvider } from "@/components/products/ProductContext";
import CampaignsList from "@/components/products/CampaignsList";

export const metadata: Metadata = pageMetadata({
    title: "Kampanye",
    description: "Kampanye dan penawaran spesial Mutiara Abadi yang sedang berlangsung.",
});

export default async function CampaignsPage() {
    const session = await auth();

    return (
        <ProductProvider>
            <main className="min-h-screen bg-gray-50 pb-20">
                <div className="mx-auto max-w-7xl px-4 pt-5 sm:px-6 lg:px-8">
                    {/* Header */}
                    <div className="mb-6">
                        <Link
                            href="/products"
                            className="text-sm text-gray-500 hover:text-gray-900"
                        >
                            ← Kembali
                        </Link>

                        <h1 className="mt-3 text-2xl font-bold text-gray-900 sm:text-3xl">
                            📢 Kampanye
                        </h1>

                        <p className="mt-1 text-sm text-gray-500">
                            Lihat kampanye dan penawaran spesial yang sedang berlangsung.
                        </p>
                    </div>

                    <CampaignsList />
                </div>

                {session?.user && <BottomNavbar />}
            </main>
        </ProductProvider>
    );
}
