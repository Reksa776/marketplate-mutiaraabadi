"use client";

import { useEffect, useMemo, useState } from "react";

import ProductCard from "./ProductCard";
import ProductSkeleton from "../skeletons/ProductSkeleton";

import { useProduct } from "./ProductContext";

type ProductVariant = {
    id: number;
    name: string;
    price: string | number;
    stock: number;
    image: string | null;
};

type Product = {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    image: string | null;
    category: string | null;
    rating: number;
    sold: number;
    bestseller: boolean;
    variants: ProductVariant[];
};

type ProductsResponse = {
    success: boolean;
    authenticated: boolean;
    products: Product[];
    message?: string;
};

export default function ProductGrid() {
    const {
        search,
        category,
    } = useProduct();

    const [products, setProducts] = useState<Product[]>(
        []
    );

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState("");

    async function loadProducts() {
        try {
            setLoading(true);
            setError("");

            const response = await fetch(
                "/api/products",
                {
                    method: "GET",
                    cache: "no-store",
                }
            );

            const data: ProductsResponse =
                await response.json();

            // console.log(
            //     "PRODUCT AUTH STATUS:",
            //     data.authenticated
            // );

            // console.log(
            //     "PRODUCT RESPONSE:",
            //     data
            // );

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal mengambil produk."
                );
            }

            /*
             * Pastikan setiap product mempunyai
             * variants berupa array.
             *
             * Ini mencegah error:
             * product.variants is undefined
             */
            const safeProducts =
                Array.isArray(data.products)
                    ? data.products.map(
                          (product) => ({
                              ...product,
                              variants:
                                  Array.isArray(
                                      product.variants
                                  )
                                      ? product.variants
                                      : [],
                          })
                      )
                    : [];

            setProducts(safeProducts);
        } catch (error) {
            console.error(
                "LOAD PRODUCTS ERROR:",
                error
            );

            setError(
                error instanceof Error
                    ? error.message
                    : "Gagal memuat produk."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadProducts();
    }, []);

    const filteredProducts = useMemo(() => {
        return products.filter((product) => {
            const matchSearch =
                product.name
                    .toLowerCase()
                    .includes(
                        search.toLowerCase()
                    );

            const matchCategory =
                category === "Semua" ||
                product.category === category;

            return (
                matchSearch &&
                matchCategory
            );
        });
    }, [
        products,
        search,
        category,
    ]);

    if (loading) {
        return (
            <section className="mx-auto max-w-7xl px-5 py-8">
                <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
                    {Array.from({
                        length: 8,
                    }).map((_, index) => (
                        <ProductSkeleton
                            key={index}
                        />
                    ))}
                </div>
            </section>
        );
    }

    if (error) {
        return (
            <section className="mx-auto max-w-7xl px-5 py-10">
                <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-center">
                    <h2 className="font-semibold text-red-700">
                        Gagal memuat produk
                    </h2>

                    <p className="mt-2 text-sm text-red-600">
                        {error}
                    </p>

                    <button
                        type="button"
                        onClick={loadProducts}
                        className="mt-5 rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800"
                    >
                        Coba Lagi
                    </button>
                </div>
            </section>
        );
    }

    return (
        <section className="mx-auto max-w-7xl px-5 pb-32 pt-8">
            {/* HEADER */}
            <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-gray-900">
                        Semua Produk
                    </h2>

                    <p className="mt-1 text-sm text-gray-500">
                        Jelajahi seluruh katalog produk kami.
                    </p>
                </div>
            </div>

            {/* PRODUCTS */}
            {filteredProducts.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center rounded-3xl border border-dashed border-gray-300 bg-white px-5 text-center">
                    <p className="text-lg font-semibold text-gray-700">
                        Produk tidak ditemukan
                    </p>

                    <p className="mt-2 text-sm text-gray-500">
                        Coba gunakan kata kunci atau
                        kategori lain.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
                    {filteredProducts.map(
                        (product) => (
                            <ProductCard
                                key={product.id}
                                product={product}
                            />
                        )
                    )}
                </div>
            )}
        </section>
    );
}