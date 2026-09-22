import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/* ==========================================
 * GET /api/admin/refunds
 * ==========================================
 *
 * Admin refund dashboard API.
 *
 * Returns:
 * - Summary counts (pending, processing, completed, failed)
 * - Paginated refund list with order + user details
 * - Search by order number or customer name
 * - Filter by status
 * - Sort by date or amount
 *
 * Security:
 * - Admin authorization required
 * - No client-controlled data
 */

export async function GET(request: Request) {
    try {
        // ==========================================
        // AUTH + ADMIN CHECK
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

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Akses ditolak.",
                },
                { status: 403 }
            );
        }

        // ==========================================
        // PARSE QUERY PARAMS
        // ==========================================

        const { searchParams } = new URL(request.url);

        const search = searchParams.get("search") || "";
        const status = searchParams.get("status") || "";
        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
        const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "10", 10)));
        // ==========================================
        // SECURITY (L2 FIX): Whitelist sortBy fields
        // ==========================================
        // Prevents sorting by sensitive/internal fields
        // (e.g., processedBy, requestedBy, providerRef)
        // and ensures only safe, intended sort columns
        // are accepted.
        const allowedSortFields = [
            "createdAt",
            "updatedAt",
            "amount",
            "status",
        ];
        const rawSortBy = searchParams.get("sortBy") || "createdAt";
        const sortBy = allowedSortFields.includes(rawSortBy)
            ? rawSortBy
            : "createdAt";
        const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

        // ==========================================
        // BUILD WHERE CLAUSE
        // ==========================================

        const where: any = {};

        if (status && ["PENDING", "PROCESSING", "COMPLETED", "FAILED"].includes(status)) {
            where.status = status;
        }

        if (search) {
            where.OR = [
                {
                    order: {
                        orderNumber: {
                            contains: search,
                        },
                    },
                },
                {
                    order: {
                        user: {
                            name: {
                                contains: search,
                            },
                        },
                    },
                },
                {
                    order: {
                        user: {
                            email: {
                                contains: search,
                            },
                        },
                    },
                },
            ];
        }

        // ==========================================
        // SUMMARY COUNTS
        // ==========================================

        const [pending, processing, completed, failed] = await Promise.all([
            prisma.refund.count({ where: { ...where, status: "PENDING" } }),
            prisma.refund.count({ where: { ...where, status: "PROCESSING" } }),
            prisma.refund.count({ where: { ...where, status: "COMPLETED" } }),
            prisma.refund.count({ where: { ...where, status: "FAILED" } }),
        ]);

        // ==========================================
        // FETCH REFUNDS
        // ==========================================

        const totalCount = await prisma.refund.count({ where });

        const refunds = await prisma.refund.findMany({
            where,
            include: {
                order: {
                    select: {
                        id: true,
                        orderNumber: true,
                        total: true,
                        status: true,
                        paymentMethod: true,
                        createdAt: true,
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                [sortBy]: sortOrder,
            },
            skip: (page - 1) * limit,
            take: limit,
        });

        // ==========================================
        // FORMAT RESPONSE
        // ==========================================

        const formattedRefunds = refunds.map((refund) => ({
            id: refund.id,
            orderId: refund.orderId,
            orderNumber: refund.order.orderNumber,
            customer: {
                id: refund.order.user.id,
                name: refund.order.user.name || "Unknown",
                email: refund.order.user.email || "",
            },
            orderTotal: Number(refund.order.total),
            refundAmount: Number(refund.amount),
            reason: refund.reason,
            status: refund.status,
            paymentMethod: refund.order.paymentMethod,
            orderStatus: refund.order.status,
            requestedBy: refund.requestedBy,
            processedBy: refund.processedBy,
            providerRef: refund.providerRef,
            bank: {
                bankName: refund.bankName,
                bankAccountName: refund.bankAccountName,
                bankAccountNumber:
                    refund.bankAccountNumber,
            },
            proofFilePath: refund.proofFilePath,
            requestedAt: refund.createdAt.toISOString(),
            processedAt: refund.updatedAt.toISOString(),
        }));

        return NextResponse.json({
            success: true,
            data: {
                summary: {
                    pending,
                    processing,
                    completed,
                    failed,
                    total: pending + processing + completed + failed,
                },
                refunds: formattedRefunds,
                pagination: {
                    page,
                    limit,
                    totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            },
        });
    } catch (error) {
        console.error("ADMIN REFUNDS LIST ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil data refund.",
            },
            { status: 500 }
        );
    }
}
