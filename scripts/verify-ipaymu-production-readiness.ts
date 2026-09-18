/**
 * ==========================================
 * iPaymu PRODUCTION READINESS CHECK (READ-ONLY)
 * ==========================================
 *
 * Run:
 *   npx tsx scripts/verify-ipaymu-production-readiness.ts
 *
 * SAFETY CONTRACT
 *  - NEVER creates a payment.
 *  - NEVER contacts iPaymu (no HTTP request at all).
 *  - NEVER prints a credential value: only presence, length, hostname
 *    and allowlist facts are reported.
 *  - Only reads `process.env` through the app's own strict resolver
 *    (`lib/payment/config.ts`) plus the channel allowlists.
 *
 * Exit code 0 = ready, 1 = at least one blocker.
 */

import "dotenv/config";

import {
    buildIpaymuConfig,
    IPAYMU_PRODUCTION_BASE_URL,
    PaymentConfigError,
    resolvePayEnvironment,
} from "@/lib/payment/config";
import {
    IPAYMU_EWALLET_CHANNELS,
    IPAYMU_QRIS_CHANNELS,
    IPAYMU_VA_CHANNELS,
    isValidDirectChannel,
    resolveProviderMethod,
    resolveQrisChannel,
} from "@/lib/payment/ipaymu";

type Check = { name: string; pass: boolean; detail: string };

const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string) {
    checks.push({ name, pass, detail });
}

function val(key: string): string {
    return (process.env[key] ?? "").trim();
}

/** Presence only — never the value. */
function presence(key: string): string {
    const v = val(key);
    return v ? `SET (len=${v.length})` : "NOT SET";
}

/** Hostname / origin only — never the full URL. */
function hostOf(raw: string): string {
    if (!raw) return "NOT SET";
    try {
        return new URL(raw).hostname;
    } catch {
        return "UNPARSEABLE";
    }
}

function originOf(raw: string): string {
    if (!raw) return "NOT SET";
    try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return "UNPARSEABLE";
    }
}

const environment = val("PAYMENT_ENVIRONMENT");
const appUrlRaw = val("NEXT_PUBLIC_APP_URL");
const appUrl = appUrlRaw ? originOf(appUrlRaw) : "NOT SET";
const productionVa = val("IPAYMU_PRODUCTION_VA");
const productionApiKey = val("IPAYMU_PRODUCTION_API_KEY");
const sandboxVa = val("IPAYMU_SANDBOX_VA");

/* ==========================================
 * 1. ENVIRONMENT
 * ========================================== */

let resolvedEnv: string = environment || "MISSING";
try {
    resolvedEnv = resolvePayEnvironment(environment);
    check(
        "PAYMENT_ENVIRONMENT is a valid value",
        resolvedEnv === "production",
        `resolved='${resolvedEnv}' (expected 'production')`
    );
} catch (error) {
    check(
        "PAYMENT_ENVIRONMENT is a valid value",
        false,
        error instanceof PaymentConfigError ? error.message : "invalid"
    );
}

/* ==========================================
 * 2. STRICT CONFIG RESOLVER (FAIL-CLOSED PROOF)
 * ========================================== */

let resolvedBaseUrl = "UNRESOLVED";
let configOk = false;

try {
    const config = buildIpaymuConfig();
    resolvedBaseUrl = config.baseUrl;
    configOk = true;

    check(
        "getIpaymuConfig()-equivalent resolves in production",
        config.environment === "production",
        `environment='${config.environment}'`
    );

    check(
        "production base URL is the production iPaymu host",
        config.baseUrl === IPAYMU_PRODUCTION_BASE_URL,
        `host='${hostOf(config.baseUrl)}' (allowed: '${hostOf(
            IPAYMU_PRODUCTION_BASE_URL
        )}')`
    );

    check(
        "production API key present and plausible",
        config.apiKey.length >= 10,
        `len=${config.apiKey.length}`
    );

    check(
        "production VA present and plausible",
        /^\d{10,20}$/.test(config.va),
        `len=${config.va.length}, numeric=${/^\d{10,20}$/.test(config.va)}`
    );

    check(
        "production VA is not the sandbox VA (no credential reuse)",
        !sandboxVa || config.va !== sandboxVa,
        sandboxVa
            ? "production VA differs from sandbox VA"
            : "sandbox VA not set — nothing to reuse"
    );
} catch (error) {
    check(
        "strict payment config resolves",
        false,
        error instanceof PaymentConfigError ||
            error instanceof Error
            ? error.message
            : "unknown error"
    );
}

