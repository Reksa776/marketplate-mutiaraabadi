/* ==========================================
 * /api/admin/refunds/[id]/proof
 * ==========================================
 *
 * POST — upload refund proof (JPG/JPEG/PNG/WEBP/PDF)
 * GET  — serve the stored proof file
 *
 * Security:
 *   - ADMIN only (upload AND view)
 *   - Upload validates extension, size, and magic
 *     bytes (no trusting Content-Type or filename)
 *   - Files stored under storage/uploads (never public)
 *   - GET verifies the resolved path stays inside
 *     storage/uploads (no path traversal)
 *   - Uploading a proof NEVER completes the refund —
 *     COMPLETED requires an explicit admin action on
 *     the refund status.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/admin/audit-log";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";

type RouteContext = {
    params: Promise<{ id: string }>;
};

const ALLOWED_TYPES: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
};

const ALLOWED_MIME = new Set(Object.keys(ALLOWED_TYPES));

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function magicBytesMatch(
    buffer: Buffer,
    mime: string
): boolean {
    if (mime === "application/pdf") {
        return (
            buffer[0] === 0x25 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x44 &&
            buffer[3] === 0x46
        );
    }

    if (mime === "image/jpeg") {
        return (
            buffer[0] === 0xff &&
            buffer[1] === 0xd8 &&
            buffer[2] === 0xff
        );
    }

    if (mime === "image/png") {
        return (
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47
        );
    }

    if (mime === "image/webp") {
        return (
            buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46
        );
    }

    return false;
}

async function uploadProof(
    request: Request,
    refundId: number,
    session: { user: { id: string } }
) {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            status: true,
            proofFilePath: true,
        },
    });

    if (!refund) {
        return NextResponse.json(
            {
                success: false,
                message: "Refund tidak ditemukan.",
            },
            { status: 404 }
        );
    }

    if (
        refund.status !== "PENDING" &&
        refund.status !== "PROCESSING"
    ) {
        return NextResponse.json(
            {
                success: false,
                message:
                    "Bukti hanya dapat diupload pada refund PENDING atau PROCESSING.",
            },
            { status: 400 }
        );
    }

    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return NextResponse.json(
            {
                success: false,
                message: "Body bukan multipart/form-data.",
            },
            { status: 400 }
        );
    }

    const file = formData.get("file") as File | null;

    if (!file || !(file instanceof File)) {
        return NextResponse.json(
            {
                success: false,
                message: "File wajib diupload.",
            },
            { status: 400 }
        );
    }

    const mime = (file.type || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
        return NextResponse.json(
            {
                success: false,
                message:
                    "Tipe file tidak didukung. Gunakan JPG, PNG, WebP, atau PDF.",
            },
            { status: 400 }
        );
    }

    if (file.size <= 0 || file.size > MAX_SIZE) {
        return NextResponse.json(
            {
                success: false,
                message: "Ukuran file maksimal 5MB.",
            },
            { status: 400 }
        );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length < 4) {
        return NextResponse.json(
            {
                success: false,
                message: "File terlalu kecil.",
            },
            { status: 400 }
        );
    }

    // Re-check actual buffered length (the client's
    // declared file.size is only a hint) so a body
    // larger than MAX_SIZE is rejected even if the
    // client lied about its size.
    if (buffer.length > MAX_SIZE) {
        return NextResponse.json(
            {
                success: false,
                message: "Ukuran file maksimal 5MB.",
            },
            { status: 400 }
        );
    }

    if (!magicBytesMatch(buffer, mime)) {
        return NextResponse.json(
            {
                success: false,
                message:
                    "Isi file tidak sesuai dengan tipe yang diklaim.",
            },
            { status: 400 }
        );
    }

    const ext = ALLOWED_TYPES[mime];
    const uploadDir = path.join(
        process.cwd(),
        "storage",
        "uploads",
        "refunds",
        "proof",
        String(refundId)
    );

    await fs.mkdir(uploadDir, { recursive: true });

    const filename = `${Date.now()}-${crypto
        .randomBytes(4)
        .toString("hex")}${ext}`;
    const filePath = path.join(uploadDir, filename);

    await fs.writeFile(filePath, buffer);

    const relativePath = path.relative(
        process.cwd(),
        filePath
    );

    await prisma.refund.update({
        where: { id: refundId },
        data: { proofFilePath: relativePath },
    });

    await createAuditLog({
        adminId: session.user.id,
        action: "REFUND_PROOF_UPLOADED",
        entityType: "Refund",
        entityId: refundId,
        description: `Bukti refund diupload: ${filename}`,
        metadata: {
            proofFilePath: relativePath,
            filename,
        },
    });

    return NextResponse.json({
        success: true,
        message: "Bukti refund berhasil diupload.",
        data: { proofFilePath: relativePath },
    });
}

async function serveProof(
    refundId: number,
    session: { user: { id: string } }
) {
    void session;

    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            id: true,
            proofFilePath: true,
        },
    });

    if (!refund || !refund.proofFilePath) {
        return NextResponse.json(
            {
                success: false,
                message: "Bukti refund tidak ditemukan.",
            },
            { status: 404 }
        );
    }

    const storageRoot = path.join(
        process.cwd(),
        "storage",
        "uploads"
    );
    const resolved = path.resolve(
        storageRoot,
        refund.proofFilePath
    );

    // Prevent path traversal outside storage/uploads.
    if (
        resolved !== storageRoot &&
        !resolved.startsWith(storageRoot + path.sep)
    ) {
        return NextResponse.json(
            {
                success: false,
                message: "Akses file ditolak.",
            },
            { status: 403 }
        );
    }

    let fileBuffer: Buffer;
    try {
        fileBuffer = await fs.readFile(resolved);
    } catch {
        return NextResponse.json(
            {
                success: false,
                message: "File tidak ditemukan.",
            },
            { status: 404 }
        );
    }

    const ext = path.extname(resolved).toLowerCase();
    const mimeByExt: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
    };
    const mime =
        mimeByExt[ext] ?? "application/octet-stream";

    // Images are previewed inline; PDFs are served as
    // attachment so a malicious PDF never executes in
    // an inline viewer context. nosniff prevents MIME
    // sniffing downgrades.
    const disposition = mime === "application/pdf"
        ? "attachment"
        : "inline";

    return new Response(
        new Uint8Array(fileBuffer),
        {
            status: 200,
            headers: {
                "Content-Type": mime,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": `${disposition}; filename="refund-${refundId}${ext}"`,
            },
        }
    );
}

export async function POST(
    request: Request,
    { params }: RouteContext
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Akses ditolak. Hanya admin.",
                },
                { status: 403 }
            );
        }

        const { id } = await params;
        const refundId = Number(id);

        if (
            !Number.isInteger(refundId) ||
            refundId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "ID refund tidak valid.",
                },
                { status: 400 }
            );
        }

        return await uploadProof(
            request,
            refundId,
            session as { user: { id: string } }
        );
    } catch (error) {
        console.error(
            "REFUND PROOF UPLOAD ERROR:",
            error instanceof Error
                ? error.message
                : error
        );
        return NextResponse.json(
            {
                success: false,
                message: "Gagal upload bukti refund.",
            },
            { status: 500 }
        );
    }
}

export async function GET(
    _request: Request,
    { params }: RouteContext
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Akses ditolak. Hanya admin.",
                },
                { status: 403 }
            );
        }

        const { id } = await params;
        const refundId = Number(id);

        if (
            !Number.isInteger(refundId) ||
            refundId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "ID refund tidak valid.",
                },
                { status: 400 }
            );
        }

        return await serveProof(
            refundId,
            session as { user: { id: string } }
        );
    } catch (error) {
        console.error(
            "REFUND PROOF VIEW ERROR:",
            error instanceof Error
                ? error.message
                : error
        );
        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil bukti refund.",
            },
            { status: 500 }
        );
    }
}