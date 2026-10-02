import crypto from "crypto";

import { fetchWithRetry } from "./fetchWithRetry";

/*
 * ============================================================
 * MENGANTAR PUBLIC API — SERVER-ONLY CLIENT
 * ============================================================
 *
 * Contract source: https://api-public.mengantar.com/docs/ and the
 * OpenAPI-verified partner mirror (github.com/ongkipro/
 * mengantar-documentation, OpenAPI 3.1 + webhook test vector).
 *
 * !! SERVER-ONLY !!
 * The API key is placed in the URL PATH, so this module must NEVER
 * be imported by a Client Component. The key is:
 *   - read only from the server env (never NEXT_PUBLIC_*)
 *   - redacted from every thrown message and log
 *
 * Never store the key / webhook secret in the database and never
 * return them from an API route.
 * ============================================================
 */

export const MENGANTAR_BASE_URL = (
    process.env.MENGANTAR_BASE_URL ||
    "https://api-public.mengantar.com"
).replace(/\/+$/, "");

export const MENGANTAR_API_KEY =
    process.env.MENGANTAR_API_KEY;

export const MENGANTAR_WEBHOOK_SECRET =
    process.env.MENGANTAR_WEBHOOK_SECRET;

export function isMengantarConfigured(): boolean {
    return Boolean(MENGANTAR_API_KEY);
}

/*
 * ============================================================
 * COURIER MAPPING
 * ============================================================
 *
 * Mengantar shipment/estimate courier names are CASE-SENSITIVE and
 * differ from the RajaOngkir codes used elsewhere in this codebase.
 *   jne → JNE, jnt → JT, ide/idexpress → iDexpress, ...
 *
 * Ninja is DISCONTINUED (1 Sep 2026) and is intentionally absent.
 */

export const MENGANTAR_COURIERS = [
    "JNE",
    "SiCepat",
    "Sap",
    "iDexpress",
    "JT",
    "lion",
    "anteraja",
    "pos",
] as const;

export type MengantarCourier =
    (typeof MENGANTAR_COURIERS)[number];

const INTERNAL_TO_MENGANTAR: Record<string, MengantarCourier> = {
    jne: "JNE",
    jnecargo: "JNE",
    sicepat: "SiCepat",
    sap: "Sap",
    ide: "iDexpress",
    idexpress: "iDexpress",
    jnt: "JT",
    "j&t": "JT",
    jt: "JT",
    lion: "lion",
    lionparcel: "lion",
    anteraja: "anteraja",
    pos: "pos",
    posindonesia: "pos",
};

/**
 * Map an internal / RajaOngkir courier code to the exact Mengantar
 * shipment courier name. Returns null when the courier is not
 * supported by Mengantar (e.g. "ninja"), so callers can reject it
 * instead of forwarding an arbitrary client value.
 */
export function toMengantarCourier(
    code: unknown
): MengantarCourier | null {
    if (typeof code !== "string") return null;

    const normalized = code
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");

    return INTERNAL_TO_MENGANTAR[normalized] ?? null;
}

/**
 * Map a Mengantar courier name back to the lowercase code used by
 * the tracking UI / existing columns (jnt, jne, sicepat, ...).
 */
export function toInternalCourier(
    name: unknown
): string {
    if (typeof name !== "string") return "";

    switch (name.trim().toLowerCase()) {
        case "jne":
            return "jne";
        case "sicepat":
            return "sicepat";
        case "sap":
            return "sap";
        case "idexpress":
            return "idexpress";
        case "jt":
            return "jnt";
        case "lion":
            return "lion";
        case "anteraja":
            return "anteraja";
        case "pos":
            return "pos";
        default:
            return name.trim().toLowerCase();
    }
}

/*
 * ============================================================
 * ERROR + REDACTION
 * ============================================================
 */

export class MengantarError extends Error {
    code?: string;
    status?: number;

