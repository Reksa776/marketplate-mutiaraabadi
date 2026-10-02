import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    normalizeComparePrice,
    parseComparePrice,
} from "@/lib/price-display";

export async function GET(request: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
        }
        const role = (session.user as any).role;
        if (role !== "ADMIN") {
            return NextResponse.json({ success: false, message: "Akses ditolak." }, { status: 403 });
        }

        const params = request.nextUrl.searchParams;
        const page = Math.max(1, Number(params.get("page")) || 1);
        const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 50));
        const search = params.get("search") || undefined;
        const category = params.get("category") || undefined;

        // ==========================================
        // ARCHIVED FILTER
        // ==========================================
        //
        // ?archived=true   → only archived
        // ?archived=false  → only active
        // (omitted)        → all products (safe default for admin)

        const archivedParam = params.get("archived");

        const where: any = {};

        if (archivedParam === "true") {
            where.isArchived = true;
        } else if (archivedParam === "false") {
            where.isArchived = false;
        }
        // If not provided: no isArchived filter → show all
        if (search && search.trim()) {
            where.OR = [
                { name: { contains: search.trim() } },
                { slug: { contains: search.trim() } },
            ];
        }
        if (category && category.trim()) {
            where.category = category.trim();
        }

        const [products, total] = await Promise.all([
            prisma.product.findMany({
                where,
                include: { variants: true },
                orderBy: { createdAt: "desc" },
                take: limit,
                skip: (page - 1) * limit,
            }),
            prisma.product.count({ where }),
        ]);

        return NextResponse.json({
            success: true,
            data: {
                items: products,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (error) {
        console.error("GET /api/admin/products ERROR:", error);
        return NextResponse.json({ success: false, message: "Gagal mengambil data produk." }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json(
                {
                    message: "Unauthorized.",
                },
                {
                    status: 401,
                }
            );
        }

        const role = (session.user as any).role;

        if (role !== "ADMIN") {
            return NextResponse.json(
                {
                    message:
                        "Kamu tidak memiliki akses admin.",
                },
                {
                    status: 403,
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

        if (
            typeof name !== "string" ||
            !name.trim()
        ) {
            return NextResponse.json(
                {
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
                    message: "Slug wajib diisi.",
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
                        message:
                            `Harga variant "${variant.name}" tidak valid.`,
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
                        message:
                            `Stok variant "${variant.name}" tidak valid.`,
                    },
                    {
                        status: 400,
                    }
                );
            }

            /*
             * BERAT HARUS ANGKA BULAT
             */
            if (
                !Number.isInteger(weight) ||
                weight <= 0
            ) {
                return NextResponse.json(
                    {
                        message:
                            `Berat variant "${variant.name}" wajib diisi dalam gram.`,
                    },
                    {
                        status: 400,
                    }
                );
            }

            /*
             * comparePrice is DISPLAY-ONLY. Validate here so an
             * invalid value can never be persisted; it is never
             * used for checkout/payment/order totals.
             */
            const compareResult = parseComparePrice(
                variant.comparePrice,
                price
            );

            if (!compareResult.ok) {
                return NextResponse.json(
                    {
                        message: `Harga normal variant "${variant.name}" tidak valid. ${compareResult.message}`,
                    },
                    {
                        status: 400,
                    }
                );
            }
        }

        /*
         * CEK SLUG
         */
        const existingProduct =
            await prisma.product.findUnique({
                where: {
                    slug: slug.trim(),
                },
            });

        if (existingProduct) {
            return NextResponse.json(
                {
                    message:
                        "Slug produk sudah digunakan.",
                },
                {
                    status: 409,
                }
            );
        }

        /*
         * CREATE PRODUCT
         */
        const product =
            await prisma.product.create({
                data: {
                    name: name.trim(),

                    slug: slug.trim(),

                    description:
                        typeof description ===
                        "string"
                            ? description.trim() ||
                              null
                            : null,

                    category:
                        typeof category ===
                        "string"
                            ? category.trim() ||
                              null
                            : null,

                    image:
                        typeof image ===
                        "string"
                            ? image.trim() ||
                              null
                            : null,

                    bestseller:
                        Boolean(bestseller),

                    variants: {
                        create: variants.map(
                            (variant: any) => ({
                                name: variant.name.trim(),

                                price: Number(
                                    variant.price
                                ),

                                comparePrice:
                                    normalizeComparePrice(
                                        variant.comparePrice,
                                        Number(variant.price)
                                    ),

                                stock: Number(
                                    variant.stock
                                ),

                                weight: Number(
                                    variant.weight
                                ),

                                image:
                                    typeof variant.image ===
                                    "string"
                                        ? variant.image.trim() ||
                                          null
                                        : null,
                            })
                        ),
                    },
                },

                include: {
                    variants: true,
                },
            });

        return NextResponse.json(
            {
                success: true,
                message:
                    "Produk berhasil dibuat.",
                product,
            },
            {
                status: 201,
            }
        );
    } catch (error) {
        console.error(
            "CREATE PRODUCT ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Terjadi kesalahan saat membuat produk.",
            },
            {
                status: 500,
            }
        );
    }
}