/* ==========================================
 * 3. APP URL (HTTPS, NON-LOCALHOST)
 * ========================================== */

try {
    if (!appUrlRaw) {
        check("NEXT_PUBLIC_APP_URL is set", false, "NOT SET");
    } else {
        const parsed = new URL(appUrlRaw);

        check(
            "NEXT_PUBLIC_APP_URL uses HTTPS",
            parsed.protocol === "https:",
            `protocol='${parsed.protocol}'`
        );

        check(
            "NEXT_PUBLIC_APP_URL is not localhost / sandbox",
            !["localhost", "127.0.0.1", "0.0.0.0"].includes(
                parsed.hostname
            ) && !parsed.hostname.includes("sandbox"),
            `host='${parsed.hostname}'`
        );
    }
} catch {
    check("NEXT_PUBLIC_APP_URL is parseable", false, "UNPARSEABLE");
}

/* ==========================================
 * 4. PAYMENT CHANNELS (QRIS + ALLOWLISTS)
 * ========================================== */

const qrisChannel = resolveQrisChannel();

check(
    "QRIS channel resolves inside the allowlist",
    (IPAYMU_QRIS_CHANNELS as readonly string[]).includes(qrisChannel),
    `channel='${qrisChannel}', allowed=[${IPAYMU_QRIS_CHANNELS.join(", ")}]`
);

check(
    "VA allowlist is non-empty and self-consistent",
    IPAYMU_VA_CHANNELS.length > 0 &&
        IPAYMU_VA_CHANNELS.every((c) => isValidDirectChannel("va", c)),
    `${IPAYMU_VA_CHANNELS.length} banks`
);

check(
    "e-wallet allowlist is non-empty and self-consistent",
    IPAYMU_EWALLET_CHANNELS.length > 0 &&
        IPAYMU_EWALLET_CHANNELS.every((c) =>
            isValidDirectChannel("ewallet", c)
        ),
    `${IPAYMU_EWALLET_CHANNELS.length} wallets`
);

// The mapping the routes actually use (pure function, no HTTP).
for (const method of ["BANK_TRANSFER", "E_WALLET", "QRIS"] as const) {
    try {
        const mapped = resolveProviderMethod(method, null);
        check(
            `resolveProviderMethod(${method}) maps to an allowlisted channel`,
            isValidDirectChannel(mapped.method, mapped.channel),
            `method='${mapped.method}', channel='${mapped.channel}'`
        );
    } catch (error) {
        check(
            `resolveProviderMethod(${method})`,
            false,
            error instanceof Error ? error.message : "failed"
        );
    }
}

/* ==========================================
 * REPORT (masked)
 * ========================================== */

console.log("\n=== iPaymu PRODUCTION READINESS (read-only) ===\n");

console.log("Environment facts (values masked):");
console.log(`  PAYMENT_ENVIRONMENT  : ${environment || "NOT SET"}`);
console.log(
    `  IPAYMU_URL host      : ${hostOf(val("IPAYMU_URL"))}  (legacy diagnostic var, unused by the app)`
);
console.log(`  IPAYMU_PRODUCTION_BASE_URL host : ${hostOf(val("IPAYMU_PRODUCTION_BASE_URL"))}`);
console.log(`  Resolved base URL host          : ${hostOf(resolvedBaseUrl)}`);
console.log(`  APP_URL origin       : ${appUrl}`);
console.log(`  Production API key   : ${presence("IPAYMU_PRODUCTION_API_KEY")}`);
console.log(`  Production VA        : ${presence("IPAYMU_PRODUCTION_VA")}`);
console.log(`  Sandbox API key      : ${presence("IPAYMU_SANDBOX_API_KEY")}`);
console.log(`  Sandbox VA           : ${presence("IPAYMU_SANDBOX_VA")}`);
console.log(`  QRIS channel         : ${qrisChannel}`);

console.log("\nChecks:");
for (const c of checks) {
    console.log(`  ${c.pass ? "✅" : "❌"} ${c.name} — ${c.detail}`);
}

const failed = checks.filter((c) => !c.pass);
console.log(
    `\nRESULT: ${checks.length - failed.length}/${checks.length} passed` +
        (failed.length ? ` — ${failed.length} BLOCKER(S)` : " — READY")
);

// The resolver must have produced a usable production config.
if (!configOk && failed.length === 0) {
    console.log("❌ BLOCKER: strict payment config did not resolve.");
    process.exit(1);
}

process.exit(failed.length === 0 ? 0 : 1);
