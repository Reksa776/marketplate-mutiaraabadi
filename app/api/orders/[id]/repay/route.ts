import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { processRepayment } from "@/lib/repay";
import { rateLimiters } from "@/lib/rate-limit";

import { formatProductName, resolveProviderMethod } from "@/lib/payment/ipaymu";
import {
    canReusePaymentInstruction,
    createDirectOrderPayment,
    getPaymentPagePath,
} from "@/lib/payment/order-payment";

import {
    IPAYMU_MIN_AMOUNT_CODE,
    IPAYMU_MIN_AMOUNT_FULL_MESSAGE,
    IPAYMU_MIN_AMOUNT_SUGGESTION,
    isIpaymuAmountAllowed,
    isIpaymuMinAmountError,
} from "@/lib/payment/ipaymu-min-amount";

/* ==========================================
 * POST /api/orders/[id]/repay
 * ==========================================
 *
 * Repayment / Bayar Lagi.
 *
 * After the DB state is reset, creates a new iPaymu DIRECT payment
 * and returns OUR OWN payment page URL to the caller.
 *
 * Flow:
 * 1. Validate ownership
 * 2. Validate order eligibility
 * 3. CAS reset order to PENDING
 * 4. Re-reserve stock if needed
 * 5. Create iPaymu direct payment (VA / QRIS / e-wallet instruction)
 * 6. Return our payment page URL to the frontend
 *
 * Amount is SERVER-AUTHORITATIVE (order.total from DB).
 * Payment creation is server-side; the customer never leaves the store
 * and settlement still comes from the webhook only.
 */



