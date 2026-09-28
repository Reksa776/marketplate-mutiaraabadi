import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";

import AdminDashboard from "./AdminDashboard";

/**
 * The dashboard itself is a Client Component (it fetches stats
 * in the browser), so it cannot export metadata. This thin
 * server page owns the route title, following the same
 * content-component pattern used by /affiliate, /faq and
 * /profile.
 */
export const metadata: Metadata = adminPageMetadata("Dashboard");

export default function AdminDashboardPage() {
    return <AdminDashboard />;
}
