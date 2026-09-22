/* ==========================================
 * RESI SCAN — FILE VALIDATION
 * ==========================================
 *
 * Validate uploaded scan files before parsing.
 * We check extension, MIME type AND magic bytes
 * (content sniffing) so a renamed executable or
 * HTML file can never reach the parsers.
 *
 * Allowed: PDF, JPG, JPEG, PNG, WEBP.
 */

export const SCAN_ALLOWED_EXTENSIONS = new Set([
    "pdf",
    "jpg",
    "jpeg",
    "png",
    "webp",
]);

export const SCAN_ALLOWED_MIME = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
]);

export const SCAN_MAX_FILE_MB = 8;
export const SCAN_MAX_FILE_BYTES =
    SCAN_MAX_FILE_MB * 1024 * 1024;

export const SCAN_MAX_FILES_PER_BATCH = 10;

export type DetectedKind =
    | "pdf"
    | "jpeg"
    | "png"
    | "webp"
    | "unknown";

function sniffMagicBytes(buffer: Buffer): DetectedKind {
    if (!buffer || buffer.length < 12) {
        return "unknown";
    }

    // PDF: %PDF
    if (
        buffer[0] === 0x25 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x44 &&
        buffer[3] === 0x46
    ) {
        return "pdf";
    }

    // JPEG: FF D8 FF
    if (
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
    ) {
        return "jpeg";
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return "png";
    }

    // WEBP: "RIFF" ... "WEBP" (bytes 8-11)
    if (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    ) {
        return "webp";
    }

    return "unknown";
}

function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    if (dot === -1 || dot === fileName.length - 1) {
        return "";
    }
    return fileName.slice(dot + 1).toLowerCase();
}

export interface ScanFileValidation {
    ok: boolean;
    error?: string;
    ext: string;
    mime: string;
    kind: DetectedKind;
    size: number;
}

export function validateScanFile(
    file: { name: string; size: number; type: string },
    buffer: Buffer
): ScanFileValidation {
    const ext = extensionOf(file.name);
    const mime = (file.type || "").toLowerCase();
    const kind = sniffMagicBytes(buffer);
    const size = file.size;

    if (!file.name || !ext) {
        return {
            ok: false,
            error:
                "Nama file tidak valid / tanpa ekstensi.",
            ext,
            mime,
            kind,
            size,
        };
    }

    if (!SCAN_ALLOWED_EXTENSIONS.has(ext)) {
        return {
            ok: false,
            error: `Ekstensi .${ext} tidak diizinkan. Gunakan PDF/JPG/JPEG/PNG/WEBP.`,
            ext,
            mime,
            kind,
            size,
        };
    }

    if (!SCAN_ALLOWED_MIME.has(mime)) {
        return {
            ok: false,
            error: `Tipe file tidak valid (${mime}).`,
            ext,
            mime,
            kind,
            size,
        };
    }

    if (size <= 0 || size > SCAN_MAX_FILE_BYTES) {
        return {
            ok: false,
            error: `Ukuran file melebihi batas maksimum ${SCAN_MAX_FILE_MB}MB.`,
            ext,
            mime,
            kind,
            size,
        };
    }

    // Magic bytes must agree with the declared
    // extension — prevents renamed payloads.
    const extensionToKind: Record<string, DetectedKind> = {
        pdf: "pdf",
        jpg: "jpeg",
        jpeg: "jpeg",
        png: "png",
        webp: "webp",
    };

    if (extensionToKind[ext] !== kind) {
        return {
            ok: false,
            error: "Isi file tidak sesuai dengan ekstensinya.",
            ext,
            mime,
            kind,
            size,
        };
    }

    return {
        ok: true,
        ext,
        mime,
        kind,
        size,
    };
}