    constructor(
        message: string,
        status?: number,
        code?: string
    ) {
        super(message);
        this.name = "MengantarError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Remove the API key from any string before it can reach a log or an
 * error response. Defense-in-depth: the key lives in the request URL,
 * which libraries/frameworks sometimes echo back.
 */
export function redactMengantarKey(
    value: unknown
): string {
    let text =
        typeof value === "string"
            ? value
            : JSON.stringify(value ?? "");

    if (MENGANTAR_API_KEY) {
        text = text.split(MENGANTAR_API_KEY).join("[REDACTED]");
    }

    return text;
}

function safeError(
    message: unknown,
    status?: number,
    code?: string
): MengantarError {
    return new MengantarError(
        redactMengantarKey(message),
        status,
        code
    );
}

/*
 * ============================================================
 * RESPONSE ENVELOPE
 * ============================================================
 */

type MengantarEnvelope<T> = {
    success?: boolean;
    data?: T;
    message?: string;
    code?: string;
    errors?: unknown;
};

/**
 * Low-level request helper. `path` is everything AFTER the base URL,
 * INCLUDING the `/api/public/{KEY}` prefix, e.g.
 *   `/api/public/<key>/order/estimate?...`
 */
async function mengantarRequest<T>(
    path: string,
    options: RequestInit = {}
): Promise<T> {
    if (!MENGANTAR_API_KEY) {
        throw new MengantarError(
            "MENGANTAR_API_KEY belum dikonfigurasi."
        );
    }

    const url = `${MENGANTAR_BASE_URL}${path}`;

    const response = await fetchWithRetry(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(options.headers || {}),
        },
        cache: "no-store",
    });

    const text = await response.text();

    let json: MengantarEnvelope<T>;

    try {
        json = JSON.parse(text);
    } catch {
        throw safeError(
            "Response Mengantar bukan JSON.",
            response.status
        );
    }

    if (!response.ok) {
        throw safeError(
            json.message ||
                `Request Mengantar gagal (HTTP ${response.status}).`,
            response.status,
            json.code
        );
    }

    if (json.success === false) {
        throw safeError(
            json.message ||
                "Request Mengantar gagal.",
            response.status,
            json.code
        );
    }

    return json.data as T;
}

function keyPath(suffix: string): string {
    return `/api/public/${MENGANTAR_API_KEY}${suffix}`;
}

/*
 * ============================================================
 * ADDRESS / AREA (origin & destination references)
 * ============================================================
 *
 * /address/search returns Indonesian area records. Their `_id` is the
 * ONLY valid `origin_id` / `destination_id` for the estimate and the
 * `customerAddressDataId` for order creation. It is a DIFFERENT ID
 * SPACE from RajaOngkir's destination id.
 */

export type MengantarArea = {
    _id: string;
    COUNTRY_NAME?: string;
    PROVINCE_NAME?: string;
    CITY_NAME?: string;
    CITY_NAME_SI?: string;
    DISTRICT_NAME?: string;
    SUBDISTRICT_NAME?: string;
    ZIP_CODE?: string;
    ORIGIN_CODE?: string;
    DESTINATION_CODE?: string;
};

export async function searchMengantarAreas(
    keyword: string
): Promise<MengantarArea[]> {
    const q = String(keyword ?? "").trim();

    if (!q) return [];

    const result = await mengantarRequest<MengantarArea[]>(
        keyPath(
            `/address/search?keyword=${encodeURIComponent(q)}`
        ),
        { method: "GET" }
    );

    return Array.isArray(result) ? result : [];
}

/*
 * ============================================================
 * PICKUP ADDRESSES + TIME SLOTS (admin settings)
 * ============================================================
 *
 * GET /address lists the pickup addresses REGISTERED on the
 * Mengantar account. Its `_id` is the ONLY valid
 * pickup.address_id for POST /order — it is a DIFFERENT id space
 * from the origin AREA id returned by /address/search.
 *
 * GET /time?address={pickupAddressId} lists that pickup address's
 * time slots; its `_id` is pickup.time_id for scheduledPickup.
 *
 * Responses are defensively normalized: the exact casing of the
 * stored field names is not guaranteed by the public docs, so we
 * accept both the documented uppercase names and camelCase.
 */

export type MengantarPickupAddress = {
    _id: string;
    name: string | null;
    address: string | null;
    pic: string | null;
    picPhone: string | null;
    /** PICKUP_AUTOFILL = the area _id the pickup address sits in. */
    areaId: string | null;
};

export type MengantarPickupTime = {
    _id: string;
    date: string | null;
    time: string | null;
};

