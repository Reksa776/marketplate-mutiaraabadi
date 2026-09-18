/**
 * ==========================================
 * iPaymu Payment Provider
 * ==========================================
 *
 * API v2 integration for customer payment.
 *
 * Customer payment now uses the DIRECT PAYMENT method:
 *
 *   POST /api/v2/payment/direct
 *
 * iPaymu returns a payment instruction (VA number, QR image URL or
 * e-wallet URL) that we render on OUR OWN payment page, so the customer
 * never leaves the store. Settlement still comes exclusively from the
 * signed webhook (see app/api/payment/ipaymu/notification/route.ts).
 *
 * Signature format (from official iPaymu
 * Go/Node.js/PHP/Python libraries):
 *
 *   bodyHash = SHA256(body)
 *   stringToSign = "POST:" + VA + ":" +
 *     lowercase(bodyHash) + ":" + apiKey
 *   signature = HMAC-SHA256(stringToSign, apiKey)
 *
 * Headers required:
 *   va: Virtual Account number
 *   signature: Generated signature
 *   timestamp: YYYYMMDDHHmmss
 *
 * Production: https://my.ipaymu.com
 * Sandbox: https://sandbox.ipaymu.com
 *
 * Direct payment contract (confirmed against docs.ipaymu.com
 * /api-direct-payment and the official ipaymu-go-api / ipaymu-php-api
 * clients — no field is guessed):
 *
 *   Request : name, phone, email, amount, notifyUrl, referenceId,
 *             paymentMethod, paymentChannel, [expired], [expiredType],
 *             [comments], [product[]/qty[]/price[] for COD only]
 *   Response: Data = { SessionId, TransactionId, ReferenceId, Via,
 *             Channel, PaymentNo, PaymentName, Total, Fee, Expired,
 *             Note, Url }
 *   Semantics: PaymentNo = VA number / payment code to pay to,
 *              Url = QR image URL (QRIS) / e-wallet URL.
 */

import crypto from "crypto";
import { getIpaymuConfig } from "./config";

/* ==========================================
 * CONFIGURATION
 * ==========================================
 *
 * Legacy constant retained for backward compatibility with
 * static config checks. It is NOT the operational source of
 * truth anymore — payment operations resolve configuration
 * through getIpaymuConfig() (lib/payment/config.ts), which is
 * strict/fail-closed and environment-aware.
 *
 * Sandbox: https://sandbox.ipaymu.com
 * Production: https://my.ipaymu.com
 */

export const IPAYMU_CONFIG = {
    apiKey: process.env.IPAYMU_API_KEY || "",
    va: process.env.IPAYMU_VA || "",
    baseUrl:
        process.env.IPAYMU_URL ||
        (process.env.IPAYMU_IS_PRODUCTION === "true"
            ? "https://my.ipaymu.com"
            : "https://sandbox.ipaymu.com"),
};

/* ==========================================
 * SIGNATURE GENERATION
 * ==========================================
 *
 * Matches official iPaymu library behavior:
 * 1. SHA256 hash of the JSON body
 * 2. Build string: "POST:<VA>:<lowercase_hash>:<apiKey>"
 * 3. HMAC-SHA256 with apiKey as secret key
 */

export function generateSignature(
    body: string,
    va: string,
    apiKey: string
): string {
    const bodyHash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex");

    const stringToSign = `POST:${va}:${bodyHash.toLowerCase()}:${apiKey}`;

    return crypto
        .createHmac("sha256", apiKey)
        .update(stringToSign)
        .digest("hex");
}

