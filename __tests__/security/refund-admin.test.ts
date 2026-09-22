/* ==========================================
 * FEATURE B — REFUND ADMIN TESTS
 * ==========================================
 *
 * Covers destination-bank collection/masking,
 * proof upload security, and the guarantee that
 * a refund never reaches COMPLETED without an
 * explicit admin confirmation (uploading proof OR
 * opening the view must not change status).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    maskAccountNumber,
    validateBankFields,
} from "@/lib/refund-bank";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/* ==========================================
 * BANK VALIDATION + MASKING
 * ========================================== */

describe("Refund — bank fields", () => {
    test("accepts a valid bank set and normalizes the number", () => {
        const result = validateBankFields(
            "BCA",
            "Budi Santoso",
            " 1234-5678-9012 "
        );
        expect(result.ok).toBe(true);
        expect(result.bankAccountNumber).toBe(
            "123456789012"
        );
        expect(result.bankName).toBe("BCA");
    });

    test("rejects missing bank name", () => {
        const result = validateBankFields(
            "",
            "Budi",
            "12345678"
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/wajib diisi/i);
    });

    test("rejects account number containing letters", () => {
        const result = validateBankFields(
            "BCA",
            "Budi",
            "1234ABCD567"
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/tidak valid/i);
    });

    test("rejects account holder with markup characters", () => {
        const result = validateBankFields(
            "BCA",
            "Budi <script>",
            "123456789012"
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/karakter tidak valid/i);
    });

    test("maskAccountNumber keeps only the last 4 digits", () => {
        expect(
            maskAccountNumber("1234567890123456")
        ).toBe("****3456");
    });

    test("maskAccountNumber handles short values safely", () => {
        expect(maskAccountNumber("1234")).toBe("****");
        expect(maskAccountNumber("")).toBe("****");
    });
});

/* ==========================================
 * CUSTOMER REFUND REQUEST
 * ========================================== */

