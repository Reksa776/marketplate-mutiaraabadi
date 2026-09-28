import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

import WhatsAppDashboard from "./WhatsAppDashboard";

export const metadata: Metadata = adminPageMetadata("WhatsApp");

export default async function AdminWhatsAppPage() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = (session.user as any).role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    return <WhatsAppDashboard />;
}