export function generateTimestamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${y}${m}${d}${hh}${mm}${ss}`;
}

/* ==========================================
 * LEGACY SIGNATURE (for tests using old API)
 * ==========================================
 *
 * Kept for backward compatibility with tests
 * that compute the old outgoing signature.
 */
export function computeLegacyWebhookSignature(
    apiKey: string,
    timestamp: string,
    externalId: string,
    rawBody: string
): string {
    const payload = `${timestamp}:${externalId}:${rawBody}`;
    return crypto
        .createHmac("sha256", apiKey)
        .update(payload)
        .digest("hex");
}

/* ==========================================
 * PRODUCT DISPLAY NAME
 * ==========================================
 *
 * Safely format product + variant name.
 * If variantName is empty/null/undefined,
 * return only productName.
 *
 * Prevents trailing " - " which changes the
 * JSON body hash and causes iPaymu 401.
 */

export function formatProductName(
    productName: string,
    variantName?: string | null
): string {
    const trimmedName = productName.trim();
    const trimmedVariant = (variantName ?? "").trim();
    return trimmedVariant
        ? `${trimmedName} - ${trimmedVariant}`
        : trimmedName;
}

/* ==========================================
 * TYPES
 * ========================================== */

/**
 * Provider payment methods used by the direct integration.
 *
 * `cstore`, `cod`, `cc` and `paylater` are intentionally NOT part of
 * our customer flow (COD is handled by our own order flow, the others
 * are not enabled for this store).
 */
export type IpaymuDirectPaymentMethod = "va" | "qris" | "ewallet";

/**
 * Legacy type names kept for backward compatibility with existing
 * imports/static checks. The redirect flow itself has been removed.
 */
export type IpaymuPaymentMethod =
    | "va"
    | "banktransfer"
    | "cstore"
    | "cod"
    | "qris";

export type IpaymuPaymentChannel =
    | "bca"
    | "bni"
    | "mandiri"
    | "bri"
    | "bsi"
    | "permata"
    | "cimb"
    | "danamon"
    | "bmi"
    | "qris";

export type IpaymuDirectRequest = {
    /** Buyer name (required by iPaymu direct payment). */
    name: string;
    /** Buyer phone (required by iPaymu direct payment). */
    phone: string;
    /** Buyer email (required by iPaymu direct payment). */
    email: string;
    /** SERVER-AUTHORITATIVE amount (never taken from the client). */
    amount: number;
    /** SERVER-AUTHORITATIVE webhook URL (never taken from the client). */
    notifyUrl: string;
    /** SERVER-AUTHORITATIVE order reference (our orderNumber). */
    referenceId: string;
    paymentMethod: IpaymuDirectPaymentMethod;
    paymentChannel: string;
    /** Optional provider expiry, in `expiredType` units. */
    expired?: number;
    expiredType?: "days" | "hours" | "minutes" | "seconds";
    /** Optional transaction note (order summary). */
    comments?: string;
};

export type IpaymuDirectData = {
    SessionId?: string;
    TransactionId?: number | string;
    ReferenceId?: string;
    Via?: string;
    Channel?: string;
    PaymentNo?: string;
    PaymentName?: string;
    Total?: number | string;
    Fee?: number | string;
    Expired?: string;
    Note?: string | null;
    /**
     * Documented QR image URL / e-wallet action URL.
     *
     * NOTE: the live QRIS direct response does NOT populate this; it
     * returns the QR through `QrImage` instead (see below).
     */
    Url?: string;
    /**
     * QRIS QR **image** URL returned by the live direct-payment API
     * (https URL on the iPaymu host). Verified against the iPaymu
     * sandbox: `Url` is absent for QRIS while `QrImage` is present.
     */
    QrImage?: string;
    /** Raw QRIS payload string (not rendered; kept for diagnostics). */
    QrString?: string;
    /** QRIS template image URL (not used). */
    QrTemplate?: string;
};

export type IpaymuDirectResponse = {
    Status: number;
    Success?: boolean;
    Message: string;
    Data: IpaymuDirectData | null;
};

/* ==========================================
 * PAYMENT CHANNELS
 * ==========================================
 *
 * Allowlists come straight from the provider documentation
 * (docs.ipaymu.com/en/docs/payment/direct-payment) and the official
 * ipaymu-go-api constants. Anything outside these lists is rejected
 * server-side before a provider request is made.
 */

export const IPAYMU_VA_CHANNELS = [
    "bag",
    "bca",
    "bpd_bali",
    "bni",
    "cimb",
    "mandiri",
    "bmi",
    "bri",
    "bsi",
    "permata",
    "danamon",
    "btn",
] as const;

export const IPAYMU_EWALLET_CHANNELS = [
    "dana",
    "shopeepay",
    "ovo",
    "gopay",
    "linkaja",
] as const;

/**
 * QRIS channel.
 *
 * The direct-payment documentation table lists `mpm` while the official
 * Go client (NewRequestDirectQRIS) sends `qris`. Both sources are
 * authoritative, so the value is switchable via IPAYMU_QRIS_CHANNEL
 * (validated against the allowlist) instead of hard-coding one guess.
 */
export const IPAYMU_QRIS_CHANNELS = ["qris", "mpm"] as const;

export function resolveQrisChannel(
    env: Record<string, string | undefined> = process.env
): string {
    const raw = (env.IPAYMU_QRIS_CHANNEL ?? "").trim().toLowerCase();
    if (
        (IPAYMU_QRIS_CHANNELS as readonly string[]).includes(raw)
    ) {
        return raw;
    }
    return "qris";
}

export function isValidDirectChannel(
    method: IpaymuDirectPaymentMethod,
    channel: string
): boolean {
    if (method === "va") {
        return (IPAYMU_VA_CHANNELS as readonly string[]).includes(
            channel
        );
    }
    if (method === "ewallet") {
        return (
            IPAYMU_EWALLET_CHANNELS as readonly string[]
        ).includes(channel);
    }
    return (IPAYMU_QRIS_CHANNELS as readonly string[]).includes(
        channel
    );
}

/**
 * Client input validation error (HTTP 400 by convention).
 *
 * Route handlers read `error.status` when building the response.
 */
export class PaymentInputError extends Error {
    status = 400;

    constructor(message: string) {
        super(message);
        this.name = "PaymentInputError";
    }
}

/**
 * Map our internal payment method (+ optional customer-selected
 * channel) to the iPaymu direct payment method/channel pair.
 *
 * The channel is validated against the provider allowlist and can
 * therefore never be used to reach an unlisted provider channel.
 */
export function resolveProviderMethod(
    paymentMethod: "BANK_TRANSFER" | "E_WALLET" | "QRIS",
    paymentChannel?: string | null,
    env: Record<string, string | undefined> = process.env
): { method: IpaymuDirectPaymentMethod; channel: string } {
    const requested = (paymentChannel ?? "").trim().toLowerCase();

    if (paymentMethod === "QRIS") {
        return {
            method: "qris",
            channel: resolveQrisChannel(env),
        };
    }

    if (paymentMethod === "E_WALLET") {
        const channel = requested || "dana";
        if (!isValidDirectChannel("ewallet", channel)) {
            throw new PaymentInputError(
                "Channel e-wallet tidak valid."
            );
        }
        return { method: "ewallet", channel };
    }

    const channel = requested || "bca";
    if (!isValidDirectChannel("va", channel)) {
        throw new PaymentInputError(
            "Channel bank tidak valid."
        );
    }
    return { method: "va", channel };
}

/* ==========================================
 * PAYMENT INSTRUCTION (CLIENT-SAFE VIEW)
 * ==========================================
 *
 * The ONLY provider data we ever persist or return to the browser.
 * Merchant VA, API key and signature can never appear here.
 */

export type PaymentInstruction = {
    method: "BANK_TRANSFER" | "E_WALLET" | "QRIS";
    via: string;
    channel: string;
    /** Provider display name, e.g. "BCA Virtual Account". */
    channelLabel: string | null;
    /** VA number / payment code to pay to (Data.PaymentNo). */
    paymentNo: string | null;
    /** QR image URL for QRIS (Data.Url). */
    qrImageUrl: string | null;
    /** E-wallet action URL (Data.Url). */
    paymentUrl: string | null;
    /** Provider expiry (Data.Expired, WIB → UTC). */
    expiresAt: Date | null;
    /** Echo of our own reference (orderNumber). */
    referenceId: string | null;
    /** Provider-reported total (informational only). */
    total: number | null;
};

/**
 * Only accept http(s) URLs from the provider. This prevents a
 * javascript:/data: URL from ever reaching an href/src in our UI.
 */
/**
 * QR image source accepted from the provider.
 *
 * The provider documents `Url` as a QR image URL, but a base64 data URI
 * is equally valid for an <img>. Only raster image data URIs are
 * accepted (never image/svg+xml, which can carry script), and only
 * http(s) URLs otherwise.
 */
export function sanitizeQrImageUrl(
    raw: unknown
): string | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value) return null;

    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
        return value;
    }

    if (value.startsWith("data:")) return null;

    return sanitizeProviderUrl(value);
}

/**
 * Only accept http(s) URLs from the provider. This prevents a
 * javascript:/data: URL from ever reaching an href in our UI.
 */
export function sanitizeProviderUrl(
    raw: unknown
): string | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value) return null;

    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== "https:" &&
            parsed.protocol !== "http:"
        ) {
            return null;
        }
        return value;
    } catch {
        return null;
    }
}

/**
 * Parse the provider `Expired` value.
 *
 * iPaymu returns a naive Jakarta time string
 * ("2023-12-31 23:59:59", GMT+7 — there is no DST in Asia/Jakarta),
 * so it is converted to an absolute UTC instant once, here.
 *
 * Unparseable values (or implausible years) return null: we then rely
 * on the webhook / checkout cleanup instead of guessing an expiry.
 */
export function parseIpaymuExpiredAt(
    expired: unknown
): Date | null {
    if (typeof expired !== "string") return null;

    const match = expired
        .trim()
        .match(
            /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
        );
    if (!match) return null;

    const [, y, mo, d, h, mi, s] = match;
    const year = Number(y);

    if (year < 2000 || year > 2100) return null;

    const WIB_OFFSET_MINUTES = 7 * 60;
    const utcMillis =
        Date.UTC(
            year,
            Number(mo) - 1,
            Number(d),
            Number(h),
            Number(mi),
            Number(s)
        ) -
        WIB_OFFSET_MINUTES * 60 * 1000;

    const date = new Date(utcMillis);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Build the client-safe instruction from a provider response.
 *
 * Returns null when the response does not contain enough information
 * to display a payment instruction — callers must fail closed and roll
 * the order back rather than leaving an unpayable order reserving stock.
 */
export function buildPaymentInstruction(
    data: IpaymuDirectData | null,
    method: "BANK_TRANSFER" | "E_WALLET" | "QRIS"
): PaymentInstruction | null {
    if (!data) return null;

    const paymentNo =
        typeof data.PaymentNo === "string" &&
        data.PaymentNo.trim()
            ? data.PaymentNo.trim()
            : null;

    const providerUrl = sanitizeProviderUrl(data.Url);

    /*
     * QRIS image source.
     *
     * The live direct-payment API returns the scannable image as
     * `QrImage` and does NOT set `Url` (verified against the iPaymu
     * sandbox for both the `qris` and `mpm` channels). `Url` is kept
     * as a fallback so the documented/redirect-era shape still works.
     */
    const qrImageUrl =
        method === "QRIS"
            ? sanitizeQrImageUrl(data.QrImage ?? data.Url)
            : null;

    const instruction: PaymentInstruction = {
        method,
        via:
            typeof data.Via === "string" && data.Via.trim()
                ? data.Via.trim()
                : method === "QRIS"
                  ? "qris"
                  : method === "E_WALLET"
                    ? "ewallet"
                    : "va",
        channel:
            typeof data.Channel === "string" && data.Channel.trim()
                ? data.Channel.trim()
                : "",
        channelLabel:
            typeof data.PaymentName === "string" &&
            data.PaymentName.trim()
                ? data.PaymentName.trim()
                : null,
        paymentNo,
        qrImageUrl,
        paymentUrl: method === "E_WALLET" ? providerUrl : null,
        expiresAt: parseIpaymuExpiredAt(data.Expired),
        referenceId:
            typeof data.ReferenceId === "string" &&
            data.ReferenceId.trim()
                ? data.ReferenceId.trim()
                : null,
        total: Number.isFinite(Number(data.Total))
            ? Number(data.Total)
            : null,
    };

    // Per-method usability check: without one of these the customer
    // has nothing to act on, so the payment must be treated as failed.
    if (method === "BANK_TRANSFER" && !instruction.paymentNo) {
        return null;
    }

    if (
        method === "QRIS" &&
        !instruction.qrImageUrl &&
        !instruction.paymentNo
    ) {
        return null;
    }

    if (
        method === "E_WALLET" &&
        !instruction.paymentUrl &&
        !instruction.paymentNo
    ) {
        return null;
    }

    return instruction;
}

/* ==========================================
 * REQUEST TIMEOUT (30 seconds)
 * ==========================================
 *
 * Production iPaymu API typically responds
 * within 5-10 seconds. 30s covers slow
 * network without hanging indefinitely.
 */
const IPAYMU_REQUEST_TIMEOUT_MS = 30_000;

/**
 * ==========================================
 * SHARED SIGNED POST
 * ==========================================
 *
 * Single place where outgoing authenticated requests are built and
 * sent, so signature/header handling, timeout and the error taxonomy
 * exist exactly once.
 */
/**
 * Loose envelope for a provider response.
 *
 * The concrete shape is validated per endpoint (Status must be 200 and
 * Data must exist) before any field is used, so the raw JSON is kept as
 * `Record<string, unknown>` here instead of being trusted.
 */
type IpaymuProviderEnvelope = {
    Status?: number;
    Success?: boolean;
    Message?: string;
    Data?: Record<string, unknown> | null;
};

async function postToIpaymu(options: {
    path: string;
    body: string;
    label: string;
    /** Additional safe fields for the dev-only request log. */
    logFields?: Record<string, unknown>;
}): Promise<{ httpStatus: number; result: IpaymuProviderEnvelope }> {
    // FAIL-CLOSED: misconfigured servers throw before any request is sent.
    const { apiKey, va, baseUrl } = getIpaymuConfig();

    if (!apiKey || !va) {
        throw new Error(
            "iPaymu credentials belum dikonfigurasi."
        );
    }

    const signature = generateSignature(
        options.body,
        va,
        apiKey
    );
    const timestamp = generateTimestamp();

    // ==========================================
    // SECURITY: Never log API key or full signature
    // ==========================================
    if (process.env.NODE_ENV !== "production") {
        console.log(`[iPaymu] ${options.label}:`, {
            url: `${baseUrl}${options.path}`,
            ...(options.logFields ?? {}),
            bodyHash: crypto
                .createHash("sha256")
                .update(options.body)
                .digest("hex")
                .substring(0, 8) + "...",
            timestamp,
        });
    }

    // ==========================================
    // FETCH WITH TIMEOUT
    // ==========================================
    let response: Response;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            IPAYMU_REQUEST_TIMEOUT_MS
        );

        response = await fetch(`${baseUrl}${options.path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                va,
                signature,
                timestamp,
                Accept: "application/json",
            },
            body: options.body,
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
    } catch (fetchError: any) {
        // ==========================================
        // NETWORK-LEVEL ERRORS (no HTTP response)
        // ==========================================
        if (fetchError.name === "AbortError") {
            throw new Error(
                "[TIMEOUT] iPaymu request timeout (30s). Pembayaran tidak dapat dibuat saat ini."
            );
        }

        if (fetchError.cause?.code === "ENOTFOUND") {
            throw new Error(
                "[DNS_ERROR] iPaymu domain tidak dapat di-resolve. Periksa koneksi internet."
            );
        }

        if (fetchError.cause?.code === "ECONNREFUSED") {
            throw new Error(
                "[CONNECTION_REFUSED] iPaymu server menolak koneksi."
            );
        }

        if (
            fetchError.cause?.code === "ECONNRESET" ||
            fetchError.message?.includes("socket hang up")
        ) {
            throw new Error(
                "[CONNECTION_RESET] iPaymu connection terputus."
            );
        }

        if (
            fetchError.cause?.code?.startsWith("ERR_TLS") ||
            fetchError.message?.includes("SSL") ||
            fetchError.message?.includes("TLS")
        ) {
            throw new Error(
                "[TLS_ERROR] iPaymu TLS/SSL handshake gagal."
            );
        }

        // Generic network error
        throw new Error(
            `[NETWORK_ERROR] iPaymu: ${fetchError.message}`
        );
    }

    // ==========================================
    // HTTP-LEVEL RESPONSE
    // ==========================================
    let result: IpaymuProviderEnvelope;

    try {
        result = await response.json();
    } catch {
        throw new Error(
            `[INVALID_JSON] iPaymu returned non-JSON response (HTTP ${response.status})`
        );
    }

    // ==========================================
    // SECURITY: Log safe fields only
    // ==========================================
    if (process.env.NODE_ENV !== "production") {
        console.log(`[iPaymu] RESPONSE (${options.label}):`, {
            httpStatus: response.status,
            ipaymuStatus: result.Status,
            message: result.Message,
            hasPaymentNo: !!result.Data?.PaymentNo,
            hasUrl: !!result.Data?.Url,
            channel: result.Data?.Channel,
        });
    }

    // ==========================================
    // HTTP 4XX / 5XX = application-level errors
    // ==========================================
    if (response.status === 401 || response.status === 403) {
        throw new Error(
            `[AUTH_ERROR] iPaymu authentication gagal (HTTP ${response.status}). Periksa API key dan VA.`
        );
    }

    if (response.status >= 500) {
        throw new Error(
            `[IPAYMU_SERVER_ERROR] iPaymu server error (HTTP ${response.status}). Coba lagi nanti.`
        );
    }

    if (response.status !== 200) {
        throw new Error(
            `[IPAYMU_HTTP_ERROR] iPaymu returned HTTP ${response.status}: ${result.Message || "unknown"}`
        );
    }

    return { httpStatus: response.status, result };
}