function toOptionalString(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    return null;
}

export async function listMengantarPickupAddresses(): Promise<
    MengantarPickupAddress[]
> {
    const result = await mengantarRequest<unknown[]>(
        keyPath(`/address`),
        { method: "GET" }
    );

    if (!Array.isArray(result)) return [];

    const addresses: MengantarPickupAddress[] = [];

    for (const raw of result) {
        const item = (raw ?? {}) as Record<string, unknown>;

        const id =
            toOptionalString(item._id) ??
            toOptionalString(item.id);

        if (!id) continue;

        addresses.push({
            _id: id,
            name:
                toOptionalString(item.PICKUP_NAME) ??
                toOptionalString(item.pickupName) ??
                toOptionalString(item.name),
            address:
                toOptionalString(item.PICKUP_ADDRESS) ??
                toOptionalString(item.pickupAddress) ??
                toOptionalString(item.address),
            pic:
                toOptionalString(item.PICKUP_PIC) ??
                toOptionalString(item.pickupPic) ??
                toOptionalString(item.pic),
            picPhone:
                toOptionalString(item.PICKUP_PIC_PHONE) ??
                toOptionalString(item.pickupPicPhone) ??
                toOptionalString(item.phone),
            areaId:
                toOptionalString(item.PICKUP_AUTOFILL) ??
                toOptionalString(item.pickupAutofill) ??
                toOptionalString(item.areaId),
        });
    }

    return addresses;
}

export async function listMengantarPickupTimes(
    addressId: string
): Promise<MengantarPickupTime[]> {
    const id = String(addressId ?? "").trim();

    if (!id) return [];

    const result = await mengantarRequest<unknown[]>(
        keyPath(
            `/time?address=${encodeURIComponent(id)}`
        ),
        { method: "GET" }
    );

    if (!Array.isArray(result)) return [];

    const times: MengantarPickupTime[] = [];

    for (const raw of result) {
        const item = (raw ?? {}) as Record<string, unknown>;

        const timeId =
            toOptionalString(item._id) ??
            toOptionalString(item.id);

        if (!timeId) continue;

        times.push({
            _id: timeId,
            date:
                toOptionalString(item.date) ??
                toOptionalString(item.DATE),
            time:
                toOptionalString(item.time) ??
                toOptionalString(item.TIME),
        });
    }

    return times;
}

/**
 * Create a pickup schedule slot — POST /time.
 *
 * Body: { address_id, date: "mm-dd-yyyy", time }
 * Mengantar REQUIRES the slot to be ≥ 90 minutes in the future,
 * otherwise the request is rejected. Callers must compute a valid
 * slot (see lib/mengantar/pickup-schedule.ts).
 *
 * POST is deliberately NOT retried by fetchWithRetry (the call is
 * not idempotent); a failure propagates so the caller can retry on
 * its own schedule.
 *
 * Returns the normalized slot (its `_id` is pickup.time_id).
 */
export async function createMengantarPickupTime({
    addressId,
    date,
    time,
}: {
    addressId: string;
    /** mm-dd-yyyy (Mengantar's documented format). */
    date: string;
    /** One of 9:00 … 18:00. */
    time: string;
}): Promise<MengantarPickupTime> {
    const id = String(addressId ?? "").trim();

    if (!id) {
        throw new MengantarError(
            "Pickup address Mengantar tidak valid."
        );
    }

    if (!/^\d{2}-\d{2}-\d{4}$/.test(String(date ?? ""))) {
        throw new MengantarError(
            "Tanggal pickup Mengantar tidak valid (mm-dd-yyyy)."
        );
    }

    if (!String(time ?? "").trim()) {
        throw new MengantarError(
            "Jam pickup Mengantar tidak valid."
        );
    }

    const result = await mengantarRequest<unknown>(
        keyPath(`/time`),
        {
            method: "POST",
            body: JSON.stringify({
                address_id: id,
                date,
                time,
            }),
        }
    );

    const item = (result ?? {}) as Record<string, unknown>;

    const timeId =
        toOptionalString(item._id) ??
        toOptionalString(item.id);

    if (!timeId) {
        throw new MengantarError(
            "Mengantar tidak mengembalikan ID jadwal pickup."
        );
    }

    return {
        _id: timeId,
        date:
            toOptionalString(item.date) ??
            toOptionalString(item.DATE) ??
            date,
        time:
            toOptionalString(item.time) ??
            toOptionalString(item.TIME) ??
            time,
    };
}

