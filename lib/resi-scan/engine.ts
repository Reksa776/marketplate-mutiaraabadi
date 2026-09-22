/* ==========================================
 * RESI SCAN — ENGINE
 * ==========================================
 *
 * Orchestrates the scan pipeline:
 *   1. extract text (PDF text → OCR fallback)
 *   2. extract order reference + tracking number
 *   3. resolve against lookup data (orders +
 *      tracking ownership) and assign a status +
 *      confidence tier.
 *
 * The DB lookups are injected via ScanLookupData
 * so the resolution logic stays pure and testable;
 * the API routes are responsible for loading the
 * lookup in one batched query.
 */

import { ORDER_NUMBER_PATTERN } from "./extract";
import {
    extractFields,
    isPlausibleTrackingNumber,
} from "./extract";
import { computeConfidence } from "./confidence";
import { extractPdfText, renderPdfFirstPagePng } from "./pdf";
import { extractImageText } from "./ocr";
import { PDF_MIN_MEANINGFUL_CHARS } from "./pdf";
import type {
    DetectedKind,
} from "./file";
import type {
    ScanDocumentResult,
    ScanExtraction,
    ScanStatus,
} from "./types";

export interface OrderLookupRow {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string | null;
    trackingNumber: string | null;
}

export interface ScanLookupData {
    orders: OrderLookupRow[];
    /** lowercase trackingNumber → order id */
    trackingOwners: Map<string, number>;
}

export interface ResolvedReference {
    orderNumber?: string;
    numericId?: number;
}

export function resolveOrderReference(
    reference: string | null
): ResolvedReference | null {
    if (!reference) return null;

    if (ORDER_NUMBER_PATTERN.test(reference)) {
        return { orderNumber: reference };
    }

    if (/^\d{1,9}$/.test(reference)) {
        return { numericId: Number(reference) };
    }

    if (/^(ORD|PAY-BN|PAY-CART)-/i.test(reference)) {
        return { orderNumber: reference };
    }

    return null;
}

export function findOrderByReference(
    lookup: ScanLookupData,
    reference: ResolvedReference | null
): OrderLookupRow | null {
    if (!reference) return null;

    if (reference.numericId !== undefined) {
        const byId = lookup.orders.find(
            (o) => o.id === reference.numericId
        );
        if (byId) return byId;
    }

    if (reference.orderNumber) {
        return (
            lookup.orders.find(
                (o) =>
                    o.orderNumber === reference.orderNumber
            ) ?? null
        );
    }

    return null;
}

export function isBlockedOrderStatus(status: string): boolean {
    return status === "CANCELLED";
}

export function isBlockedPaymentStatus(
    paymentStatus: string | null
): boolean {
    return paymentStatus === "REFUNDED";
}

function pickStatus(
    extraction: ScanExtraction,
    trackingValid: boolean,
    order: OrderLookupRow | null,
    orderExists: boolean,
    matchingExisting: boolean,
    trackingInUseElsewhere: boolean,
    score: number
): ScanStatus {
    if (
        !extraction.trackingNumber &&
        !extraction.orderReference
    ) {
        return "EXTRACTION_FAILED";
    }

    if (!trackingValid) {
        return "INVALID";
    }

    if (orderExists && matchingExisting) {
        return "DUPLICATE_SAME";
    }

    if (
        orderExists &&
        order?.trackingNumber &&
        order.trackingNumber.toLowerCase() !==
            extraction.trackingNumber!.toLowerCase()
    ) {
        return "CONFLICT";
    }

    if (orderExists && trackingInUseElsewhere) {
        return "CONFLICT";
    }

    if (!orderExists && trackingInUseElsewhere) {
        return "CONFLICT";
    }

    if (!orderExists) {
        return "NOT_FOUND";
    }

    if (
        order &&
        (isBlockedOrderStatus(order.status) ||
            isBlockedPaymentStatus(order.paymentStatus))
    ) {
        return "CONFLICT";
    }

    return score >= 0.65 ? "MATCHED_READY" : "NEEDS_REVIEW";
}

export function resolveScanOutcome(
    extraction: ScanExtraction,
    lookup: ScanLookupData
): Omit<
    ScanDocumentResult,
    | "index"
    | "fileName"
    | "fileSize"
    | "fileMime"
    | "fileExt"
