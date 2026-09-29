/**
 * ==========================================
 * TIKTOK EVENTS API — STANDALONE PROBE
 * ==========================================
 *
 * Guards the diagnostic that operators run with plain tsx on a
 * server WITHOUT the Next.js runtime:
 *
 *   npx tsx scripts/tiktok-events-api-check.ts
 *
 * A. it can never pull in a `server-only` module again (the
 *    "Cannot find module 'server-only'" regression)
 * B. its probe request matches the verified v1.3 / Events API 2.0
 *    contract (endpoint, header, top-level test_event_code)
 * C. it carries no customer data and uses a unique event id
 * D. its acceptance rule matches the application's
 * E. it can never print the Access Token, the test code VALUE or a
 *    request body
 *
 * Source-scan assertions inspect CODE, not prose: a doc comment
 * that mentions `server-only` describes the contract, it does not
 * import it.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    TIKTOK_EVENTS_API_ENDPOINT,
    TIKTOK_EVENTS_API_TOKEN_HEADER,
    TIKTOK_PROBE_CURRENCY,
    TIKTOK_PROBE_EVENT_NAME,
    TIKTOK_PROBE_REFERENCE_PREFIX,
    buildTikTokProbeEventId,
    buildTikTokProbePayload,
    buildTikTokProbeReference,
    buildTikTokProbeReport,
    isTikTokProbeAccepted,
    readTikTokProbeResponse,
} from "@/lib/analytics/tiktok-events-api-probe";

const SCRIPT_PATH = "scripts/tiktok-events-api-check.ts";
const PROBE_PATH =
    "lib/analytics/tiktok-events-api-probe.ts";

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TEST_CODE = "TEST68129";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/** Source with every block/line comment removed. */
function readCode(relativePath: string): string {
    return readFile(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/* ==========================================
 * A. STANDALONE-SAFE IMPORTS
 * ========================================== */

describe("TikTok probe — runs without the Next.js runtime", () => {
    test("the probe module imports nothing at all", () => {
        const code = readCode(PROBE_PATH);

        /*
         * Zero imports is the strongest possible guarantee: a module
         * with no import statement cannot transitively reach
         * `import "server-only"`, which Next resolves through its
         * bundler and tsx cannot resolve at all.
         */
        expect(code).not.toMatch(
            /^\s*(import|export)\s+.*\sfrom\s+["']/m
        );
        expect(code).not.toMatch(/^\s*import\s+["']/m);
        expect(code).not.toContain("require(");
        expect(code).not.toContain("server-only");
    });

    test("the script imports no server-only analytics module", () => {
        const code = readCode(SCRIPT_PATH);

        for (const forbidden of [
            "../lib/analytics/tiktok-events-api\"",
            "../lib/analytics/tiktok-events-config",
            "../lib/analytics/tiktok-user-match",
            "@/lib/analytics/tiktok-events-api",
            "@/lib/analytics/tiktok-events-config",
            "server-only",
        ]) {
            expect(code).not.toContain(forbidden);
        }

        /* It does use the standalone probe + the pure helpers. */
        expect(code).toContain(
            "../lib/analytics/tiktok-events-api-probe"
        );
        expect(code).toContain(
            "../lib/analytics/tiktok-test-event-code"
        );
    });

    test("every module the script imports is server-only free", () => {
        for (const file of [
            PROBE_PATH,
            "lib/analytics/tiktok.ts",
            "lib/analytics/tiktok-access-token.ts",
            "lib/analytics/tiktok-test-event-code.ts",
        ]) {
            expect(readCode(file)).not.toContain(
                "server-only"
            );
        }
    });

    test("the application keeps its server-only protection", () => {
        expect(
            readCode(
                "lib/analytics/tiktok-events-config.ts"
            )
        ).toMatch(/^\s*import\s+"server-only";/m);
        expect(
            readCode(
                "lib/analytics/tiktok-events-api.ts"
            )
        ).toMatch(/^\s*import\s+"server-only";/m);
    });

    test("the test event code rule is shared with the application", () => {
        /*
         * The app must re-export the same rule the script uses,
         * otherwise the diagnostic could call a code usable while
         * the app skips it.
         */
        expect(
            readCode(
                "lib/analytics/tiktok-events-config.ts"
            )
        ).toContain(
            "@/lib/analytics/tiktok-test-event-code"
        );
    });
});

/* ==========================================
 * B. PROBE REQUEST CONTRACT
 * ========================================== */

describe("TikTok probe — request contract", () => {
    const base = {
        pixelId: PIXEL_ID,
        reference: "TIKTOK-DIAGNOSTIC-1-2",
        eventId:
            "ttq:completepayment:TIKTOK-DIAGNOSTIC-1-2",
        eventTime: new Date(
            "2026-09-29T10:00:00.000Z"
        ),
    };

    test("endpoint and token header are the verified ones", () => {
        expect(TIKTOK_EVENTS_API_ENDPOINT).toBe(
            "https://business-api.tiktok.com/open_api/v1.3/event/track/"
        );
        expect(TIKTOK_EVENTS_API_TOKEN_HEADER).toBe(
            "Access-Token"
        );
    });

    test("payload matches the Events API 2.0 shape", () => {
        const payload = buildTikTokProbePayload({
            ...base,
            testEventCode: null,
        });

        expect(payload.event_source).toBe("web");
        expect(payload.event_source_id).toBe(
            PIXEL_ID
        );
        expect("test_event_code" in payload).toBe(
            false
        );

        const event = payload.data[0];

        expect(event.event).toBe(
            TIKTOK_PROBE_EVENT_NAME
        );
        expect(event.event_id).toBe(base.eventId);
        expect(event.event_time).toBe(
            Math.floor(
                base.eventTime.getTime() / 1000
            )
        );
        expect(event.properties).toEqual({
            value: 1,
            currency: TIKTOK_PROBE_CURRENCY,
            order_id: base.reference,
        });
    });

    test("test_event_code is added at the TOP level only", () => {
        const payload = buildTikTokProbePayload({
            ...base,
            testEventCode: TEST_CODE,
        });

        expect(payload.test_event_code).toBe(
            TEST_CODE
        );

        const event = payload.data[0] as Record<
            string,
            unknown
        >;

        expect(event.test_event_code).toBeUndefined();
        expect(
            (
                event.properties as Record<
                    string,
                    unknown
                >
            ).test_event_code
        ).toBeUndefined();
    });

    test("the probe carries no customer data", () => {
        const payload = buildTikTokProbePayload({
            ...base,
            testEventCode: TEST_CODE,
        });

        const event = payload.data[0] as Record<
            string,
            unknown
        >;

        expect(event.user).toBeUndefined();
        expect(event.page).toBeUndefined();

        const serialized = JSON.stringify(payload);

        for (const forbidden of [
            "email",
            "phone",
            "ttclid",
            "ttp",
            "user_agent",
            "external_id",
            "content_id",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }

        /* Not just absent from the payload — absent from the code. */
        expect(readCode(PROBE_PATH)).not.toMatch(
            /email|phone|ttclid|user_agent|external_id/i
        );
    });
});

/* ==========================================
 * C. UNIQUENESS
 * ========================================== */

describe("TikTok probe — unique event id", () => {
    test("references are unique, recognisable and never an order number", () => {
        const first = buildTikTokProbeReference(
            1000,
            1
        );
        const second = buildTikTokProbeReference(
            1000,
            2
        );

        expect(first).not.toBe(second);
        expect(
            first.startsWith(
                TIKTOK_PROBE_REFERENCE_PREFIX
            )
        ).toBe(true);
        expect(first).toContain("1000");
        expect(first).not.toMatch(/^ORD-|^PAY-CART-/);
    });

    test("event id keeps the application's deterministic shape", () => {
        expect(
            buildTikTokProbeEventId(
                "TIKTOK-DIAGNOSTIC-1-2"
            )
        ).toBe(
            "ttq:completepayment:TIKTOK-DIAGNOSTIC-1-2"
        );
    });
});

/* ==========================================
 * D. RESPONSE HANDLING
 * ========================================== */

describe("TikTok probe — response handling", () => {
    test("a readable body is parsed defensively", () => {
        expect(
            readTikTokProbeResponse({
                code: 0,
                message: "OK",
                request_id: "req-1",
            })
        ).toEqual({
            readable: true,
            code: 0,
            message: "OK",
            requestId: "req-1",
        });

        /* Wrong types are ignored, never coerced. */
        expect(
            readTikTokProbeResponse({
                code: "0",
                message: 7,
                request_id: null,
            })
        ).toEqual({
            readable: true,
            code: undefined,
            message: undefined,
            requestId: undefined,
        });
    });

    test("an unreadable body is reported as such", () => {
        expect(
            readTikTokProbeResponse(null)
        ).toEqual({ readable: false });
        expect(
            readTikTokProbeResponse("<html>")
        ).toEqual({ readable: false });
    });

    test("acceptance is HTTP 2xx AND code 0", () => {
        expect(
            isTikTokProbeAccepted(200, {
                readable: true,
                code: 0,
            })
        ).toBe(true);

        expect(
            isTikTokProbeAccepted(200, {
                readable: true,
                code: 40002,
            })
        ).toBe(false);

        expect(
            isTikTokProbeAccepted(500, {
                readable: true,
                code: 0,
            })
        ).toBe(false);

        expect(
            isTikTokProbeAccepted(200, {
                readable: true,
            })
        ).toBe(false);
    });
});

/* ==========================================
 * E. SAFE OUTPUT
 * ========================================== */

describe("TikTok probe — report and script never leak", () => {
    test("the report exposes exactly the safe fields", () => {
        const report = buildTikTokProbeReport({
            reference: "TIKTOK-DIAGNOSTIC-1-2",
            eventId:
                "ttq:completepayment:TIKTOK-DIAGNOSTIC-1-2",
            accepted: true,
            status: 200,
            response: {
                readable: true,
                code: 0,
                message: "OK",
                requestId: "req-1",
            },
            testEventCodeConfigured: true,
        });

        expect(Object.keys(report).sort()).toEqual(
            [
                "accepted",
                "bodyReadable",
                "code",
                "endpoint",
                "event",
                "eventId",
                "message",
                "reference",
                "requestId",
                "status",
                "testEventCodeConfigured",
            ].sort()
        );

        /*
         * The test event code is reported as a BOOLEAN — its value
         * never reaches the report.
         */
        expect(report.testEventCodeConfigured).toBe(
            true
        );
        expect(JSON.stringify(report)).not.toContain(
            TEST_CODE
        );
    });

    test("the script never prints the token, a payload or a body", () => {
        const code = readCode(SCRIPT_PATH);

        for (const singleLine of code.split("\n")) {
            if (!singleLine.includes("accessToken")) {
                continue;
            }

            /*
             * The token may be USED (header value, length check) but
             * never handed to console.* or to the printer, which is
             * the only thing that could put it in a log.
             */
            expect(singleLine).not.toMatch(/console\./);
            expect(
                singleLine.trim().startsWith("line(")
            ).toBe(false);
        }

        expect(code).not.toMatch(
            /console\.[a-z]+\([^)]*payload/i
        );
        expect(code).not.toMatch(
            /console\.[a-z]+\([^)]*JSON\.stringify/i
        );
        expect(code).not.toMatch(
            /console\.[a-z]+\([^)]*testEventCode\b/
        );

        /* No hardcoded credential-looking literal, either. */
        expect(code).not.toMatch(
            /["'][A-Za-z0-9_-]{40,}["']/
        );
    });

    test("the token is only ever sent as the Access-Token header", () => {
        const code = readCode(SCRIPT_PATH);

        expect(code).toContain(
            "[TIKTOK_EVENTS_API_TOKEN_HEADER]:"
        );

        /* The probe module never handles a token at all. */
        expect(readCode(PROBE_PATH)).not.toContain(
            "accessToken"
        );
    });
});
