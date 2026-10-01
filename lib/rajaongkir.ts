import { fetchWithRetry } from "./fetchWithRetry";

export const RAJAONGKIR_BASE_URL =
    process.env.RAJAONGKIR_BASE_URL ||
    "https://rajaongkir.komerce.id/api/v1";

export const RAJAONGKIR_API_KEY =
    process.env.RAJAONGKIR_API_KEY;

/*
 * Couriers allowed to be forwarded to RajaOngkir. Anything else is
 * rejected server-side (allowlist), so arbitrary client-supplied
 * courier codes cannot reach the provider payload.
 */
export const COURIER_ALLOWLIST = [
    "jne",
    "jnt",
    "sicepat",
    "ide",
    "sap",
    "ninja",
    "tiki",
    "lion",
    "anteraja",
    "pos",
    "ncs",
    "rex",
    "rpx",
    "sentral",
    "star",
    "wahana",
    "dse",
] as const;

type RajaOngkirResponse<T = unknown> = {
    meta?: {
        message?: string;
        code?: number;
        status?: string;
    };
    data?: T;
};

/**
 * Generic GET/POST helper for RajaOngkir endpoints (regions, admin
 * settings, destination search, sync). Throws on non-JSON or HTTP
 * / meta.code >= 400 failures.
 */
export async function rajaOngkirFetch<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    if (!RAJAONGKIR_API_KEY) {
        throw new Error(
            "RAJAONGKIR_API_KEY belum diatur."
        );
    }

    const response = await fetchWithRetry(
        `${RAJAONGKIR_BASE_URL}${endpoint}`,
        {
            ...options,
            headers: {
                "Content-Type": "application/json",
                key: RAJAONGKIR_API_KEY,
                ...(options.headers || {}),
            },
            cache: "no-store",
        }
    );

    const text = await response.text();

    let json: RajaOngkirResponse<T>;

    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(
            "Response RajaOngkir bukan JSON."
        );
    }

    if (!response.ok) {
        throw new Error(
            json.meta?.message ||
                "Request RajaOngkir gagal."
        );
    }

    if (
        json.meta?.code &&
        json.meta.code >= 400
    ) {
        throw new Error(
            json.meta.message ||
                "Request RajaOngkir gagal."
        );
    }

    return json.data as T;
}

/**
 * Parse a colon-joined courier string, keep only allowlisted codes,
 * lowercase + trim + dedupe. Returns "" when no courier survives.
 */
export function sanitizeCouriers(
    value: unknown
): string {
    if (typeof value !== "string") return "";

    const seen = new Set<string>();
    const accepted: string[] = [];

    for (const raw of value.split(":")) {
        const code = raw.trim().toLowerCase();
        if (!code) continue;
        if (!(COURIER_ALLOWLIST as readonly string[]).includes(code)) {
            continue;
        }
        if (seen.has(code)) continue;
        seen.add(code);
        accepted.push(code);
    }

    return accepted.join(":");
}

/**
 * Server-authoritative price mode. Never forwarded from the client;
 * the audit required `price` to be pinned server-side.
 */
export const DEFAULT_PRICE_MODE = "lowest" as const;

export type DomesticCostInput = {
    origin: number;
    destination: number;
    weight: number;
    courier?: string;
};

/**
 * POST /calculate/domestic-cost with enforced validation.
 *
 * - API key must be configured.
 * - Couriers sanitized against COURIER_ALLOWLIST.
 * - `price` pinned to "lowest" (client value ignored).
 * - JSON body validated before returning.
 */
export async function calculateDomesticCost({
    origin,
    destination,
    weight,
    courier,
}: DomesticCostInput) {
    if (!RAJAONGKIR_API_KEY) {
        throw new Error(
            "RAJAONGKIR_API_KEY belum diatur."
        );
    }

    const allowedCouriers = sanitizeCouriers(
        courier ||
            "jne:jnt:sicepat:ide:sap:ninja:tiki:lion:anteraja:pos:ncs:rex:rpx:sentral:star:wahana:dse"
    );

    if (!allowedCouriers) {
        throw new Error(
            "Courier tidak diperbolehkan."
        );
    }

    const form = new URLSearchParams();

    form.append("origin", String(origin));
    form.append("destination", String(destination));
    form.append("weight", String(Math.ceil(weight)));
    form.append("courier", allowedCouriers);
    form.append("price", DEFAULT_PRICE_MODE);

    const response = await fetchWithRetry(
        `${RAJAONGKIR_BASE_URL}/calculate/domestic-cost`,
        {
            method: "POST",
            headers: {
                key: RAJAONGKIR_API_KEY,
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: form.toString(),
            cache: "no-store",
        },
        /*
         * Pricing POST: side-effect free, so it is safe to retry
         * once on a transient timeout/network error. (Mengantar's
         * order/payment POSTs deliberately do NOT opt in.)
         */
        { idempotent: true }
    );

    const text = await response.text();

    let json: RajaOngkirResponse;

    try {
        json = JSON.parse(text);
    } catch {
        console.error(
            "RAJAONGKIR RESPONSE:",
            text
        );

        throw new Error(
            "Response RajaOngkir bukan JSON."
        );
    }

    if (!response.ok) {
        throw new Error(
            json.meta?.message ||
                "Gagal mengambil ongkir."
        );
    }

    if (
        json.meta?.code &&
        json.meta.code >= 400
    ) {
        throw new Error(
            json.meta.message ||
                "Gagal mengambil ongkir."
        );
    }

    return json.data;
}

/**
 * Clean a raw RajaOngkir cost response into the response contract
 * both shipping routes share:
 *   - drop cargo services (JTR*)
 *   - drop invalid costs
 *   - keep only allowlisted couriers (defense-in-depth)
 *   - dedupe by courier|service|cost
 *   - sort by courier, then cheapest cost
 */
export type RajaOngkirShipping = {
    name?: string;
    code?: string;
    service?: string;
    description?: string;
    cost?: number | string;
    etd?: string;
};

export type ShippingData = {
    courier: string;
    courierName: string;
    service: string;
    description: string;
    cost: number;
    etd: string;
};

export function normalizeShippingData(
    raw: unknown
): ShippingData[] {
    const rawData: RajaOngkirShipping[] = Array.isArray(raw)
        ? (raw as RajaOngkirShipping[])
        : [];

    const allowlist = COURIER_ALLOWLIST as readonly string[];

    const shippingData = rawData
        .filter((item) => {
            const service = String(
                item.service ?? ""
            )
                .trim()
                .toUpperCase();

            if (service.startsWith("JTR")) {
                return false;
            }

            if (
                item.code &&
                !allowlist.includes(
                    String(item.code).toLowerCase()
                )
            ) {
                return false;
            }

            const cost = Number(item.cost);
            if (!Number.isFinite(cost) || cost < 0) {
                return false;
            }

            return true;
        })
        .map(
            (item): ShippingData => ({
                courier: item.code ?? "",
                courierName: item.name ?? "",
                service: item.service ?? "",
                description: item.description ?? "",
                cost: Number(item.cost),
                etd: item.etd ?? "",
            })
        );

    const uniqueShipping = Array.from(
        new Map<string, ShippingData>(
            shippingData.map((item) => [
                [
                    item.courier,
                    item.service,
                    item.cost,
                ].join("|"),
                item,
            ])
        ).values()
    );

    uniqueShipping.sort((a, b) => {
        const courierCompare = a.courier.localeCompare(b.courier);
        if (courierCompare !== 0) {
            return courierCompare;
        }
        return a.cost - b.cost;
    });

    return uniqueShipping;
}