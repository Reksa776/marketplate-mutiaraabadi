import "server-only";

import path from "path";

import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * STORE FAVICON (SINGLE SOURCE OF TRUTH)
 * ==========================================
 *
 * Owns everything the storefront and the admin
 * settings UI need to agree on about the website
 * favicon:
 *
 *   - where the uploaded file lives on disk
 *   - which formats are accepted
 *   - how a raw upload is validated
 *   - how the PUBLIC url is built
 *   - how the active favicon is read for metadata
 *
 * The favicon is stored with the project's EXISTING
 * local upload mechanism (`storage/uploads/<dir>`,
 * served through a route handler) — the same approach
 * already used for product images and affiliate files.
 * Only the public URL is persisted in `StoreSetting`;
 * the image bytes never touch the database.
 */

/** Hard upper bound for an uploaded favicon (1 MB). */
export const FAVICON_MAX_BYTES = 1024 * 1024;

/** Public route prefix that serves stored favicons. */
export const FAVICON_PUBLIC_PREFIX = "/api/favicons";

/** Storage sub-directory below UPLOAD_DIR / storage/uploads. */
export const FAVICON_STORAGE_DIR = "favicons";

/**
 * Allowed extensions mapped to the canonical MIME type.
 *
 * SVG is deliberately NOT allowed: an SVG can embed
 * scripts/handlers and would need a full sanitizer to be
 * safe, while a favicon gains nothing from being vector.
 * ICO is supported because it is the classic favicon format.
 */
export const FAVICON_MIME_BY_EXTENSION: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
};

/** Extensions accepted for a stored favicon. */
export const FAVICON_ALLOWED_EXTENSIONS = Object.keys(
    FAVICON_MIME_BY_EXTENSION
);

/**
 * Client-declared MIME types mapped to a canonical
 * extension. `image/vnd.microsoft.icon` is what Windows
 * and some tools report instead of `image/x-icon`; both
 * mean ICO.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
};

/**
 * Map a browser-declared MIME type to the canonical
 * extension, or null when the type is not accepted.
 *
 * This is only a first gate: the browser MIME is
 * attacker-controlled, so the real decision is made from
 * the file's magic bytes in `detectFaviconExtension`.
 */
export function extensionForFaviconMime(
    mime: string
): string | null {
    return EXTENSION_BY_MIME[mime] ?? null;
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
    if (buffer.length < signature.length) {
        return false;
    }

    return signature.every(
        (byte, index) => buffer[index] === byte
    );
}

/**
 * ==========================================
 * MAGIC BYTE VALIDATION
 * ==========================================
 *
 * Decide the real format from the file content, never
 * from the extension or the client MIME type. A file
 * must match one of the known signatures to be stored,
 * which stops HTML/SVG/script payloads renamed to
 * `.png` from ever reaching the storage directory.
 *
 * Returns the canonical extension, or null when the
 * content is not a supported image.
 */
export function detectFaviconExtension(
    buffer: Buffer
): string | null {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])
    ) {
        return "png";
    }

    // JPEG: FF D8 FF
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
        return "jpg";
    }

    // WebP: "RIFF" .... "WEBP"
    if (
        buffer.length >= 12 &&
        buffer
            .subarray(0, 4)
            .toString("ascii") === "RIFF" &&
        buffer
            .subarray(8, 12)
            .toString("ascii") === "WEBP"
    ) {
        return "webp";
    }

    // ICO: 00 00 01 00 (icon resource)
    if (
        startsWith(buffer, [0x00, 0x00, 0x01, 0x00])
    ) {
        return "ico";
    }

    return null;
}

/**
 * Resolve a MIME type from a stored favicon filename or
 * public URL. Unknown extensions fall back to
 * `application/octet-stream` so a bad value can never be
 * served as an executable content type.
 */
export function faviconMimeTypeFor(
    filenameOrUrl: string
): string {
    const withoutQuery = filenameOrUrl.split(/[?#]/)[0];
    const extension = path
        .extname(withoutQuery)
        .toLowerCase();

    return (
        FAVICON_MIME_BY_EXTENSION[extension] ??
        "application/octet-stream"
    );
}

/**
 * Absolute on-disk directory for stored favicons.
 * Mirrors the existing product/affiliate upload layout.
 */
export function getFaviconStorageDir(): string {
    return process.env.UPLOAD_DIR
        ? path.join(
              process.env.UPLOAD_DIR,
              FAVICON_STORAGE_DIR
          )
        : path.join(
              process.cwd(),
              "storage",
              "uploads",
              FAVICON_STORAGE_DIR
          );
}

/** Public URL for a stored favicon file name. */
export function getFaviconPublicUrl(filename: string): string {
    return `${FAVICON_PUBLIC_PREFIX}/${filename}`;
}

/**
 * Extract the stored file name from a favicon URL, or null
 * when the URL does not point at our own storage.
 *
 * Used to clean up the previous file after a replacement
 * without ever trusting a value read back from the
 * database as a filesystem path.
 */
export function faviconFilenameFromUrl(
    url: string | null | undefined
): string | null {
    if (!url || !url.startsWith(`${FAVICON_PUBLIC_PREFIX}/`)) {
        return null;
    }

    const filename = path.basename(
        url.slice(FAVICON_PUBLIC_PREFIX.length + 1)
    );

    return FAVICON_ALLOWED_EXTENSIONS.includes(
        path.extname(filename).toLowerCase()
    )
        ? filename
        : null;
}

/**
 * ==========================================
 * ACTIVE FAVICON FOR METADATA
 * ==========================================
 *
 * Read by `app/layout.tsx#generateMetadata`. Only a
 * same-origin, root-relative URL is ever returned so a
 * bad database value can never become a `javascript:`,
 * `data:` or external `<link rel="icon">` target.
 *
 * The whole read is guarded: if the database is
 * unreachable the storefront must keep rendering with the
 * bundled default icons instead of failing every page.
 */
export async function getStoreFaviconUrl(): Promise<
    string | null
> {
    try {
        const setting =
            await prisma.storeSetting.findUnique({
                where: { id: 1 },
                select: { faviconUrl: true },
            });

        const url = setting?.faviconUrl?.trim();

        if (
            !url ||
            !url.startsWith("/") ||
            url.startsWith("//")
        ) {
            return null;
        }

        return url;
    } catch (error) {
        console.error(
            "GET STORE FAVICON ERROR:",
            error
        );

        return null;
    }
}