/* ==========================================
 * PAYMENT CREATION (Direct)
 * ==========================================
 *
 * Endpoint: POST /api/v2/payment/direct
 *
 * The instruction (VA number / QR image URL / e-wallet URL) is
 * returned to the server caller only — it is persisted by the
 * caller and rendered on our own payment page. The customer is
 * never redirected to iPaymu.
 */

export async function createDirectPayment(
    request: IpaymuDirectRequest
): Promise<IpaymuDirectResponse> {
    // ==========================================
    // VALIDATE AMOUNT (server-authoritative)
    // ==========================================
    if (
        !Number.isFinite(request.amount) ||
        request.amount <= 0
    ) {
        throw new Error(
            `iPaymu amount tidak valid: ${request.amount}`
        );
    }

    // ==========================================
    // VALIDATE SERVER-AUTHORITATIVE FIELDS
    // ==========================================
    const referenceId = (request.referenceId ?? "").trim();
    if (!referenceId) {
        throw new Error("iPaymu referenceId wajib diisi.");
    }

    const notifyUrl = (request.notifyUrl ?? "").trim();
    if (!notifyUrl) {
        throw new Error("iPaymu notifyUrl wajib diisi.");
    }

    const name = (request.name ?? "").trim();
    const phone = (request.phone ?? "").trim();
    const email = (request.email ?? "").trim();

    if (!name || !phone || !email) {
        throw new Error(
            "Data pembeli (name/phone/email) wajib diisi."
        );
    }

    // ==========================================
    // VALIDATE METHOD / CHANNEL AGAINST ALLOWLIST
    // ==========================================
    const method = request.paymentMethod;
    const channel = (request.paymentChannel ?? "")
        .trim()
        .toLowerCase();

    if (!isValidDirectChannel(method, channel)) {
        throw new Error(
            `iPaymu paymentChannel tidak valid untuk ${method}: ${channel}`
        );
    }

    // ==========================================
    // BUILD BODY (documented fields only)
    // ==========================================
    //
    // NOTE: the amount is passed through EXACTLY as computed by the
    // server. Rounding here would make the charged amount differ from
    // order.total, and the webhook amount check compares against
    // order.total — a mismatch would make a legitimate payment
    // unrecognizable, so the value is never adjusted.
    const payload: Record<string, unknown> = {
        name,
        phone,
        email,
        amount: request.amount,
        notifyUrl,
        referenceId,
        paymentMethod: method,
        paymentChannel: channel,
    };

    if (request.comments) {
        payload.comments = request.comments.substring(0, 191);
    }

    // `expired` is only sent when explicitly requested: the provider
    // documents channels where it cannot be customized (QRIS 5 minutes,
    // BCA VA 12 hours, BSI ≤ 3h, BRI ≤ 2h), so we default to the
    // provider value and use the Expired it returns.
    if (
        Number.isInteger(request.expired) &&
        (request.expired as number) > 0
    ) {
        payload.expired = request.expired;
        payload.expiredType = request.expiredType ?? "hours";
    }

    // NOTE: product[]/qty[]/price[] are COD-only fields in the direct
    // payment contract. Our COD orders never reach iPaymu (they are
    // created directly), so those arrays are deliberately not sent for
    // va/qris/ewallet and the optional fields are ignored above.

    const body = JSON.stringify(payload);

    const { result } = await postToIpaymu({
        path: "/api/v2/payment/direct",
        body,
        label: "CREATE DIRECT PAYMENT",
        logFields: {
            amount: request.amount,
            referenceId,
            method,
            channel,
        },
    });

    // ==========================================
    // IPAYMU BUSINESS-LEVEL VALIDATION
    // ==========================================
    if (result.Status !== 200) {
        const message =
            process.env.NODE_ENV === "production"
                ? "[IPAYMU_API_ERROR] Gagal membuat pembayaran iPaymu."
                : `[IPAYMU_API_ERROR] ${result.Message || "Gagal membuat pembayaran iPaymu."}`;
        throw new Error(message);
    }

    if (!result.Data) {
        throw new Error(
            "[IPAYMU_API_ERROR] iPaymu returned success but no payment data."
        );
    }

    const data = result.Data as IpaymuDirectData;

    // Defense-in-depth: a provider total that differs from our amount
    // is logged (never trusted, never used for settlement).
    if (
        process.env.NODE_ENV !== "production" &&
        data.Total !== undefined &&
        Number(data.Total) !== Number(request.amount)
    ) {
        console.warn(
            "[iPaymu] PROVIDER TOTAL MISMATCH (informational):",
            {
                referenceId,
                requested: request.amount,
                providerTotal: data.Total,
            }
        );
    }

    return {
        Status: result.Status,
        Success: result.Success,
        Message: result.Message ?? "Success",
        Data: data,
    };
}

