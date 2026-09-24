/* ==========================================
 * RESI SCAN — PDF TEXT EXTRACTION TESTS
 * ==========================================
 *
 * Runs the REAL pdf-parse / pdf.js parser (no
 * mocks) against a generated text PDF, so the
 * extraction contract used by
 * POST /api/admin/resi-scan is locked:
 *
 *   - order id + tracking number are extracted
 *   - a PDF without text falls back (empty text,
 *     caller renders page 1 for OCR)
 *   - corrupt input fails gracefully at the
 *     engine boundary — never an unhandled throw
 *
 * It also guards the deployment invariant that
 * broke in production: pdf.js's Node "fake
 * worker" imports `./pdf.worker.mjs` RELATIVE to
 * its own module URL, so the parser must run from
 * node_modules instead of a bundled chunk.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    PDF_MIN_MEANINGFUL_CHARS,
    extractPdfText,
    renderPdfFirstPagePng,
} from "@/lib/resi-scan/pdf";
import { extractFields } from "@/lib/resi-scan/extract";
import { extractDocumentText } from "@/lib/resi-scan/engine";

jest.setTimeout(60_000);

const ORDER_NUMBER = "ORD-1745012345678";
const TRACKING = "JNE123456789";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/*
 * Guards below assert on CODE, so documentation that
 * explains the worker trap is stripped first.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ==========================================
 * MINIMAL PDF BUILDER
 * ==========================================
 * Uncompressed single page, Helvetica text —
 * exactly what pdf.js reads deterministically.
 * Built with correct xref offsets so the parser
 * has to do real work (no "repair mode").
 */

function escapePdfText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
}

function buildTextPdf(lines: string[]): Buffer {
    const stream = lines
        .map(
            (line, i) =>
                `BT /F1 22 Tf 50 ${760 - i * 44} Td (${escapePdfText(line)}) Tj ET`
        )
        .join("\n");

    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];

    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(pdf, "latin1"));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
}

/* A page whose content stream has no text at all. */
function buildTextlessPdf(): Buffer {
    const stream =
        "1 1 0 rg 50 50 200 200 re f";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>",
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(pdf, "latin1"));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
}

/* ==========================================
 * REAL PARSER
 * ==========================================
 *
 * pdf.js loads its worker through a runtime
 * `import(...)`. Jest sandboxes modules in a vm
 * context, and a dynamic import there needs
 * Node's --experimental-vm-modules flag:
 *
 *   NODE_OPTIONS=--experimental-vm-modules \
 *     npx jest __tests__/security/resi-scan-pdf.test.ts
 *
 * Without the flag the real-parser cases are
 * reported as skipped instead of failing, so a bare
 * `npx jest` never produces a false failure. The
 * production runtime is unaffected — this is purely
 * a Jest vm limitation.
 */

const vmModulesEnabled = [
    ...process.execArgv,
    process.env.NODE_OPTIONS ?? "",
].some((arg) => arg.includes("experimental-vm-modules"));

const realParserDescribe = vmModulesEnabled
    ? describe
    : describe.skip;

realParserDescribe("PDF text extraction (real pdf-parse)", () => {
    test("extracts order number + tracking number from a text PDF", async () => {
        const pdf = buildTextPdf([
            "BUKTI PENGIRIMAN",
            `No. Pesanan: ${ORDER_NUMBER}`,
            `No. Resi: ${TRACKING}`,
        ]);

        const text = await extractPdfText(pdf);

        expect(text).toContain(ORDER_NUMBER);
        expect(text).toContain(TRACKING);
        expect(text.trim().length).toBeGreaterThanOrEqual(
            PDF_MIN_MEANINGFUL_CHARS
        );

        const fields = extractFields(text);
        expect(fields.orderReference).toBe(ORDER_NUMBER);
        expect(fields.trackingNumber).toBe(TRACKING);
    });

    test("PDF without text content returns empty text (OCR fallback path)", async () => {
        const text = await extractPdfText(buildTextlessPdf());

        expect(text.trim().length).toBeLessThan(
            PDF_MIN_MEANINGFUL_CHARS
        );
    });

    test("textless PDF can be rendered for the OCR fallback", async () => {
        const png = await renderPdfFirstPagePng(
            buildTextlessPdf()
        );

        expect(png).not.toBeNull();
        // PNG magic bytes
        expect(png!.subarray(0, 4).toString("hex")).toBe(
            "89504e47"
        );
    });

    test("corrupt PDF input stays a graceful failure (engine boundary)", async () => {
        const corrupt = Buffer.from(
            "%PDF-1.4\nthis is not a valid pdf body\n%%EOF\n"
        );

        // The parser itself reports the failure…
        await expect(extractPdfText(corrupt)).rejects.toBeTruthy();

        // …and the engine degrades to a needs-review result
        // instead of throwing.
        const extraction = await extractDocumentText(
            "pdf",
            corrupt
        );

        expect(extraction.rawText).toBe("");
        expect(extraction.warnings.length).toBeGreaterThan(0);
    });
});

/* ==========================================
 * DEPLOYMENT GUARDS
 * ==========================================
 *
 * pdfjs-dist sets, in Node:
 *   GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"
 * and the fake worker loads it with a relative,
 * bundler-ignored dynamic import, so it resolves
 * against the importing module's URL. Bundled,
 * that becomes `<build>/.next/server/chunks/
 * pdf.worker.mjs` → "Setting up fake worker
 * failed". These guards keep the parser external.
 */

describe("PDF deployment guards", () => {
    const pdfSource = readFile("lib/resi-scan/pdf.ts");
    const pdfCode = stripComments(pdfSource);
    const nextConfig = readFile("next.config.ts");

    test("pdf.ts uses only the public pdf-parse entry", () => {
        expect(pdfCode).toMatch(/from\s+"pdf-parse"/);
        expect(pdfCode).not.toMatch(
            /from\s+"pdf-parse\//
        );
        expect(pdfCode).not.toMatch(
            /from\s+"pdfjs-dist/
        );
        expect(pdfCode).not.toMatch(
            /require\(\s*"pdf-parse/
        );
    });

    test("pdf.ts never pins a worker path or reads package internals", () => {
        expect(pdfCode).not.toMatch(
            /setWorker|workerSrc|workerPath/
        );
        expect(pdfCode).not.toContain("pdf.worker");
        expect(pdfCode).not.toContain("createRequire");
        expect(pdfCode).not.toContain("node_modules");
    });

    test("PDF packages are excluded from server bundling", () => {
        const block = nextConfig.slice(
            nextConfig.indexOf(
                "serverExternalPackages"
            ),
            nextConfig.indexOf(
                "outputFileTracingIncludes"
            )
        );
        // pdf-parse pulls pdfjs-dist into the bundle as a
        // plain dependency, but pdfjs-dist is the package
        // that resolves the worker, so both must stay
        // external for the relative import to resolve
        // against the real node_modules layout.
        expect(block).toContain('"pdf-parse"');
        expect(block).toContain('"pdfjs-dist"');
    });

    test("pdf runtime assets are traced for standalone deploys", () => {
        const block = nextConfig.slice(
            nextConfig.indexOf(
                "outputFileTracingIncludes"
            )
        );
        expect(block).toContain("node_modules/pdf-parse");
        expect(block).toContain("node_modules/pdfjs-dist");
        expect(block).toContain("node_modules/@napi-rs/canvas");
    });
});
