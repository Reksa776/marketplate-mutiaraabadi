import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import type { ReactNode } from "react";

/**
 * The page in this segment is a Client Component, which
 * cannot export `metadata` / `generateMetadata`. This
 * colocated layout carries the route title instead, so the
 * segment still renders a proper tab title.
 */
export const metadata: Metadata = pageMetadata({
    title: "Promo Saya",
    description: "Kode promo dan voucher yang tersedia untuk akun Anda di Mutiara Abadi.",
    noindex: true,
});

export default function PromosLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
