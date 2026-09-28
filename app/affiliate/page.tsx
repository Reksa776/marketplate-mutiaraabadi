import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import AffiliateContent from "./AffiliateContent";

export const metadata: Metadata = pageMetadata({
    title: "Program Affiliate",
    description:
        "Program affiliate Mutiara Abadi. Ajukan kemitraan, lengkapi data, dan dapatkan komisi dari setiap penjualan.",
});

export default async function AffiliatePage() {
    const session = await auth();

    if (!session?.user?.id) {
        redirect("/login");
    }

    return <AffiliateContent />;
}
