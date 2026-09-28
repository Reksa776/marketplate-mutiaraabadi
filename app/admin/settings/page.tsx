import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

import AdminSettingsForm from "./AdminSettingsForm";

/**
 * Pengaturan also hosts the TikTok Pixel configuration
 * (see AdminSettingsForm) — there is no separate
 * /admin/tiktok-pixel route in this codebase.
 */
export const metadata: Metadata = adminPageMetadata("Pengaturan");

export default async function AdminSettingsPage() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = (session.user as any).role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    return <AdminSettingsForm />;
}