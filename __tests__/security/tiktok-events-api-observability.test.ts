/**
 * ==========================================
 * TIKTOK EVENTS API — DELIVERY OBSERVABILITY
 * ==========================================
 *
 * Covers the sender's outcome reporting, which is what makes a
 * production "the event never arrived" investigation possible:
 *
 *   A. every outcome is logged (sending / accepted / not accepted /
 *      skipped / request failed) with the exact fields needed to
 *      diagnose it
 *   B. the skip reasons are distinguishable from each other, so an
 *      unreadable configuration or an invalid stored Pixel ID can
 *      no longer masquerade as "the pixel is off"
 *   C. TikTok's `request_id` (the trace id support asks for) is
 *      parsed out of the response
 *   D. a non-JSON response body is reported as such instead of
 *      collapsing into "code: undefined"
 *   E. test mode is reported per request
 *   F. nothing sensitive (token, raw identifiers, request body,
 *      test event code value) ever reaches a log
 *
 * No test ever talks to TikTok production.
 */

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import {
    TIKTOK_EVENTS_API_URL,
    sendTikTokEvent,
    trackTikTokServerCompletePayment,
} from "@/lib/analytics/tiktok-events-api";

import { TIKTOK_TEST_EVENT_CODE_ENV } from "@/lib/analytics/tiktok-events-config";

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const TOKEN = "act.example-access-token-0000wxyz";
const TEST_CODE = "TEST68129";

const RAW_EMAIL = "buyer@example.com";
const RAW_PHONE = "081234567890";
const RAW_IP = "203.0.113.77";
const RAW_USER_AGENT = "Mozilla/5.0 (Diagnostic)";

type ConsoleLevel = "log" | "warn" | "error";

type LoggedCall = {
    level: ConsoleLevel;
    args: unknown[];
};

/**
 * Capture (and silence) every console call for the duration of one
 * test, so log assertions never print noise and never race.
 */
function captureConsole(): {
    calls: LoggedCall[];
    restore: () => void;
} {
    const calls: LoggedCall[] = [];

    const logSpy = jest
        .spyOn(console, "log")
        .mockImplementation((...args) => {
            calls.push({ level: "log", args });
        });

    const warnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation((...args) => {
            calls.push({ level: "warn", args });
        });

    const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation((...args) => {
            calls.push({ level: "error", args });
        });

    return {
        calls,
        restore: () => {
            logSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        },
    };
}

function findCall(
    calls: LoggedCall[],
    message: string
): LoggedCall | undefined {
    return calls.find(
        (call) => call.args[0] === message
    );
}

/** Every captured argument, serialized — for "must not contain" checks. */
function loggedText(calls: LoggedCall[]): string {
    return calls
        .flatMap((call) => call.args)
        .map((arg) =>
            typeof arg === "string"
                ? arg
                : JSON.stringify(arg)
        )
        .join("\n");
}

function jsonResponse(
    body: unknown,
    status = 200
): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

function nonJsonResponse(status: number): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            throw new SyntaxError(
                "Unexpected token < in JSON"
            );
        },
    } as unknown as Response;
}

function configRow(
    overrides: Record<string, unknown> = {}
) {
    return {
        tiktokPixelEnabled: true,
        tiktokPixelId: PIXEL_ID,
        tiktokPixelAccessToken: TOKEN,
        ...overrides,
    };
}

function configured(
    overrides: Record<string, unknown> = {}
) {
    mockPrisma.storeSetting.findUnique.mockResolvedValue(
        configRow(overrides)
    );
}

const ORIGINAL_TEST_CODE =
    process.env[TIKTOK_TEST_EVENT_CODE_ENV];

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    delete process.env[TIKTOK_TEST_EVENT_CODE_ENV];
});

afterEach(() => {
    if (ORIGINAL_TEST_CODE === undefined) {
        delete process.env[TIKTOK_TEST_EVENT_CODE_ENV];
    } else {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            ORIGINAL_TEST_CODE;
    }
});

/* ==========================================
 * A. ACCEPTED
 * ========================================== */

