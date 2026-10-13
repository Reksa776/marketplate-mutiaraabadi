/**
 * ==========================================
 * CLIENT IP / TRUSTED PROXY — REGRESSION TESTS
 * ==========================================
 *
 * `x-forwarded-for` and `x-real-ip` are client-controllable. They may
 * only be honoured behind a known reverse proxy, otherwise an attacker
 * could mint a fresh rate-limit bucket per request.
 *
 * TRUST RULE (see docs/TRUSTED-PROXY.md):
 *   - TRUSTED_PROXY unset  → headers ignored, sentinel "untrusted".
 *   - TRUSTED_PROXY set    → client IP is the entry TRUSTED_PROXY_HOPS
 *     (default 1) from the RIGHT of x-forwarded-for, because only the
 *     entries our own proxies appended are trustworthy. A client-sent
 *     leftmost value must never win.
 *   - Anything that is not an IP literal fails closed to "untrusted".
 *
 * The flip side is equally important: when TRUSTED_PROXY is NOT set the
 * sentinel makes every guest share ONE bucket, so these tests also pin
 * down which limiter key each guest path uses. That is the deployment
 * prerequisite documented in the audit (all guest limiters are global
 * until TRUSTED_PROXY is configured).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    getClientIp,
    guestDeviceKey,
    guestIdentityKey,
    guestIpKey,
    UNTRUSTED_IP,
} from "@/lib/rate-limit";

const ORIGINAL_TRUSTED_PROXY = process.env.TRUSTED_PROXY;
const ORIGINAL_TRUSTED_PROXY_HOPS = process.env.TRUSTED_PROXY_HOPS;

afterEach(() => {
    if (ORIGINAL_TRUSTED_PROXY === undefined) {
        delete process.env.TRUSTED_PROXY;
    } else {
        process.env.TRUSTED_PROXY = ORIGINAL_TRUSTED_PROXY;
    }

    if (ORIGINAL_TRUSTED_PROXY_HOPS === undefined) {
        delete process.env.TRUSTED_PROXY_HOPS;
    } else {
        process.env.TRUSTED_PROXY_HOPS =
            ORIGINAL_TRUSTED_PROXY_HOPS;
    }
});

function requestWith(
    headers: Record<string, string> = {}
): Request {
    return new Request("http://test", { headers });
}

describe("getClientIp", () => {
    test("ignores forwarding headers when no trusted proxy is configured", () => {
        delete process.env.TRUSTED_PROXY;

        const ip = getClientIp(
            requestWith({
                "x-forwarded-for": "203.0.113.9, 10.0.0.1",
                "x-real-ip": "203.0.113.9",
            })
        );

        // Spoofing a header must NOT buy a unique bucket.
        expect(ip).toBe(UNTRUSTED_IP);
    });

    test("uses the hop our own proxy appended, not the client-supplied leftmost value", () => {
        process.env.TRUSTED_PROXY = "1";

        /*
         * `client → nginx → app` with nginx using
         * `$proxy_add_x_forwarded_for`: the attacker-injected
         * "1.2.3.4" sits on the LEFT, and the address nginx actually
         * saw is appended on the RIGHT.
         */
        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "1.2.3.4, 203.0.113.9",
                })
            )
        ).toBe("203.0.113.9");
    });

    test("a single-entry chain resolves to that entry", () => {
        process.env.TRUSTED_PROXY = "1";

        // `proxy_set_header X-Forwarded-For $remote_addr` (overwrite).
        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "203.0.113.9",
                })
            )
        ).toBe("203.0.113.9");
    });

    test("TRUSTED_PROXY_HOPS counts our proxies from the right (CDN topology)", () => {
        process.env.TRUSTED_PROXY = "1";
        process.env.TRUSTED_PROXY_HOPS = "2";

        /*
         * `client → CDN → nginx → app`: the rightmost entry is nginx's
         * peer (the CDN) and the one before it is the real client.
         */
        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "203.0.113.9, 198.51.100.7",
                })
            )
        ).toBe("203.0.113.9");
    });

    test("a hop count deeper than the chain fails closed instead of trusting the leftmost entry", () => {
        process.env.TRUSTED_PROXY = "1";
        /*
         * A misconfigured (too deep) hop count means we cannot tell
         * which entry our proxies wrote, so the request is treated as
         * untrusted — never as "the leftmost value must be the client".
         */
        process.env.TRUSTED_PROXY_HOPS = "9";

        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "203.0.113.9",
                })
            )
        ).toBe(UNTRUSTED_IP);
    });

    test("malformed hop config is clamped to a single trusted hop", () => {
        process.env.TRUSTED_PROXY = "1";
        process.env.TRUSTED_PROXY_HOPS = "not-a-number";

        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "1.2.3.4, 203.0.113.9",
                })
            )
        ).toBe("203.0.113.9");
    });

    test("falls back to x-real-ip behind a trusted proxy", () => {
        process.env.TRUSTED_PROXY = "1";

        expect(
            getClientIp(requestWith({ "x-real-ip": "198.51.100.7" }))
        ).toBe("198.51.100.7");
    });

    test("still returns the sentinel when the proxy sends neither header", () => {
        process.env.TRUSTED_PROXY = "1";

        expect(getClientIp(requestWith())).toBe(UNTRUSTED_IP);
    });

    test("a non-IP value fails closed instead of becoming a bucket key", () => {
        process.env.TRUSTED_PROXY = "1";

        // A hostname, a port suffix or a crafted key fragment must not
        // be usable to mint (or collide with) a limiter bucket.
        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for":
                        "attacker.example.com, 203.0.113.9:443",
                    "x-real-ip": "not-an-ip",
                })
            )
        ).toBe(UNTRUSTED_IP);
    });

    test("an empty hop is not treated as a client address", () => {
        process.env.TRUSTED_PROXY = "1";

        expect(
            getClientIp(
                requestWith({
                    "x-forwarded-for": "203.0.113.9,   ",
                })
            )
        ).toBe("203.0.113.9");
    });
});

