import type { Metadata } from "next";

import { adminPageMetadata } from "@/lib/site-metadata";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

import {
    FiArrowLeft,
    FiEdit2,
    FiPlus,
} from "react-icons/fi";

import DeleteProductButton from "./DeleteProductButton";
import RealtimeProductFilter from "./RealtimeProductFilter";

export const metadata: Metadata = adminPageMetadata("Produk");

type SearchParams = {
    q?: string;
    category?: string;
    status?: string;
    stock?: string;
    sort?: string;
};

type Props = {
    searchParams: Promise<SearchParams>;
};

export default async function AdminProductsPage({
    searchParams,
}: Props) {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = (session.user as any).role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    const params = await searchParams;

    const q = params.q?.trim() ?? "";
    const category =
        params.category ?? "ALL";
    const status =
        params.status ?? "ALL";
    const stock =
        params.stock ?? "ALL";
    const sort =
        params.sort ?? "NEWEST";

    /*
     * ==========================================
     * CATEGORY
     * ==========================================
     */

    const categoryRows =
        await prisma.product.findMany({
            where: {
                category: {
                    not: null,
                },
            },
            select: {
                category: true,
            },
            distinct: ["category"],
            orderBy: {
                category: "asc",
            },
        });

    const categories = categoryRows
        .map((item) => item.category)
        .filter(
            (item): item is string =>
                Boolean(item)
        );

    /*
     * ==========================================
     * WHERE
     * ==========================================
     */

    const where: any = {};

    if (q) {
        where.OR = [
            {
                name: {
                    contains: q,
                },
            },
            {
                slug: {
                    contains: q,
                },
            },
        ];
    }

    if (
        category !== "ALL" &&
        category
    ) {
        where.category = category;
    }

    if (status === "BESTSELLER") {
        where.bestseller = true;
    }

    if (status === "NORMAL") {
        where.bestseller = false;
    }

    /*
     * ==========================================
     * DEFAULT ORDER
     * ==========================================
     */

    let orderBy: any = {
        createdAt: "desc",
    };

    if (sort === "OLDEST") {
        orderBy = {
            createdAt: "asc",
        };
    }

    /*
     * ==========================================
     * PRODUCTS
     * ==========================================
     */

    const products =
        await prisma.product.findMany({
            where,
            orderBy,
            include: {
                variants: {
                    orderBy: {
                        price: "asc",
                    },
                },
            },
        });

    /*
     * ==========================================
     * STOCK FILTER
     * ==========================================
     */

    const filteredProducts =
        products.filter((product) => {
            const totalStock =
                product.variants.reduce(
                    (total, variant) =>
                        total + variant.stock,
                    0
                );

            if (stock === "AVAILABLE") {
                return totalStock > 5;
            }

            if (stock === "LOW") {
                return (
                    totalStock > 0 &&
                    totalStock <= 5
                );
            }

            if (stock === "EMPTY") {
                return totalStock === 0;
            }

            return true;
        });

    /*
     * ==========================================
     * PRICE SORT
     * ==========================================
     */

    if (
        sort === "PRICE_LOW" ||
        sort === "PRICE_HIGH"
    ) {
        filteredProducts.sort(
            (a, b) => {
                const priceA =
                    a.variants.length > 0
                        ? Number(
                              a.variants[0].price
                          )
                        : Infinity;

                const priceB =
                    b.variants.length > 0
                        ? Number(
                              b.variants[0].price
                          )
                        : Infinity;

                return sort === "PRICE_LOW"
                    ? priceA - priceB
                    : priceB - priceA;
            }
        );
    }

    /*
     * ==========================================
     * STOCK SORT
     * ==========================================
     */

    if (sort === "STOCK_HIGH") {
        filteredProducts.sort(
            (a, b) => {
                const stockA =
                    a.variants.reduce(
                        (total, variant) =>
                            total + variant.stock,
                        0
                    );

                const stockB =
                    b.variants.reduce(
                        (total, variant) =>
                            total + variant.stock,
                        0
                    );

                return stockB - stockA;
            }
        );
    }

    return (
        <main className="min-h-screen bg-[#f8f8f7] px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
            <div className="mx-auto max-w-7xl">

                {/* HEADER */}

                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                        <Link
                            href="/admin"
                            className="flex h-9 w-9 shrink-0 items-center justify-center border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:text-gray-800"
                        >
                            <FiArrowLeft
                                size={17}
                            />
                        </Link>

                        <div>
                            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-gray-900">
                                Produk
                            </h1>

                            <p className="mt-1 text-[13px] text-gray-500">
                                Kelola produk dan
                                variant toko.
                            </p>
                        </div>
                    </div>

                    <Link
                        href="/admin/products/new"
                        className="inline-flex h-10 items-center justify-center gap-2 bg-gray-900 px-4 text-[13px] font-medium text-white transition hover:bg-gray-800"
                    >
                        <FiPlus size={17} />
                        Tambah Produk
                    </Link>
                </div>

                {/* REALTIME FILTER */}

                <RealtimeProductFilter
                    categories={
                        categories
                    }
                />

                {/* RESULT */}

                <div className="mb-4 flex items-center justify-between">
                    <p className="text-[12px] text-gray-500">
                        <span className="font-semibold text-gray-800">
                            {
                                filteredProducts.length
                            }
                        </span>{" "}
                        produk
                    </p>

                    {q && (
                        <p className="text-[12px] text-gray-400">
                            Hasil untuk{" "}
                            <span className="font-medium text-gray-700">
                                "{q}"
                            </span>
                        </p>
                    )}
                </div>

                {/* EMPTY */}

                {filteredProducts.length ===
                0 ? (
                    <div className="border border-gray-200 bg-white px-6 py-20 text-center">
                        <h2 className="text-base font-semibold text-gray-800">
                            Produk tidak ditemukan
                        </h2>

                        <p className="mt-2 text-[13px] text-gray-500">
                            Tidak ada produk yang
                            sesuai dengan filter
                            saat ini.
                        </p>

                        <Link
                            href="/admin/products"
                            className="mt-5 inline-flex h-10 items-center border border-gray-200 px-4 text-[13px] font-medium text-gray-700 transition hover:bg-gray-50"
                        >
                            Reset Filter
                        </Link>
                    </div>
                ) : (
                    <>
                        {/* MOBILE */}

                        <div className="space-y-3 md:hidden">
                            {filteredProducts.map(
                                (product) => {
                                    const lowestPrice =
                                        product
                                            .variants
                                            .length >
                                        0
                                            ? product
                                                  .variants[0]
                                                  .price
                                            : null;

                                    const totalStock =
                                        product.variants.reduce(
                                            (
                                                total,
                                                variant
                                            ) =>
                                                total +
                                                variant.stock,
                                            0
                                        );

                                    return (
                                        <div
                                            key={
                                                product.id
                                            }
                                            className="border border-gray-200 bg-white"
                                        >
                                            <div className="p-4">

                                                <div className="flex gap-3">
                                                    <div className="h-[68px] w-[68px] shrink-0 overflow-hidden bg-gray-100">
                                                        {product.image ? (
                                                            <img
                                                                src={
                                                                    product.image
                                                                }
                                                                alt={
                                                                    product.name
                                                                }
                                                                className="h-full w-full object-cover"
                                                            />
                                                        ) : (
                                                            <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                                                                No Image
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <h2 className="truncate text-[14px] font-semibold text-gray-900">
                                                                    {
                                                                        product.name
                                                                    }
                                                                </h2>

                                                                <p className="mt-1 text-[12px] text-gray-500">
                                                                    {
                                                                        product.category
                                                                    }
                                                                </p>
                                                            </div>

                                                            {product.bestseller && (
                                                                <span className="shrink-0 text-[10px] font-medium text-rose-600">
                                                                    Bestseller
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-3 border-t border-gray-100 pt-3">
                                                    <div>
                                                        <p className="text-[11px] text-gray-400">
                                                            Harga
                                                        </p>

                                                        <p className="mt-1 text-[13px] font-semibold text-gray-900">
                                                            {lowestPrice
                                                                ? `Rp ${Number(
                                                                      lowestPrice
                                                                  ).toLocaleString(
                                                                      "id-ID"
                                                                  )}`
                                                                : "-"}
                                                        </p>
                                                    </div>

                                                    <div className="border-l border-gray-100 pl-3">
                                                        <p className="text-[11px] text-gray-400">
                                                            Variant
                                                        </p>

                                                        <p className="mt-1 text-[13px] font-semibold text-gray-900">
                                                            {
                                                                product
                                                                    .variants
                                                                    .length
                                                            }
                                                        </p>
                                                    </div>

                                                    <div className="border-l border-gray-100 pl-3">
                                                        <p className="text-[11px] text-gray-400">
                                                            Stok
                                                        </p>

                                                        <p
                                                            className={`mt-1 text-[13px] font-semibold ${
                                                                totalStock ===
                                                                0
                                                                    ? "text-red-600"
                                                                    : totalStock <=
                                                                        5
                                                                      ? "text-amber-600"
                                                                      : "text-gray-900"
                                                            }`}
                                                        >
                                                            {
                                                                totalStock
                                                            }
                                                        </p>
                                                    </div>
                                                </div>

                                                <div className="mt-4 flex border-t border-gray-100 pt-3">
                                                    <Link
                                                        href={`/admin/products/${product.id}/edit`}
                                                        className="flex h-9 flex-1 items-center justify-center gap-1.5 border border-gray-200 text-[12px] font-medium text-gray-700 transition hover:bg-gray-50"
                                                    >
                                                        <FiEdit2
                                                            size={
                                                                14
                                                            }
                                                        />
                                                        Edit
                                                    </Link>

                                                    <div className="ml-2">
                                                        <DeleteProductButton
                                                            productId={
                                                                product.id
                                                            }
                                                            productName={
                                                                product.name
                                                            }
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>

                        {/* DESKTOP */}

                        <div className="hidden border border-gray-200 bg-white md:block">

                            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
                                <div>
                                    <h2 className="text-[14px] font-semibold text-gray-900">
                                        Daftar Produk
                                    </h2>

                                    <p className="mt-0.5 text-[12px] text-gray-500">
                                        {
                                            filteredProducts.length
                                        }{" "}
                                        produk
                                    </p>
                                </div>

                                <span className="text-[12px] text-gray-400">
                                    {sort ===
                                    "NEWEST"
                                        ? "Terbaru"
                                        : sort ===
                                            "OLDEST"
                                          ? "Terlama"
                                          : sort ===
                                              "PRICE_LOW"
                                            ? "Harga terendah"
                                            : sort ===
                                                "PRICE_HIGH"
                                              ? "Harga tertinggi"
                                              : "Stok terbanyak"}
                                </span>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[1000px] text-left">
                                    <thead className="border-b border-gray-200 bg-gray-50">
                                        <tr>
                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Produk
                                            </th>

                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Kategori
                                            </th>

                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Variant
                                            </th>

                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Harga
                                            </th>

                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Stok
                                            </th>

                                            <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Status
                                            </th>

                                            <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                                                Aksi
                                            </th>
                                        </tr>
                                    </thead>

                                    <tbody className="divide-y divide-gray-100">
                                        {filteredProducts.map(
                                            (
                                                product
                                            ) => {
                                                const lowestPrice =
                                                    product
                                                        .variants
                                                        .length >
                                                    0
                                                        ? product
                                                              .variants[0]
                                                              .price
                                                        : null;

                                                const totalStock =
                                                    product.variants.reduce(
                                                        (
                                                            total,
                                                            variant
                                                        ) =>
                                                            total +
                                                            variant.stock,
                                                        0
                                                    );

                                                return (
                                                    <tr
                                                        key={
                                                            product.id
                                                        }
                                                        className="transition-colors hover:bg-gray-50"
                                                    >
                                                        <td className="px-5 py-4">
                                                            <div className="flex items-center gap-3">
                                                                <div className="h-11 w-11 shrink-0 overflow-hidden bg-gray-100">
                                                                    {product.image ? (
                                                                        <img
                                                                            src={
                                                                                product.image
                                                                            }
                                                                            alt={
                                                                                product.name
                                                                            }
                                                                            className="h-full w-full object-cover"
                                                                        />
                                                                    ) : (
                                                                        <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                                                                            No Image
                                                                        </div>
                                                                    )}
                                                                </div>

                                                                <div className="min-w-0">
                                                                    <p className="max-w-xs truncate text-[13px] font-semibold text-gray-900">
                                                                        {
                                                                            product.name
                                                                        }
                                                                    </p>

                                                                    <p className="mt-0.5 max-w-xs truncate text-[11px] text-gray-400">
                                                                        /products/
                                                                        {
                                                                            product.slug
                                                                        }
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            <span className="text-[12px] text-gray-600">
                                                                {
                                                                    product.category
                                                                }
                                                            </span>
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            <div className="flex max-w-[260px] flex-wrap gap-x-2 gap-y-1">
                                                                {product.variants.map(
                                                                    (
                                                                        variant
                                                                    ) => (
                                                                        <span
                                                                            key={
                                                                                variant.id
                                                                            }
                                                                            className="text-[11px] text-gray-600"
                                                                        >
                                                                            {
                                                                                variant.name
                                                                            }
                                                                        </span>
                                                                    )
                                                                )}
                                                            </div>
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            <p className="whitespace-nowrap text-[13px] font-semibold text-gray-900">
                                                                {lowestPrice
                                                                    ? `Rp ${Number(
                                                                          lowestPrice
                                                                      ).toLocaleString(
                                                                          "id-ID"
                                                                      )}`
                                                                    : "-"}
                                                            </p>

                                                            <p className="mt-0.5 text-[10px] text-gray-400">
                                                                harga mulai
                                                            </p>
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            <p
                                                                className={`text-[13px] font-semibold ${
                                                                    totalStock ===
                                                                    0
                                                                        ? "text-red-600"
                                                                        : totalStock <=
                                                                            5
                                                                          ? "text-amber-600"
                                                                          : "text-gray-900"
                                                                }`}
                                                            >
                                                                {
                                                                    totalStock
                                                                }
                                                            </p>

                                                            <p className="mt-0.5 text-[10px] text-gray-400">
                                                                total stok
                                                            </p>
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            {product.bestseller ? (
                                                                <span className="text-[12px] font-medium text-rose-600">
                                                                    Bestseller
                                                                </span>
                                                            ) : (
                                                                <span className="text-[12px] text-gray-400">
                                                                    Normal
                                                                </span>
                                                            )}
                                                        </td>

                                                        <td className="px-5 py-4">
                                                            <div className="flex items-center justify-end gap-1.5">
                                                                <Link
                                                                    href={`/admin/products/${product.id}/edit`}
                                                                    className="inline-flex h-8 items-center gap-1.5 border border-gray-200 px-2.5 text-[11px] font-medium text-gray-700 transition hover:border-gray-300 hover:bg-gray-50"
                                                                >
                                                                    <FiEdit2
                                                                        size={
                                                                            13
                                                                        }
                                                                    />
                                                                    Edit
                                                                </Link>

                                                                <DeleteProductButton
                                                                    productId={
                                                                        product.id
                                                                    }
                                                                    productName={
                                                                        product.name
                                                                    }
                                                                />
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            }
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </main>
    );
}