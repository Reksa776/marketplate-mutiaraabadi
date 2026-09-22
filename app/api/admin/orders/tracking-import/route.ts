import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";

/* ==========================================
 * POST /api/admin/orders/tracking-import
 * ==========================================
 *
 * Accepts multipart/form-data with an Excel
 * file (.xlsx, .xls, .csv).
 *
 * Process:
 *   1. Validate file extension & size
 *   2. Parse Excel rows
 *   3. Validate each row individually
 *   4. Update trackingNumber per order
 *   5. Return import summary with row results
 *
 * Security:
 *   - ADMIN authorization required
 *   - File extension validated (not just MIME)
 *   - Max 5MB file size
 *   - Required headers validated
 *   - Input sanitized (trim, no formulas)
 *
 * Idempotency:
 *   - Same trackingNumber on same order → SKIP
 *   - Different trackingNumber on same order → FAIL
 *
 * Partial success:
 *   - Each row is independent
 *   - One row failure does NOT rollback others
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_EXTENSIONS = [
    ".xlsx",
    ".xls",
    ".csv",
];

type RowResult = {
    row: number;
    orderNumber: string;
    trackingNumber: string;
    courier: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    reason: string;
};

function getExtension(filename: string): string {
    const idx = filename.lastIndexOf(".");
    if (idx === -1) return "";
    return filename.slice(idx).toLowerCase();
}

function sanitizeValue(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }

    // Convert to string, trim whitespace
    let str = String(value).trim();

    // Strip leading/trailing single quotes (Excel text prefix)
    if (
        str.startsWith("'") &&
        str.endsWith("'")
    ) {
        str = str.slice(1, -1);
    }

    // If it starts with = it's a formula → strip it
    if (str.startsWith("=")) {
        str = str.slice(1);
    }

    return str.trim();
}

function isFormulasPayload(
    value: unknown
): boolean {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    // Detect Excel formulas or script injection attempts
    if (trimmed.startsWith("=")) return true;
    if (trimmed.startsWith("+")) return true;
    if (trimmed.startsWith("-") && /\d/.test(trimmed)) return true;
    if (trimmed.startsWith("@")) return true;
    return false;
}

export async function POST(request: Request) {
    try {
        /* ==========================================
         * AUTH CHECK
         * ========================================== */

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
                    message: "Forbidden.",
                },
                { status: 403 }
            );
        }

        /* ==========================================
         * PARSE FORM DATA
         * ========================================== */

        const contentType =
            request.headers.get("content-type") || "";

        if (
            !contentType.includes(
                "multipart/form-data"
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Content-Type harus multipart/form-data.",
                },
                { status: 400 }
            );
        }

        let formData: FormData;

        try {
            formData = await request.formData();
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Gagal membaca form data.",
                },
                { status: 400 }
            );
        }

        const file = formData.get("file") as File | null;

        if (!file || !(file instanceof File)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File tidak ditemukan. Pilih file Excel (.xlsx) untuk diupload.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * VALIDATE FILE SIZE
         * ========================================== */

        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Ukuran file terlalu besar. Maksimal 5MB.",
                },
                { status: 400 }
            );
        }

        if (file.size === 0) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File kosong. Pilih file yang memiliki data.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * VALIDATE FILE EXTENSION
         * ========================================== */

        const filename = file.name || "upload.xlsx";
        const ext = getExtension(filename);

        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Format file tidak didukung. Gunakan file .xlsx, .xls, atau .csv.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * READ FILE AS BUFFER
         * ========================================== */

        const arrayBuffer =
            await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        /* ==========================================
         * PARSE EXCEL
         * ========================================== */

        let workbook: XLSX.WorkBook;

        try {
            workbook = XLSX.read(buffer, {
                type: "buffer",
                cellDates: false,
                cellNF: false,
                cellText: true,
            });
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File bukan Excel yang valid. Pastikan file tidak corrupt.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * VALIDATE SHEET EXISTS
         * ========================================== */

        const sheetNames = workbook.SheetNames;

        if (
            !sheetNames ||
            sheetNames.length === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File tidak memiliki sheet.",
                },
                { status: 400 }
            );
        }

        // Use first sheet
        const firstSheetName = sheetNames[0];
        const sheet =
            workbook.Sheets[firstSheetName];

        if (!sheet) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Sheet pertama kosong.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * PARSE ROWS
         * ========================================== */

        const rawData: Record<string, unknown>[] =
            XLSX.utils.sheet_to_json(sheet, {
                defval: "",
                raw: false,
            });

        if (rawData.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "File kosong atau tidak memiliki data.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * VALIDATE HEADERS
         * ========================================== */

        const headers = Object.keys(rawData[0]);
        const requiredHeaders = [
            "orderNumber",
            "trackingNumber",
            "courier",
        ];

        const missingHeaders =
            requiredHeaders.filter(
                (h) => !headers.includes(h)
            );

        if (missingHeaders.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    message: `Kolom yang wajib ada tidak ditemukan: ${missingHeaders.join(", ")}. Unduh template terlebih dahulu.`,
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * MAX ROWS LIMIT
         * ========================================== */

        if (rawData.length > 500) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Maksimal 500 baris per import. Bagi menjadi beberapa file.",
                },
                { status: 400 }
            );
        }

        /* ==========================================
         * PRE-FLIGHT: COLLECT ALL ORDER NUMBERS
         * ==========================================
         *
         * Fetch all matching orders in one query
         * for performance.
         */

        const orderNumbers = new Set<string>();

        for (const raw of rawData) {
            const orderNum = sanitizeValue(
                raw.orderNumber
            );
            if (orderNum) {
                orderNumbers.add(orderNum);
            }
        }

        const orders = await prisma.order.findMany({
            where: {
                orderNumber: {
                    in: Array.from(orderNumbers),
                },
            },
            select: {
                id: true,
                orderNumber: true,
                status: true,
                trackingNumber: true,
                shippingCourier: true,
                paymentStatus: true,
            },
        });

        const orderMap = new Map(
            orders.map((o) => [o.orderNumber, o])
        );

        /* ==========================================
         * CANCELLED/REFUNDED STATUS SET
         * ========================================== */

        const blockedStatuses = new Set([
            "CANCELLED",
        ]);

        const completedStatuses = new Set([
            "COMPLETED",
        ]);

        /* ==========================================
         * PROCESS EACH ROW
         * ==========================================
         *
         * Each row is independent — one failure
         * does NOT affect others.
         */

        const results: RowResult[] = [];
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        // Track duplicate orderNumbers within file
        const seenOrderNumbers = new Set<string>();
        // Track duplicate trackingNumbers within file
        const seenTrackingNumbers = new Set<string>();

        for (
            let i = 0;
            i < rawData.length;
            i++
        ) {
            const raw = rawData[i];
            const excelRow = i + 2; // +2: 1-indexed + header row

            const orderNumber = sanitizeValue(
                raw.orderNumber
            );
            const trackingNumber = sanitizeValue(
                raw.trackingNumber
            );
            const courier = sanitizeValue(
                raw.courier
            );

            // ---- ROW VALIDATION ----

            // 1. orderNumber required
            if (!orderNumber) {
                results.push({
                    row: excelRow,
                    orderNumber:
                        orderNumber || "-",
                    trackingNumber:
                        trackingNumber || "-",
                    courier: courier || "-",
                    status: "FAILED",
                    reason:
                        "orderNumber wajib diisi.",
                });
                failedCount++;
                continue;
            }

            // 2. trackingNumber required
            if (!trackingNumber) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber: "-",
                    courier: courier || "-",
                    status: "FAILED",
                    reason:
                        "trackingNumber wajib diisi.",
                });
                failedCount++;
                continue;
            }

            // 3. courier required
            if (!courier) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier: "-",
                    status: "FAILED",
                    reason:
                        "courier wajib diisi.",
                });
                failedCount++;
                continue;
            }

            // 4. Detect formula/injection payloads
            if (
                isFormulasPayload(
                    raw.orderNumber
                ) ||
                isFormulasPayload(
                    raw.trackingNumber
                ) ||
                isFormulasPayload(raw.courier)
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "Data mengandung formula atau karakter tidak valid.",
                });
                failedCount++;
                continue;
            }

            // 5. Duplicate orderNumber within file
            if (
                seenOrderNumbers.has(orderNumber)
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "orderNumber duplikat dalam satu file.",
                });
                failedCount++;
                continue;
            }
            seenOrderNumbers.add(orderNumber);

            // 6. Duplicate trackingNumber within file
            if (
                seenTrackingNumbers.has(
                    trackingNumber
                )
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "trackingNumber duplikat dalam satu file.",
                });
                failedCount++;
                continue;
            }
            seenTrackingNumbers.add(
                trackingNumber
            );

            // 7. Find order in database
            const order =
                orderMap.get(orderNumber);

            if (!order) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "Order tidak ditemukan.",
                });
                failedCount++;
                continue;
            }

            // 8. Order cancelled
            if (
                blockedStatuses.has(order.status)
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason: `Order sudah ${order.status}. Tidak dapat menambahkan resi.`,
                });
                failedCount++;
                continue;
            }

            // 9. Idempotency — same tracking number
            if (
                order.trackingNumber ===
                trackingNumber
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "SKIPPED",
                    reason:
                        "Order sudah memiliki nomor resi yang sama.",
                });
                skippedCount++;
                continue;
            }

            // 10. Existing different tracking number
            if (
                order.trackingNumber &&
                order.trackingNumber !==
                    trackingNumber
            ) {
                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "Order sudah memiliki nomor resi berbeda. Hubungi admin untuk mengubah.",
                });
                failedCount++;
                continue;
            }

            // ---- UPDATE ----

            try {
                // Build tracking URL
                const trackingUrl =
                    createTrackingUrl(
                        courier,
                        trackingNumber
                    );

                await prisma.order.update({
                    where: {
                        id: order.id,
                    },
                    data: {
                        trackingNumber,
                        trackingUrl,
                    },
                });

                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "SUCCESS",
                    reason:
                        "Resi berhasil diperbarui.",
                });
                successCount++;

                console.log(
                    `TRACKING_IMPORT: Row ${excelRow} SUCCESS — ${orderNumber} → ${trackingNumber} (${courier})`
                );
            } catch (rowError) {
                console.error(
                    `TRACKING_IMPORT: Row ${excelRow} ERROR — ${orderNumber}:`,
                    rowError
                );

                results.push({
                    row: excelRow,
                    orderNumber,
                    trackingNumber,
                    courier,
                    status: "FAILED",
                    reason:
                        "Gagal memperbarui database.",
                });
                failedCount++;
            }
        }

        /* ==========================================
         * SERVER-SIDE LOG
         * ========================================== */

        console.log(
            `TRACKING_IMPORT: Admin ${session.user.id} — ` +
                `Total: ${rawData.length}, ` +
                `Success: ${successCount}, ` +
                `Failed: ${failedCount}, ` +
                `Skipped: ${skippedCount}`
        );

        /* ==========================================
         * RETURN RESULTS
         * ========================================== */

        return NextResponse.json({
            success: true,
            message: "Import selesai.",
            data: {
                summary: {
                    total: rawData.length,
                    success: successCount,
                    failed: failedCount,
                    skipped: skippedCount,
                },
                results,
            },
        });
    } catch (error) {
        console.error(
            "TRACKING IMPORT ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "Gagal memproses import resi.",
            },
            { status: 500 }
        );
    }
}

