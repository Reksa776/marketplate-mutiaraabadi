/* ==========================================
 * RESI SCAN — PDF TEXT EXTRACTION
 * ==========================================
 *
 * Uses pdf-parse v2 (pure TypeScript, Electron
 * pdf.js in a sandboxed worker). Chosen over
 * native poppler/pdftotext so the VPS requires
 * NO system PDF packages; the package bundles
 * @napi-rs/canvas for optional page rendering
 * (used to OCR scanned PDFs via getScreenshot).
 *
 * Deployment notes:
 *   - pdf.js resolves its worker with a RELATIVE
 *     runtime import (GlobalWorkerOptions.workerSrc
 *     defaults to './pdf.worker.mjs' in Node). That
 *     path is legitimate from the real package
 *     (node_modules/pdfjs-dist/legacy/build/
 *     pdf.worker.mjs) but breaks when the package is
 *     bundled, because the import then runs from a
 *     generated chunk and resolves to
 *     <project>/.next/server/chunks/pdf.worker.mjs,
 *     which is never emitted. pdf-parse and
 *     pdfjs-dist are therefore listed in
 *     `serverExternalPackages` (next.config.ts) so
 *     they load from node_modules at runtime.
 *   - Only the public `pdf-parse` entry is imported.
 *     Never import package internals (pdf-parse/dist/**
 *     or pdfjs-dist/**) and never hardcode a worker
 *     path — the library owns that resolution.
 *   - This module is server-only. It must never be
 *     imported from a client component; the
 *     `server-only` guard turns such an import into a
 *     build-time error.
 */

import "server-only";

import { PDFParse } from "pdf-parse";

export async function extractPdfText(
    buffer: Buffer
): Promise<string> {
    const parser = new PDFParse({
        data: new Uint8Array(buffer),
    });

    try {
        const result = await parser.getText({
            first: 3,
            pageJoiner: "\n",
        });
        return result.text || "";
    } finally {
        await parser
            .destroy()
            .catch(() => {});
    }
}

/**
 * Render the first page of a (scanned) PDF to a
 * PNG buffer so it can be run through OCR.
 * Returns null when the PDF cannot be rendered
 * (e.g. encrypted / unsupported) — callers must
 * treat that as a graceful failure.
 */
export async function renderPdfFirstPagePng(
    buffer: Buffer
): Promise<Buffer | null> {
    const parser = new PDFParse({
        data: new Uint8Array(buffer),
    });

    try {
        // Render at a bounded width instead of a fixed
        // scale, so a malicious PDF with an enormous
        // media box cannot balloon into a huge PNG and
        // exhaust memory before OCR.
        const screenshot = await parser.getScreenshot({
            first: 1,
            desiredWidth: 1600,
            imageBuffer: true,
            imageDataUrl: false,
        });

        const page = screenshot.pages[0];
        if (!page || !page.data) {
            return null;
        }

        return Buffer.from(page.data);
    } catch (error) {
        console.error(
            "PDF_RENDER_ERROR:",
            error instanceof Error
                ? error.message
                : error
        );
        return null;
    } finally {
        await parser
            .destroy()
            .catch(() => {});
    }
}

export const PDF_MIN_MEANINGFUL_CHARS = 6;