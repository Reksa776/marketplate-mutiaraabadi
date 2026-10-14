"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
    FiPackage,
    FiChevronRight,
    FiClock,
    FiTruck,
    FiCheckCircle,
    FiXCircle,
} from "react-icons/fi";
import toast from "react-hot-toast";

import OrderRecovery from "./OrderRecovery";
import {
    SHIPMENT_STAGE_LABELS,
    resolveShipmentStage,
} from "@/lib/tracking/tracking-page";

type OrderItem = {
    id: number;
    productName: string;
    variantName: string;
    price: string | number;
    quantity: number;
    subtotal: string | number;
};

type Order = {
    id: number;
    orderNumber: string;

    total: string | number;
    subtotal: string | number;
    shippingCost: string | number;

    status: string;
    paymentMethod: string;
    paymentStatus: string;

    shippingCourier: string | null;
    shippingService: string | null;

    /*
     * Shipment state the card renders. GET /api/orders projects
     * exactly these fields — never the address, phone, e-mail or
     * payment instruction — so the list cannot expose personal data a
     * customer card does not need.
     */
    shippingProvider: string | null;
    providerCourier: string | null;
    trackingNumber: string | null;
    shipmentStatus: string | null;

    createdAt: string;

    items: OrderItem[];
};

function formatRupiah(value: string | number) {
    return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

function formatDate(value: string) {
    return new Date(value).toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function statusLabel(status: string) {
    switch (status) {
        case "PENDING":
            return "Menunggu diproses";

        case "PAID":
            return "Sudah dibayar";

        case "PROCESSING":
            return "Sedang diproses";

        case "SHIPPED":
            return "Dikirim";

        case "COMPLETED":
            return "Selesai";

        case "CANCELLED":
            return "Dibatalkan";

        case "REFUND_PENDING":
            return "Refund diproses";

        default:
            return status;
    }
}

function paymentStatusLabel(status: string) {
    switch (status) {
        case "PAID":
            return "Sudah dibayar";

        case "UNPAID":
            return "Belum dibayar";

        case "PENDING":
            return "Menunggu pembayaran";

        case "FAILED":
            return "Pembayaran gagal";

        case "EXPIRED":
            return "Pembayaran kedaluwarsa";

        default:
            return status;
    }
}

function StatusIcon({
    status,
}: {
    status: string;
}) {
    if (status === "DELIVERED") {
        return <FiCheckCircle size={14} />;
    }

    if (status === "SHIPPED") {
        return <FiTruck size={14} />;
    }

    if (status === "CANCELLED") {
        return <FiXCircle size={14} />;
    }

    return <FiClock size={14} />;
}

function StatusBadge({
    status,
}: {
    status: string;
}) {
    const styles: Record<string, string> = {
        PENDING:
            "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",

        PROCESSING:
            "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",

        SHIPPED:
            "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200",

        DELIVERED:
            "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",

        CANCELLED:
            "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
    };

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold ${
                styles[status] ??
                "bg-gray-100 text-gray-600"
            }`}
        >
            <StatusIcon status={status} />
            {statusLabel(status)}
        </span>
    );
}

/**
 * Status pengiriman + nama ekspedisi + nomor resi (when there is one).
 *
 * The stage comes from the SAME pure helper the tracking page uses, so a
 * list card and the detail page can never describe one parcel
 * differently. No personal field (address, phone, e-mail) is read here —
 * the list endpoint does not even send them.
 */
function OrderShippingRow({
    order,
}: {
    order: Order;
}) {
    const courier =
        order.providerCourier ?? order.shippingCourier;

    return (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-gray-100 px-4 py-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
                <FiTruck
                    size={14}
                    aria-hidden="true"
                    className="shrink-0 text-gray-400"
                />

                <span className="text-xs font-semibold text-gray-700">
                    {
                        SHIPMENT_STAGE_LABELS[
                            resolveShipmentStage(order)
                        ]
                    }
                </span>

                {courier && (
                    <>
                        <span className="text-gray-300">•</span>

                        <span className="truncate text-xs text-gray-500 uppercase">
                            {courier}
                        </span>
                    </>
                )}
            </div>

            <p className="text-xs text-gray-500">
                {order.trackingNumber ? (
                    <>
                        Resi:{" "}
                        <span className="font-semibold break-all text-gray-800">
                            {order.trackingNumber}
                        </span>
                    </>
                ) : (
                    <span className="text-gray-400">
                        Resi belum tersedia
                    </span>
                )}
            </p>
        </div>
    );
}

function OrderItemRow({
    item,
}: {
    item: OrderItem;
}) {
    return (
        <div className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800">
                    {item.productName}
                </p>

                <p className="mt-1 text-xs text-gray-500">
                    {item.variantName}
                    <span className="mx-1.5 text-gray-300">
                        •
                    </span>
                    {item.quantity} barang
                </p>
            </div>

            <p className="shrink-0 text-sm font-semibold text-gray-800">
                {formatRupiah(item.subtotal)}
            </p>
        </div>
    );
}

export default function OrdersPage() {
    const [orders, setOrders] =
        useState<Order[]>([]);

    const [loading, setLoading] =
        useState(true);

    async function loadOrders() {
        try {
            setLoading(true);

            const response = await fetch(
                "/api/orders",
                {
                    method: "GET",
                    cache: "no-store",
                }
            );

            const data =
                await response.json();

            if (!response.ok) {
                toast.error(
                    data.message ??
                        "Gagal mengambil pesanan."
                );

                return;
            }

            setOrders(data.data ?? []);
        } catch (error) {
            console.error(error);

            toast.error(
                "Terjadi kesalahan saat mengambil pesanan."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadOrders();
    }, []);

    if (loading) {
        return (
            <main className="min-h-screen bg-[#f7f7f8]">
                <div className="mx-auto max-w-5xl px-4 py-7 sm:px-6">
                    <div className="h-7 w-40 animate-pulse rounded-md bg-gray-200" />

                    <div className="mt-2 h-4 w-64 animate-pulse rounded bg-gray-200" />

                    <div className="mt-7 space-y-3">
                        {[1, 2, 3].map(
                            (item) => (
                                <div
                                    key={item}
                                    className="h-52 animate-pulse rounded-xl border border-gray-100 bg-white"
                                />
                            )
                        )}
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-[#f7f7f8] pb-24">
            <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">

                {/* HEADER */}
                <header className="mb-7">
                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <h1 className="text-[22px] font-bold tracking-tight text-gray-900">
                                Pesanan Saya
                            </h1>

                            <p className="mt-1.5 text-sm text-gray-500">
                                Pantau status dan detail
                                pesananmu.
                            </p>
                        </div>

                        {orders.length > 0 && (
                            <span className="hidden text-xs text-gray-400 sm:block">
                                {orders.length} pesanan
                            </span>
                        )}
                    </div>
                </header>

                {/* EMPTY */}
                {orders.length === 0 ? (
                    <div className="border border-gray-200 bg-white px-6 py-16 text-center shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                            <FiPackage
                                size={28}
                                className="text-gray-400"
                            />
                        </div>

                        <h2 className="mt-5 text-base font-bold text-gray-900">
                            Belum ada pesanan
                        </h2>

                        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-gray-500">
                            Pesanan yang kamu buat
                            akan muncul di halaman
                            ini.
                        </p>

                        <Link
                            href="/products"
                            className="mt-6 inline-flex h-10 items-center rounded-lg bg-gray-900 px-5 text-sm font-semibold text-white transition hover:bg-gray-800"
                        >
                            Mulai Belanja
                        </Link>

                        {/*
                         * Lost the access token (cleared browser /
                         * new device)? Recover it with the order
                         * number + the checkout contact.
                         */}
                        <OrderRecovery />
                    </div>
                ) : (
                    <div className="space-y-3">
                        {orders.map(
                            (order) => (
                                <Link
                                    key={
                                        order.id
                                    }
                                    href={`/orders/${order.id}`}
                                    className="group block border border-gray-200 bg-white transition hover:border-gray-300 hover:shadow-[0_4px_18px_rgba(0,0,0,0.05)]"
                                >
                                    {/* ORDER HEADER */}
                                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3.5 sm:px-5">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gray-100">
                                                <FiPackage
                                                    size={14}
                                                    className="text-gray-600"
                                                />
                                            </span>

                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                                    <span className="text-xs font-bold text-gray-800">
                                                        {
                                                            order.orderNumber
                                                        }
                                                    </span>

                                                    <span className="text-gray-300">
                                                        /
                                                    </span>

                                                    <span className="text-xs text-gray-500">
                                                        {formatDate(
                                                            order.createdAt
                                                        )}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <StatusBadge
                                            status={
                                                order.status
                                            }
                                        />
                                    </div>

                                    {/* ITEMS */}
                                    <div className="px-4 sm:px-5">
                                        {order.items
                                            .slice(
                                                0,
                                                2
                                            )
                                            .map(
                                                (
                                                    item
                                                ) => (
                                                    <OrderItemRow
                                                        key={
                                                            item.id
                                                        }
                                                        item={
                                                            item
                                                        }
                                                    />
                                                )
                                            )}

                                        {order.items
                                            .length >
                                            2 && (
                                            <p className="border-t border-dashed border-gray-100 py-2.5 text-xs text-gray-400">
                                                +{" "}
                                                {order
                                                    .items
                                                    .length -
                                                    2}{" "}
                                                item
                                                lainnya
                                            </p>
                                        )}
                                    </div>

                                    {/* SHIPPING */}

                                    <OrderShippingRow
                                        order={order}
                                    />

                                    {/* FOOTER */}
                                    <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="text-xs text-gray-400">
                                                {
                                                    order.paymentMethod
                                                }
                                            </span>

                                            <span className="text-gray-300">
                                                •
                                            </span>

                                            <span
                                                className={`text-xs font-medium ${
                                                    order.paymentStatus ===
                                                    "PAID"
                                                        ? "text-emerald-600"
                                                        : order.paymentStatus ===
                                                            "FAILED"
                                                          ? "text-red-600"
                                                          : "text-gray-500"
                                                }`}
                                            >
                                                {paymentStatusLabel(
                                                    order.paymentStatus
                                                )}
                                            </span>
                                        </div>

                                        <div className="flex items-center justify-between gap-4 sm:justify-end">
                                            <div className="text-left sm:text-right">
                                                <p className="text-[11px] text-gray-400">
                                                    Total
                                                    pesanan
                                                </p>

                                                <p className="mt-0.5 text-base font-bold text-gray-900">
                                                    {formatRupiah(
                                                        order.total
                                                    )}
                                                </p>
                                            </div>

                                            {/*
                                             * The whole card is the link
                                             * (so a tap anywhere opens the
                                             * detail page); this is the
                                             * explicit affordance for it.
                                             */}
                                            <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition group-hover:border-gray-400 group-hover:bg-gray-50">
                                                Lihat Detail

                                                <FiChevronRight
                                                    size={14}
                                                    className="text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-gray-600"
                                                />
                                            </span>
                                        </div>
                                    </div>
                                </Link>
                            )
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}