describe("TikTok Events API — accepted delivery", () => {
    test("logs `sending` before the request and `event accepted` after it", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({
                code: 0,
                message: "OK",
                request_id: "req-abc-123",
            })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "ttq:completepayment:PAY-1",
                value: 125000,
                currency: "IDR",
                orderId: "PAY-1",
            });

            expect(result.ok).toBe(true);
            expect(result.code).toBe(0);
            expect(result.status).toBe(200);
            expect(result.requestId).toBe("req-abc-123");
            expect(
                result.testEventCodeConfigured
            ).toBe(false);

            const messages = capture.calls.map(
                (call) => call.args[0]
            );

            expect(messages).toEqual([
                "[TIKTOK EVENTS API] sending",
                "[TIKTOK EVENTS API] event accepted",
            ]);

            const accepted = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] event accepted"
            );

            expect(accepted?.level).toBe("log");
            expect(accepted?.args[1]).toEqual({
                event: "CompletePayment",
                eventId:
                    "ttq:completepayment:PAY-1",
                status: 200,
                code: 0,
                message: "OK",
                requestId: "req-abc-123",
                bodyReadable: true,
                testEventCodeConfigured: false,
            });

            const sending = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] sending"
            );

            expect(sending?.args[1]).toEqual({
                event: "CompletePayment",
                eventId:
                    "ttq:completepayment:PAY-1",
                testEventCodeConfigured: false,
                userKeys: [],
            });
        } finally {
            capture.restore();
        }
    });

    test("a 2xx body without code 0 is still a failure", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ message: "OK" })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e1",
            });

            expect(result.ok).toBe(false);

            const rejected = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] event not accepted"
            );

            expect(rejected?.level).toBe("error");
            expect(rejected?.args[1]).toMatchObject({
                status: 200,
                code: undefined,
                bodyReadable: true,
            });
        } finally {
            capture.restore();
        }
    });
});

/* ==========================================
 * B. REJECTED BY TIKTOK
 * ========================================== */

describe("TikTok Events API — rejected delivery", () => {
    test("a non-zero TikTok code is logged with code, message, request_id and trace status", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({
                code: 40002,
                message: "Invalid parameter",
                request_id: "req-reject-1",
            })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId:
                    "ttq:completepayment:PAY-2",
            });

            expect(result.ok).toBe(false);
            expect(result.code).toBe(40002);
            expect(result.message).toBe(
                "Invalid parameter"
            );
            expect(result.requestId).toBe(
                "req-reject-1"
            );

            const rejected = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] event not accepted"
            );

            expect(rejected?.args[1]).toEqual({
                event: "CompletePayment",
                eventId:
                    "ttq:completepayment:PAY-2",
                status: 200,
                code: 40002,
                message: "Invalid parameter",
                requestId: "req-reject-1",
                bodyReadable: true,
                testEventCodeConfigured: false,
            });
        } finally {
            capture.restore();
        }
    });

    test("HTTP failure with a non-JSON body reports bodyReadable false", async () => {
        configured();
        fetchMock.mockResolvedValue(
            nonJsonResponse(502)
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e2",
            });

            expect(result.ok).toBe(false);
            expect(result.status).toBe(502);

            const rejected = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] event not accepted"
            );

            expect(rejected?.args[1]).toMatchObject({
                status: 502,
                bodyReadable: false,
            });
        } finally {
            capture.restore();
        }
    });

    test("a network failure logs `request failed` and never throws", async () => {
        configured();
        fetchMock.mockRejectedValue(
            new TypeError("fetch failed")
        );

        const capture = captureConsole();

        try {
            await expect(
                sendTikTokEvent({
                    event: "CompletePayment",
                    eventId: "e3",
                })
            ).resolves.toMatchObject({
                ok: false,
                skipped: false,
                reason: "request_failed",
            });

            const failed = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] request failed"
            );

            expect(failed?.level).toBe("error");
            expect(failed?.args[1]).toEqual({
                event: "CompletePayment",
                eventId: "e3",
                reason: "TypeError",
                testEventCodeConfigured: false,
            });
        } finally {
            capture.restore();
        }
    });

    test("a timeout logs `request failed` with AbortError", async () => {
        configured();
        fetchMock.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e4",
            });

            expect(result.reason).toBe(
                "request_failed"
            );

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] request failed"
                )?.args[1]
            ).toMatchObject({ reason: "AbortError" });
        } finally {
            capture.restore();
        }
    });
});

