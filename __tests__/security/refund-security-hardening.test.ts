/* ==========================================
 * REFUND — SECURITY HARDENING REGRESSION TESTS
 * ==========================================
 *
 * Protects the customer → admin refund boundary:
 *   - customers can never read another user's bank /
 *     proof, upload proof, or drive refund state
 *   - admins are the only callers of approve /
 *     complete / proof endpoints
 *   - refund state transitions are CAS/atomic, and a
 *     refund can never be completed twice
 *   - proof upload is content-sniffed and fenced into
 *     non-public storage with traversal protection
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { maskAccountNumber } from "@/lib/refund-bank";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

const proofRoute = readFile(
    "app/api/admin/refunds/[id]/proof/route.ts"
);
const customerRefundRoute = readFile(
    "app/api/orders/[id]/refund/route.ts"
);
const customerOrderRoute = readFile(
    "app/api/orders/[id]/route.ts"
);
const refundLib = readFile("lib/refund.ts");
const schema = readFile("prisma/schema.prisma");
const adminRefundsRoute = readFile(
    "app/api/admin/refunds/route.ts"
);
const auditLog = readFile("lib/admin/audit-log.ts");

function refundUpdateBlock(source: string): string {
    const start = source.indexOf("prisma.refund.update");
    if (start === -1) return "";
    const end = source.indexOf("});", start);
    return end === -1 ? "" : source.slice(start, end);
}

/* ==========================================
 * CUSTOMER BOUNDARY
 * ========================================== */

