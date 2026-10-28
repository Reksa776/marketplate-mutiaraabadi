import { NextResponse } from "next/server";
import {
    RAJAONGKIR_API_KEY,
    calculateDomesticCost,
    normalizeShippingData,
    sanitizeCouriers,
} from "@/lib/rajaongkir";
import { getClientIp, rateLimiters } from "@/lib/rate-limit";

const MAX_WEIGHT_GRAMS = 30000;

export async function POST(request: Request) {
    try {
        const rate = rateLimiters.shippingCost(
            getClientIp(request)
        );

        if (!rate.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Terlalu banyak permintaan. Coba lagi sebentar lagi.",
                },
                {
                    status: 429,
                    headers: {
                        "Retry-After": String(
                            Math.ceil(
                                rate.retryAfterMs / 1000
                            )
                        ),
                    },
                }
            );
        }

        if (!RAJAONGKIR_API_KEY) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "RAJAONGKIR_API_KEY belum dikonfigurasi.",
                },
                {
                    status: 500,
                }
            );
        }

        const body = await request.json();

        const {
            origin,
            destination,
            weight,
            courier = "jne:jnt",
        } = body;

        const originId = Number(origin);

        if (
            !Number.isInteger(originId) ||
            originId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Origin tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const destinationId = Number(destination);

        if (
            !Number.isInteger(destinationId) ||
            destinationId <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Destination tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        const packageWeight = Number(weight);

        if (
            !Number.isFinite(packageWeight) ||
            packageWeight <= 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Berat paket tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        if (
            Math.ceil(packageWeight) > MAX_WEIGHT_GRAMS
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Berat paket melebihi batas maksimum.",
                },
                {
                    status: 400,
                }
            );
        }

        const finalWeight = Math.ceil(packageWeight);

        /*
         * Courier allowlist: only known couriers are forwarded to
         * RajaOngkir. Only JNE and J&T are allowed.
         */
        const allowedCouriers =
            sanitizeCouriers(courier) ||
            sanitizeCouriers("jne:jnt");

        if (!allowedCouriers) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Courier tidak valid.",
                },
                {
                    status: 400,
                }
            );
        }

        console.log(
            "[BUY-NOW SHIPPING DEBUG] courier in:",
            typeof courier === "string" ? courier : "(non-string)",
            "| sanitized:",
            allowedCouriers.split(":").length,
            "courier(s)"
        );

        /*
         * Price mode is pinned server-side to "lowest" inside
         * calculateDomesticCost; the client value is ignored.
         */
        const result: unknown =
            await calculateDomesticCost({
                origin: originId,
                destination: destinationId,
                weight: finalWeight,
                courier: allowedCouriers,
            });

        const shippingData = normalizeShippingData(result);

        console.log(
            "[BUY-NOW SHIPPING DEBUG] Total items after normalize:",
            shippingData.length
        );

        return NextResponse.json({
            success: true,
            data: shippingData,
            weight: finalWeight,
        });
    } catch (error) {
        console.error(
            "SHIPPING COST ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Gagal menghitung ongkir.",
            },
            {
                status: 500,
            }
        );
    }
}