/* ==========================================
 * WEBHOOK SIGNATURE VERIFICATION
 * ==========================================
 *
 * iPaymu webhook notification is sent as
 * POST to the notifyUrl.
 *
 * The notification contains payment status
 * information. For security, we verify:
 *
 * 1. The amount matches the order total
 * 2. The signature in the callback (if present)
 *
 * NOTE: iPaymu v2 webhook notification body
 * format (based on official docs and sample
 * code):
 *
 * {
 *   "Status": 200,
 *   "SessionId": "ses_xxx",
 *   "ReferenceId": "ORDER_NUMBER",
 *   "PaymentMethod": "va",
 *   "PaymentChannel": "bca",
 *   "VirtualAccount": "1179000899",
 *   "Amount": "150000",
 *   "Fee": "0",
 *   "SenderBank": "bca",
 *   "SenderAccount": "1234567890",
 *   "BuyerName": "John Doe",
 *   "BuyerEmail": "john@example.com",
 *   "BuyerPhone": "081234567890",
 *   "Status": 200,
 *   "Message": "Payment success"
 * }
 *
 * Status mapping (see classifyIpaymuNotification for the full,
 * fail-safe mapping):
 * - Status 1 (status_code) → success
 * - Status 0 / 100-199 → pending
 * - Status -2 (expired) / >= 4 → failed/expired
 * - Anything else (including 2 and 3) is EXPLICITLY never success.
 *
 * NOTE: The exact webhook payload varies.
 * We handle multiple possible formats.
 */