describe("REFUND — customer cannot read/change another user's refund", () => {
    test("customer refund response only ever returns a MASKED account number", () => {
        // Success payload must call maskAccountNumber when
        // it mentions bankAccountNumber.
        expect(customerRefundRoute).toContain(
            "maskAccountNumber"
        );
        expect(customerRefundRoute).toMatch(
            /bankAccountNumber:\s*maskAccountNumber\(/
        );
        // The route must never surface a proof path.
        expect(customerRefundRoute).not.toContain(
            "proofFilePath"
        );
        expect(customerRefundRoute).not.toContain("proof");
    });

    test("customer order route never exposes refund bank/proof data", () => {
        expect(customerOrderRoute).not.toContain(
            "bankAccountNumber"
        );
        expect(customerOrderRoute).not.toContain(
            "proofFilePath"
        );
    });

    test("customer refund route only creates — no status change / proof / approve", () => {
        expect(customerRefundRoute).not.toContain(
            "approveRefund"
        );
        expect(customerRefundRoute).not.toContain(
            "executeRefundCompletion"
        );
        expect(customerRefundRoute).not.toContain(
            "GET"
        );
        expect(customerRefundRoute).toContain(
            "createRefundRequest"
        );
    });

    test("refund amount is server-authoritative (from order, not client)", () => {
        expect(refundLib).toContain("amount: order.total");
    });

    test("bank destination is immutable after the refund is created", () => {
        // No update path anywhere writes bank fields.
        const targets = [
            refundLib,
            proofRoute,
            adminRefundsRoute,
            readFile(
                "app/api/admin/orders/[id]/refund/route.ts"
            ),
        ];
        for (const source of targets) {
            expect(source).not.toMatch(
                /refund\.update\([\s\S]{0,400}?bankAccount/i
            );
            expect(source).not.toMatch(
                /refund\.update\([\s\S]{0,400}?bankName/i
            );
        }
    });
});

/* ==========================================
 * ADMIN ONLY + PROOF SAFETY
 * ========================================== */

describe("REFUND — admin-only proof flow + file safety", () => {
    test("proof POST and GET both enforce ADMIN", () => {
        const matches =
            proofRoute.match(/role !== "ADMIN"/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("proof upload never accepts SVG and sniffs magic bytes", () => {
        expect(proofRoute).not.toContain("svg");
        const allowed = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "application/pdf",
        ];
        for (const mime of allowed) {
            expect(proofRoute).toContain(mime);
        }
        expect(proofRoute).toContain("magicBytesMatch");
    });

    test("stored filename is server-generated (no filename/extension injection)", () => {
        expect(proofRoute).not.toContain("file.name");
        expect(proofRoute).toContain("randomBytes");
        expect(proofRoute).toContain("ALLOWED_TYPES[mime]");
    });

    test("GET is traversal-safe (resolved path fenced under storage/uploads)", () => {
        expect(proofRoute).toContain(
            "resolved.startsWith(storageRoot + path.sep)"
        );
        expect(proofRoute).toContain("resolved !== storageRoot");
        expect(proofRoute).toContain("Akses file ditolak.");
    });

    test("uploaded proof is post-read size capped (no trusting file.size)", () => {
        expect(proofRoute).toContain(
            "buffer.length > MAX_SIZE"
        );
        expect(proofRoute).toContain("file.size > MAX_SIZE");
    });

    test("served proof: no-sniff, private no-store, PDF as attachment", () => {
        expect(proofRoute).toContain(
            'X-Content-Type-Options": "nosniff'
        );
        expect(proofRoute).toContain('"private, no-store"');
        // PDF is served as attachment (never inline); images inline.
        expect(proofRoute).toMatch(
            /mime === "application\/pdf"[\s\S]{0,120}"attachment"/
        );
        expect(proofRoute).toMatch(
            /disposition[\s\S]{0,120}"inline"/
        );
    });

    function refundUpdateBlock(source: string): string {
        const start = source.indexOf(
            "prisma.refund.update"
        );
        if (start === -1) return "";
        const end = source.indexOf("});", start);
        return end === -1 ? "" : source.slice(start, end);
    }

    test("proof upload NEVER completes / changes refund status", () => {
        const uploadSection = proofRoute.slice(
            proofRoute.indexOf("function uploadProof"),
            proofRoute.indexOf("function serveProof")
        );
        expect(uploadSection).toContain(
            'refund.status !== "PENDING"'
        );
        expect(uploadSection).not.toContain("COMPLETED");
        // No status assignment ever happens during upload.
        expect(uploadSection).not.toMatch(
            /status\s*[:=]\s*['"]/
        );
        const block = refundUpdateBlock(uploadSection);
        expect(block).toContain("proofFilePath");
        expect(block).not.toMatch(/status\s*[:=]/);
    });

    test("admin refunds list is ADMIN-only and includes proof path", () => {
        expect(adminRefundsRoute).toContain(
            'role !== "ADMIN"'
        );
        expect(adminRefundsRoute).toContain("proofFilePath");
    });
});

/* ==========================================
 * STATE MACHINE + CONCURRENCY
 * ========================================== */

describe("REFUND — state transitions are atomic + non-duplicable", () => {
    test("creation is guarded against double refund (order CAS + unique orderId)", () => {
        expect(refundLib).toContain("existingRefund");
        expect(refundLib).toMatch(
            /status IN \('PAID', 'PROCESSING'\)/
        );
        expect(refundLib).toContain("paymentStatus = 'PAID'");
        expect(schema).toMatch(
            /orderId\s+Int\s+@unique/
        );
    });

    test("approval CAS: only PENDING → PROCESSING", () => {
        expect(refundLib).toMatch(
            /AND status = 'PENDING'/
        );
    });

    test("completion CAS: only PROCESSING → COMPLETED (no double-complete)", () => {
        expect(refundLib).toMatch(
            /AND status = 'PROCESSING'/
        );
        expect(refundLib).toContain(
            'refund.status === "COMPLETED"'
        );
    });

    test("proof upload and completion cannot race into a wrong state", () => {
        // Upload only touches proofFilePath, completion only
        // touches status — never combined.
        const block = refundUpdateBlock(proofRoute);
        expect(block).toContain("proofFilePath");
        expect(block).not.toMatch(/status\s*[:=]/);
    });

    test("audit log has both new actions and masks account numbers", () => {
        expect(auditLog).toContain(
            '"ORDER_TRACKING_ASSIGNED"'
        );
        expect(auditLog).toContain(
            '"REFUND_PROOF_UPLOADED"'
        );
        expect(auditLog).toMatch(/accountnumber\$/i);
    });
});

/* ==========================================
 * MASKING (runtime)
 * ========================================== */

describe("REFUND — maskAccountNumber runtime guard", () => {
    test("long account keeps only last 4 digits", () => {
        expect(
            maskAccountNumber("1234567890123456")
        ).toBe("****3456");
    });

    test("handles empty/short values safely", () => {
        expect(maskAccountNumber("")).toBe("****");
        expect(maskAccountNumber("12")).toBe("****");
    });
});