/* ==========================================
 * FEATURE A — RESI SCAN TESTS
 * ==========================================
 *
 * Pure-logic + source-integrity tests for the
 * scan-resi pipeline. No database required:
 * resolution logic is exercised against fixture
 * lookup data; routes are checked statically for
 * auth guards, file validation and the rule that
 * the SCAN route never writes.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    extractOrderReference,
    extractTrackingNumber,
    extractFields,
    isPlausibleTrackingNumber,
} from "@/lib/resi-scan/extract";
import { normalizeText } from "@/lib/resi-scan/normalize";
import {
    computeConfidence,
    classifyConfidence,
} from "@/lib/resi-scan/confidence";
import {
    resolveScanOutcome,
    resolveOrderReference,
} from "@/lib/resi-scan/engine";
import { validateScanFile } from "@/lib/resi-scan/file";
import type { ScanLookupData } from "@/lib/resi-scan/engine";
import type { ScanExtraction } from "@/lib/resi-scan/types";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

function makeLookup(
    rows: Array<{
        id: number;
        orderNumber: string;
        status?: string;
        paymentStatus?: string | null;
        trackingNumber?: string | null;
    }>,
    trackingOwners?: ScanLookupData["trackingOwners"]
): ScanLookupData {
    const owners =
        trackingOwners ??
        new Map<string, number>();
    return {
        orders: rows.map((r) => ({
            id: r.id,
            orderNumber: r.orderNumber,
            status: r.status ?? "PAID",
            paymentStatus: r.paymentStatus ?? "PAID",
            trackingNumber: r.trackingNumber ?? null,
        })),
        trackingOwners: owners,
    };
}

function extraction(
    patch: Partial<ScanExtraction>
): ScanExtraction {
    return {
        rawText: "",
        orderReference: null,
        trackingNumber: null,
        source: "pdf-text",
        warnings: [],
        ...patch,
    };
}

/* ==========================================
 * EXTRACTION
 * ========================================== */

describe("Resi Scan — label variants", () => {
    test("extracts resi from Indonesian label (No Resi)", () => {
        expect(
            extractTrackingNumber(
                "No Resi: SJPH1234567890"
            )
        ).toBe("SJPH1234567890");
    });

    test.each([
        ["Nomor Resi : 123456789012345", "123456789012345"],
        ["No. Resi : JP123456789", "JP123456789"],
        ["resi pengiriman: 0001234567890123", "0001234567890123"],
        ["Tracking Number: JT1234567890123", "JT1234567890123"],
        ["No. Awb : SPXID0123456789012", "SPXID0123456789012"],
        ["Nomor AWB  0009876543210123", "0009876543210123"],
        ["Kode resi: NINJA12345678901", "NINJA12345678901"],
        ["Tracking No: IDEX123456789012", "IDEX123456789012"],
    ])("extractTrackingNumber(%s) => %s", (text, expected) => {
        expect(extractTrackingNumber(text)).toBe(expected);
    });

    test("extracts order id from numeric label", () => {
        expect(
            extractOrderReference(
                "Order ID: 10293847"
            )
        ).toBe("10293847");
    });

    test.each([
        [
            "Nomor Order : ORD-1745012345678-abc12345",
            "ORD-1745012345678-ABC12345",
        ],
        [
            "No. Order: PAY-BN-1745012345678-abc12345",
            "PAY-BN-1745012345678-ABC12345",
        ],
    ])("extractOrderReference(%s) => %s", (text, expected) => {
        expect(extractOrderReference(text)).toBe(expected);
    });

    test("extractFields returns both fields from a combined label block", () => {
        const fields = extractFields(
            "Nomor Pesanan: ORD-1745012345678-abc12345\n" +
                "No. Resi: SJPH1234567890\n" +
                "Tanggal: 22/09/2026"
        );
        expect(fields.orderReference).toBe(
            "ORD-1745012345678-ABC12345"
        );
        expect(fields.trackingNumber).toBe(
            "SJPH1234567890"
        );
    });

    test("does NOT extract a non-reference from Order Total", () => {
        expect(
            extractOrderReference(
                "Pembayaran — Order Total: Rp 500.000"
            )
        ).toBeNull();
    });
});

/* ==========================================
 * TRACKING PLAUSIBILITY (OCR-safety)
 * ========================================== */