export type IpaymuNotification = {
    Status?: number | string;
    SessionId?: string;
    TransactionId?: string;
    ReferenceId?: string;
    PaymentMethod?: string;
    PaymentChannel?: string;
    VirtualAccount?: string;
    Amount?: string | number;
    Fee?: string | number;
    SenderBank?: string;
    SenderAccount?: string;
    BuyerName?: string;
    BuyerEmail?: string;
    BuyerPhone?: string;
    Message?: string;
    PaymentId?: string;
    payment_id?: string;
    trx_id?: string;
    status?: string;
    code?: string;
    /**
     * iPaymu webhook snake_case fields
     * (real sandbox payload)
     */
    reference_id?: string;
    sid?: string;
    status_code?: string | number;
    sub_total?: string | number;
    amount?: string | number;
    fee?: string | number;
    total?: string | number;
    settlement_status?: string;
    transaction_status_code?: string | number;
    via?: string;
    channel?: string;
    payment_no?: string;
    paid_off?: number;
    created_at?: string;
    expired_at?: string;
    paid_at?: string;
    buyer_name?: string;
    buyer_email?: string;
    buyer_phone?: string;
};

/**
 * Determine if the iPaymu notification indicates
 * a successful payment.
 *
 * iPaymu Status codes:
 * - 200 = Success (berhasil)
 * - Other codes = pending/failed/expired
 *
 * We also handle string-based status formats
 * that some iPaymu webhook versions may use.
 */
