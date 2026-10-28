import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { promoQuotaDate } from "@/lib/promo-claim";

export const dynamic = "force-dynamic";

async function adminError() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json(
            { success: false, message: "Silakan login terlebih dahulu." },
            { status: 401 }
        );
    }
    if (session.user.role !== "ADMIN") {
        return NextResponse.json(
            { success: false, message: "Akses ditolak." },
            { status: 403 }
        );
    }
    return null;
}

function parsePromoBody(body: Record<string, unknown>) {
    const slug = String(body.slug ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const title = String(body.title ?? "").trim();
    const description = String(body.description ?? "").trim();
    const productId = Number(body.productId);
    const variantId = Number(body.variantId);
    const promoPrice = Number(body.promoPrice);
    const dailyQuota = Number(body.dailyQuota);
    const startAt = new Date(String(body.startAt ?? ""));
    const endAt = new Date(String(body.endAt ?? ""));

    if (!slug || slug.length > 191) throw new Error("Link promo wajib diisi dengan slug yang valid.");
    if (!title || title.length > 191) throw new Error("Judul promo wajib diisi.");
    if (description.length > 5000) throw new Error("Deskripsi promo terlalu panjang.");
    if (!Number.isInteger(productId) || productId < 1) throw new Error("Produk promo wajib dipilih.");
    if (!Number.isInteger(variantId) || variantId < 1) throw new Error("Varian promo wajib dipilih.");
    if (!Number.isInteger(promoPrice) || promoPrice <= 0) throw new Error("Harga promo harus berupa rupiah bulat lebih dari nol.");
    if (!Number.isInteger(dailyQuota) || dailyQuota < 1 || dailyQuota > 1000000) {
        throw new Error("Kuota harian harus berupa angka antara 1 dan 1.000.000.");
    }
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
        throw new Error("Periode promo tidak valid. Waktu berakhir harus setelah waktu mulai.");
    }

    return {
        slug,
        title,
        description: description || null,
        productId,
        variantId,
        promoPrice,
        dailyQuota,
        startAt,
        endAt,
        isActive: body.isActive !== false,
    };
}

export async function GET() {
    const denied = await adminError();
    if (denied) return denied;

    try {
        const quotaDate = promoQuotaDate();
        const items = await prisma.promoLanding.findMany({
            orderBy: { createdAt: "desc" },
            include: {
                product: { select: { name: true, slug: true } },
                variant: { select: { name: true, price: true } },
                daily: {
                    where: { quotaDate },
                    select: { claimedCount: true },
                    take: 1,
                },
            },
        });

        return NextResponse.json({
            success: true,
            data: items.map((item) => ({
                id: item.id,
                slug: item.slug,
                title: item.title,
                description: item.description,
                productId: item.productId,
                productName: item.product?.name ?? null,
                productSlug: item.product?.slug ?? null,
                variantId: item.variantId,
                variantName: item.variant?.name ?? null,
                regularPrice: item.variant ? Number(item.variant.price) : null,
                promoPrice: item.promoPrice === null ? null : Number(item.promoPrice),
                dailyQuota: item.dailyQuota,
                claimedToday: item.daily[0]?.claimedCount ?? 0,
                startAt: item.startAt.toISOString(),
                endAt: item.endAt.toISOString(),
                isActive: item.isActive,
                createdAt: item.createdAt.toISOString(),
            })),
        });
    } catch (error) {
        console.error("LIST PROMO CLAIMS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Gagal mengambil daftar promo." },
            { status: 500 }
        );
    }
}

export async function POST(request: Request) {
    const denied = await adminError();
    if (denied) return denied;

    try {
        const body = await request.json();
        const data = parsePromoBody(body);
        const variant = await prisma.productVariant.findFirst({
            where: { id: data.variantId, productId: data.productId, product: { isArchived: false } },
            select: { price: true, product: { select: { category: true } } },
        });
        if (!variant) {
            return NextResponse.json({ success: false, message: "Varian yang dipilih tidak ditemukan atau produknya diarsipkan." }, { status: 400 });
        }
        if (data.promoPrice >= Number(variant.price)) {
            return NextResponse.json({ success: false, message: "Harga promo harus lebih rendah dari harga normal varian." }, { status: 400 });
        }
        const [conflict, flashSaleConflict] = data.isActive
            ? await Promise.all([
                  prisma.promoLanding.findFirst({
                      where: {
                          variantId: data.variantId,
                          isActive: true,
                          startAt: { lt: data.endAt },
                          endAt: { gt: data.startAt },
                      },
                      select: { id: true },
                  }),
                  prisma.flashSale.findFirst({
                      where: {
                          variantId: data.variantId,
                          isActive: true,
                          startAt: { lt: data.endAt },
                          endAt: { gt: data.startAt },
                      },
                      select: { id: true },
                  }),
              ])
            : [null, null];
        if (conflict || flashSaleConflict) {
            return NextResponse.json({ success: false, message: "Varian sudah memiliki promo atau flash sale yang waktunya bertumpuk." }, { status: 409 });
        }

        const promo = await prisma.promoLanding.create({ data });
        return NextResponse.json({ success: true, data: { id: promo.id } }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membuat promo.";
        const conflict = (error as { code?: string })?.code === "P2002";
        return NextResponse.json(
            { success: false, message: conflict ? "Link promo tersebut sudah dipakai." : message },
            { status: conflict ? 409 : 400 }
        );
    }
}
