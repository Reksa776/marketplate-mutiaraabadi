/**
 * ==========================================
 * iPaymu DIRECT PAYMENT — RUNTIME VERIFICATION HARNESS
 * ==========================================
 *
 * Read-only with respect to production: this script is HARD-GUARDED to
 * the iPaymu SANDBOX and refuses to run against any other endpoint.
 *
 * Modes:
 *   probe [qris|va|ewallet]
 *                    — call POST /api/v2/payment/direct for every
 *                      channel (QRIS, VA banks, e-wallets) through the
 *                      app's own createDirectPayment() and print the
 *                      ACTUAL provider response shape (sanitized).
 *                      The optional argument only NARROWS the run to
 *                      one method (it can never widen it).
 *   check            — print the resolved payment configuration
 *                      (masked) and assert sandbox-only safety.
 *
 * No database writes, no order creation, no production traffic.
 * Credentials are never printed: only presence and length.
 */

import "dotenv/config";

import {
    createDirectPayment,
    buildPaymentInstruction,
    resolveProviderMethod,
    IPAYMU_EWALLET_CHANNELS,
    IPAYMU_VA_CHANNELS,
    type IpaymuDirectPaymentMethod,
} from "@/lib/payment/ipaymu";
import { getIpaymuConfig } from "@/lib/payment/config";

/* ==========================================
 * SAFETY GATE
 * ==========================================
 * Fail closed: the provider probes CREATE payments, so this script
 * must never be able to target production.
 */

function assertSandbox(): { baseUrl: string; environment: string } {
    const config = getIpaymuConfig();

    if (
        config.environment !== "sandbox" ||
        !config.baseUrl.includes("sandbox.ipaymu.com")
    ) {
        console.error(
            "❌ REFUSED: resolved payment config is not the iPaymu sandbox.\n" +
                `   environment=${config.environment} baseUrl=${config.baseUrl}\n` +
                "   This harness creates provider payments and must never run against production."
        );
        process.exit(1);
    }

    return { baseUrl: config.baseUrl, environment: config.environment };
}

function mask(label: string, value: string): string {
    if (!value) return `${label}=<unset>`;
    return `${label}=<set,len=${value.length},masked>`;
}

/* ==========================================
 * PROVIDER PROBE
 * ========================================== */

function hostOf(url: string | undefined | null): string | null {
    if (typeof url !== "string" || !url.trim()) return null;

    if (url.startsWith("data:")) {
        return `data:${url.slice(5, url.indexOf(";") > 0 ? url.indexOf(";") : 30)}`;
    }

    try {
        return new URL(url).host;
    } catch {
        return "<unparseable>";
    }
}

/**
 * Describe an unknown provider value WITHOUT printing it.
 *
 * Used for fields whose runtime shape is not yet documented
 * (e.g. the QRIS `QrImage` / `QrString` / `QrTemplate` members):
 * the report only needs to know the KIND, host and length.
 */
function describeValue(raw: unknown): string | null {
    if (raw === undefined) return null;
    if (raw === null) return "null";
    if (typeof raw !== "string") return `${typeof raw},len=${String(raw).length}`;

    const value = raw.trim();
    if (!value) return "empty-string";

    if (value.startsWith("data:")) {
        const semi = value.indexOf(";");
        const mime = value.slice(5, semi > 0 ? semi : 30);
        return `data-uri:${mime},len=${value.length}`;
    }

    if (/^https?:\/\//i.test(value)) {
        try {
            return `url:${new URL(value).host},len=${value.length}`;
        } catch {
            return `http-like-unparseable,len=${value.length}`;
        }
    }

    const newlines = (value.match(/\n/g) ?? []).length;
    return `raw-string,len=${value.length},lines=${newlines + 1}`;
}

type ProbeResult = {
    label: string;
    method: IpaymuDirectPaymentMethod;
    channel: string;
    ok: boolean;
    status?: number;
    message?: string;
    via?: string;
    channelEchoed?: string;
    paymentNo?: string;
    paymentName?: string;
    expired?: string;
    total?: unknown;
    fee?: unknown;
    urlHost?: string | null;
    urlPresent: boolean;
    sessionIdPresent: boolean;
    transactionIdPresent: boolean;
    dataKeys: string[];
    instructionAccepted: boolean;
    /** Shape (never content) of QRIS-specific provider fields. */
    qrImage?: string | null;
    qrString?: string | null;
    qrTemplate?: string | null;
    /** What the app's buildPaymentInstruction() actually mapped. */
    instructionQrImage?: string | null;
    instructionPaymentNoLength?: number;
    error?: string;
};

