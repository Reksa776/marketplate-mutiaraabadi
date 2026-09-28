import { ReactNode } from "react";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

import AdminNavbar from "@/components/admin/AdminNavbar";
import { ADMIN_SITE_NAME, SITE_DESCRIPTION } from "@/lib/site-metadata";

/**
 * ==========================================
 * ADMIN METADATA
 * ==========================================
 *
 * The back office declares its OWN title template so no
 * admin screen can ever inherit the storefront suffix
 * ("... | Mutiara Abadi"). Descendant pages only set
 * `title: "Pengaturan"` and get "Pengaturan | Mutiara Abadi
 * Admin" for free.
 *
 * The admin area is also excluded from crawlers: it is
 * authenticated, holds operational data, and has no
 * business being indexed. `robots` lives on the layout so
 * every descendant inherits it.
 */
export const metadata: Metadata = {
    title: {
        template: `%s | ${ADMIN_SITE_NAME}`,
        default: ADMIN_SITE_NAME,
        // `absolute` is required: without it the root layout's
        // `%s | Mutiara Abadi` template would be applied to this
        // segment's `default`, producing the wrong
        // "Mutiara Abadi Admin | Mutiara Abadi".
        absolute: ADMIN_SITE_NAME,
    },
    description: SITE_DESCRIPTION,
    applicationName: ADMIN_SITE_NAME,
    // Declared explicitly: metadata is shallowly merged, so
    // without this the back office would publish the
    // storefront's homepage `og:title` on every admin screen.
    openGraph: {
        type: "website",
        siteName: ADMIN_SITE_NAME,
        locale: "id_ID",
        title: ADMIN_SITE_NAME,
        description: SITE_DESCRIPTION,
    },
    twitter: {
        card: "summary",
        title: ADMIN_SITE_NAME,
        description: SITE_DESCRIPTION,
    },
    robots: {
        index: false,
        follow: false,
    },
};

export default async function AdminLayout({
    children,
}: {
    children: ReactNode;
}) {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = (session.user as any).role;

    if (role !== "ADMIN") {
        redirect("/products");
    }

    return (
        <div className="min-h-screen bg-gray-50">
            <AdminNavbar />

            <main className="lg:pl-64">
                {children}
            </main>
        </div>
    );
}