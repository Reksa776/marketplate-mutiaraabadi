import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import PromoClaimPage from "@/components/promo/PromoClaimPage";

export const dynamic = "force-dynamic";

export default async function PromoLandingPage({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const promo = await prisma.promoLanding.findUnique({
        where: { slug },
        select: {
            slug: true,
            title: true,
            description: true,
        },
    });

    if (!promo) notFound();

    return <PromoClaimPage {...promo} />;
}
