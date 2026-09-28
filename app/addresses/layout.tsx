import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SITE_NAME, pageMetadata } from "@/lib/site-metadata";

/**
 * The pages in this segment tree are Client Components and
 * cannot export `metadata` / `generateMetadata`, so these
 * colocated layouts carry the route titles instead.
 *
 * The `template` is re-declared here on purpose. In the App
 * Router a `title` given as a plain string CLEARS the template
 * inherited from ancestor segments, so without it the titles
 * of the nested `new` and `[id]/edit` layouts would render
 * without the brand suffix.
 */
export const metadata: Metadata = {
    ...pageMetadata({
        title: "Alamat Saya",
        description:
            "Kelola daftar alamat pengiriman yang tersimpan di akun Mutiara Abadi Anda.",
        noindex: true,
    }),
    title: {
        template: `%s | ${SITE_NAME}`,
        default: "Alamat Saya",
    },
};

export default function AddressesLayout({
    children,
}: {
    children: ReactNode;
}) {
    return children;
}
