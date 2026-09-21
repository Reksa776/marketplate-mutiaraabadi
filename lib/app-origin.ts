import type { NextRequest } from "next/server";

/**
 * ==========================================
 * APP ORIGIN RESOLUTION (SECURE)
 * ==========================================
 *
 * Resolves the application's origin URL for
 * payment callback URLs (finish, return, cancel).
 *
 * SECURITY (H1 FIX):
 * Previously, when NEXT_PUBLIC_APP_URL was not set,
 * the function fell back to x-forwarded-proto and
 * x-forwarded-host headers without validation.
 * An attacker could spoof these headers to redirect
 * users to a malicious site after payment.
 *
 * Fixed behavior:
 * 1. Always prefer NEXT_PUBLIC_APP_URL env var
 * 2. If env var not set, fall back to headers
 * 3. When using headers, validate host against allowlist
 * 4. If host doesn't match allowlist, return empty (reject)
 *
 * The allowlist includes:
 * - The hostname from NEXT_PUBLIC_APP_URL (if set)
 * - Any domains from next.config.ts allowedDevOrigins
 * - localhost for development
 */
export function getAppOrigin(request: NextRequest): string {
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;

    // ==========================================
    // PRIMARY: Use env var (trusted source)
    // ==========================================
    if (envUrl && /^https?:\/\//.test(envUrl)) {
        return envUrl.replace(/\/+$/, "");
    }

    // ==========================================
    // FALLBACK: Build from request headers
    // ==========================================
    //
    // SECURITY: Validate host against allowlist
    // to prevent open redirect via header spoofing.

    const forwardedProto =
        request.headers.get("x-forwarded-proto") || "https";

    const host =
        request.headers.get("x-forwarded-host") ||
        request.headers.get("host");

    if (!host) {
        console.error(
            "APP_ORIGIN: NEXT_PUBLIC_APP_URL tidak ter-set " +
            "dan host tidak terdeteksi dari headers."
        );
        return "";
    }

    // Strip port for allowlist matching
    const hostname = host.split(":")[0];

    // ==========================================
    // HOST ALLOWLIST
    // ==========================================
    //
    // Only allow known hostnames. If the host
    // doesn't match, reject to prevent redirect
    // to attacker-controlled domain.

    const allowedHosts = buildAllowedHosts();

    if (!allowedHosts.has(hostname.toLowerCase())) {
        console.error(
            "APP_ORIGIN: REJECTED — host not in allowlist:",
            hostname
        );
        return "";
    }

    return `${forwardedProto}://${host}`;
}

/**
 * Build the set of allowed hostnames.
 *
 * Sources:
 * 1. NEXT_PUBLIC_APP_URL hostname (if set)
 * 2. next.config.ts allowedDevOrigins (known domains)
 * 3. localhost variants (development)
 */
function buildAllowedHosts(): Set<string> {
    const hosts = new Set<string>();

    // From NEXT_PUBLIC_APP_URL
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (envUrl) {
        try {
            const parsed = new URL(envUrl);
            hosts.add(parsed.hostname.toLowerCase());
        } catch {
            // Invalid URL — skip
        }
    }

    // Known production/staging domains
    // (mirrors next.config.ts allowedDevOrigins)
    hosts.add("demosolusisejalan.my.id");
    hosts.add("mutiaraabadisnack.com");
    hosts.add("103.93.132.214");
    hosts.add("192.168.99.247");
    hosts.add("202.73.25.122");
    hosts.add("debut-thanks-spray-wine.trycloudflare.com");

    // Localhost variants (development)
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("0.0.0.0");

    return hosts;
}