describe("Refund — customer request route", () => {
    test("customer route never exposes admin actions (approve/complete/reject)", () => {
        const code = readFile(
            "app/api/orders/[id]/refund/route.ts"
        );
        expect(code).not.toContain('"approve"');
        expect(code).not.toContain('"complete"');
        expect(code).not.toContain('"reject"');
        expect(code).toContain("createRefundRequest");
    });

    test("customer request validates destination bank (server-side lib)", () => {
        const code = readFile(
            "app/api/orders/[id]/refund/route.ts"
        );
        expect(code).toContain(
            "validateBankFields"
        );
        const lib = readFile("lib/refund-bank.ts");
        expect(lib).toContain(
            "Nama bank wajib diisi."
        );
        expect(lib).toContain(
            "Nomor rekening wajib diisi."
        );
    });

    test("customer request returns only a masked account number", () => {
        const code = readFile(
            "app/api/orders/[id]/refund/route.ts"
        );
        expect(code).toMatch(
            /maskAccountNumber\(/
        );
        // The raw account number and holder must not be
        // echoed back into the success payload.
        expect(code).toContain(
            'bankAccountNumber: maskAccountNumber'
        );
        expect(code).not.toContain(
            '"bankAccountNumber": bankAccountNumber'
        );
    });

    test("createRefundRequest stores bank fields on the record", () => {
        const lib = readFile("lib/refund.ts");
        expect(lib).toContain("bankName");
        expect(lib).toContain("bankAccountName");
        expect(lib).toContain("bankAccountNumber");
        expect(lib).toContain("bank?.bankAccountNumber");
    });

    test("Refund model has destination-bank + proof fields", () => {
        const schema = readFile(
            "prisma/schema.prisma"
        );
        expect(schema).toContain("bankName");
        expect(schema).toContain("bankAccountName");
        expect(schema).toContain("bankAccountNumber");
        expect(schema).toContain("proofFilePath");
    });

    test("migration for refund bank + proof is non-destructive", () => {
        const migration = readFile(
            "prisma/migrations/20260922010000_add_refund_bank_and_proof/migration.sql"
        );
        expect(migration).toMatch(/^\s*-- AddRefundBankAndProof/i);
        expect(migration).toContain("ALTER TABLE `refund`");
        expect(migration).toMatch(/ADD COLUMN/);
        expect(migration).not.toMatch(/DROP COLUMN|DELETE FROM|DROP TABLE/i);
    });
});

/* ==========================================
 * REFUND STATE MACHINE — explicit confirmation
 * ========================================== */

describe("Refund — COMPLETED requires explicit admin confirmation", () => {
    test("executeRefundCompletion only accepts PROCESSING", () => {
        const lib = readFile("lib/refund.ts");
        expect(lib).toContain(
            'refund.status !== "PROCESSING"'
        );
        expect(lib).toMatch(
            /Refund dengan status/
        );
    });

    test("admin approves first (PENDING→PROCESSING) and completes separately", () => {
        const route = readFile(
            "app/api/admin/orders/[id]/refund/route.ts"
        );
        expect(route).toContain('case "approve"');
        expect(route).toContain('case "complete"');
        expect(route).toContain('case "reject"');
        // complete must go through the shared lib, not
        // a direct status write.
        expect(route).toContain("completeRefund");
        const lib = readFile("lib/refund.ts");
        expect(lib).toContain(
            "export async function executeRefundCompletion"
        );
        expect(lib).toMatch(
            /export async function completeRefund/
        );
        expect(lib).toMatch(
            /completeRefund\([\s\S]*executeRefundCompletion\(refundId, providerRef, "ADMIN"\)/
        );
    });

    test("proof upload never changes refund status to COMPLETED", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        const uploadBlock = proofRoute.slice(
            0,
            proofRoute.indexOf("async function serveProof")
        );
        expect(uploadBlock).toContain("proofFilePath");
        expect(uploadBlock).not.toContain(
            "status: \"COMPLETED\""
        );
        expect(uploadBlock).not.toContain(
            "excuteRefundCompletion"
        );
        expect(uploadBlock).not.toContain(
            "executeRefundCompletion"
        );
        // Only proofFilePath may be written by the upload.
        expect(uploadBlock).toMatch(
            /data: \{ proofFilePath: relativePath \}/
        );
    });

    test("complete action is triggered only by an explicit admin button", () => {
        const page = readFile(
            "app/admin/refunds/page.tsx"
        );
        expect(page).toContain(
            "Konfirmasi Refund Selesai"
        );
        expect(page).toContain('action === "complete"');
    });
});

/* ==========================================
 * PROOF UPLOAD SECURITY
 * ========================================== */

describe("Refund — proof upload & access control", () => {
    test("proof route is ADMIN-only (upload + view)", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        expect(proofRoute).toContain('role !== "ADMIN"');
        expect(proofRoute).toContain("{ status: 403 }");
        expect(proofRoute).toContain("{ status: 401 }");
    });

    test("proof route validates magic bytes, size, and MIME", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        expect(proofRoute).toContain(
            "magicBytesMatch"
        );
        expect(proofRoute).toContain("MAX_SIZE");
        expect(proofRoute).toContain("ALLOWED_TYPES");
    });

    test("proof files live under storage/uploads and are never public", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        expect(proofRoute).toContain(
            '"storage"',
        );
        expect(proofRoute).toContain("uploads");
        expect(proofRoute).toContain("private, no-store");
    });

    test("serve endpoint guards against path traversal", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        expect(proofRoute).toContain("path.resolve");
        expect(proofRoute).toContain("startsWith");
        expect(proofRoute).toMatch(/storageRoot \+ path\.sep/);
    });

    test("upload only allowed for PENDING or PROCESSING refunds", () => {
        const proofRoute = readFile(
            "app/api/admin/refunds/[id]/proof/route.ts"
        );
        expect(proofRoute).toContain(
            'refund.status !== "PENDING"'
        );
        expect(proofRoute).toContain(
            'refund.status !== "PROCESSING"'
        );
    });

    test("admin refunds list exposes bank + proof only through admin route", () => {
        const route = readFile(
            "app/api/admin/refunds/route.ts"
        );
        expect(route).toContain('role !== "ADMIN"');
        expect(route).toContain("bankName");
        expect(route).toContain("bankAccountNumber");
        expect(route).toContain("proofFilePath");
    });

    test("audit metadata masks bank account numbers", () => {
        const audit = readFile(
            "lib/admin/audit-log.ts"
        );
        expect(audit).toMatch(
            /accountnumber\$/i
        );
        expect(audit).toContain('"****" + value.slice(-4)');
    });
});