/*
 * ============================================================
 * SHIPPING ESTIMATE
 * ============================================================
 */

export type MengantarEstimateEntry = {
    unsupported?: boolean | null;
    unsupported_cod?: boolean | null;
    price?: number;
    estimate_delivery?: string;
    estimatedDate?: string;
    discountPercent?: number;
    discount?: number;
    codFee?: number;
    estimatedPrice?: number;
    estimatedSpecialPrice?: number;
    currency?: string;
    isDangerousGoodsSupported?: boolean;
};

export async function estimateMengantarShipping({
    originAreaId,
    destinationAreaId,
    weightKg,
    courier = "all",
    codAmount,
}: {
    originAreaId: string;
    destinationAreaId: string;
    weightKg: number;
    courier?: string;
    codAmount?: number;
}): Promise<Record<string, MengantarEstimateEntry>> {
    if (!originAreaId || !destinationAreaId) {
        throw new MengantarError(
            "Origin/destination area Mengantar tidak valid."
        );
    }

    if (
        !Number.isFinite(weightKg) ||
        weightKg <= 0
    ) {
        throw new MengantarError(
            "Berat paket tidak valid."
        );
    }

    const params = new URLSearchParams();

    params.set("origin_id", originAreaId);
    params.set("destination_id", destinationAreaId);
    params.set("courier", courier);
    // Mengantar expects kilograms.
    params.set("weight", String(weightKg));

    if (
        typeof codAmount === "number" &&
        Number.isFinite(codAmount) &&
        codAmount > 0
    ) {
        // NOTE: exact casing is COD_AMOUNT.
        params.set("COD_AMOUNT", String(Math.round(codAmount)));
    }

    const result = await mengantarRequest<
        Record<string, MengantarEstimateEntry>
    >(
        keyPath(`/order/estimate?${params.toString()}`),
        { method: "GET" }
    );

    return result && typeof result === "object"
        ? result
        : {};
}

/*
 * ============================================================
 * SHIPMENT CREATION + PAY UNPAID
 * ============================================================
 */

export type MengantarCreateOrderItem = {
    goodsValue?: number;
    COD?: number;
    customerAddressDataId: string;
    customerAddress: string;
    customerName: string;
    /**
     * 10–15 digits, no spaces/dashes. Callers must normalize.
     */
    customerPhone: string;
    parcelContent: string;
    weight: number; // kg
    quantity: number;
    customProducts?: Array<{
        name: string;
        variant?: string;
        qty: number;
        price?: number;
        weight?: number;
    }>;
};

export type MengantarCreateOrderResponse = {
    _id: string;
    ORDER_ID: string;
    batch_id: string;
    batch?: string;
    cnote_no: string | null;
    isPaid: boolean;
    queueStatus?: string;
    status?: string;
    statusCategory?: string;
    COD_AMOUNT?: number;
    COD_FEE?: number;
    GOODS_AMOUNT?: number;
    estimatedPrice?: number;
    estimatedSpecialPrice?: number;
    error?: unknown;
};

export async function createMengantarOrder({
    courier,
    pickup,
    orders,
}: {
    courier: MengantarCourier;
    pickup: {
        type: "scheduledPickup" | "dropOff";
        volume?: string;
        address_id: string;
        time_id?: string;
    };
    orders: MengantarCreateOrderItem[];
}): Promise<{
    data: MengantarCreateOrderResponse[];
    batch_id: string;
    errors?: unknown;
}> {
    const result = await mengantarRequest<{
        data?: MengantarCreateOrderResponse[];
        batch_id?: string;
        errors?: unknown;
    }>(keyPath(`/order`), {
        method: "POST",
        body: JSON.stringify({ courier, pickup, orders }),
    });

    return {
        data: Array.isArray(result?.data)
            ? result!.data!
            : [],
        batch_id: result?.batch_id ?? "",
        errors: result?.errors,
    };
}

/**
 * Pay previously-created unpaid (balance-insufficient) orders.
 * Completing the payment generates the tracking number (cnote_no)
 * and creates the shipment.
 */
