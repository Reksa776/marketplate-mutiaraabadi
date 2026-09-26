import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import PurchaseTracker from "@/components/analytics/PurchaseTracker";

export default async function CheckoutSuccessPage({
    searchParams,
}: {
    searchParams: Promise<{
        order?: string;
    }>;
}) {
    const session = await auth();

    if (!session?.user?.id) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold">
                        Silakan login terlebih dahulu
                    </h1>

                    <Link
                        href="/login"
                        className="mt-4 inline-block rounded-lg bg-black px-5 py-3 text-white"
                    >
                        Login
                    </Link>
                </div>
            </div>
        );
    }

    const params = await searchParams;
    const orderId = Number(params.order);

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold">
                        Pesanan tidak valid
                    </h1>

                    <Link
                        href="/products"
                        className="mt-4 inline-block rounded-lg bg-black px-5 py-3 text-white"
                    >
                        Kembali Belanja
                    </Link>
                </div>
            </div>
        );
    }

    const order = await prisma.order.findFirst({
        where: {
            id: orderId,
            userId: session.user.id,
        },
        include: {
            items: true,
        },
    });

    if (!order) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold">
                        Pesanan tidak ditemukan
                    </h1>

                    <p className="mt-2 text-gray-500">
                        Pesanan mungkin tidak tersedia atau bukan milik akun ini.
                    </p>

                    <Link
                        href="/products"
                        className="mt-6 inline-block rounded-lg bg-black px-5 py-3 text-white"
                    >
                        Kembali Belanja
                    </Link>
                </div>
            </div>
        );
    }

    const paymentMethodLabel: Record<string, string> = {
        COD: "COD",
        BANK_TRANSFER: "Bank Transfer",
        E_WALLET: "E-Wallet",
        QRIS: "QRIS",
    };

    const paymentStatusLabel: Record<string, string> = {
        UNPAID: "Belum Dibayar",
        PENDING: "Menunggu Pembayaran",
        PAID: "Sudah Dibayar",
        FAILED: "Pembayaran Gagal",
        EXPIRED: "Pembayaran Kedaluwarsa",
        REFUNDED: "Dana Dikembalikan",
    };

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-10">
            {/*
             * Authoritative order lines straight from the database:
             * each item contributes its own catalog content_id.
             */}
            <PurchaseTracker
                orderId={order.orderNumber}
                total={Number(order.total)}
                items={order.items.map((item) => ({
                    productId: item.productId,
                    variantId: item.variantId,
                    productName: item.productName,
                    variantName: item.variantName,
                    quantity: item.quantity,
                    price: Number(item.price),
                }))}
            />
            <div className="mx-auto max-w-3xl">
                <div className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
                    {/* SUCCESS */}
                    <div className="text-center">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl">
                            ✓
                        </div>

                        <h1 className="mt-5 text-3xl font-bold">
                            Pesanan Berhasil!
                        </h1>

                        <p className="mt-2 text-gray-500">
                            Terima kasih. Pesanan kamu sudah berhasil dibuat.
                        </p>
                    </div>

                    {/* ORDER INFO */}
                    <div className="mt-8 rounded-xl border p-5">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-500">
                                Nomor Pesanan
                            </span>

                            <span className="font-semibold">
                                {order.orderNumber}
                            </span>
                        </div>

                        <div className="mt-4 flex items-center justify-between">
                            <span className="text-sm text-gray-500">
                                Status Pesanan
                            </span>

                            <span className="rounded-full bg-yellow-100 px-3 py-1 text-sm font-medium text-yellow-700">
                                {order.status}
                            </span>
                        </div>

                        <div className="mt-4 flex items-center justify-between">
                            <span className="text-sm text-gray-500">
                                Metode Pembayaran
                            </span>

                            <span className="font-medium">
                                {paymentMethodLabel[
                                    order.paymentMethod
                                ] ?? order.paymentMethod}
                            </span>
                        </div>

                        <div className="mt-4 flex items-center justify-between">
                            <span className="text-sm text-gray-500">
                                Status Pembayaran
                            </span>

                            <span className="font-medium">
                                {paymentStatusLabel[
                                    order.paymentStatus
                                ] ?? order.paymentStatus}
                            </span>
                        </div>
                    </div>

                    {/* ITEMS */}
                    <div className="mt-6">
                        <h2 className="text-lg font-semibold">
                            Detail Pesanan
                        </h2>

                        <div className="mt-3 divide-y rounded-xl border">
                            {order.items.map((item) => (
                                <div
                                    key={item.id}
                                    className="flex items-center justify-between p-4"
                                >
                                    <div>
                                        <div className="font-medium">
                                            {item.productName}
                                        </div>

                                        <div className="text-sm text-gray-500">
                                            {item.variantName} ×{" "}
                                            {item.quantity}
                                        </div>
                                    </div>

                                    <div className="font-medium">
                                        Rp{" "}
                                        {Number(
                                            item.subtotal
                                        ).toLocaleString("id-ID")}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* TOTAL */}
                    <div className="mt-6 rounded-xl bg-gray-50 p-5">
                        <div className="flex justify-between">
                            <span>Subtotal</span>

                            <span>
                                Rp{" "}
                                {Number(
                                    order.subtotal
                                ).toLocaleString("id-ID")}
                            </span>
                        </div>

                        <div className="mt-2 flex justify-between">
                            <span>Ongkir</span>

                            <span>
                                Rp{" "}
                                {Number(
                                    order.shippingCost
                                ).toLocaleString("id-ID")}
                            </span>
                        </div>

                        <div className="mt-4 flex justify-between border-t pt-4 text-lg font-bold">
                            <span>Total</span>

                            <span>
                                Rp{" "}
                                {Number(
                                    order.total
                                ).toLocaleString("id-ID")}
                            </span>
                        </div>
                    </div>

                    {/* ADDRESS */}
                    <div className="mt-6">
                        <h2 className="text-lg font-semibold">
                            Alamat Pengiriman
                        </h2>

                        <div className="mt-3 rounded-xl border p-5">
                            <div className="font-medium">
                                {order.recipientName}
                            </div>

                            <div className="mt-1 text-sm text-gray-500">
                                {order.phone}
                            </div>

                            <div className="mt-3 text-sm text-gray-600">
                                {order.address}
                            </div>

                            <div className="mt-1 text-sm text-gray-600">
                                {order.district},{" "}
                                {order.city},{" "}
                                {order.province}{" "}
                                {order.postalCode}
                            </div>
                        </div>
                    </div>

                    {/* BUTTON */}
                    <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                        <Link
                            href="/products"
                            className="flex-1 rounded-lg bg-black px-5 py-3 text-center font-medium text-white"
                        >
                            Lanjut Belanja
                        </Link>

                        <Link
                            href={`/orders/${order.id}`}
                            className="flex-1 rounded-lg border px-5 py-3 text-center font-medium"
                        >
                            Lihat Pesanan
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}