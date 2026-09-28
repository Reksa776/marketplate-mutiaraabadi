import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import AffiliateDashboard from "./AffiliateDashboard";

export const metadata: Metadata = pageMetadata({
    title: "Dashboard Affiliate",
    description: "Ringkasan klik, konversi, dan komisi affiliate Mutiara Abadi Anda.",
    noindex: true,
});

export default function AffiliateDashboardPage() {
    return <AffiliateDashboard />;
}
