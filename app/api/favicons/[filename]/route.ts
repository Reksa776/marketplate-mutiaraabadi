import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

import {
    FAVICON_ALLOWED_EXTENSIONS,
    faviconMimeTypeFor,
    getFaviconStorageDir,
} from "@/lib/store-favicon";

export const runtime = "nodejs";

/**
 * ==========================================
 * GET /api/favicons/[filename]
 * ==========================================
 *
 * Serves the admin-uploaded website favicon. Public on
 * purpose: a favicon is fetched by every browser and holds
 * no private data.
 *
 * Security:
 *   - `path.basename` strips any directory component
 *   - only whitelisted image extensions are served
 *   - reads exclusively from the favicon storage directory,
 *     so an upload can never be used to read arbitrary files
 *   - `Content-Type` is derived from the extension, never
 *     from user input, so a stored file cannot be executed
 */

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ filename: string }> }
) {
    const { filename } = await params;

    const safeName = path.basename(filename);
    const extension = path
        .extname(safeName)
        .toLowerCase();

    if (
        !safeName ||
        !FAVICON_ALLOWED_EXTENSIONS.includes(extension)
    ) {
        return NextResponse.json(
            {
                success: false,
                message: "Favicon tidak ditemukan.",
            },
            { status: 404 }
        );
    }

    const filePath = path.join(
        getFaviconStorageDir(),
        safeName
    );

    try {
        const fileBuffer = await fs.readFile(filePath);

        return new NextResponse(fileBuffer, {
            status: 200,
            headers: {
                "Content-Type":
                    faviconMimeTypeFor(safeName),
                "Cache-Control":
                    "public, max-age=31536000, immutable",
            },
        });
    } catch {
        return NextResponse.json(
            {
                success: false,
                message: "Favicon tidak ditemukan.",
            },
            { status: 404 }
        );
    }
}
