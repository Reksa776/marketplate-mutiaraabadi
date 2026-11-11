import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";
import { normalizePhone } from "@/lib/whatsapp/phone";
import { registerSchema } from "@/lib/validations/register";
import { rejectCrossSite } from "@/lib/checkout-idempotency";

export async function POST(req: Request) {
    try {
        const crossSite = rejectCrossSite(req);
        if (crossSite) return crossSite;

        const body = await req.json();
        const data = registerSchema.parse(body);
        const phone = normalizePhone(data.phone);

        if (!phone) {
            return NextResponse.json(
                { success: false, message: "Masukkan nomor WhatsApp Indonesia yang valid." },
                { status: 400 }
            );
        }

        const clientIp = getClientIp(req);
        const phoneKey = createHash("sha256").update(phone).digest("hex").slice(0, 20);
        if (!rateLimiters.register(clientIp, phoneKey).allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Terlalu banyak permintaan. Silakan coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const phoneCandidates = [...new Set([
            phone,
            `0${phone.slice(2)}`,
            `+${phone}`,
            data.phone.trim(),
        ])];
        const existingUser = await prisma.user.findFirst({
            where: { phone: { in: phoneCandidates } },
            select: { id: true },
        });
        if (existingUser) {
            return NextResponse.json(
                { success: false, message: "Nomor WhatsApp sudah terdaftar. Silakan login." },
                { status: 409 }
            );
        }

        const password = await hashPassword(data.password);
        const user = await prisma.user.create({
            data: {
                phone,
                password,
                role: "CUSTOMER",
            },
            select: {
                id: true,
                phone: true,
                role: true,
            },
        });

        return NextResponse.json(
            { success: true, message: "Registrasi berhasil.", user },
            { status: 201 }
        );
    } catch (error) {
        if (error instanceof SyntaxError) {
            return NextResponse.json(
                { success: false, message: "Data registrasi tidak valid." },
                { status: 400 }
            );
        }

        if (error && typeof error === "object" && "issues" in error) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Periksa nomor WhatsApp dan password. Password minimal 8 karakter serta berisi huruf besar, huruf kecil, dan angka.",
                },
                { status: 400 }
            );
        }

        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
            return NextResponse.json(
                { success: false, message: "Nomor WhatsApp sudah terdaftar. Silakan login." },
                { status: 409 }
            );
        }

        console.error("CUSTOMER REGISTRATION ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Registrasi gagal. Silakan coba lagi." },
            { status: 500 }
        );
    }
}