/* ==========================================
 * TRACKING URL BUILDER
 * ==========================================
 *
 * Generates clickable tracking URLs based
 * on courier name. Reuses same pattern as
 * admin order PATCH route and mirrors
 * lib/tracking-url.ts (used by resi-scan).
 */

function createTrackingUrl(
    courier: string,
    trackingNumber: string
): string | null {
    const normalizedCourier = courier
        .toLowerCase()
        .trim();

    const encoded = encodeURIComponent(
        trackingNumber
    );

    if (
        normalizedCourier.includes("jne")
    ) {
        return `https://www.jne.co.id/id/tracking/trace/tracking?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("jnt") ||
        normalizedCourier.includes("j&t") ||
        normalizedCourier.includes("j&t express")
    ) {
        return `https://www.jet.co.id/track?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("sicepat") ||
        normalizedCourier.includes("si cepat")
    ) {
        return `https://www.sicepat.com/checkAwb?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("anteraja") ||
        normalizedCourier.includes("anter aja")
    ) {
        return `https://anteraja.id/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("pos")
    ) {
        return `https://www.posindonesia.co.id/id/tracking?code=${encoded}`;
    }

    if (
        normalizedCourier.includes("tiki")
    ) {
        return `https://www.tiki.id/tracking?airwaybill=${encoded}`;
    }

    if (
        normalizedCourier.includes("ninja")
    ) {
        return `https://www.ninjavan.co/en-id/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("idexpress")
    ) {
        return `https://idexpress.com/en/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("wahana")
    ) {
        return `https://www.wahana.com/info/tracking/?noresi=${encoded}`;
    }

    return null;
}
