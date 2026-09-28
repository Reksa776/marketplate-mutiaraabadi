import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminAffiliatePage from "@/components/admin/affiliate/AdminAffiliatePage";

export default function Page() {
    return <AdminAffiliatePage />;
}

export const metadata: Metadata = adminPageMetadata("Affiliate");