describe("Resi Scan — tracking plausibility", () => {
    test("accepts standard courier resi formats", () => {
        expect(
            isPlausibleTrackingNumber("SJPH1234567890")
        ).toBe(true);
        expect(
            isPlausibleTrackingNumber("JP123456789")
        ).toBe(true);
        expect(
            isPlausibleTrackingNumber("123456789012345")
        ).toBe(true);
    });

    test("rejects order-number tokens as resi", () => {
        expect(
            isPlausibleTrackingNumber(
                "ORD-1745012345678-ABC12345"
            )
        ).toBe(false);
        expect(
            isPlausibleTrackingNumber(
                "PAY-BN-1745012345678-ABC12345"
            )
        ).toBe(false);
    });

    test("rejects short numerics (order ids / dates / phones)", () => {
        expect(
            isPlausibleTrackingNumber("20260922")
        ).toBe(false);
        expect(
            isPlausibleTrackingNumber("123456789")
        ).toBe(false);
        expect(
            isPlausibleTrackingNumber("12345")
        ).toBe(false);
    });

    test("rejects repeated single-character sequences", () => {
        expect(
            isPlausibleTrackingNumber("AAAAAAAA")
        ).toBe(false);
        expect(
            isPlausibleTrackingNumber("111111111")
        ).toBe(false);
    });

    test("does NOT apply OCR typo substitutions (O->0, I->1, S->5)", () => {
        // A resi extracted via OCR must equal its text
        // representation — no aggressive correction.
        expect(
            extractTrackingNumber("No Resi: SJPH1I2345678")
        ).toBe("SJPH1I2345678"); // 'I' kept, not turned into '1'
        expect(
            extractTrackingNumber("No Resi: SJPH0OO123456")
        ).toBe("SJPH0OO123456");
    });

    test("normalizeText collapses whitespace only", () => {
        expect(
            normalizeText("Nomor  Resi:\n\t123  ABC  ")
        ).toBe("Nomor Resi: 123 ABC");
    });
});

/* ==========================================
 * CONFIDENCE SCORING
 * ========================================== */

describe("Resi Scan — confidence tiers", () => {
    test("clean pdf-text match scores HIGH", () => {
        const { tier, score } = computeConfidence({
            source: "pdf-text",
            orderFound: true,
            trackingValid: true,
            orderEligible: true,
            alreadyHasTracking: false,
            matchingExistingTracking: false,
            trackingInUseByOtherOrder: false,
            referenceMissing: false,
        });
        expect(tier).toBe("HIGH");
        expect(score).toBeGreaterThanOrEqual(0.65);
    });

    test("ocr with matching order lands in MEDIUM (needs review)", () => {
        const { tier } = computeConfidence({
            source: "ocr",
            orderFound: true,
            trackingValid: true,
            orderEligible: true,
            alreadyHasTracking: false,
            matchingExistingTracking: false,
            trackingInUseByOtherOrder: false,
            referenceMissing: true,
        });
        expect(tier).toBe("MEDIUM");
    });

    test("pdf-text clean match never requires review", () => {
        const { tier } = computeConfidence({
            source: "pdf-text",
            orderFound: true,
            trackingValid: true,
            orderEligible: true,
            alreadyHasTracking: false,
            matchingExistingTracking: false,
            trackingInUseByOtherOrder: false,
            referenceMissing: true,
        });
        expect(tier).toBe("HIGH");
    });

    test("order not found drops to LOW", () => {
        const { tier } = computeConfidence({
            source: "pdf-text",
            orderFound: false,
            trackingValid: true,
            orderEligible: false,
            alreadyHasTracking: false,
            matchingExistingTracking: false,
            trackingInUseByOtherOrder: false,
            referenceMissing: false,
        });
        expect(tier).toBe("LOW");
    });

    test("classifyConfidence boundaries", () => {
        expect(classifyConfidence(0.7)).toBe("HIGH");
        expect(classifyConfidence(0.65)).toBe("HIGH");
        expect(classifyConfidence(0.5)).toBe("MEDIUM");
        expect(classifyConfidence(0.34)).toBe("LOW");
    });
});

/* ==========================================
 * RESOLUTION OUTCOMES (fixture DB lookup)
 * ========================================== */