/* ==========================================
 * C. SKIPPED (NOTHING SENT)
 * ==========================================
 *
 * Every one of these produced ZERO log output before, which is
 * exactly why "no TikTok log" used to prove nothing.
 */

describe("TikTok Events API — skipped delivery", () => {
    test("disabled pixel → `event skipped` reason pixel_disabled", async () => {
        configured({ tiktokPixelEnabled: false });

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e5",
            });

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe(
                "pixel_disabled"
            );
            expect(fetchMock).not.toHaveBeenCalled();

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event skipped"
                )?.args[1]
            ).toEqual({
                event: "CompletePayment",
                eventId: "e5",
                reason: "pixel_disabled",
                testEventCodeConfigured: false,
            });
        } finally {
            capture.restore();
        }
    });

    test("stored Pixel ID that fails the format check → missing_pixel_id", async () => {
        /*
         * StoreSetting.tiktokPixelId IS set (so an admin sees a
         * Pixel ID) but it does not match the Pixel ID contract,
         * so the normalizer rejects it. Previously silent.
         */
        configured({
            tiktokPixelId: "pixel-id-from-copy-paste",
        });

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e6",
            });

            expect(result.reason).toBe(
                "missing_pixel_id"
            );
            expect(fetchMock).not.toHaveBeenCalled();

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event skipped"
                )?.args[1]
            ).toMatchObject({
                reason: "missing_pixel_id",
            });
        } finally {
            capture.restore();
        }
    });

    test("missing Access Token → missing_access_token", async () => {
        configured({
            tiktokPixelAccessToken: null,
        });

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e7",
            });

            expect(result.reason).toBe(
                "missing_access_token"
            );
            expect(fetchMock).not.toHaveBeenCalled();

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event skipped"
                )?.args[1]
            ).toMatchObject({
                reason: "missing_access_token",
            });
        } finally {
            capture.restore();
        }
    });

    test("unreadable StoreSetting row → config_unavailable with the error code, not pixel_disabled", async () => {
        mockPrisma.storeSetting.findUnique.mockRejectedValue(
            Object.assign(new Error("bad column"), {
                code: "P2022",
            })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e8",
            });

            expect(result.skipped).toBe(true);
            expect(result.reason).toBe(
                "config_unavailable"
            );
            expect(fetchMock).not.toHaveBeenCalled();

            const skipped = findCall(
                capture.calls,
                "[TIKTOK EVENTS API] event skipped"
            );

            expect(skipped?.args[1]).toEqual({
                event: "CompletePayment",
                eventId: "e8",
                reason: "config_unavailable",
                testEventCodeConfigured: false,
                configError: "P2022",
            });

            const configError = findCall(
                capture.calls,
                "GET TIKTOK EVENTS API CONFIG ERROR:"
            );

            expect(configError?.args[1]).toBe("P2022");
        } finally {
            capture.restore();
        }
    });

    test("an unreadable StoreSetting row still reports test mode from the environment", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            TEST_CODE;

        mockPrisma.storeSetting.findUnique.mockRejectedValue(
            new Error("db down")
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e9",
            });

            /*
             * Proves whether the running process actually sees
             * TIKTOK_TEST_EVENT_CODE, independently of the
             * database.
             */
            expect(
                result.testEventCodeConfigured
            ).toBe(true);

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event skipped"
                )?.args[1]
            ).toMatchObject({
                reason: "config_unavailable",
                testEventCodeConfigured: true,
            });
        } finally {
            capture.restore();
        }
    });
});

/* ==========================================
 * D. TEST MODE
 * ========================================== */