export async function payMengantarUnpaid({
    courier,
    batchId,
}: {
    courier: MengantarCourier;
    batchId: string;
}): Promise<{ paidCount: number; cnoteNos: string[] }> {
    if (!batchId) {
        throw new MengantarError(
            "Batch ID Mengantar tidak valid."
        );
    }

    const response = await fetchWithRetry(
        `${MENGANTAR_BASE_URL}${keyPath(
            `/order/pay-unpaid`
        )}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                courier,
                batch_id: batchId,
            }),
            cache: "no-store",
        }
    );

    const text = await response.text();

    let json: {
        success?: boolean;
        data?: number;
        cnote_no?: string[];
        message?: string;
        code?: string;
    };

    try {
        json = JSON.parse(text);
    } catch {
        throw safeError(
            "Response Mengantar bukan JSON.",
            response.status
        );
    }

    if (!response.ok || json.success === false) {
        throw safeError(
            json.message ||
                `Pay unpaid gagal (HTTP ${response.status}).`,
            response.status,
            json.code
        );
    }

    return {
        paidCount: Number(json.data ?? 0),
        cnoteNos: Array.isArray(json.cnote_no)
            ? json.cnote_no
            : [],
    };
}

/*
 * ============================================================
 * ORDER LOOKUP / TRACKING
 * ============================================================
 */

export type MengantarOrderHistoryEntry = {
    date: string;
    desc: string;
};

export async function getMengantarOrderByTracking(
    trackingNumber: string
): Promise<
    | {
          orderId: string | null;
          status: string | null;
          statusCategory: string | null;
          trackingNumber: string | null;
          history: MengantarOrderHistoryEntry[];
      }
    | null
> {
    if (!trackingNumber) return null;

    const params = new URLSearchParams();
    params.set("tracking_id", trackingNumber);

    const result = await mengantarRequest<
        Array<{
            ORDER_ID?: string;
            cnote_no?: string;
            status?: string;
            statusCategory?: string;
            history?: MengantarOrderHistoryEntry[];
        }>
    >(
        keyPath(`/order?${params.toString()}`),
        { method: "GET" }
    );

    const order = Array.isArray(result)
        ? result[0]
        : null;

    if (!order) return null;

    return {
        orderId: order.ORDER_ID ?? null,
        status: order.status ?? null,
        statusCategory: order.statusCategory ?? null,
        trackingNumber: order.cnote_no ?? null,
        history: Array.isArray(order.history)
            ? order.history
            : [],
    };
}

/*
 * ============================================================
 * WEBHOOK SIGNATURE VERIFICATION
 * ============================================================
 *
 * string_to_sign = x-timestamp + "." + raw_request_body
 * signature      = HMAC-SHA256(WebhookSecret, string_to_sign) hex
 *
 * Verified against the official test vector documented by Mengantar:
 *   secret "testsecret", x-timestamp "1787548800000",
 *   body {"cnote_no":"JNE1234567890","order_id":"ORD-000123",
 *         "courier":"JNE","status_category":"DELIVERED"}
 *   → 05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111
 *
 * FAIL-CLOSED: missing secret / timestamp / signature → false.
 */
export function verifyMengantarWebhookSignature({
    rawBody,
    timestamp,
    signature,
}: {
    rawBody: string;
    timestamp: string;
    signature: string;
}): boolean {
    if (!MENGANTAR_WEBHOOK_SECRET) return false;
    if (!rawBody || !timestamp || !signature) return false;

    const expected = crypto
        .createHmac("sha256", MENGANTAR_WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(
        String(signature).trim().toLowerCase(),
        "utf8"
    );

    if (a.length !== b.length) return false;

    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

/*
 * ============================================================
 * WALLET BALANCE (admin: "saldo Mengantar")
 * ============================================================
 */

export async function getMengantarBalance(): Promise<
    number | null
> {
    const result = await mengantarRequest<unknown>(
        keyPath(`/invoices?page=1&size=1`),
        { method: "GET" }
    );

    // The envelope is { data: [...], count, balance }.
    const balance = (result as { balance?: unknown })?.balance;

    return typeof balance === "number" ? balance : null;
}
