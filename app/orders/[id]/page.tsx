"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
    useEffect,
    useState,
} from "react";
import toast from "react-hot-toast";
import { useDialog } from "@/components/ui/Dialog";
type OrderItem = {
    id: number;
    productId: number;
    variantId: number;

    productName: string;
    variantName: string;

    price: number;
    quantity: number;
    subtotal: number;

    product: {
        id: number;
        name: string;
        slug: string;
        image: string | null;
    } | null;

    variant: {
        id: number;
        name: string;
        image: string | null;
        weight: number;
    } | null;
};

type Order = {
    id: number;
    orderNumber: string;

    recipientName: string;
    phone: string;
    address: string;

    note: string | null;

    city: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;

    latitude: number | null;
    longitude: number | null;

    shippingCourier: string | null;
    shippingService: string | null;

    trackingNumber: string | null;
    trackingUrl: string | null;
    paymentStatus: string;
    paidAt: string | null;

    subtotal: number;
    shippingCost: number;
    total: number;

    status: string;
    paymentMethod: string;

    createdAt: string;
    updatedAt: string;

    items: OrderItem[];
};
type TrackingManifest = {
    manifest_code: string;
    manifest_description: string;
    manifest_date: string;
    manifest_time: string;
    city_name: string;
    title: string;
};

type TrackingSummary = {
    courier_code: string;
    courier_name: string;
    waybill_number: string;
    service_code: string;
    waybill_date: string;
    shipper_name?: string;
    receiver_name?: string;
    origin: string;
    destination: string;
    status: string;
};

type TrackingDeliveryStatus = {
    status: string;
    pod_receiver?: string;
    pod_date?: string;
    pod_time?: string;
};

type TrackingData = {
    summary?: TrackingSummary;
    details?: unknown;
    deliveryStatus?: TrackingDeliveryStatus;
    manifest: TrackingManifest[];
};



function formatRupiah(value: number) {
    return `Rp ${Number(value || 0).toLocaleString(
        "id-ID"
    )}`;
}

function formatDate(value: string) {
    return new Date(value).toLocaleString(
        "id-ID",
        {
            dateStyle: "long",
            timeStyle: "short",
        }
    );
}

function getStatusLabel(status: string) {
    const labels: Record<string, string> = {
        PENDING: "Menunggu Pembayaran",
        PAID: "Sudah Dibayar",
        PROCESSING: "Sedang Diproses",
        SHIPPED: "Sedang Dikirim",
        COMPLETED: "Selesai",
        CANCELLED: "Dibatalkan",
        REFUND_PENDING: "Refund Diproses",
    };

    return (
        labels[status] ??
        status
    );
}

function getPaymentLabel(
    paymentMethod: string
) {
    const labels: Record<string, string> = {
        COD: "Cash on Delivery",
        BANK_TRANSFER:
            "Transfer Bank",
        E_WALLET: "E-Wallet",
    };

    return (
        labels[paymentMethod] ??
        paymentMethod
    );
}

function getStatusClass(status: string) {
    switch (status) {
        case "COMPLETED":
            return "bg-green-100 text-green-700";

        case "CANCELLED":
            return "bg-red-100 text-red-700";

        case "SHIPPED":
            return "bg-blue-100 text-blue-700";

        case "PAID":
        case "PROCESSING":
            return "bg-yellow-100 text-yellow-700";

        case "REFUND_PENDING":
            return "bg-orange-100 text-orange-700";

        default:
            return "bg-gray-100 text-gray-700";
    }
}