> {
    const reference = resolveOrderReference(
        extraction.orderReference
    );
    const order = findOrderByReference(lookup, reference);

    const orderExists = !!order;
    const tracking = extraction.trackingNumber;
    const trackingValid =
        tracking !== null &&
        isPlausibleTrackingNumber(tracking);

    const trackingKey = tracking?.toLowerCase();
    const trackingOwnerId = trackingKey
        ? lookup.trackingOwners.get(trackingKey)
        : undefined;

    const trackingInUseByOtherOrder =
        !!trackingKey &&
        trackingOwnerId !== undefined &&
        (!orderExists || trackingOwnerId !== order!.id);

    const matchingExisting =
        !!order &&
        !!order.trackingNumber &&
        tracking !== null &&
        order.trackingNumber.toLowerCase() ===
            tracking.toLowerCase();

    const orderEligible =
        orderExists &&
        !!order &&
        !isBlockedOrderStatus(order.status) &&
        !isBlockedPaymentStatus(order.paymentStatus);

    const { score } = computeConfidence({
        source: extraction.source,
        orderFound: orderExists,
        trackingValid,
        orderEligible,
        alreadyHasTracking:
            !!order?.trackingNumber,
        matchingExistingTracking: matchingExisting,
        trackingInUseByOtherOrder,
        referenceMissing: !extraction.orderReference,
    });

    const status = pickStatus(
        extraction,
        trackingValid,
        order,
        orderExists,
        matchingExisting,
        trackingInUseByOtherOrder,
        score
    );

    const warnings = [...extraction.warnings];

    if (!orderExists && extraction.orderReference) {
        warnings.push(
            "Pesanan tidak ditemukan berdasarkan referensi pada dokumen."
        );
    }

    if (trackingInUseByOtherOrder) {
        warnings.push(
            "Nomor resi tersebut sudah terpakai oleh pesanan lain."
        );
    }

    if (
        orderExists &&
        order!.trackingNumber &&
        !matchingExisting
    ) {
        warnings.push(
            "Pesanan sudah memiliki nomor resi berbeda."
        );
    }

    if (orderExists && !orderEligible) {
        warnings.push(
            "Status pesanan tidak mengizinkan penambahan resi."
        );
    }

    return {
        source:
            extraction.source,
        rawText: extraction.rawText,
        orderReference: extraction.orderReference,
        trackingNumber: tracking,
        warnings,
        confidence: score,
        status,
        resolution: {
            orderId: order?.id ?? null,
            orderNumber: order?.orderNumber ?? null,
            orderStatus: order?.status ?? null,
            paymentStatus:
                order?.paymentStatus ?? null,
            orderExists,
            orderEligible,
            alreadyHasTracking: !!order?.trackingNumber,
            existingTracking:
                order?.trackingNumber ?? null,
            matchingExistingTracking: matchingExisting,
            trackingInUseByOtherOrder,
            trackingValid,
        },
    };
}

/**
 * Run text extraction on an uploaded file.
 * PDFs go through pdf-parse first; if no text is
 * present (scanned PDF) we render page 1 to a PNG
 * and OCR it. Images go straight to OCR.
 */
export async function extractDocumentText(
    kind: DetectedKind,
    buffer: Buffer
): Promise<ScanExtraction> {
    try {
        if (kind === "pdf") {
            const warnings: string[] = [];
            const text = await extractPdfText(buffer);

            if (text.trim().length >= PDF_MIN_MEANINGFUL_CHARS) {
                const fields = extractFields(text);
                return {
                    rawText: text,
                    orderReference:
                        fields.orderReference,
                    trackingNumber:
                        fields.trackingNumber,
                    source: "pdf-text",
                    warnings,
                };
            }

            warnings.push(
                "PDF tidak mengandung teks pencarian langsung — mencoba OCR halaman pertama."
            );

            const pagePng =
                await renderPdfFirstPagePng(buffer);
            if (!pagePng) {
                return {
                    rawText: "",
                    orderReference: null,
                    trackingNumber: null,
                    source: "ocr",
                    warnings: [
                        ...warnings,
                        "PDF terscan tidak dapat dirender untuk OCR.",
                    ],
                };
            }

            const ocr = await extractImageText(pagePng);
            if (!ocr.ok) {
                return {
                    rawText: "",
                    orderReference: null,
                    trackingNumber: null,
                    source: "ocr",
                    warnings: [
                        ...warnings,
                        ocr.error,
                    ],
                };
            }

            const fields = extractFields(ocr.text);
            return {
                rawText: ocr.text,
                orderReference:
                    fields.orderReference,
                trackingNumber: fields.trackingNumber,
                source: "ocr",
                warnings,
            };
        }

        const ocr = await extractImageText(buffer);
        if (!ocr.ok) {
            return {
                rawText: "",
                orderReference: null,
                trackingNumber: null,
                source: "ocr",
                warnings: [ocr.error],
            };
        }

        const fields = extractFields(ocr.text);
        return {
            rawText: ocr.text,
            orderReference: fields.orderReference,
            trackingNumber: fields.trackingNumber,
            source: "ocr",
            warnings: [],
        };
    } catch (error) {
        console.error(
            "RESI_SCAN_EXTRACT_ERROR:",
            error instanceof Error ? error.message : error
        );
        return {
            rawText: "",
            orderReference: null,
            trackingNumber: null,
            source: "ocr",
            warnings: [
                "Terjadi kesalahan saat mengekstrak dokumen.",
            ],
        };
    }
}

export function buildTrackingOwnerMap(
    rows: Array<{
        id: number;
        trackingNumber: string | null;
    }>
): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
        if (row.trackingNumber) {
            map.set(
                row.trackingNumber.toLowerCase(),
                row.id
            );
        }
    }
    return map;
}