export function isSuccessNotification(
    notification: IpaymuNotification
): boolean {
    // Numeric status 200 = success
    if (notification.Status === 200) {
        return true;
    }

    // String status "berhasil" = success
    if (
        typeof notification.status === "string" &&
        notification.status.toLowerCase() ===
            "berhasil"
    ) {
        return true;
    }

    return false;
}

export function isPendingNotification(
    notification: IpaymuNotification
): boolean {
    if (
        typeof notification.Status === "number" &&
        notification.Status >= 100 &&
        notification.Status < 200
    ) {
        return true;
    }

    if (
        typeof notification.status === "string" &&
        notification.status.toLowerCase() ===
            "pending"
    ) {
        return true;
    }

    return false;
}

export function isFailedNotification(
    notification: IpaymuNotification
): boolean {
    // Documented provider status code -2 = "expired".
    if (
        typeof notification.Status === "number" &&
        notification.Status < 0
    ) {
        return true;
    }

    if (
        typeof notification.Status === "number" &&
        notification.Status >= 400
    ) {
        return true;
    }

    if (
        typeof notification.status === "string" &&
        (notification.status.toLowerCase() ===
            "gagal" ||
            notification.status.toLowerCase() ===
                "failed" ||
            notification.status.toLowerCase() ===
                "expired")
    ) {
        return true;
    }

    return false;
}

/* ==========================================
 * EXPLICIT STATUS CLASSIFICATION
 * ==========================================
 *
 * F14 FIX: Instead of relying on loose "success/pending/failed"
 * heuristics, classify the notification into an explicit union
 * so an unrecognized status can NEVER be treated as success.
 *
 * iPaymu `status_code` mapping (v2 callback, official constants):
 *   1  → success (berhasil)
 *   0  → pending (menunggu pembayaran)
 *  -2  → expired (kedaluwarsa) → failed
 *   2  → cancel / 3 → refund → explicit non-success, treated as
 *        pending here so a stray code can never cancel a live order
 *  >=4 → failed / error
 *
 * String `status` values:
 *   "berhasil" → success
 *   "pending"  → pending
 *   "gagal"/"failed"/"expired"/"canceled" → failed
 *   anything else → unknown (never success)
 */
export type IpaymuStatusClass =
    | "success"
    | "pending"
    | "failed"
    | "unknown";