export async function POST(
    req: Request,
    context: {
        params: Promise<{
            id: string;
        }>;
    }
) {
    try {
        // ==========================================
        // AUTH
        // ==========================================

        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        // ==========================================
        // RATE LIMIT
        // ==========================================

        const rateLimit = rateLimiters.repayment(session.user.id);
        if (!rateLimit.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Terlalu banyak permintaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        // ==========================================
        // VALIDATE ORDER ID
        // ==========================================

        const { id } = await context.params;
        const orderId = Number(id);

        if (!Number.isInteger(orderId) || orderId <= 0) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order ID tidak valid.",
                },
                { status: 400 }
            );
        }

        // ==========================================
        // PARSE PAYMENT METHOD
        // ==========================================

        let body: {
            paymentMethod?: string;
            paymentChannel?: string;
        } = {};
        try {
            body = await req.json();
        } catch {
            // Body is optional — default to existing payment method
        }

        const paymentMethod = body.paymentMethod || "BANK_TRANSFER";

        const paymentChannel =
            typeof body.paymentChannel === "string"
                ? body.paymentChannel.trim().toLowerCase()
                : null;

        // ==========================================
        // VALIDATE METHOD + CHANNEL (ALLOWLIST)
        // ==========================================
        //
        // Runs before any DB state is touched, so a bad channel can
        // never reset the order or reserve stock.

        if (
            paymentMethod !== "BANK_TRANSFER" &&
            paymentMethod !== "E_WALLET" &&
            paymentMethod !== "QRIS"
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Metode pembayaran tidak valid.",
                },
                { status: 400 }
            );
        }

        try {
            resolveProviderMethod(paymentMethod, paymentChannel);
        } catch (error) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        error instanceof Error
                            ? error.message
                            : "Channel pembayaran tidak valid.",
                },
                { status: 400 }
            );
        }

        // ==========================================
        // STEP 0: SNAPSHOT (REUSE DECISION INPUT)
        // ==========================================
        //
        // Read BEFORE the state reset. An order that is still awaiting
        // payment and has an instruction inside its provider window must
        // be REUSED — creating a second provider payment with the same
        // referenceId would either be rejected by the provider or make
        // settlement ambiguous.
        //
        // Scoped by userId, so another user's order is indistinguishable
        // from a missing one.

        const snapshot = await prisma.order.findFirst({
            where: { id: orderId, userId: session.user.id },
            select: {
                id: true,
                total: true,
                status: true,
                paymentStatus: true,
                paymentMethod: true,
                paymentChannel: true,
                paymentNo: true,
                paymentUrl: true,
                qrString: true,
                paymentExpiresAt: true,
            },
        });

        if (!snapshot) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        // ==========================================
        // IPAYMU MIN-AMOUNT RULE (REPAY)
        // ==========================================
        //
        // Only QRIS is available below Rp10.000. The amount is the
        // PERSISTED order total from the DB (never recalculated) and is
        // checked BEFORE any state is reset, so a blocked repayment
        // leaves the original order untouched — and no second provider
        // payment can ever be created for a sub-minimum non-QRIS order.

        if (!isIpaymuAmountAllowed(Number(snapshot.total), paymentMethod)) {
            return NextResponse.json(
                {
                    success: false,
                    code: IPAYMU_MIN_AMOUNT_CODE,
                    message: IPAYMU_MIN_AMOUNT_FULL_MESSAGE,
                    detail: IPAYMU_MIN_AMOUNT_SUGGESTION,
                },
                { status: 400 }
            );
        }

        const reuseInstruction = canReusePaymentInstruction(
            snapshot,
            paymentMethod
        );

        // ==========================================
        // STEP 1: PROCESS REPAYMENT (DB STATE RESET)
        // ==========================================

        const result = await processRepayment(
            session.user.id,
            orderId,
            paymentMethod,
            {
                status: snapshot.status,
                paymentStatus: snapshot.paymentStatus,
            }
        );

        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message: result.reason,
                },
                { status: 400 }
            );
        }

        // ==========================================
        // STEP 2: REUSE THE OPEN INSTRUCTION
        // ==========================================
        //
        // The order is still awaiting payment and the provider window is
        // open, so the customer keeps the SAME VA / QR / e-wallet
        // instruction. No provider call, no duplicate session, no
        // duplicate referenceId.

        if (reuseInstruction) {
            return NextResponse.json({
                success: true,
                message: "Pembayaran ulang berhasil dibuat.",
                data: {
                    orderId: result.orderId,
                    orderNumber: result.orderNumber,
                    grossAmount: result.grossAmount,
                    paymentMethod: result.paymentMethod,
                    gateway: "ipaymu",
                    reused: true,
                    // OUR OWN payment page — no provider redirect.
                    paymentUrl: getPaymentPagePath(result.orderId),
                    paymentChannel: snapshot.paymentChannel,
                    expiresAt: snapshot.paymentExpiresAt
                        ? snapshot.paymentExpiresAt.toISOString()
                        : null,
                },
            });
        }

        // ==========================================
        // STEP 3: CREATE A NEW PAYMENT INSTRUCTION
        // ==========================================
        //
        // No usable instruction exists (absent, expired, or for another
        // method), so a fresh provider payment is created.

        const appUrl = process.env.NEXT_PUBLIC_APP_URL;
        if (!appUrl) {
            console.error(
                "REPAY ORDER ERROR: NEXT_PUBLIC_APP_URL belum dikonfigurasi."
            );

            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Konfigurasi aplikasi belum lengkap. Silakan hubungi dukungan.",
                },
                { status: 500 }
            );
        }

        // Fetch order details for gateway creation
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { items: true },
        });

        if (!order) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Order tidak ditemukan.",
                },
                { status: 404 }
            );
        }

        // ==========================================
        // IPAYMU DIRECT PAYMENT CREATION
        // ==========================================
        //
        // Amount is SERVER-AUTHORITATIVE (order.total from the DB) and
        // the resulting instruction is persisted for OUR payment page.
        // The provider URL is never returned to the client.

        try {
            const descriptions: string[] = order.items.map((item) =>
                formatProductName(item.productName, item.variantName).substring(0, 50)
            );

            const payment = await createDirectOrderPayment({
                orderId: order.id,
                orderNumber: order.orderNumber,
                buyerName: (order.recipientName || "").substring(0, 50),
                buyerEmail: session.user.email ?? "",
                buyerPhone: (order.phone || "").substring(0, 20),
                amount: Number(order.total),
                paymentMethod,
                paymentChannel,
                notifyUrl: `${appUrl}/api/payment/ipaymu/notification`,
                comments:
                    descriptions.join(", ").substring(0, 191) ||
                    undefined,
            });

            return NextResponse.json({
                success: true,
                message: "Pembayaran ulang berhasil dibuat.",
                data: {
                    orderId: result.orderId,
                    orderNumber: result.orderNumber,
                    grossAmount: result.grossAmount,
                    paymentMethod: result.paymentMethod,
                    gateway: "ipaymu",
                    // OUR OWN payment page — no provider redirect.
                    paymentUrl: payment.paymentPageUrl,
                    paymentChannel: payment.providerChannel,
                    expiresAt: payment.instruction.expiresAt
                        ? payment.instruction.expiresAt.toISOString()
                        : null,
                },
            });
        } catch (ipaymuError: any) {
            console.error("IPAYMU REPAYMENT CREATE FAILED:", ipaymuError);

            if (isIpaymuMinAmountError(ipaymuError)) {
                return NextResponse.json(
                    {
                        success: false,
                        code: ipaymuError.code,
                        message: ipaymuError.message,
                        detail: ipaymuError.suggestion,
                    },
                    { status: 400 }
                );
            }

            // Never pretend this succeeded: the client must be able to
            // show a clear error instead of silently doing nothing.
            // The DB state was reset, so the customer can simply retry
            // (or pick another method/channel).
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Gagal membuat instruksi pembayaran baru. Silakan coba lagi atau pilih metode pembayaran lain.",
                },
                { status: 502 }
            );
        }
    } catch (error) {
        console.error("REPAY ORDER ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Gagal memproses pembayaran ulang.",
            },
            { status: 500 }
        );
    }
}