describe("guest limiter keys", () => {
    test("the IP bucket is shared for every guest without TRUSTED_PROXY", () => {
        /*
         * Documents the availability constraint of finding B2: the
         * bucket below is the SAME string for all clients, so an
         * unconfigured deployment has a global (not per-client) guest
         * ceiling until TRUSTED_PROXY is set.
         */
        const shared = guestIpKey({
            ip: UNTRUSTED_IP,
            scope: "cod",
        });

        expect(
            guestIpKey({ ip: UNTRUSTED_IP, scope: "cod" })
        ).toBe(shared);
        expect(shared).toBe("guest:cod:ip:untrusted");
    });

    test("a real client IP yields a distinct bucket", () => {
        expect(
            guestIpKey({ ip: "203.0.113.9", scope: "cod" })
        ).not.toBe(
            guestIpKey({ ip: "203.0.113.10", scope: "cod" })
        );
    });

    test("device and identity buckets are namespaced and optional", () => {
        expect(
            guestDeviceKey({
                ip: "203.0.113.9",
                scope: "recover-request",
                deviceKey: "e:abc",
            })
        ).toBe("guest:recover-request:dev:e:abc");

        expect(
            guestDeviceKey({
                ip: "203.0.113.9",
                scope: "recover-request",
            })
        ).toBeNull();

        expect(
            guestIdentityKey({
                ip: "203.0.113.9",
                scope: "cod",
                identityKey: "g1:a:b",
            })
        ).toBe("guest:cod:id:g1:a:b");

        expect(
            guestIdentityKey({
                ip: "203.0.113.9",
                scope: "cod",
            })
        ).toBeNull();
    });

    test("recovery uses BOTH an IP bucket and a contact bucket", () => {
        /*
         * Two-way protection: the IP bucket caps one client, the
         * hashed-contact bucket caps one buyer rotating clients. A
         * denial from either must be honoured by the recovery routes.
         */
        const ip = "203.0.113.9";

        expect(
            guestIpKey({ ip, scope: "recover" })
        ).not.toBe(guestIpKey({ ip, scope: "recover-request" }));

        /*
         * The contact bucket deliberately does NOT include the IP: one
         * buyer switching addresses must stay in the SAME bucket, or
         * they could simply rotate IPs to farm unlimited recovery
         * requests against their own orders.
         */
        expect(
            guestDeviceKey({
                ip,
                scope: "recover-request",
                deviceKey: "e:hash",
            })
        ).toBe(
            guestDeviceKey({
                ip: "203.0.113.10",
                scope: "recover-request",
                deviceKey: "e:hash",
            })
        );

        expect(
            guestDeviceKey({
                ip,
                scope: "recover-request",
                deviceKey: "p:other-hash",
            })
        ).not.toBe(
            guestDeviceKey({
                ip,
                scope: "recover-request",
                deviceKey: "e:hash",
            })
        );
    });
});

/* ==========================================
 * DOCUMENTED CONFIGURATION (deployment deliverable)
 * ========================================== */

describe("TRUSTED_PROXY is documented where operators look", () => {
    const envExample = readFileSync(
        resolve(process.cwd(), ".env.example"),
        "utf-8"
    );
    const doc = readFileSync(
        resolve(process.cwd(), "docs/TRUSTED-PROXY.md"),
        "utf-8"
    );

    test(".env.example documents both knobs", () => {
        expect(envExample).toContain("TRUSTED_PROXY=");
        expect(envExample).toContain("TRUSTED_PROXY_HOPS=");

        // …and warns that trusting headers is opt-in.
        expect(envExample).toContain("LEAVE EMPTY");
    });

    test("the doc states the rightmost-hop rule and the topology table", () => {
        expect(doc).toContain("TRUSTED_PROXY_HOPS");
        expect(doc.toLowerCase()).toContain("rightmost");

        // Both supported topologies must be spelled out.
        expect(doc).toMatch(/nginx/);
        expect(doc).toMatch(/CDN/i);

        // The doc must not promise the spoofable behaviour.
        expect(doc).not.toMatch(/first IP in x-forwarded-for/i);
    });
});
