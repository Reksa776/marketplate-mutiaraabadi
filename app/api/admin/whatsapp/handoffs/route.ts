/**
 * ==========================================
 * WHATSAPP HANDOFF INBOX (ADMIN)
 * ==========================================
 *
 * GET /api/admin/whatsapp/handoffs
 *
 * Lists the chats the auto-reply bot has handed over to a human admin
 * in the last 24 hours. This is the ENTIRE handoff mechanism: the bot
 * writes one AdminAuditLog row (`WHATSAPP_HANDOFF`) when it pauses for
 * a human, and this endpoint surfaces those rows. There is no ticket
 * system, no new table and no state the admin has to maintain.
 *
 * WHY THE ADMIN ONLY NEEDS THIS LIST
 *
 *   The bot replies from the SAME WhatsApp account the admin is logged
 *   into, so the conversation itself is already sitting in the admin's
 *   WhatsApp app. What the admin cannot see from there is WHICH chats
 *   are waiting — that is the only thing this endpoint adds.
 *
 * PRIVACY
 *
 *   Only the MASKED chat label stored at handoff time is returned
 *   (`62*******7890` or an opaque `chat-xxxxxxxx` for LID chats); the
 *   raw JID/phone number and the customer's message content are never
 *   stored, so they cannot leak here either.
 *
 * SECURITY: admin session only, no-store.
 */

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Only recent handoffs are actionable. */
const HANDOFF_WINDOW_HOURS = 24;
const MAX_ROWS = 20;

export async function GET() {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                { success: false, message: "Unauthorized." },
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                { success: false, message: "Akses ditolak." },
                { status: 403 }
            );
        }

        const since = new Date(
            Date.now() - HANDOFF_WINDOW_HOURS * 60 * 60 * 1000
        );

        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "WHATSAPP_HANDOFF",
                createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                id: true,
                entityId: true,
                metadata: true,
                createdAt: true,
            },
        });

        /*
         * Resolve order numbers in ONE extra query instead of N, and
         * only for rows that actually carry an order id.
         */
        const orderIds = Array.from(
            new Set(
                rows
                    .map((row) => row.entityId)
                    .filter(
                        (value): value is number =>
                            typeof value === "number"
                    )
            )
        );

        const orders =
            orderIds.length > 0
                ? await prisma.order.findMany({
                      where: { id: { in: orderIds } },
                      select: {
                          id: true,
                          orderNumber: true,
                      },
                  })
                : [];

        const orderNumbers = new Map(
            orders.map((order) => [
                order.id,
                order.orderNumber,
            ])
        );

        const data = rows.map((row) => {
            const metadata =
                (row.metadata ?? {}) as Record<
                    string,
                    unknown
                >;

            return {
                id: row.id,
                orderNumber:
                    typeof row.entityId === "number"
                        ? (orderNumbers.get(row.entityId) ??
                          null)
                        : null,
                chat:
                    typeof metadata.chat === "string"
                        ? metadata.chat
                        : null,
                reason:
                    typeof metadata.reason === "string"
                        ? metadata.reason
                        : null,
                createdAt: row.createdAt.toISOString(),
            };
        });

        return NextResponse.json(
            {
                success: true,
                data,
            },
            {
                status: 200,
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (error) {
        console.error(
            "GET WHATSAPP HANDOFFS ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal mengambil daftar handoff.",
            },
            { status: 500 }
        );
    }
}