describe("Resi Scan — resolution outcomes", () => {
    const lookup = makeLookup(
        [
            {
                id: 41,
                orderNumber:
                    "ORD-1745012345678-ABC12345",
                status: "PAID",
                paymentStatus: "PAID",
                trackingNumber: null,
            },
            {
                id: 42,
                orderNumber:
                    "ORD-1745012345679-ABC12346",
                status: "PAID",
                paymentStatus: "PAID",
                trackingNumber: "SJPH9999999999",
            },
        ],
        new Map([
            ["sjph8888888888", 41],
        ])
    );

    test("MATCHED_READY for clean high-confidence order match", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference:
                    "ORD-1745012345678-ABC12345",
                trackingNumber: "SJPH1234567890",
            }),
            lookup
        );
        expect(outcome.status).toBe("MATCHED_READY");
        expect(outcome.resolution.orderId).toBe(41);
        expect(outcome.resolution.trackingInUseByOtherOrder).toBe(false);
    });

    test("NEEDS_REVIEW for OCR-matched doc until admin confirms", () => {
        const outcome = resolveScanOutcome(
            extraction({
                source: "ocr",
                orderReference:
                    "ORD-1745012345678-ABC12345",
                trackingNumber: "SJPH1234567890",
                warnings: [],
            }),
            lookup
        );
        expect(outcome.status).toBe("NEEDS_REVIEW");
        expect(outcome.confidence).toBeLessThan(0.65);
        expect(outcome.confidence).toBeGreaterThanOrEqual(0.35);
    });

    test("NOT_FOUND when order reference matches nothing", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference: "999999",
                trackingNumber: "SJPH1234567890",
            }),
            lookup
        );
        expect(outcome.status).toBe("NOT_FOUND");
        expect(outcome.confidence).toBeLessThan(0.35);
    });

    test("INVALID when extracted tracking is not a plausible resi", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference:
                    "ORD-1745012345678-ABC12345",
                trackingNumber: "12345",
            }),
            lookup
        );
        expect(outcome.status).toBe("INVALID");
    });

    test("CONFLICT when order already has a different resi — no silent overwrite", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference:
                    "ORD-1745012345679-ABC12346",
                trackingNumber: "SJPH1234567890",
            }),
            lookup
        );
        expect(outcome.status).toBe("CONFLICT");
        expect(outcome.resolution.existingTracking).toBe("SJPH9999999999");
        expect(outcome.warnings.join(" ")).toMatch(/berbeda/i);
    });

    test("DUPLICATE_SAME when order already has the same resi", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference:
                    "ORD-1745012345679-ABC12346",
                trackingNumber: "SJPH9999999999",
            }),
            lookup
        );
        expect(outcome.status).toBe("DUPLICATE_SAME");
    });

    test("CONFLICT when resi is already used by another order", () => {
        const outcome = resolveScanOutcome(
            extraction({
                orderReference:
                    "ORD-1745012345679-ABC12346",
                trackingNumber: "SJPH8888888888",
            }),
            lookup
        );
        expect(outcome.status).toBe("CONFLICT");
        expect(outcome.resolution.trackingInUseByOtherOrder).toBe(true);
    });

    test("CONFLICT when order status blocks tracking", () => {
        const blockedLookup = makeLookup([
            {
                id: 77,
                orderNumber: "ORD-1711111111111-AAA11111",
                status: "CANCELLED",
                paymentStatus: "PAID",
                trackingNumber: null,
            },
        ]);
        const outcome = resolveScanOutcome(
            extraction({
                orderReference: "ORD-1711111111111-AAA11111",
                trackingNumber: "SJPH1234567890",
            }),
            blockedLookup
        );
        expect(outcome.status).toBe("CONFLICT");
    });

    test("EXTRACTION_FAILED when nothing was extracted", () => {
        const outcome = resolveScanOutcome(
            extraction({}),
            lookup
        );
        expect(outcome.status).toBe("EXTRACTION_FAILED");
    });

    test("resolveOrderReference parses numeric id and orderNumber", () => {
        expect(resolveOrderReference("1234")).toEqual({
            numericId: 1234,
        });
        expect(
            resolveOrderReference("ORD-1745012345678-ABC12345")
        ).toEqual({
            orderNumber: "ORD-1745012345678-ABC12345",
        });
        expect(resolveOrderReference(null)).toBeNull();
    });
});

