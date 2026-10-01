import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { rajaOngkirFetch } from "@/lib/rajaongkir";
import {
    UpstreamError,
    isUpstreamTimeout,
} from "@/lib/upstream-error";

async function checkAdmin() {
    const session = await auth();

    if (!session?.user) {
        return false;
    }

    const role = (session.user as any).role;

    return role === "ADMIN";
}

export async function GET(request: NextRequest) {
    try {
        const isAdmin = await checkAdmin();

        if (!isAdmin) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Unauthorized.",
                },
                { status: 401 }
            );
        }

        const { searchParams } =
            new URL(request.url);

        const type =
            searchParams.get("type");

        const id =
            searchParams.get("id");

        // ==========================================
        // SECURITY (L3 FIX): Validate id is numeric
        // ==========================================
        // Prevents SSRF via path traversal in RajaOngkir
        // API endpoint construction. Without this, an
        // attacker could pass e.g. "../../v2/user" to
        // access unintended API endpoints.
        const numericId = id ? Number(id) : null;
        if (id && (numericId === null || !Number.isInteger(numericId) || numericId <= 0)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "ID wilayah tidak valid.",
                },
                { status: 400 }
            );
        }

        let endpoint = "";

        switch (type) {
            case "provinces":
                endpoint = "/destination/province";
                break;

            case "cities":
                if (!id) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "provinceId wajib diisi.",
                        },
                        { status: 400 }
                    );
                }

                endpoint = `/destination/city/${numericId}`;
                break;

            case "districts":
                if (!id) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "cityId wajib diisi.",
                        },
                        { status: 400 }
                    );
                }

                endpoint = `/destination/district/${numericId}`;
                break;

            case "subdistricts":
                if (!id) {
                    return NextResponse.json(
                        {
                            success: false,
                            message:
                                "districtId wajib diisi.",
                        },
                        { status: 400 }
                    );
                }

                endpoint =
                    `/destination/sub-district/${numericId}`;
                break;

            default:
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            "Type wilayah tidak valid.",
                    },
                    { status: 400 }
                );
        }

        const data =
            await rajaOngkirFetch(endpoint);

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (error) {
        /*
         * Never log the raw error object: a fetch failure used to
         * surface as `AbortError: This operation was aborted` with a
         * stack trace. Log the normalized message only.
         */
        console.error(
            "REGION API ERROR:",
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
                message: "Gagal mengambil data wilayah.",
            },
            { status: 500 }
        );
    }
}