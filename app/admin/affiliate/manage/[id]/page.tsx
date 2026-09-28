import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import AdminAffiliateDetail from "@/components/admin/affiliate/AdminAffiliateDetail";

type Props = { params: Promise<{ id: string }> };

/**
 * Static title on purpose: the affiliate identity (name,
 * e-mail, KYC data) is PII and must never end up in the
 * document head, so the id is not echoed into the tab title.
 */
export const metadata: Metadata = adminPageMetadata("Detail Affiliate");

export default async function Page({ params }: Props) {
    const { id } = await params;
    return <AdminAffiliateDetail id={id} />;
}
