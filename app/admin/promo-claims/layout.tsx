import type { Metadata } from "next";
import type { ReactNode } from "react";
import { adminPageMetadata } from "@/lib/site-metadata";

export const metadata: Metadata = adminPageMetadata("Promo Klaim Harian");

export default function PromoClaimsLayout({ children }: { children: ReactNode }) {
    return children;
}