/* ==========================================
 * FILE VALIDATION (magic bytes)
 * ========================================== */

describe("Resi Scan — file validation", () => {
    function pngBuffer(): Buffer {
        return Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a,
            0x1a, 0x0a, 0, 0, 0, 0,
        ]);
    }

    test("accepts a valid PNG with matching magic bytes", () => {
        const result = validateScanFile(
            {
                name: "scan.png",
                size: 12,
                type: "image/png",
            },
            pngBuffer()
        );
        expect(result.ok).toBe(true);
        expect(result.kind).toBe("png");
    });

    test("rejects a renamed payload (jpeg magic, png extension)", () => {
        const jpegMagic = Buffer.from([
            0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0,
            0, 0, 0, 0,
        ]);
        const result = validateScanFile(
            {
                name: "scan.png",
                size: 12,
                type: "image/png",
            },
            jpegMagic
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/ekstensi/i);
    });

    test("rejects disallowed extension", () => {
        const result = validateScanFile(
            {
                name: "scan.exe",
                size: 12,
                type: "application/pdf",
            },
            Buffer.concat([
                Buffer.from("%PDF"),
                Buffer.alloc(8),
            ])
        );
        expect(result.ok).toBe(false);
    });

    test("rejects MIME mismatch", () => {
        const result = validateScanFile(
            {
                name: "scan.pdf",
                size: 12,
                type: "text/plain",
            },
            Buffer.concat([
                Buffer.from("%PDF"),
                Buffer.alloc(8),
            ])
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/tipe file/i);
    });
});

/* ==========================================
 * ROUTE SECURITY (source integrity)
 * ========================================== */

describe("Resi Scan — route authorization & safety", () => {
    test("SCAN route requires ADMIN and rejects non-admins with 403", () => {
        const code = readFile(
            "app/api/admin/resi-scan/route.ts"
        );
        expect(code).toContain('role !== "ADMIN"');
        expect(code).toContain("{ status: 403 }");
        expect(code).toContain("Unauthorized.");
    });

    test("SCAN route never writes to the database", () => {
        const code = readFile(
            "app/api/admin/resi-scan/route.ts"
        );
        expect(code).not.toMatch(/\.update\(/);
        expect(code).not.toMatch(/\$transaction/);
        expect(code).toMatch(/\.findMany\(/);
    });

    test("SCAN route validates magic bytes + extension + size", () => {
        const code = readFile(
            "app/api/admin/resi-scan/route.ts"
        );
        expect(code).toContain("validateScanFile");
        expect(code).toContain("SCAN_MAX_FILES_PER_BATCH");
    });

    test("APPLY route requires ADMIN and caps batch size", () => {
        const code = readFile(
            "app/api/admin/resi-scan/apply/route.ts"
        );
        expect(code).toContain('role !== "ADMIN"');
        expect(code).toContain("{ status: 403 }");
        expect(code).toContain("MAX_ITEMS");
    });

    test("APPLY re-validates tracking server-side", () => {
        const code = readFile(
            "app/api/admin/resi-scan/apply/route.ts"
        );
        expect(code).toContain("isPlausibleTrackingNumber");
    });

    test("APPLY is safe per item (no overwrite semantics)", () => {
        const applyLib = readFile(
            "lib/resi-scan/apply.ts"
        );
        // Never overwrites an existing different resi
        expect(applyLib).toMatch(/trackingNumber\)\s*\{/);
        expect(applyLib).toMatch(/tidak menimpa resi existing/i);
        expect(applyLib).toMatch(/\$transaction/);
    });

    test("APPLY writes an audit log on success", () => {
        const applyLib = readFile(
            "lib/resi-scan/apply.ts"
        );
        expect(applyLib).toContain("createAuditLog");
        expect(applyLib).toContain(
            "ORDER_TRACKING_ASSIGNED"
        );
    });

    test("audit actions include ORDER_TRACKING_ASSIGNED", () => {
        const audit = readFile(
            "lib/admin/audit-log.ts"
        );
        expect(audit).toContain(
            "ORDER_TRACKING_ASSIGNED"
        );
    });
});