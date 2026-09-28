import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminAuditLogPage from "@/components/admin/affiliate/AdminAuditLogPage";

export default function Page() {
    return <AdminAuditLogPage />;
}

export const metadata: Metadata = adminPageMetadata("Audit Log");