async function probe(
    method: IpaymuDirectPaymentMethod,
    channel: string,
    amount = 10_000
): Promise<ProbeResult> {
    const referenceId = `VERIFY-${method}-${channel}-${Date.now()}`
        .toUpperCase()
        .slice(0, 60);

    const result: ProbeResult = {
        label: `${method}/${channel}`,
        method,
        channel,
        ok: false,
        urlPresent: false,
        sessionIdPresent: false,
        transactionIdPresent: false,
        dataKeys: [],
        instructionAccepted: false,
    };

    try {
        const response = await createDirectPayment({
            name: "Runtime Verification",
            phone: "081234567890",
            email: "verify@example.com",
            amount,
            notifyUrl:
                "https://example.com/api/payment/ipaymu/notification",
            referenceId,
            paymentMethod: method,
            paymentChannel: channel,
            comments: "sandbox runtime verification",
        });

        const data = (response.Data ?? {}) as Record<string, unknown>;

        result.ok = response.Status === 200;
        result.status = response.Status;
        result.message = response.Message;
        result.via = data.Via as string | undefined;
        result.channelEchoed = data.Channel as string | undefined;
        result.paymentNo = data.PaymentNo as string | undefined;
        result.paymentName = data.PaymentName as string | undefined;
        result.expired = data.Expired as string | undefined;
        result.total = data.Total;
        result.fee = data.Fee;
        result.urlPresent = Boolean(data.Url);
        result.urlHost = hostOf(data.Url as string | undefined);
        result.sessionIdPresent = Boolean(data.SessionId);
        result.transactionIdPresent = data.TransactionId !== undefined;
        result.dataKeys = Object.keys(data).sort();
        result.qrImage = describeValue(data.QrImage);
        result.qrString = describeValue(data.QrString);
        result.qrTemplate = describeValue(data.QrTemplate);

        const instruction = buildPaymentInstruction(
            data as never,
            method === "va"
                ? "BANK_TRANSFER"
                : method === "qris"
                  ? "QRIS"
                  : "E_WALLET"
        );
        result.instructionAccepted = Boolean(instruction);
        result.instructionQrImage = instruction
            ? describeValue(instruction.qrImageUrl)
            : null;
        result.instructionPaymentNoLength =
            instruction?.paymentNo?.length ?? 0;
    } catch (error) {
        result.error =
            error instanceof Error
                ? error.message.slice(0, 300)
                : String(error);
    }

    return result;
}

async function runProbes(only?: string): Promise<void> {
    const wants = (method: IpaymuDirectPaymentMethod) =>
        !only || only === method;
    const { baseUrl, environment } = assertSandbox();
    const config = getIpaymuConfig();

    console.log("========== ENVIRONMENT ==========");
    console.log(`PAYMENT_ENVIRONMENT=${environment}`);
    console.log(`BASE_URL=${baseUrl}`);
    console.log(mask("VA", config.va));
    console.log(mask("API_KEY", config.apiKey));
    console.log(
        `IPAYMU_QRIS_CHANNEL=${process.env.IPAYMU_QRIS_CHANNEL ?? "<unset> (defaults to qris)"}`
    );
    console.log(
        `resolvedQrisChannel=${resolveProviderMethod("QRIS").channel}`
    );

    const results: ProbeResult[] = [];

    /* QRIS — test the configured channel AND the documented alternative. */
    const configuredQris = resolveProviderMethod("QRIS").channel;
    const qrisChannels = Array.from(
        new Set([configuredQris, "qris", "mpm"])
    );

    for (const channel of qrisChannels) {
        if (!wants("qris")) break;
        console.log(`\n--- probing qris/${channel} ---`);
        const r = await probe("qris", channel);
        results.push(r);
        console.log(JSON.stringify(r, null, 1));
    }

    /* VIRTUAL ACCOUNT — documented bank list. */
    for (const channel of IPAYMU_VA_CHANNELS) {
        if (!wants("va")) break;
        console.log(`\n--- probing va/${channel} ---`);
        const r = await probe("va", channel);
        results.push(r);
        console.log(JSON.stringify(r, null, 1));
    }

    /* E-WALLET */
    for (const channel of IPAYMU_EWALLET_CHANNELS) {
        if (!wants("ewallet")) break;
        console.log(`\n--- probing ewallet/${channel} ---`);
        const r = await probe("ewallet", channel);
        results.push(r);
        console.log(JSON.stringify(r, null, 1));
    }

    console.log("\n========== SUMMARY ==========");
    for (const r of results) {
        console.log(
            [
                r.label.padEnd(18),
                r.ok ? "OK " : "FAIL",
                `status=${r.status ?? "-"}`,
                `payNo=${r.paymentNo ? "yes" : "no"}`,
                `url=${r.urlPresent ? r.urlHost : "no"}`,
                `exp=${r.expired ?? "-"}`,
                `ui=${r.instructionAccepted ? "yes" : "NO"}`,
                r.error ? `err=${r.error.slice(0, 60)}` : "",
                r.ok ? "" : `msg=${(r.message ?? "").slice(0, 60)}`,
            ]
                .filter(Boolean)
                .join(" | ")
        );
    }

    const okCount = results.filter((r) => r.ok).length;
    console.log(`\n${okCount}/${results.length} probes returned Status 200`);
}

async function main(): Promise<void> {
    const mode = process.argv[2] ?? "check";

    if (mode === "check") {
        const { baseUrl, environment } = assertSandbox();
        const config = getIpaymuConfig();
        console.log("PAYMENT_ENVIRONMENT=", environment);
        console.log("BASE_URL=", baseUrl);
        console.log(mask("VA", config.va));
        console.log(mask("API_KEY", config.apiKey));
        console.log("SANDBOX GATE: PASS");
        return;
    }

    if (mode === "probe") {
        // Optional filter: `probe qris` / `probe va` / `probe ewallet`
        // Only narrows the run — it can never widen it beyond the
        // sandbox-gated allowlists above.
        await runProbes(process.argv[3]);
        return;
    }

    console.error(`Unknown mode: ${mode} (expected "check" or "probe")`);
    process.exit(1);
}

main().catch((error) => {
    console.error("HARNESS ERROR:", error?.message ?? error);
    process.exit(1);
});
