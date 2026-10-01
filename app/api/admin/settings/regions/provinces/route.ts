import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

type Province = {
    id: number;
    name: string;
};

export async function GET() {
    try {
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized",
                },
                {
                    status: 401,
                }
            );
        }

        const role = (session.user as any).role;

        if (role !== "ADMIN") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Forbidden",
                },
                {
                    status: 403,
                }
            );
        }

        const provinces =
            await rajaOngkirFetch<Province[]>(
                "/destination/province"
            );

        return NextResponse.json({
            success: true,
            data: provinces,
        });
    } catch (error) {
        console.error(
            "GET PROVINCES ERROR:",
            error instanceof Error
                ? error.message
                : error
        );

        if (isUpstreamTimeout(error)) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Layanan wilayah sedang lambat. Silakan coba lagi.",
                },
                { status: 504 }
            );
        }

        if (error instanceof UpstreamError) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Layanan wilayah sedang tidak merespons. Silakan coba lagi.",
                },
                { status: 502 }
            );
        }

        return NextResponse.json(
            {
                success: false,
                message: "Gagal mengambil provinsi.",
            },
            {
                status: 500,
            }
        );
    }
}