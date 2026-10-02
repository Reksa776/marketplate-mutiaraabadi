import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    normalizeComparePrice,
    parseComparePrice,
} from "@/lib/price-display";

async function checkAdmin() {
    const session = await auth();

    if (!session?.user) {
        return {
            ok: false,
            status: 401,
            message: "Unauthorized.",
        };
    }

    const role = (session.user as any).role;

    if (role !== "ADMIN") {
        return {
            ok: false,
            status: 403,
            message:
                "Kamu tidak memiliki akses admin.",
        };
    }

    return {
        ok: true,
        status: 200,
        message: "",
    };
}

/*
|--------------------------------------------------------------------------
| GET DETAIL PRODUCT
|--------------------------------------------------------------------------
*/

export async function GET(
    _request: Request,
    context: {
        params: Promise<{
            id: string;
        }>;
    }
) {
    try {
        const admin = await checkAdmin();

        if (!admin.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message: admin.message,
                },
                {
                    status: admin.status,
                }
            );
        }

        const { id } = await context.params;

        const productId = Number(id);

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "ID produk tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const product =
            await prisma.product.findUnique({
                where: {
                    id: productId,
                },
                include: {
                    variants: {
                        orderBy: {
                            id: "asc",
                        },
                    },
                },
            });

        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Produk tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        return NextResponse.json({
            success: true,
            product: {
                ...product,
                variants: product.variants.map(
                    (variant) => ({
                        ...variant,
                        price: Number(
                            variant.price
                        ),
                        comparePrice:
                            variant.comparePrice != null
                                ? Number(variant.comparePrice)
                                : null,
                    })
                ),
            },
        });
    } catch (error) {
        console.error(
            "GET ADMIN PRODUCT ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil produk.",
            },
            {
                status: 500,
            }
        );
    }
}

/*
|--------------------------------------------------------------------------
| UPDATE PRODUCT
|--------------------------------------------------------------------------
*/

