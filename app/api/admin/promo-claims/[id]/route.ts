import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function isAdmin() {
    const session = await auth();
    return Boolean(session?.user?.id && session.user.role === "ADMIN");
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    if (!(await isAdmin())) {
        return NextResponse.json(
            { success: false, message: "Akses ditolak." },
            { status: 403 }
        );
    }

    try {
        const { id: rawId } = await params;
        const id = Number(rawId);
        if (!Number.isInteger(id) || id < 1) {
            return NextResponse.json({ success: false, message: "ID promo tidak valid." }, { status: 400 });
        }
        const existing = await prisma.promoLanding.findUnique({ where: { id } });
        if (!existing) {
            return NextResponse.json({ success: false, message: "Promo tidak ditemukan." }, { status: 404 });
        }

        const body = await request.json();
        const merged = {
            slug: body.slug ?? existing.slug,
            title: body.title ?? existing.title,
            description: body.description ?? existing.description,
            voucherId: body.voucherId ?? existing.voucherId,
            productId: body.productId ?? existing.productId,
            variantId: body.variantId ?? existing.variantId,
            promoPrice: body.promoPrice ?? Number(existing.promoPrice),
            dailyQuota: body.dailyQuota ?? existing.dailyQuota,
            startAt: body.startAt ?? existing.startAt.toISOString(),
            endAt: body.endAt ?? existing.endAt.toISOString(),
            isActive: body.isActive ?? existing.isActive,
        };
        const parsed = parsePromoBody(merged);
        const voucher = await prisma.voucher.findUnique({
            where: { id: parsed.voucherId },
            include: {
                productRestrictions: { select: { productId: true } },
                categoryRestrictions: { select: { category: true } },
            },
        });
        if (!voucher) {
            return NextResponse.json({ success: false, message: "Voucher yang dipilih tidak ditemukan." }, { status: 400 });
        }
        if (
            !voucher.isActive ||
            (voucher.startDate && voucher.startDate > parsed.startAt) ||
            (voucher.endDate && voucher.endDate < parsed.endAt)
        ) {
            return NextResponse.json({ success: false, message: "Periode voucher harus mencakup seluruh periode promo dan voucher harus aktif." }, { status: 400 });
        }

        const variant = await prisma.productVariant.findFirst({
            where: { id: parsed.variantId, productId: parsed.productId, product: { isArchived: false } },
            select: { price: true, product: { select: { category: true } } },
        });
        if (!variant) {
            return NextResponse.json({ success: false, message: "Varian yang dipilih tidak ditemukan atau produknya diarsipkan." }, { status: 400 });
        }
        if (parsed.promoPrice >= Number(variant.price)) {
            return NextResponse.json({ success: false, message: "Harga promo harus lebih rendah dari harga normal varian." }, { status: 400 });
        }
        if (
            voucher.productRestrictions.length > 0 &&
            !voucher.productRestrictions.some((restriction) => restriction.productId === parsed.productId)
        ) {
            return NextResponse.json({ success: false, message: "Voucher tidak berlaku untuk produk promo yang dipilih." }, { status: 400 });
        }
        if (
            voucher.categoryRestrictions.length > 0 &&
            !voucher.categoryRestrictions.some((restriction) => restriction.category.toLowerCase() === (variant.product.category ?? "").toLowerCase())
        ) {
            return NextResponse.json({ success: false, message: "Voucher tidak berlaku untuk kategori produk promo yang dipilih." }, { status: 400 });
        }
        const overlapWhere = {
            variantId: parsed.variantId,
            isActive: true,
            startAt: { lt: parsed.endAt },
            endAt: { gt: parsed.startAt },
            id: { not: id },
        };
        const [overlappingPromo, overlappingFlashSale] = parsed.isActive
            ? await Promise.all([
                  prisma.promoLanding.findFirst({ where: overlapWhere, select: { id: true } }),
                  prisma.flashSale.findFirst({
                      where: {
                          variantId: parsed.variantId,
                          isActive: true,
                          startAt: { lt: parsed.endAt },
                          endAt: { gt: parsed.startAt },
                      },
                      select: { id: true },
                  }),
              ])
            : [null, null];
        if (overlappingPromo || overlappingFlashSale) {
            return NextResponse.json({ success: false, message: "Varian sudah memiliki promo atau flash sale yang waktunya bertumpuk." }, { status: 409 });
        }

        await prisma.promoLanding.update({ where: { id }, data: parsed });
        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal mengubah promo.";
        const conflict = (error as { code?: string })?.code === "P2002";
        return NextResponse.json(
            { success: false, message: conflict ? "Link promo tersebut sudah dipakai." : message },
            { status: conflict ? 409 : 400 }
        );
    }
}

function parsePromoBody(body: Record<string, unknown>) {
    const slug = String(body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const title = String(body.title ?? "").trim();
    const description = String(body.description ?? "").trim();
    const voucherId = Number(body.voucherId);
    const productId = Number(body.productId);
    const variantId = Number(body.variantId);
    const promoPrice = Number(body.promoPrice);
    const dailyQuota = Number(body.dailyQuota);
    const startAt = new Date(String(body.startAt ?? ""));
    const endAt = new Date(String(body.endAt ?? ""));

    if (!slug || slug.length > 191) throw new Error("Link promo wajib diisi dengan slug yang valid.");
    if (!title || title.length > 191) throw new Error("Judul promo wajib diisi.");
    if (description.length > 5000) throw new Error("Deskripsi promo terlalu panjang.");
    if (!Number.isInteger(voucherId) || voucherId < 1) throw new Error("Voucher wajib dipilih.");
    if (!Number.isInteger(productId) || productId < 1) throw new Error("Produk promo wajib dipilih.");
    if (!Number.isInteger(variantId) || variantId < 1) throw new Error("Varian promo wajib dipilih.");
    if (!Number.isInteger(promoPrice) || promoPrice <= 0) throw new Error("Harga promo harus berupa rupiah bulat lebih dari nol.");
    if (!Number.isInteger(dailyQuota) || dailyQuota < 1 || dailyQuota > 1000000) throw new Error("Kuota harian harus berupa angka antara 1 dan 1.000.000.");
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) throw new Error("Periode promo tidak valid. Waktu berakhir harus setelah waktu mulai.");

    return {
        slug,
        title,
        description: description || null,
        voucherId,
        productId,
        variantId,
        promoPrice,
        dailyQuota,
        startAt,
        endAt,
        isActive: body.isActive !== false,
    };
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    if (!(await isAdmin())) {
        return NextResponse.json(
            { success: false, message: "Akses ditolak." },
            { status: 403 }
        );
    }

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) {
        return NextResponse.json({ success: false, message: "ID promo tidak valid." }, { status: 400 });
    }
    const existing = await prisma.promoLanding.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
        return NextResponse.json({ success: false, message: "Promo tidak ditemukan." }, { status: 404 });
    }
    await prisma.promoLanding.delete({ where: { id } });
    return NextResponse.json({ success: true });
}