describe("TikTok Events API — test mode reporting", () => {
    test("test_event_code is attached to the request and reported in every line", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            TEST_CODE;
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e10",
            });

            expect(
                result.testEventCodeConfigured
            ).toBe(true);

            const [, init] = fetchMock.mock.calls[0];
            const payload = JSON.parse(init.body);

            expect(payload.test_event_code).toBe(
                TEST_CODE
            );

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] sending"
                )?.args[1]
            ).toMatchObject({
                testEventCodeConfigured: true,
            });

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event accepted"
                )?.args[1]
            ).toMatchObject({
                status: 200,
                code: 0,
                testEventCodeConfigured: true,
            });
        } finally {
            capture.restore();
        }
    });

    test("a malformed test_event_code is not attached and not reported as configured", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            "TEST 68129";
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const capture = captureConsole();

        try {
            const result = await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e11",
            });

            expect(
                result.testEventCodeConfigured
            ).toBe(false);

            const [, init] = fetchMock.mock.calls[0];

            expect(
                "test_event_code" in
                    JSON.parse(init.body)
            ).toBe(false);

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event accepted"
                )?.args[1]
            ).toMatchObject({
                testEventCodeConfigured: false,
            });
        } finally {
            capture.restore();
        }
    });

    test("the endpoint, method and Access-Token header are unchanged", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            TEST_CODE;
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const capture = captureConsole();

        try {
            await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e12",
            });

            const [url, init] =
                fetchMock.mock.calls[0];

            expect(url).toBe(
                TIKTOK_EVENTS_API_URL
            );
            expect(init.method).toBe("POST");
            expect(init.headers["Access-Token"]).toBe(
                TOKEN
            );
            expect(
                init.headers["Content-Type"]
            ).toBe("application/json");
        } finally {
            capture.restore();
        }
    });
});

/* ==========================================
 * E. LOG HYGIENE
 * ========================================== */

describe("TikTok Events API — logs never carry secrets", () => {
    test("no token, test code value, raw identifier or request body is logged", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            TEST_CODE;
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({
                code: 0,
                message: "OK",
                request_id: "req-safe-1",
            })
        );

        const capture = captureConsole();

        try {
            await sendTikTokEvent({
                event: "CompletePayment",
                eventId:
                    "ttq:completepayment:PAY-CART-900",
                value: 150000,
                currency: "IDR",
                orderId: "PAY-CART-900",
                pageUrl:
                    "https://example.com/thank-you",
                ttclid: "ttclid-value-1",
                ttp: "ttp-cookie-value-1",
                ip: RAW_IP,
                userAgent: RAW_USER_AGENT,
                user: {
                    email: "a".repeat(64),
                    phone: "b".repeat(64),
                },
            });

            const text = loggedText(capture.calls);

            /* Secrets and PII. */
            expect(text).not.toContain(TOKEN);
            expect(text).not.toContain("Access-Token");
            expect(text).not.toContain(TEST_CODE);
            expect(text).not.toContain(RAW_IP);
            expect(text).not.toContain(
                RAW_USER_AGENT
            );
            expect(text).not.toContain("a".repeat(64));
            expect(text).not.toContain("b".repeat(64));

            /* Request/response bodies. */
            expect(text).not.toContain(
                "event_source_id"
            );
            expect(text).not.toContain(
                "ttclid-value-1"
            );
            expect(text).not.toContain(
                "ttp-cookie-value-1"
            );

            /*
             * Only the NAMES of the matching keys are logged, which
             * is what makes Advanced Matching diagnosable without
             * leaking anything.
             */
            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] sending"
                )?.args[1]
            ).toMatchObject({
                userKeys: [
                    "email",
                    "ip",
                    "phone",
                    "ttclid",
                    "ttp",
                    "user_agent",
                ],
            });
        } finally {
            capture.restore();
        }
    });

    test("failure logs stay secret-free", async () => {
        process.env[TIKTOK_TEST_EVENT_CODE_ENV] =
            TEST_CODE;
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse(
                { code: 40001, message: "unauthorized" },
                401
            )
        );

        const capture = captureConsole();

        try {
            await sendTikTokEvent({
                event: "CompletePayment",
                eventId: "e13",
            });

            const text = loggedText(capture.calls);

            expect(text).not.toContain(TOKEN);
            expect(text).not.toContain(
                "Access-Token"
            );
            expect(text).not.toContain(TEST_CODE);

            expect(
                findCall(
                    capture.calls,
                    "[TIKTOK EVENTS API] event not accepted"
                )?.args[1]
            ).toMatchObject({
                status: 401,
                code: 40001,
                message: "unauthorized",
                testEventCodeConfigured: true,
            });
        } finally {
            capture.restore();
        }
    });
});

