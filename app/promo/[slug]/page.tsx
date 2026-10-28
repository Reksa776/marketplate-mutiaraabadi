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
            promoPrice: true,
            product: { select: { name: true, slug: true, image: true } },
            variant: { select: { name: true, price: true } },
        },
    });

    if (!promo) notFound();

    return (
        <PromoClaimPage
            slug={promo.slug}
            title={promo.title}
            description={promo.description}
            product={{
                name: promo.product.name,
                slug: promo.product.slug,
                image: promo.product.image,
                variant: promo.variant.name,
                regularPrice: Number(promo.variant.price),
                promoPrice: Number(promo.promoPrice),
            }}
        />
    );
}
