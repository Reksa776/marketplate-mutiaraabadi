import { NextResponse } from "next/server";
import { createRefundRequest } from "@/lib/refund";
import { authorizeOrderRequest } from "@/lib/guest-order-access";
import { rateLimiters } from "@/lib/rate-limit";
import {
    maskAccountNumber,
    validateBankFields,
} from "@/lib/refund-bank";

/* ==========================================
 * POST /api/orders/[id]/refund
 * ==========================================
 *
 * User-initiated refund request.
 *
 * Security:
 * - Authentication required
 * - Ownership check (userId matches order)
 * - Server-side refund amount (order.total from DB)
 * - Rate limited (3 per hour)
 * - Idempotent (unique orderId on Refund model)
 *
 * Flow:
 * 1. Verify ownership
 * 2. Check refund eligibility
 * 3. Create Refund record (PENDING)
 * 4. CAS: Order.status → REFUND_PENDING
 * 5. Admin will process the refund
 *
 * Amount is NEVER taken from client request.
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

        // ==========================================
        // OWNERSHIP (session OR guest access token)
        // ==========================================

        const access = await authorizeOrderRequest(
            req,
            Number((await context.params).id)
        );

        if (!access.ok) {
            return NextResponse.json(
                { success: false, message: access.message },
                { status: access.status }
            );
        }

        // ==========================================
        // RATE LIMIT
        // ==========================================

        if (access.userId) {
            const rateLimit = rateLimiters.refundRequest(
                access.userId
            );
            if (!rateLimit.allowed) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Terlalu banyak permintaan. Coba lagi nanti.",
                    },
                    { status: 429 }
                );
            }
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
        // PARSE REASON + DESTINATION BANK
        // ==========================================

        let reason: string | undefined;
        let bankName: string | undefined;
        let bankAccountName: string | undefined;
        let bankAccountNumber: string | undefined;

        try {
            const body = await req.json();

            if (typeof body.reason === "string" && body.reason.trim()) {
                reason = body.reason.trim().substring(0, 500);
            }

            bankName = typeof body.bankName === "string" ? body.bankName.trim() : "";
            bankAccountName = typeof body.bankAccountName === "string" ? body.bankAccountName.trim() : "";
            bankAccountNumber = typeof body.bankAccountNumber === "string" ? body.bankAccountNumber.trim() : "";
        } catch {
            // Body is optional
        }

        // ==========================================
        // VALIDATE DESTINATION BANK (REQUIRED)
        // ==========================================
        //
        // The admin needs the customer's destination
        // bank to execute the transfer. Fields are
        // server-validated (length/charset) and
        // stored on the Refund record.

        const bankValidation = validateBankFields(
            bankName,
            bankAccountName,
            bankAccountNumber
        );

        if (!bankValidation.ok) {
            return NextResponse.json(
                {
                    success: false,
                    message: bankValidation.error,
                },
                { status: 400 }
            );
        }

        // ==========================================
        // CREATE REFUND REQUEST
        // ==========================================
        //
        // Amount is SERVER-AUTHORITATIVE: order.total from DB.
        // Client cannot influence the refund amount.

        const result = await createRefundRequest(
            /*
             * Refund.requestedBy records WHO asked. A guest order has no
             * user id, so the caller is recorded as the guest owner of
             * that order (ownership was just verified above).
             */
            access.userId ?? "GUEST",
            orderId,
            reason,
            {
                bankName: bankName,
                bankAccountName: bankAccountName,
                bankAccountNumber: bankAccountNumber,
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

        return NextResponse.json({
            success: true,
            message:
                "Permintaan refund berhasil diajukan. Admin akan memproses segera.",
            data: {
                refundId: result.refundId,
                status: "PENDING",
                bankAccountNumber: maskAccountNumber(
                    bankAccountNumber || ""
                ),
            },
        });
    } catch (error) {
        console.error("REFUND REQUEST ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengajukan permintaan refund.",
            },
            { status: 500 }
        );
    }
}