export function classifyIpaymuNotification(
    notification: IpaymuNotification
): IpaymuStatusClass {
    // 1. String-based status (some webhook versions)
    if (typeof notification.status === "string") {
        const s = notification.status.toLowerCase();
        if (s === "berhasil") return "success";
        if (s === "pending") return "pending";
        if (
            s === "gagal" ||
            s === "failed" ||
            s === "expired" ||
            s === "canceled" ||
            s === "cancelled"
        ) {
            return "failed";
        }
        return "unknown";
    }

    // 2. Numeric Status field (after route normalization)
    if (typeof notification.Status === "number") {
        const code = notification.Status;
        if (code === 200) return "success";
        if (code >= 100 && code < 200) return "pending";
        // Documented provider code -2 = expired.
        if (code < 0) return "failed";
        if (code >= 400) return "failed";
        // 2xx/3xx and anything else: NOT success
        return "unknown";
    }

    // 3. Raw status_code (still present on the notification)
    // NOTE: Number(undefined) → NaN, so Number.isInteger handles
    // the missing-field case without TypeScript narrowing issues.
    const rawCode = Number(notification.status_code);
    if (Number.isInteger(rawCode)) {
        if (rawCode === 1) return "success";
        if (rawCode === 0) return "pending";
        // -2 = expired (documented) → never a success
        if (rawCode < 0) return "failed";
        // 2 = cancel and 3 = refund are explicitly non-success;
        // they are non-destructive here (pending, never settle).
        if (rawCode === 2 || rawCode === 3) return "pending";
        if (rawCode >= 4) return "failed";
        return "unknown";
    }

    // 4. transaction_status_code / settlement_status fallback
    const txCode = Number(notification.transaction_status_code);
    if (Number.isInteger(txCode)) {
        if (txCode === 1) return "success";
        if (txCode === 0) return "pending";
        if (txCode === 2 || txCode === 3) return "pending";
        if (txCode >= 4) return "failed";
        return "unknown";
    }

    if (typeof notification.settlement_status === "string") {
        const s = notification.settlement_status.toLowerCase();
        if (s === "paid" || s === "settlement") return "success";
        if (s === "refunded" || s === "canceled") return "failed";
        return "unknown";
    }

    // Nothing recognizable → unknown. The route treats unknown as
    // a no-op (acknowledges to iPaymu but makes NO state change),
    // which can never accidentally settle an order.
    return "unknown";
}

/**
 * True when the notification represents a provider expiry
 * (documented codes: string "expired", status_code -2).
 */
export function isExpiryNotification(
    notification: IpaymuNotification
): boolean {
    if (
        typeof notification.status === "string" &&
        notification.status.toLowerCase() === "expired"
    ) {
        return true;
    }

    const rawCode = Number(notification.status_code);
    if (Number.isInteger(rawCode) && rawCode < 0) {
        return true;
    }

    return false;
}

/**
 * Verify the notification amount matches the
 * expected order amount.
 */
export function verifyNotificationAmount(
    notification: IpaymuNotification,
    expectedAmount: number
): boolean {
    /*
     * iPaymu webhook sends:
     * - sub_total = product total (matches order.total)
     * - amount/total = product total + fee (does NOT match)
     *
     * We compare sub_total against order.total to avoid
     * fee mismatch rejecting valid payments.
     */
    const notificationAmount = Number(
        notification.sub_total ?? notification.Amount
    );

    if (
        !Number.isFinite(notificationAmount) ||
        notificationAmount !== expectedAmount
    ) {
        return false;
    }

    return true;
}

/* ==========================================
 * CALLBACK SIGNATURE NORMALIZATION
 * ==========================================
 *
 * iPaymu callback signature verification follows
 * these steps (from official docs):
 *
 * 1. Parse form-encoded body into key-value pairs
 * 2. Normalize data types:
 *    - trx_id, status_code, transaction_status_code,
 *      paid_off → Integer
 *    - is_escrow → Boolean
 *    - additional_info → Array ([] if missing)
 *    - All other values → String
 * 3. Remove 'signature' field if present
 * 4. Ensure additional_info exists (add [] if missing)
 * 5. Sort keys alphabetically A-Z (case-sensitive)
 * 6. JSON.stringify the sorted object
 * 7. Escape forward slashes (/ → \/)
 * 8. HMAC-SHA256 with VA Number as secret key
 * 9. Compare with X-Signature header
 */
const INTEGER_KEYS = [
    "trx_id",
    "status_code",
    "transaction_status_code",
    "paid_off",
];

export function normalizeCallbackBody(
    raw: Record<string, string>
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key in raw) {
        const val = raw[key];

        if (key === "is_escrow") {
            result[key] = val === "true" || val === "1";
        } else if (INTEGER_KEYS.includes(key)) {
            result[key] = parseInt(val, 10);
        } else if (key === "additional_info") {
            if (val === "[]") {
                result[key] = [];
            } else {
                try {
                    const parsed = JSON.parse(val);
                    result[key] = Array.isArray(parsed) ? parsed : [];
                } catch {
                    result[key] = [];
                }
            }
        } else {
            result[key] = String(val);
        }
    }

    if (!Object.prototype.hasOwnProperty.call(result, "additional_info")) {
        result["additional_info"] = [];
    }

    return result;
}

/**
 * Sort object keys alphabetically (A-Z),
 * matching PHP json_encode behavior.
 */