export default function OrderDetailPage() {
    const params = useParams();
    const dialog = useDialog();
    const [tracking, setTracking] =
        useState<any>(null);

    const [trackingLoading, setTrackingLoading] =
        useState(false);
    const id =
        Array.isArray(params.id)
            ? params.id[0]
            : params.id;

    const [order, setOrder] =
        useState<Order | null>(null);

    const [loading, setLoading] =
        useState(true);

    // Guards the "Bayar Lagi" button: a second click while a repayment
    // is in flight must never create a duplicate payment attempt.
    const [repaying, setRepaying] =
        useState(false);
    useEffect(() => {
        if (!order?.id) {
            return;
        }

        if (!order.trackingNumber) {
            setTracking(null);
            return;
        }

        loadTracking();
    }, [
        order?.id,
        order?.trackingNumber,
    ]);
    async function loadTracking() {
        if (!order?.id) {
            return;
        }

        if (!order.trackingNumber) {
            setTracking(null);
            return;
        }

        try {
            setTrackingLoading(true);

            const response =
                await fetch(
                    `/api/orders/${order.id}/tracking`,
                    {
                        method: "GET",
                        cache: "no-store",
                    }
                );

            const result =
                await response.json();

            console.log(
                "TRACKING RESPONSE FROM APP:",
                result
            );

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ??
                    "Gagal mengambil tracking."
                );
            }

            /*
             * API kita sekarang:
             *
             * result.data.summary
             * result.data.deliveryStatus
             * result.data.manifest
             */

            setTracking({
                summary:
                    result.data?.summary ??
                    undefined,

                details:
                    result.data?.details ??
                    undefined,

                deliveryStatus:
                    result.data
                        ?.deliveryStatus ??
                    undefined,

                manifest:
                    Array.isArray(
                        result.data?.manifest
                    )
                        ? result.data
                            .manifest
                        : [],
            });
        } catch (error) {
            console.error(
                "LOAD TRACKING ERROR:",
                error
            );

            setTracking(null);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil tracking."
            );
        } finally {
            setTrackingLoading(false);
        }
    }

    async function loadOrder() {
        if (!id) {
            return;
        }

        try {
            setLoading(true);

            const response =
                await fetch(
                    `/api/orders/${id}`,
                    {
                        cache: "no-store",
                    }
                );

            const result =
                await response.json();

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ||
                    "Gagal mengambil pesanan."
                );
            }

            setOrder(result.data);
        } catch (error) {
            console.error(
                "LOAD ORDER ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil pesanan."
            );
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadOrder();
    }, [id]);

    async function handleRepay() {
        if (!order || repaying) {
            return;
        }

        try {
            setRepaying(true);

            const response = await fetch(
                `/api/orders/${order.id}/repay`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        paymentMethod:
                            order.paymentMethod === "COD"
                                ? "BANK_TRANSFER"
                                : order.paymentMethod,
                    }),
                }
            );

            const result =
                await response.json();

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ||
                    "Gagal memproses pembayaran ulang."
                );
            }

            /*
             * ==========================================
             * HALAMAN PEMBAYARAN TOKO SENDIRI
             * ==========================================
             *
             * Selalu menuju halaman pembayaran milik toko:
             * pakai URL internal dari server bila ada, kalau tidak
             * diturunkan dari order id. URL provider (iPaymu) TIDAK
             * pernah dipakai — customer tidak boleh keluar dari toko.
             */

            const serverUrl =
                typeof result.data?.paymentUrl ===
                "string"
                    ? result.data.paymentUrl
                    : "";

            const paymentPageUrl =
                serverUrl.startsWith(
                    "/checkout/payment/"
                )
                    ? serverUrl
                    : `/checkout/payment/${order.id}`;

            toast.success(
                "Mengarahkan ke halaman pembayaran..."
            );

            window.location.assign(
                paymentPageUrl
            );
        } catch (error) {
            setRepaying(false);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal memproses pembayaran ulang."
            );
        }
    }

    if (loading) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-5xl">
                    <div className="rounded-3xl border border-gray-200 bg-white p-8">
                        Memuat detail pesanan...
                    </div>
                </div>
            </main>
        );
    }

    if (!order) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-5xl">
                    <div className="rounded-3xl border border-gray-200 bg-white p-8 text-center">
                        <h1 className="text-xl font-bold">
                            Pesanan tidak ditemukan
                        </h1>

                        <p className="mt-2 text-sm text-gray-500">
                            Pesanan yang kamu cari
                            tidak tersedia.
                        </p>

                        <Link
                            href="/orders"
                            className="mt-6 inline-flex rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700"
                        >
                            Kembali ke Pesanan
                        </Link>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-5xl">

                {/* HEADER */}

                <div className="mb-6">
                    <Link
                        href="/orders"
                        className="text-sm text-gray-500 hover:text-gray-900"
                    >
                        ← Kembali ke Pesanan
                    </Link>

                    <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900">
                                Detail Pesanan
                            </h1>

                            <p className="mt-1 text-sm text-gray-500">
                                {order.orderNumber}
                            </p>
                        </div>

                        <span
                            className={`inline-flex w-fit rounded-full px-4 py-2 text-sm font-semibold ${getStatusClass(
                                order.status
                            )}`}
                        >
                            {getStatusLabel(
                                order.status
                            )}
                        </span>
                    </div>

                    {/* ACTION BUTTONS */}
                    <div className="mt-4 flex flex-wrap gap-3">
                        {/* BAYAR LAGI — for failed/expired/pending payment */}
                        {(
                            (order.paymentStatus === "FAILED" ||
                                order.paymentStatus === "EXPIRED" ||
                                (order.paymentStatus === "PENDING" &&
                                    order.status === "PENDING")) &&
                            order.status !== "COMPLETED" &&
                            order.status !== "SHIPPED" &&
                            order.status !== "REFUND_PENDING"
                        ) && (
                            <button
                                onClick={handleRepay}
                                disabled={repaying}
                                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {repaying
                                    ? "Memproses..."
                                    : "💳 Bayar Lagi"}
                            </button>
                        )}

                        {/* MINTA REFUND — for paid orders */}
                        {order.paymentStatus === "PAID" &&
                            (order.status === "PAID" ||
                                order.status === "PROCESSING") && (
                            <button
                                onClick={async () => {
                                    if (
                                        !(await dialog.confirm({
                                            title: "Minta Refund",
                                            message: "Ajukan permintaan refund untuk pesanan ini?",
                                            variant: "warning",
                                            confirmText: "Ya, Ajukan",
                                        }))
                                    ) {
                                        return;
                                    }

                                    // Collect destination bank info (required —
                                    // admin needs it to execute the transfer).
                                    const bankName =
                                        await dialog.prompt({
                                            title: "Nama Bank Tujuan",
                                            message: "Masukkan nama bank tujuan refund (contoh: BCA):",
                                            placeholder: "Nama bank",
                                            required: true,
                                        });

                                    if (!bankName) return;

                                    const bankAccountName =
                                        await dialog.prompt({
                                            title: "Nama Pemilik Rekening",
                                            message: "Masukkan nama pemilik rekening (atas nama):",
                                            placeholder: "Atas nama",
                                            required: true,
                                        });

                                    if (!bankAccountName) return;

                                    const bankAccountNumber =
                                        await dialog.prompt({
                                            title: "Nomor Rekening",
                                            message: "Masukkan nomor rekening tujuan:",
                                            placeholder: "Nomor rekening",
                                            required: true,
                                        });

                                    if (!bankAccountNumber) return;

                                    try {
                                        const response = await fetch(
                                            `/api/orders/${order.id}/refund`,
                                            {
                                                method: "POST",
                                                headers: {
                                                    "Content-Type":
                                                        "application/json",
                                                },
                                                body: JSON.stringify({
                                                    bankName,
                                                    bankAccountName,
                                                    bankAccountNumber,
                                                }),
                                            }
                                        );

                                        const result =
                                            await response.json();

                                        if (
                                            !response.ok ||
                                            !result.success
                                        ) {
                                            throw new Error(
                                                result.message ||
                                                    "Gagal mengajukan refund."
                                            );
                                        }

                                        toast.success(
                                            "Permintaan refund berhasil diajukan!"
                                        );

                                        loadOrder();
                                    } catch (error) {
                                        toast.error(
                                            error instanceof Error
                                                ? error.message
                                                : "Gagal mengajukan refund."
                                        );
                                    }
                                }}
                                className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-white px-5 py-3 text-sm font-semibold text-red-600 hover:bg-red-50"
                            >
                                🔄 Minta Refund
                            </button>
                        )}

                        {/* REFUND PENDING STATUS */}
                        {order.status === "REFUND_PENDING" && (
                            <div className="inline-flex items-center gap-2 rounded-xl bg-yellow-50 px-5 py-3 text-sm font-semibold text-yellow-700">
                                ⏳ Refund sedang diproses...
                            </div>
                        )}

                        {/* CANCEL BUTTON — for pending unpaid orders */}
                        {order.paymentStatus === "PENDING" &&
                            order.status === "PENDING" && (
                            <button
                                onClick={async () => {
                                    if (
                                        !(await dialog.confirm({
                                            title: "Batalkan Pesanan",
                                            message: "Batalkan pesanan ini?",
                                            variant: "danger",
                                            confirmText: "Ya, Batalkan",
                                        }))
                                    ) {
                                        return;
                                    }

                                    try {
                                        const response = await fetch(
                                            `/api/orders/${order.id}/cancel`,
                                            {
                                                method: "POST",
                                            }
                                        );

                                        const result =
                                            await response.json();

                                        if (
                                            !response.ok ||
                                            !result.success
                                        ) {
                                            throw new Error(
                                                result.message ||
                                                    "Gagal membatalkan pesanan."
                                            );
                                        }

                                        toast.success(
                                            "Pesanan berhasil dibatalkan."
                                        );

                                        loadOrder();
                                    } catch (error) {
                                        toast.error(
                                            error instanceof Error
                                                ? error.message
                                                : "Gagal membatalkan pesanan."
                                        );
                                    }
                                }}
                                className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50"
                            >
                                ✕ Batalkan Pesanan
                            </button>
                        )}
                    </div>
                </div>

                <div className="space-y-6">

                    {/* ORDER INFO */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold">
                            Informasi Pesanan
                        </h2>

                        <div className="mt-5 grid gap-5 sm:grid-cols-2">
                            <div>
                                <p className="text-xs text-gray-500">
                                    Nomor Pesanan
                                </p>

                                <p className="mt-1 font-semibold">
                                    {order.orderNumber}
                                </p>
                            </div>

                            <div>
                                <p className="text-xs text-gray-500">
                                    Tanggal Pesanan
                                </p>

                                <p className="mt-1 font-semibold">
                                    {formatDate(
                                        order.createdAt
                                    )}
                                </p>
                            </div>

                            <div>
                                <p className="text-xs text-gray-500">
                                    Pembayaran
                                </p>

                                <p className="mt-1 font-semibold">
                                    {getPaymentLabel(
                                        order.paymentMethod
                                    )}
                                </p>
                            </div>

                            <div>
                                <p className="text-xs text-gray-500">
                                    Pengiriman
                                </p>

                                <p className="mt-1 font-semibold">
                                    {order.shippingCourier
                                        ? order.shippingCourier.toUpperCase()
                                        : "-"}
                                </p>

                                {order.shippingService && (
                                    <p className="mt-1 text-sm text-gray-500">
                                        {
                                            order.shippingService
                                        }
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* ADDRESS */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold">
                            Alamat Pengiriman
                        </h2>

                        <div className="mt-5">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold">
                                    {
                                        order.recipientName
                                    }
                                </p>

                                <span className="text-sm text-gray-400">
                                    |
                                </span>

                                <p className="text-sm text-gray-600">
                                    {order.phone}
                                </p>
                            </div>

                            <p className="mt-3 whitespace-pre-line text-sm leading-6 text-gray-700">
                                {order.address}
                            </p>

                            {(order.district ||
                                order.city ||
                                order.province ||
                                order.postalCode) && (
                                    <p className="mt-2 text-sm leading-6 text-gray-500">
                                        {[
                                            order.district,
                                            order.city,
                                            order.province,
                                            order.postalCode,
                                        ]
                                            .filter(
                                                Boolean
                                            )
                                            .join(
                                                ", "
                                            )}
                                    </p>
                                )}

                            {order.note && (
                                <div className="mt-4 rounded-2xl bg-gray-50 p-4">
                                    <p className="text-xs font-semibold text-gray-500">
                                        Catatan
                                    </p>

                                    <p className="mt-1 text-sm text-gray-700">
                                        {order.note}
                                    </p>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* PRODUCTS */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold">
                            Produk
                        </h2>

                        <div className="mt-5 divide-y divide-gray-100">
                            {order.items.map(
                                (item) => {
                                    const image =
                                        item.variant
                                            ?.image ||
                                        item.product
                                            ?.image ||
                                        null;

                                    return (
                                        <div
                                            key={
                                                item.id
                                            }
                                            className="flex gap-4 py-5 first:pt-0 last:pb-0"
                                        >
                                            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                                                {image ? (
                                                    <img
                                                        src={
                                                            image
                                                        }
                                                        alt={
                                                            item.productName
                                                        }
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
                                                        No Image
                                                    </div>
                                                )}
                                            </div>

                                            <div className="min-w-0 flex-1">
                                                <h3 className="font-semibold text-gray-900">
                                                    {
                                                        item.productName
                                                    }
                                                </h3>

                                                <p className="mt-1 text-sm text-gray-500">
                                                    {
                                                        item.variantName
                                                    }
                                                </p>

                                                <p className="mt-2 text-sm text-gray-500">
                                                    {item.quantity} ×{" "}
                                                    {formatRupiah(
                                                        item.price
                                                    )}
                                                </p>
                                            </div>

                                            <div className="shrink-0 text-right font-semibold text-gray-900">
                                                {formatRupiah(
                                                    item.subtotal
                                                )}
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </section>
                    {/* TRACKING */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6">
                        {/* HEADER */}

                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">
                                    Pengiriman
                                </h2>

                                <p className="mt-1 text-sm text-gray-500">
                                    Informasi pengiriman dan perjalanan paket
                                </p>
                            </div>

                            {order.trackingNumber &&
                                tracking?.summary?.status && (
                                    <span
                                        className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${tracking.summary.status ===
                                            "DELIVERED"
                                            ? "bg-green-100 text-green-700"
                                            : tracking.summary.status ===
                                                "ON DELIVERY"
                                                ? "bg-yellow-100 text-yellow-700"
                                                : "bg-blue-100 text-blue-700"
                                            }`}
                                    >
                                        {tracking.summary.status}
                                    </span>
                                )}
                        </div>

                        {/* INFO PENGIRIMAN */}

                        <div className="mt-5 grid gap-4 sm:grid-cols-3">
                            <div className="rounded-2xl bg-gray-50 p-4">
                                <p className="text-xs text-gray-500">
                                    Kurir
                                </p>

                                <p className="mt-1 font-semibold uppercase text-gray-900">
                                    {order.shippingCourier ??
                                        "-"}
                                </p>
                            </div>

                            <div className="rounded-2xl bg-gray-50 p-4">
                                <p className="text-xs text-gray-500">
                                    Layanan
                                </p>

                                <p className="mt-1 font-semibold text-gray-900">
                                    {order.shippingService ??
                                        "-"}
                                </p>
                            </div>

                            <div className="rounded-2xl bg-gray-50 p-4">
                                <p className="text-xs text-gray-500">
                                    Nomor Resi
                                </p>

                                <p className="mt-1 break-all font-semibold text-gray-900">
                                    {order.trackingNumber ??
                                        "Belum tersedia"}
                                </p>
                            </div>
                        </div>

                        {/* BELUM ADA RESI */}

                        {!order.trackingNumber && (
                            <div className="mt-6 rounded-2xl bg-gray-50 p-5">
                                <p className="text-sm font-semibold text-gray-700">
                                    Nomor resi belum tersedia
                                </p>

                                <p className="mt-1 text-sm text-gray-500">
                                    Admin belum memasukkan nomor resi
                                    untuk pesanan ini.
                                </p>
                            </div>
                        )}

                        {/* LOADING TRACKING */}

                        {order.trackingNumber &&
                            trackingLoading && (
                                <div className="mt-8">
                                    <h3 className="text-sm font-bold text-gray-900">
                                        Perjalanan Paket
                                    </h3>

                                    <div className="mt-6 space-y-6">
                                        {Array.from({
                                            length: 5,
                                        }).map((_, index) => (
                                            <div
                                                key={index}
                                                className="flex gap-4"
                                            >
                                                <div className="h-5 w-5 shrink-0 animate-pulse rounded-full bg-gray-200" />

                                                <div className="flex-1">
                                                    <div className="h-4 w-64 animate-pulse rounded bg-gray-200" />

                                                    <div className="mt-2 h-3 w-40 animate-pulse rounded bg-gray-100" />

                                                    <div className="mt-2 h-3 w-28 animate-pulse rounded bg-gray-100" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                        {/* TRACKING ERROR / EMPTY */}

                        {order.trackingNumber &&
                            !trackingLoading &&
                            (!tracking ||
                                tracking.manifest.length === 0) && (
                                <div className="mt-6 rounded-2xl bg-gray-50 p-5">
                                    <p className="text-sm font-semibold text-gray-700">
                                        Riwayat tracking belum tersedia
                                    </p>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Data perjalanan paket belum
                                        tersedia dari kurir.
                                    </p>
                                </div>
                            )}

                        {/* TRACKING DATA */}

                        {tracking &&
                            !trackingLoading &&
                            tracking.manifest.length > 0 && (
                                <div className="mt-8">
                                    {/* SUMMARY TRACKING */}

                                    <div className="grid gap-4 sm:grid-cols-3">
                                        <div className="rounded-2xl bg-gray-50 p-4">
                                            <p className="text-xs text-gray-500">
                                                Asal
                                            </p>

                                            <p className="mt-1 font-semibold text-gray-900">
                                                {tracking.summary
                                                    ?.origin ??
                                                    "-"}
                                            </p>
                                        </div>

                                        <div className="rounded-2xl bg-gray-50 p-4">
                                            <p className="text-xs text-gray-500">
                                                Tujuan
                                            </p>

                                            <p className="mt-1 font-semibold text-gray-900">
                                                {tracking.summary
                                                    ?.destination ??
                                                    "-"}
                                            </p>
                                        </div>

                                        <div className="rounded-2xl bg-gray-50 p-4">
                                            <p className="text-xs text-gray-500">
                                                Status
                                            </p>

                                            <p
                                                className={`mt-1 font-semibold ${tracking.summary
                                                    ?.status ===
                                                    "DELIVERED"
                                                    ? "text-green-600"
                                                    : "text-blue-600"
                                                    }`}
                                            >
                                                {tracking.summary
                                                    ?.status ??
                                                    "-"}
                                            </p>
                                        </div>
                                    </div>

                                    {/* DELIVERY / POD */}

                                    {tracking.deliveryStatus
                                        ?.status ===
                                        "DELIVERED" && (
                                            <div className="mt-6 rounded-2xl bg-green-50 p-5">
                                                <p className="text-sm font-bold text-green-700">
                                                    Paket sudah diterima
                                                </p>

                                                {tracking
                                                    .deliveryStatus
                                                    .pod_receiver && (
                                                        <p className="mt-1 text-sm text-green-700">
                                                            Diterima oleh{" "}
                                                            {
                                                                tracking
                                                                    .deliveryStatus
                                                                    .pod_receiver
                                                            }
                                                        </p>
                                                    )}

                                                {tracking
                                                    .deliveryStatus
                                                    .pod_date && (
                                                        <p className="mt-1 text-xs text-green-600">
                                                            {
                                                                tracking
                                                                    .deliveryStatus
                                                                    .pod_date
                                                            }{" "}
                                                            {
                                                                tracking
                                                                    .deliveryStatus
                                                                    .pod_time ??
                                                                ""
                                                            }
                                                        </p>
                                                    )}
                                            </div>
                                        )}

                                    {/* TIMELINE */}

                                    <div className="mt-8">
                                        <h3 className="text-sm font-bold text-gray-900">
                                            Riwayat Perjalanan
                                        </h3>

                                        <div className="mt-6">
                                            {[
                                                ...tracking.manifest,
                                            ]
                                                .reverse()
                                                .map(
                                                    (
                                                        item,
                                                        index
                                                    ) => {
                                                        const isLatest =
                                                            index === 0;

                                                        const isLast =
                                                            index ===
                                                            tracking
                                                                .manifest
                                                                .length -
                                                            1;

                                                        return (
                                                            <div
                                                                key={`${item.manifest_date}-${item.manifest_time}-${index}`}
                                                                className="relative flex gap-4"
                                                            >
                                                                {/* DOT + LINE */}

                                                                <div className="flex w-6 shrink-0 flex-col items-center">
                                                                    <div
                                                                        className={`relative z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 ${isLatest
                                                                            ? "border-green-500 bg-green-500"
                                                                            : "border-gray-300 bg-white"
                                                                            }`}
                                                                    >
                                                                        {isLatest && (
                                                                            <div className="h-2 w-2 rounded-full bg-white" />
                                                                        )}
                                                                    </div>

                                                                    {!isLast && (
                                                                        <div className="w-px flex-1 bg-gray-200" />
                                                                    )}
                                                                </div>

                                                                {/* CONTENT */}

                                                                <div className="pb-7">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <p
                                                                            className={`text-sm font-semibold ${isLatest
                                                                                ? "text-gray-900"
                                                                                : "text-gray-700"
                                                                                }`}
                                                                        >
                                                                            {
                                                                                item.manifest_description
                                                                            }
                                                                        </p>

                                                                        {isLatest && (
                                                                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                                                                                TERBARU
                                                                            </span>
                                                                        )}
                                                                    </div>

                                                                    {item.city_name && (
                                                                        <p className="mt-1 text-xs text-gray-500">
                                                                            {
                                                                                item.city_name
                                                                            }
                                                                        </p>
                                                                    )}

                                                                    <p className="mt-1 text-xs text-gray-400">
                                                                        {
                                                                            item.manifest_date
                                                                        }{" "}
                                                                        •{" "}
                                                                        {
                                                                            item.manifest_time
                                                                        }
                                                                    </p>

                                                                    {item.title && (
                                                                        <span
                                                                            className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${isLatest
                                                                                ? "bg-green-100 text-green-700"
                                                                                : "bg-gray-100 text-gray-600"
                                                                                }`}
                                                                        >
                                                                            {
                                                                                item.title
                                                                            }
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        );
                                                    }
                                                )}
                                        </div>
                                    </div>
                                </div>
                            )}
                    </section>

                    {/* SUMMARY */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6">
                        <h2 className="text-lg font-bold">
                            Ringkasan Pembayaran
                        </h2>

                        <div className="mt-5 space-y-4 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-gray-500">
                                    Subtotal
                                </span>

                                <span className="font-medium">
                                    {formatRupiah(
                                        order.subtotal
                                    )}
                                </span>
                            </div>

                            <div className="flex items-center justify-between">
                                <span className="text-gray-500">
                                    Ongkir
                                </span>

                                <span className="font-medium">
                                    {formatRupiah(
                                        order.shippingCost
                                    )}
                                </span>
                            </div>

                            <div className="border-t border-gray-200 pt-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-base font-bold">
                                        Total
                                    </span>

                                    <span className="text-xl font-bold text-rose-600">
                                        {formatRupiah(
                                            order.total
                                        )}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </section>

                </div>
            </div>
        </main>
    );
}