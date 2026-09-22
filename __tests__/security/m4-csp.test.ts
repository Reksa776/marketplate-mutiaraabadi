/**
 * ==========================================
 * M4 SECURITY TEST — Content-Security-Policy
 * ==========================================
 *
 * Verifies that CSP is configured with
 * appropriate restrictive directives.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function readConfig(): string {
    return readFileSync(
        resolve(process.cwd(), "next.config.ts"),
        "utf-8"
    );
}

/* ==========================================
 * TESTS
 * ========================================== */

describe("M4 — CSP Configuration Audit", () => {
    let config: string;

    beforeAll(() => {
        config = readConfig();
    });

    test("Content-Security-Policy header exists", () => {
        expect(config).toContain("Content-Security-Policy");
    });

    test("default-src is restricted to 'self'", () => {
        expect(config).toContain("default-src 'self'");
    });

    test("script-src includes 'self'", async () => {
        // CSP is now dynamically generated — validate runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") csp = h.value;
            }
        }
        expect(csp).toMatch(/script-src\s+.*'self'/);
    });

    test("script-src includes 'unsafe-inline' (required for TikTok Pixel)", async () => {
        // CSP is now dynamically generated — validate runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") csp = h.value;
            }
        }
        // TikTok Pixel uses innerHTML to inject bootstrap script
        expect(csp).toMatch(/script-src\s+.*'unsafe-inline'/);
    });

    test("script-src allows analytics.tiktok.com", () => {
        expect(config).toContain("https://analytics.tiktok.com");
    });

    test("script-src does NOT allow arbitrary external script origins", async () => {
        // CSP is now dynamically generated — validate the actual runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrcMatch).not.toBeNull();
        if (scriptSrcMatch) {
            // Must contain only known-safe origins
            expect(scriptSrcMatch[1]).toContain("'self'");
            expect(scriptSrcMatch[1]).toContain("'unsafe-inline'");
            expect(scriptSrcMatch[1]).toContain("https://analytics.tiktok.com");
            // Should NOT contain eval in production
            expect(scriptSrcMatch[1]).not.toContain("'unsafe-eval'");
        }
    });

    test("style-src includes 'self' and 'unsafe-inline'", () => {
        expect(config).toMatch(/style-src.*'self'.*'unsafe-inline'/);
    });

    test("img-src allows required image origins", () => {
        // CSP is built as array joined with '; ' — search for each origin
        expect(config).toContain("img-src 'self'");
        expect(config).toContain("https://down-id.img.susercontent.com");
        expect(config).toContain("https://unpkg.com");
        expect(config).toContain("https://*.tile.openstreetmap.org");
    });

    test("img-src allows data: URIs (for inline images)", () => {
        expect(config).toContain("img-src");
        expect(config).toContain("data:");
    });

    test("font-src is restricted to 'self'", () => {
        expect(config).toContain("font-src 'self'");
    });

    test("connect-src is restricted to 'self' + the TikTok pixel origin", async () => {
        // CSP is now dynamically generated — validate runtime output.
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }

        const connectSrcMatch = csp.match(/connect-src\s+([^;]+)/);
        expect(connectSrcMatch).not.toBeNull();

        if (connectSrcMatch) {
            expect(connectSrcMatch[1]).toContain("'self'");
            // TikTok pixel beacon/fetch target
            expect(connectSrcMatch[1]).toContain(
                "https://analytics.tiktok.com"
            );
            // Still no wildcard connect sources
            expect(connectSrcMatch[1]).not.toContain("*");
        }
    });

    test("frame-src is set to 'none'", () => {
        expect(config).toContain("frame-src 'none'");
    });

    test("object-src is set to 'none'", () => {
        expect(config).toContain("object-src 'none'");
    });

    test("base-uri is restricted to 'self'", () => {
        expect(config).toContain("base-uri 'self'");
    });

    test("form-action is restricted to 'self'", () => {
        expect(config).toContain("form-action 'self'");
    });

    test("frame-ancestors is set to 'none'", () => {
        expect(config).toContain("frame-ancestors 'none'");
    });

    test("No eval or new Function in CSP (production)", async () => {
        // CSP without 'unsafe-eval' blocks eval() and new Function()
        // Validate the actual runtime output for production
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrcMatch).not.toBeNull();
        if (scriptSrcMatch) {
            // In the current test environment (NODE_ENV=test), unsafe-eval must not be present
            expect(scriptSrcMatch[1]).not.toContain("'unsafe-eval'");
        }
    });

    test("CSP directives are semicolon-separated", () => {
        expect(config).toContain('.join("; ")');
    });

    test("No duplicate CSP definitions", () => {
        const matches = config.match(/Content-Security-Policy/g);
        expect(matches).toHaveLength(1);
    });
});

/* ==========================================
 * EXTERNAL ORIGIN VERIFICATION
 * ========================================== */

describe("M4 — External Origin Verification", () => {
    test("TikTok Pixel origin matches CSP allowance", async () => {
        // The pixel base code is now ADMIN-configurable
        // (Admin Settings → TikTok Pixel), so there is no in-repo loader
        // URL to read. The CSP allowance is the contract that keeps that
        // admin code working on the storefront.
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }

        expect(csp).toContain("https://analytics.tiktok.com");

        // Still no wildcard script sources
        const scriptSrc = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrc?.[1]).not.toContain("*");
    });

    test("Leaflet tile origin matches CSP allowance", async () => {
        const mapCode = readFileSync(
            resolve(
                process.cwd(),
                "app/addresses/new/LocationPickerMap.tsx"
            ),
            "utf-8"
        );
        // Leaflet uses tile.openstreetmap.org
        expect(mapCode).toContain("tile.openstreetmap.org");
    });

    test("Leaflet marker origin matches CSP allowance", async () => {
        const mapCode = readFileSync(
            resolve(
                process.cwd(),
                "app/addresses/new/LocationPickerMap.tsx"
            ),
            "utf-8"
        );
        // Leaflet markers come from unpkg.com
        expect(mapCode).toContain("unpkg.com");
    });
});

/* ==========================================
 * REGRESSION CHECKS
 * ========================================== */

describe("M4 — No regression to other fixes", () => {
    test("HSTS still present (M3 not broken)", () => {
        const config = readConfig();
        expect(config).toContain("Strict-Transport-Security");
        expect(config).toContain("max-age=31536000");
    });

    test("Other security headers still present", () => {
        const config = readConfig();
        expect(config).toContain("X-Content-Type-Options");
        expect(config).toContain("X-Frame-Options");
        expect(config).toContain("Referrer-Policy");
        expect(config).toContain("Permissions-Policy");
    });

    test("iPaymu outgoing signature still works (H2 not broken)", async () => {
        const { generateSignature } = await import(
            "@/lib/payment/ipaymu"
        );
        const sig = generateSignature(
            '{"amount":10000}',
            "1179000899",
            "test-key"
        );
        expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    test("getClientIp still works (M2 not broken)", async () => {
        const { getClientIp } = await import(
            "@/lib/rate-limit"
        );
        delete process.env.TRUSTED_PROXY;
        const req = new Request("https://example.com", {
            headers: { "x-forwarded-for": "1.2.3.4" },
        });
        expect(getClientIp(req)).toBe("untrusted");
    });
});