function phpKsort(
    obj: Record<string, unknown>
): Record<string, unknown> {
    return Object.keys(obj)
        .sort((a, b) => a.localeCompare(b))
        .reduce(
            (sortedObj, key) => {
                sortedObj[key] = obj[key];
                return sortedObj;
            },
            {} as Record<string, unknown>
        );
}

/**
 * Compute the canonical JSON body used for callback
 * signature verification.
 *
 * 1. Normalize types
 * 2. Sort keys A-Z
 * 3. JSON.stringify
 * 4. Escape forward slashes
 */
export function computeCanonicalJson(
    raw: Record<string, string>
): string {
    const normalized = normalizeCallbackBody(raw);
    const sorted = phpKsort(normalized);
    let jsonBody = JSON.stringify(sorted);
    // Escape forward slashes to match PHP json_encode
    jsonBody = jsonBody.replace(/\//g, "\\/");
    return jsonBody;
}

/**
 * Compute the HMAC-SHA256 signature for a callback.
 *
 * Uses the VA Number (not API Key) as the secret.
 *
 * @param jsonBody - The canonical JSON string
 * @param merchantVa - The merchant VA number (secret key)
 * @returns hex-encoded HMAC-SHA256 signature
 */
export function computeWebhookSignature(
    jsonBody: string,
    merchantVa: string
): string {
    return crypto
        .createHmac("sha256", merchantVa)
        .update(jsonBody)
        .digest("hex");
}

/**
 * Verify the incoming iPaymu webhook signature.
 *
 * iPaymu callback signature algorithm (from official docs):
 * 1. Parse form body
 * 2. Normalize data types
 * 3. Sort keys A-Z
 * 4. JSON.stringify
 * 5. Escape slashes
 * 6. HMAC-SHA256(VA, canonicalJson)
 * 7. Compare with X-Signature
 *
 * @param rawBody - The exact raw HTTP body
 * @param receivedSignature - The value from X-Signature header
 * @param merchantVa - The VA Number (secret key for callback signature)
 * @returns true if signature is valid, false otherwise
 *
 * Security:
 * - Uses timingSafeEqual to prevent timing attacks
 * - Returns false on any error (fail-closed)
 */
export function verifyWebhookSignature(
    rawBody: string,
    receivedSignature: string,
    merchantVa: string
): boolean {
    // Fail-closed: no VA = cannot verify = reject
    if (!merchantVa) {
        return false;
    }

    // Fail-closed: missing signature = reject
    if (!receivedSignature) {
        return false;
    }

    try {
        // Parse the form-encoded body
        const params = new URLSearchParams(rawBody);
        const raw: Record<string, string> = {};
        params.forEach((value, key) => {
            raw[key] = value;
        });

        // Compute canonical JSON
        const canonicalJson = computeCanonicalJson(raw);

        // Compute expected signature using VA as secret
        const expectedSignature = computeWebhookSignature(
            canonicalJson,
            merchantVa
        );

        // Safe comparison using timingSafeEqual
        const receivedBuf = Buffer.from(receivedSignature, "utf8");
        const expectedBuf = Buffer.from(expectedSignature, "utf8");

        if (receivedBuf.length !== expectedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(receivedBuf, expectedBuf);
    } catch {
        // Any error → fail-closed
        return false;
    }
}

/**
 * ==========================================
 * SERVER-TO-SERVER PAYMENT VERIFICATION
 * ==========================================
 *
 * Defense-in-depth: query iPaymu directly to
 * verify payment status. Use when:
 * 1. Webhook signature fails but payment looks legit
 * 2. First-time payment confirmation needs
 *    authoritative verification
 * 3. Reconciliation checks
 *
 * Endpoint: POST /api/v2/payment/status
 * Auth: Same headers as outgoing (va, signature, timestamp)
 *
 * NOTE: intentionally NOT used by the customer payment page —
 * the browser must never reach the provider. It stays available for
 * server-side reconciliation / operations.
 */
export type PaymentStatusResponse = {
    Status: number;
    Data?: {
        Status?: string;
        Amount?: number;
        ReferenceId?: string;
        SessionId?: string;
    };
    Message?: string;
};

export async function verifyPaymentStatus(
    sessionId: string
): Promise<PaymentStatusResponse> {
    if (!sessionId) {
        throw new Error("SessionId tidak boleh kosong.");
    }

    const body = JSON.stringify({
        sessionId,
    });

    const { result } = await postToIpaymu({
        path: "/api/v2/payment/status",
        body,
        label: "VERIFY PAYMENT STATUS",
        logFields: { sessionId },
    });

    return result as PaymentStatusResponse;
}

/**
 * Determine if a payment status response indicates success.
 */
export function isPaymentConfirmed(
    statusResponse: PaymentStatusResponse
): boolean {
    return (
        statusResponse.Status === 200 &&
        (
            statusResponse.Data?.Status?.toLowerCase() === "paid" ||
            statusResponse.Data?.Status?.toLowerCase() === "settlement"
        )
    );
}

/**
 * Map iPaymu payment method/channel to our
 * internal CheckoutPaymentMethod.
 */
export function mapPaymentMethod(
    method?: string,
    channel?: string
): string {
    if (method === "qris" || channel === "qris") {
        return "QRIS";
    }

    if (method === "ewallet") {
        return "E_WALLET";
    }

    if (method === "va" || method === "banktransfer") {
        return "BANK_TRANSFER";
    }

    if (method === "cstore") {
        return "E_WALLET";
    }

    return "BANK_TRANSFER";
}
