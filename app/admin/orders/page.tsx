import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminOrdersPage from "@/components/admin/orders/AdminOrdersPage";

export const metadata: Metadata = adminPageMetadata("Pesanan");

export default function Page() {
    return <AdminOrdersPage />;
}