import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminAffiliateManagement from "@/components/admin/affiliate/AdminAffiliateManagement";

export default function Page() {
    return <AdminAffiliateManagement />;
}

export const metadata: Metadata = adminPageMetadata("Management Affiliate");