/* ==========================================
 * F. COMPLETEPAYMENT CONTRACT (UNCHANGED)
 * ==========================================
 *
 * Logging must not alter the request. The deterministic event id
 * and the hashed/attribution `user` block are re-pinned here so a
 * future logging change cannot silently rewrite the payload.
 */

describe("TikTok Events API — CompletePayment is unchanged", () => {
    test("deterministic event id + hashed identifiers + attribution", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const capture = captureConsole();

        try {
            await trackTikTokServerCompletePayment({
                orderNumber: "PAY-CART-901",
                total: "150000.00",
                items: [
                    {
                        productId: 42,
                        productName: "Kaos",
                        quantity: 2,
                        price: "75000.00",
                    },
                ],
                email: RAW_EMAIL,
                phone: RAW_PHONE,
                userId: "user-1",
                ttclid: "ttclid-value-1",
                ttp: "ttp-cookie-value-1",
                pageUrl:
                    "https://example.com/thank-you",
                ip: RAW_IP,
                userAgent: RAW_USER_AGENT,
            });

            const [url, init] =
                fetchMock.mock.calls[0];
            const payload = JSON.parse(init.body);

            expect(url).toBe(
                TIKTOK_EVENTS_API_URL
            );
            expect(payload.event_source).toBe("web");
            expect(payload.event_source_id).toBe(
                PIXEL_ID
            );

            const event = payload.data[0];

            expect(event.event).toBe(
                "CompletePayment"
            );
            expect(event.event_id).toBe(
                "ttq:completepayment:PAY-CART-901"
            );
            expect(typeof event.event_time).toBe(
                "number"
            );

            expect(event.properties).toMatchObject({
                value: 150000,
                currency: "IDR",
                order_id: "PAY-CART-901",
                content_type: "product",
            });
            expect(
                event.properties.contents
            ).toEqual([
                {
                    content_id: "42",
                    content_type: "product",
                    content_name: "Kaos",
                    quantity: 2,
                    price: 75000,
                },
            ]);

            /* Hashed Advanced Matching — never the raw values. */
            expect(event.user.email).toHaveLength(
                64
            );
            expect(event.user.phone).toHaveLength(
                64
            );
            expect(
                event.user.external_id
            ).toHaveLength(64);
            expect(event.user.email).not.toBe(
                RAW_EMAIL
            );
            expect(event.user.phone).not.toBe(
                RAW_PHONE
            );

            /* Attribution — forwarded unhashed, by design. */
            expect(
                event.user.ttclid
            ).toBe("ttclid-value-1");
            expect(event.user.ttp).toBe(
                "ttp-cookie-value-1"
            );
            expect(event.user.ip).toBe(RAW_IP);
            expect(
                event.user.user_agent
            ).toBe(RAW_USER_AGENT);
            expect(event.page).toEqual({
                url: "https://example.com/thank-you",
            });

            /* And the raw values are nowhere in the logs. */
            const text = loggedText(capture.calls);

            expect(text).not.toContain(RAW_EMAIL);
            expect(text).not.toContain(RAW_PHONE);
            expect(text).not.toContain(RAW_IP);
        } finally {
            capture.restore();
        }
    });

    test("the same order always produces the same event id", async () => {
        configured();
        fetchMock.mockResolvedValue(
            jsonResponse({ code: 0, message: "OK" })
        );

        const capture = captureConsole();

        try {
            for (let i = 0; i < 2; i++) {
                await trackTikTokServerCompletePayment({
                    orderNumber: "PAY-CART-902",
                    total: 10000,
                    items: [],
                });
            }

            const ids = fetchMock.mock.calls.map(
                ([, init]) =>
                    JSON.parse(init.body).data[0]
                        .event_id
            );

            expect(ids).toEqual([
                "ttq:completepayment:PAY-CART-902",
                "ttq:completepayment:PAY-CART-902",
            ]);
        } finally {
            capture.restore();
        }
    });
});
