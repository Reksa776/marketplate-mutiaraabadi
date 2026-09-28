import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminPayoutsPage from "@/components/admin/affiliate/AdminPayoutsPage";

export default function Page() {
    return <AdminPayoutsPage />;
}

export const metadata: Metadata = adminPageMetadata("Payout Affiliate");
