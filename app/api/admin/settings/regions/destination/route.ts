import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

export async function GET(
    request: Request
) {
    try {
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json(
                {
                    message: "Unauthorized",
                },
                { status: 401 }
            );
        }

        if ((session.user as any).role !== "ADMIN") {
            return NextResponse.json(
                {
                    message: "Forbidden",
                },
                { status: 403 }
            );
        }

        const { searchParams } =
            new URL(request.url);

        const subdistrictId =
            searchParams.get(
                "subdistrictId"
            );

        if (!subdistrictId) {
            return NextResponse.json(
                {
                    message:
                        "subdistrictId wajib diisi.",
                },
                { status: 400 }
            );
        }

        // ==========================================
        // SECURITY (L3 FIX): Validate subdistrictId is numeric
        // ==========================================
        // Prevents SSRF via path traversal in RajaOngkir
        // API endpoint construction. Without this, an
        // attacker could pass e.g. "../../v2/user" to
        // access unintended API endpoints.
        const numericSubdistrictId = Number(subdistrictId);
        if (!Number.isInteger(numericSubdistrictId) || numericSubdistrictId <= 0) {
            return NextResponse.json(
                {
                    message: "subdistrictId tidak valid.",
                },
                { status: 400 }
            );
        }

        /*
         * Kita tetap menggunakan API RajaOngkir.
         * Jangan mengubah endpoint region yang
         * sekarang sudah berjalan.
         */

        const data =
            await rajaOngkirFetch(
                `/destination/domestic-destination/${numericSubdistrictId}`,
                {
                    method: "GET",
                }
            );

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error(
            "DESTINATION ERROR:",
            error instanceof Error
                ? error.message
                : error
        );

        if (isUpstreamTimeout(error)) {
            return NextResponse.json(
                {
                    message:
                        "Layanan wilayah sedang lambat. Silakan coba lagi.",
                },
                { status: 504 }
            );
        }

        if (error instanceof UpstreamError) {
            return NextResponse.json(
                {
                    message:
                        "Layanan wilayah sedang tidak merespons. Silakan coba lagi.",
                },
                { status: 502 }
            );
        }

        return NextResponse.json(
            {
                message: "Gagal mengambil destination RajaOngkir.",
            },
            { status: 500 }
        );
    }
}