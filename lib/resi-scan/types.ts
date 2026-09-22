/* ==========================================
 * RESI SCAN — SHARED TYPES
 * ==========================================
 *
 * Types shared across the resi-scan pipeline
 * (normalize → extract → validate → resolve
 *  → apply). Kept framework-agnostic so the
 * core logic can be reused by API routes and
 * tested without a running server.
 */

export type ScanSource =
    | "pdf-text"
    | "ocr";

export type ScanStatus =
    | "MATCHED_READY" // HIGH: order found, tracking valid, no conflict → auto-assignable
    | "NEEDS_REVIEW" // MEDIUM: order found but ambiguous → requires admin confirmation
    | "CONFLICT" // existing different tracking / resi used by another order / blocked
    | "NOT_FOUND" // order reference did not match any order (LOW — never auto-apply)
    | "INVALID" // tracking number failed format validation (LOW)
    | "DUPLICATE_SAME" // order already has this exact tracking (SKIP)
    | "EXTRACTION_FAILED"; // no text/order/tracking could be extracted (LOW)

export interface ScanExtraction {
    rawText: string;
    orderReference: string | null;
    trackingNumber: string | null;
    source: ScanSource;
    warnings: string[];
}

export interface ScanResolution {
    orderId: number | null;
    orderNumber: string | null;
    orderStatus: string | null;
    paymentStatus: string | null;
    orderExists: boolean;
    orderEligible: boolean;
    alreadyHasTracking: boolean;
    existingTracking: string | null;
    matchingExistingTracking: boolean;
    trackingInUseByOtherOrder: boolean;
    trackingValid: boolean;
}

export interface ScanDocumentResult {
    index: number;
    fileName: string;
    fileSize: number;
    fileMime: string;
    fileExt: string;
    source: ScanSource | null;
    rawText: string;
    orderReference: string | null;
    trackingNumber: string | null;
    warnings: string[];
    confidence: number;
    status: ScanStatus;
    resolution: ScanResolution;
}

export type ApplyResultStatus =
    | "APPLIED" // tracking stored
    | "ALREADY_SAME" // identical resi already on order
    | "CONFLICT" // different resi / used elsewhere / order blocked
    | "NOT_FOUND" // order missing
    | "INVALID"; // tracking format invalid

export interface ApplyScanItem {
    orderId: number;
    orderNumber: string | null;
    reference: string | null;
    trackingNumber: string;
    courier: string | null;
    source: ScanSource;
    confidence: number;
    fileName: string | null;
}

export interface ApplyScanResult {
    orderId: number | null;
    orderNumber: string | null;
    trackingNumber: string;
    status: ApplyResultStatus;
    message: string;
}