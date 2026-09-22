/* ==========================================
 * POST /api/admin/resi-scan
 * ==========================================
 *
 * Admin scans one or more PDF/images that contain
 * order + resi (tracking) info.
 *
 * Pipeline:
 *   1. ADMIN authorization
 *   2. Validate each file (extension+MIME+magic
 *      bytes+size), reject bad files individually
 *   3. Extract text (PDF text → OCR fallback for
 *      scanned PDFs; image → OCR)
 *   4. Extract order reference + tracking number
 *   5. Resolve against orders + existing resi in
 *      one batched query → per-file status:
 *      MATCHED_READY / NEEDS_REVIEW / CONFLICT /
 *      NOT_FOUND / INVALID / DUPLICATE_SAME
 *
 * This route NEVER writes to the database — the
 * admin must explicitly apply via
 * /api/admin/resi-scan/apply.
 *
 * Security: ADMIN only; files validated; raw text
 * stored nowhere; no external fetch.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    SCAN_MAX_FILES_PER_BATCH,
    SCAN_MAX_FILE_BYTES,
    validateScanFile,
} from "@/lib/resi-scan/file";
import {
    extractDocumentText,
    buildTrackingOwnerMap,
    resolveScanOutcome,
} from "@/lib/resi-scan/engine";
import type {
    OrderLookupRow,
} from "@/lib/resi-scan/engine";
import type {
    ScanDocumentResult,
    ScanExtraction,
} from "@/lib/resi-scan/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
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
                message:
                    "Akses ditolak. Hanya admin.",
            },
            { status: 403 }
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
                    "Permintaan bukan multipart/form-data.",
            },
            { status: 400 }
        );
    }

    const files = formData
        .getAll("files")
        .filter(
            (entry): entry is File =>
                entry instanceof File
        );

    if (files.length === 0) {
        return NextResponse.json(
            {
                success: false,
                message:
                    "Pilih minimal satu file untuk dipindai.",
            },
            { status: 400 }
        );
    }

    if (files.length > SCAN_MAX_FILES_PER_BATCH) {
        return NextResponse.json(
            {
                success: false,
                message: `Maksimal ${SCAN_MAX_FILES_PER_BATCH} file per pemindaian.`,
            },
            { status: 400 }
        );
    }

    if (
        files.some((f) => f.size > SCAN_MAX_FILE_BYTES)
    ) {
        return NextResponse.json(
            {
                success: false,
                message:
                    "Ada file yang melebihi batas ukuran.",
            },
            { status: 400 }
        );
    }

    // ---- EXTRACT (sequential to bound memory) ----

    const extractions: Array<
        | { ok: false; fileName: string; error: string }
        | {
              ok: true;
              fileName: string;
              fileSize: number;
              fileMime: string;
              fileExt: string;
              extraction: ScanExtraction;
          }
    > = [];

    for (const file of files) {
        let buffer: Buffer;
        try {
            buffer = Buffer.from(
                await file.arrayBuffer()
            );
        } catch {
            extractions.push({
                ok: false,
                fileName: file.name,
                error: "Gagal membaca file.",
            });
            continue;
        }

        const validation = validateScanFile(
            {
                name: file.name,
                size: file.size,
                type: file.type,
            },
            buffer
        );

        if (!validation.ok) {
            extractions.push({
                ok: false,
                fileName: file.name,
                error: validation.error ?? "File tidak valid.",
            });
            continue;
        }

        const extraction = await extractDocumentText(
            validation.kind,
            buffer
        );

        extractions.push({
            ok: true,
            fileName: file.name,
            fileSize: file.size,
            fileMime: validation.mime,
            fileExt: validation.ext,
            extraction,
        });
    }

    // ---- BATCH DB LOOKUP ----

    const orderNumberRefs = new Set<string>();
    const numericIdRefs = new Set<number>();
    const trackingLookup = new Set<string>();

    for (const entry of extractions) {
        if (!entry.ok) continue;
        const fields = entry.extraction;

        const ref = fields.orderReference;
        if (ref) {
            if (/^\d{1,9}$/.test(ref)) {
                numericIdRefs.add(Number(ref));
            } else if (
                /^(ORD|PAY-BN|PAY-CART)-/.test(ref)
            ) {
                orderNumberRefs.add(ref);
            }
        }

        if (fields.trackingNumber) {
            trackingLookup.add(
                fields.trackingNumber.toUpperCase()
            );
        }
    }

    let orders: OrderLookupRow[] = [];
    let trackingRows: Array<{
        id: number;
        trackingNumber: string | null;
    }> = [];

    if (
        orderNumberRefs.size > 0 ||
        numericIdRefs.size > 0
    ) {
        orders = await prisma.order.findMany({
            where: {
                OR: [
                    ...(orderNumberRefs.size > 0
                        ? [
                              {
                                  orderNumber: {
                                      in: Array.from(
                                          orderNumberRefs
                                      ),
                                  },
                              },
                          ]
                        : []),
                    ...(numericIdRefs.size > 0
                        ? [
                              {
                                  id: {
                                      in: Array.from(
                                          numericIdRefs
                                      ),
                                  },
                              },
                          ]
                        : []),
                ],
            },
            select: {
                id: true,
                orderNumber: true,
                status: true,
                paymentStatus: true,
                trackingNumber: true,
            },
        });
    }

    if (trackingLookup.size > 0) {
        trackingRows = await prisma.order.findMany({
            where: {
                trackingNumber: {
                    in: Array.from(trackingLookup),
                },
            },
            select: {
                id: true,
                trackingNumber: true,
            },
        });
    }

    const lookup = {
        orders,
        trackingOwners: buildTrackingOwnerMap(
            trackingRows
        ),
    };

    // ---- RESOLVE ----

    const results: ScanDocumentResult[] = [];

    for (let index = 0; index < extractions.length; index++) {
        const entry = extractions[index];

        if (!entry.ok) {
            results.push({
                index,
                fileName: entry.fileName,
                fileSize: 0,
                fileMime: "",
                fileExt: "",
                source: null,
                rawText: "",
                orderReference: null,
                trackingNumber: null,
                warnings: [entry.error],
                confidence: 0,
                status: "EXTRACTION_FAILED",
                resolution: {
                    orderId: null,
                    orderNumber: null,
                    orderStatus: null,
                    paymentStatus: null,
                    orderExists: false,
                    orderEligible: false,
                    alreadyHasTracking: false,
                    existingTracking: null,
                    matchingExistingTracking: false,
                    trackingInUseByOtherOrder: false,
                    trackingValid: false,
                },
            });
            continue;
        }

        const outcome = resolveScanOutcome(
            entry.extraction,
            lookup
        );

        results.push({
            index,
            fileName: entry.fileName,
            fileSize: entry.fileSize,
            fileMime: entry.fileMime,
            fileExt: entry.fileExt,
            source: entry.extraction.source,
            rawText: entry.extraction.rawText,
            orderReference: outcome.orderReference,
            trackingNumber: outcome.trackingNumber,
            warnings: outcome.warnings,
            confidence: outcome.confidence,
            status: outcome.status,
            resolution: outcome.resolution,
        });
    }

    const summary = {
        total: results.length,
        matched:
            results.filter(
                (r) => r.status === "MATCHED_READY"
            ).length,
        review:
            results.filter(
                (r) => r.status === "NEEDS_REVIEW"
            ).length,
        conflict:
            results.filter(
                (r) => r.status === "CONFLICT"
            ).length,
        skipped:
            results.filter(
                (r) => r.status === "DUPLICATE_SAME"
            ).length,
        failed:
            results.filter(
                (r) =>
                    r.status === "NOT_FOUND" ||
                    r.status === "INVALID" ||
                    r.status === "EXTRACTION_FAILED"
            ).length,
    };

    console.log(
        `RESI_SCAN: Admin ${session.user.id} — ` +
            `Files: ${results.length}, ` +
            `Matched: ${summary.matched}, ` +
            `Review: ${summary.review}, ` +
            `Conflict: ${summary.conflict}, ` +
            `Failed: ${summary.failed}`
    );

    return NextResponse.json({
        success: true,
        message: "Pemindaian selesai.",
        data: {
            summary,
            results,
        },
    });
}