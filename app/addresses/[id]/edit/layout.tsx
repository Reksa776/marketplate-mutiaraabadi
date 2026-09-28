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
    title: "Ubah Alamat",
    description: "Perbarui data alamat pengiriman Anda.",
    noindex: true,
});

export default function EditAddressLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