export async function PUT(
    request: Request,
    context: {
        params: Promise<{
            id: string;
        }>;
    }
) {
    try {
        const admin = await checkAdmin();

        if (!admin.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message: admin.message,
                },
                {
                    status: admin.status,
                }
            );
        }

        const { id } = await context.params;

        const productId = Number(id);

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "ID produk tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const body = await request.json();

        const {
            name,
            slug,
            description,
            category,
            image,
            bestseller,
            variants,
        } = body;

        /*
         * VALIDASI PRODUCT
         */

        if (
            typeof name !== "string" ||
            !name.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Nama produk wajib diisi.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            typeof slug !== "string" ||
            !slug.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Slug wajib diisi.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            typeof category !== "string" ||
            !category.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Kategori wajib diisi.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            !Array.isArray(variants) ||
            variants.length === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Minimal harus ada satu variant.",
                },
                {
                    status: 400,
                }
            );
        }

        /*
         * VALIDASI VARIANT
         */

        for (const variant of variants) {
            if (
                typeof variant.name !== "string" ||
                !variant.name.trim()
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Nama variant wajib diisi.",
                    },
                    {
                        status: 400,
                    }
                );
            }

            const price = Number(
                variant.price
            );

            const stock = Number(
                variant.stock
            );

            const weight = Number(
                variant.weight
            );

            if (
                !Number.isFinite(price) ||
                price <= 0
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            `Harga variant "${variant.name}" tidak valid.`,
                    },
                    {
                        status: 400,
                    }
                );
            }
            if (price > 9999999999.99) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            `Harga variant "${variant.name}" terlalu besar. Maksimal Rp 9.999.999.999.`,
                    },
                    {
                        status: 400,
                    }
                );
            }

            if (
                !Number.isInteger(stock) ||
                stock < 0
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            `Stok variant "${variant.name}" tidak valid.`,
                    },
                    {
                        status: 400,
                    }
                );
            }

            if (
                !Number.isInteger(weight) ||
                weight <= 0
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            `Berat variant "${variant.name}" wajib diisi dalam gram.`,
                    },
                    {
                        status: 400,
                    }
                );
            }

            /*
             * comparePrice is DISPLAY-ONLY. Validate so an invalid
             * value can never be persisted; it is never used for
             * checkout/payment/order totals.
             */
            const compareResult = parseComparePrice(
                variant.comparePrice,
                price
            );

            if (!compareResult.ok) {
                return NextResponse.json(
                    {
                        success: false,
                        message: `Harga normal variant "${variant.name}" tidak valid. ${compareResult.message}`,
                    },
                    {
                        status: 400,
                    }
                );
            }
        }

        /*
         * CEK PRODUCT
         */

        const existingProduct =
            await prisma.product.findUnique({
                where: {
                    id: productId,
                },
            });

        if (!existingProduct) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Produk tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        /*
         * CEK SLUG
         *
         * Jangan sampai slug product lain
         * ikut bentrok.
         */

        const duplicateSlug =
            await prisma.product.findFirst({
                where: {
                    slug: slug.trim(),
                    NOT: {
                        id: productId,
                    },
                },
            });

        if (duplicateSlug) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Slug produk sudah digunakan.",
                },
                {
                    status: 409,
                }
            );
        }

        /*
         * TRANSACTION
         *
         * Pola diff-based:
         * - Variant yang punya id valid & masih ada di form -> UPDATE
         * - Variant tanpa id (baru dari form) -> CREATE
         * - Variant lama yang gak ada lagi di form -> DELETE,
         *   KECUALI variant itu masih punya OrderItem (history order),
         *   karena FK constraint bakal nolak & data order harus tetap utuh.
         */

        let skippedDeleteCount = 0;

        const product = await prisma.$transaction(
            async (tx) => {
                const existingVariants =
                    await tx.productVariant.findMany({
                        where: { productId },
                        select: { id: true },
                    });

                const existingIds = existingVariants.map(
                    (v) => v.id
                );

                const incomingIds = variants
                    .filter(
                        (v: any) =>
                            v.id &&
                            existingIds.includes(
                                Number(v.id)
                            )
                    )
                    .map((v: any) => Number(v.id));

                const idsToDelete = existingIds.filter(
                    (id) => !incomingIds.includes(id)
                );

                let actualIdsToDelete: number[] = [];

                if (idsToDelete.length > 0) {
                    const blocked =
                        await tx.orderItem.findMany({
                            where: {
                                variantId: {
                                    in: idsToDelete,
                                },
                            },
                            select: { variantId: true },
                            distinct: ["variantId"],
                        });

                    const blockedIds = new Set(
                        blocked.map((b) => b.variantId)
                    );

                    actualIdsToDelete = idsToDelete.filter(
                        (id) => !blockedIds.has(id)
                    );

                    skippedDeleteCount =
                        idsToDelete.length -
                        actualIdsToDelete.length;
                }

                if (actualIdsToDelete.length > 0) {
                    await tx.productVariant.deleteMany({
                        where: {
                            id: { in: actualIdsToDelete },
                        },
                    });
                }

                for (const variant of variants) {
                    const variantData = {
                        name: variant.name.trim(),
                        price: Number(variant.price),
                        comparePrice: normalizeComparePrice(
                            variant.comparePrice,
                            Number(variant.price)
                        ),
                        stock: Number(variant.stock),
                        weight: Number(variant.weight),
                        image:
                            typeof variant.image ===
                                "string"
                                ? variant.image.trim() ||
                                null
                                : null,
                    };

                    if (
                        variant.id &&
                        incomingIds.includes(
                            Number(variant.id)
                        )
                    ) {
                        await tx.productVariant.update({
                            where: {
                                id: Number(variant.id),
                            },
                            data: variantData,
                        });
                    } else {
                        await tx.productVariant.create({
                            data: {
                                ...variantData,
                                productId,
                            },
                        });
                    }
                }

                return tx.product.update({
                    where: { id: productId },
                    data: {
                        name: name.trim(),
                        slug: slug.trim(),
                        description:
                            typeof description === "string"
                                ? description.trim() ||
                                null
                                : null,
                        category:
                            typeof category === "string"
                                ? category.trim() || null
                                : null,
                        image:
                            typeof image === "string"
                                ? image.trim() || null
                                : null,
                        bestseller: Boolean(bestseller),
                    },
                    include: {
                        variants: {
                            orderBy: { id: "asc" },
                        },
                    },
                });
            }
        );

        return NextResponse.json({
            success: true,
            message:
                skippedDeleteCount > 0
                    ? `Produk berhasil diperbarui. ${skippedDeleteCount} variant tidak dihapus karena sudah punya history pesanan.`
                    : "Produk berhasil diperbarui.",
            product: {
                ...product,
                variants: product.variants.map(
                    (variant) => ({
                        ...variant,
                        price: Number(
                            variant.price
                        ),
                        comparePrice:
                            variant.comparePrice != null
                                ? Number(variant.comparePrice)
                                : null,
                    })
                ),
            },
        });
    } catch (error) {
        console.error(
            "UPDATE PRODUCT ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal memperbarui produk.",
            },
            {
                status: 500,
            }
        );
    }
}

/*
|--------------------------------------------------------------------------
| DELETE PRODUCT
|--------------------------------------------------------------------------
*/

export async function DELETE(
    _request: Request,
    context: {
        params: Promise<{
            id: string;
        }>;
    }
) {
    try {
        const admin = await checkAdmin();

        if (!admin.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message: admin.message,
                },
                {
                    status: admin.status,
                }
            );
        }

        const { id } = await context.params;

        const productId = Number(id);

        if (
            !Number.isInteger(productId) ||
            productId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "ID produk tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const product =
            await prisma.product.findUnique({
                where: {
                    id: productId,
                },
            });

        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Produk tidak ditemukan.",
                },
                {
                    status: 404,
                }
            );
        }

        /*
         * Product dihapus, ProductVariant ikut
         * cascade delete. OrderItem.productId dan
         * variantId di-set NULL otomatis (onDelete:
         * SetNull), tapi productName/variantName/
         * price/subtotal di OrderItem tetap utuh
         * karena itu snapshot, bukan relasi baca-langsung.
         */

        await prisma.product.delete({
            where: {
                id: productId,
            },
        });

        return NextResponse.json({
            success: true,
            message:
                "Produk berhasil dihapus.",
        });
    } catch (error) {
        console.error(
            "DELETE PRODUCT ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Gagal menghapus produk.",
            },
            {
                status: 500,
            }
        );
    }
}