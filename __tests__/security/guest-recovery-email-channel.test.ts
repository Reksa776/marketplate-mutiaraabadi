/**
 * ==========================================
 * GUEST ORDER RECOVERY — OTP CHANNELS (EMAIL + WHATSAPP)
 * ==========================================
 *
 * The recovery flow is the only path that hands a fresh access token to
 * a buyer who has lost the checkout cookie, so every property of it is
 * pinned here for BOTH transports:
 *
 *   WhatsApp (the original channel) — unchanged: the code goes to the
 *   PHONE recorded on the order and the challenge records "whatsapp".
 *
 *   Email — new: the code goes to the EMAIL recorded on the order (never
 *   to an address typed into the form), the email factor itself must
 *   match, and the challenge records "email".
 *
 * What must hold for both:
 *   1. NO access token is rotated, minted or revealed in phase 1 — no
 *      matter which channel is chosen.
 *   2. The recipient is DERIVED FROM THE ORDER. A caller-supplied
 *      destination is never used, so the email option cannot be turned
 *      into \"send the code to my mailbox\".
 *   3. The email channel is gated on the email factor, and a mismatch is
 *      a uniform NOT_FOUND — this is not an existence oracle.
 *   4. The challenge keeps its TTL, attempt budget, contact binding and
 *      single-use redemption regardless of channel.
 *   5. A delivery failure BURNS the challenge (fail closed) — an
 *      undelivered code can never be redeemed.
 *   6. Only keyed hashes are stored; raw code/contact never appear in a
 *      response, and the code is only ever in the message handed to the
 *      provider.
 *
 * Prisma, auth and the notification pipeline are mocked: no database,
 * no WhatsApp session and no SMTP connection is touched.
 */

process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || "guest-recovery-email-test-secret";

/* A trusted proxy is configured so every request can be given a UNIQUE
 * client IP — the recovery limiters are real (in-memory), and without a
 * per-test bucket a later test would see the budget the earlier ones
 * consumed. */
process.env.TRUSTED_PROXY = "1";

jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

jest.mock("next/headers", () => ({
    cookies: jest.fn(async () => ({
        get: () => undefined,
        getAll: () => [],
    })),
}));

const mockOrder = {
    findUnique: jest.fn(),
    update: jest.fn(),
};

const mockChallenge = {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
};

const mockTx = {
    guestRecoveryChallenge: mockChallenge,
};

jest.mock("@/lib/prisma", () => ({
    prisma: {
        order: mockOrder,
        guestRecoveryChallenge: mockChallenge,
        $transaction: jest.fn(
            async (
                fn: (tx: unknown) => Promise<unknown>
            ) => fn(mockTx)
        ),
    },
}));

const mockSendRawNotificationNow = jest.fn();

jest.mock("@/lib/notification/order-status-handler", () => ({
    sendRawNotificationNow: (
        input: unknown
    ) => mockSendRawNotificationNow(input),
}));

import { prisma } from "@/lib/prisma";

import {
    RECOVERY_CODE_MAX_ATTEMPTS,
    RECOVERY_CODE_TTL_MS,
    confirmGuestRecovery,
    startGuestRecovery,
} from "@/lib/guest-recovery";
import {
    hashContact,
    hashGuestAccessToken,
    hashRecoveryCode,
    normalizePhone,
} from "@/lib/guest-identity";

import { POST as recoverPOST } from "@/app/api/orders/recover/route";
import { POST as confirmPOST } from "@/app/api/orders/recover/confirm/route";

const mockedOrder = prisma.order as unknown as {
    findUnique: jest.Mock;
    update: jest.Mock;
};
const mockedChallenge = prisma
    .guestRecoveryChallenge as unknown as {
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
};

const ORDER_ID = 4242;

let ipCounter = 0;
let contactCounter = 0;

function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter}`;
}

/** A unique contact per test, so the real per-identity limiter is not shared. */
function nextContact() {
    contactCounter += 1;
    const suffix = `${Date.now()}-${contactCounter}`;

    return {
        email: `channel-buyer-${suffix}@example.com`,
        phone: `0813${String(contactCounter).padStart(4, "0")}${String(
            Date.now() % 100000
        ).padStart(5, "0")}`,
    };
}

function orderFixture(
    contact: { email: string; phone: string },
    overrides: Record<string, unknown> = {}
) {
    return {
        id: ORDER_ID,
        userId: null,
        orderNumber: "PAY-CART-4242",
        customerEmail: contact.email,
        phone: contact.phone,
        guestAccessTokenHash: hashGuestAccessToken("old-token"),
        ...overrides,
    };
}

/** Phase-1 challenge row as persisted by startGuestRecovery. */
function challengeFixture(overrides: Record<string, unknown> = {}) {
    return {
        id: "challenge-email-1",
        orderId: ORDER_ID,
        orderNumber: "PAY-CART-4242",
        channel: "email",
        contactChannel: "email",
        contactHash: hashContact("recover-buyer@example.com"),
        codeHash: hashRecoveryCode("challenge-email-1", "123456"),
        attempts: 0,
        maxAttempts: RECOVERY_CODE_MAX_ATTEMPTS,
        deliveredAt: new Date(),
        deliveryError: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() + RECOVERY_CODE_TTL_MS),
        notificationId: 7,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

function jsonRequest(
    url: string,
    body: unknown,
    ip: string
): Request {
    return new Request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
    });
}

/** The OTP in the EMAIL body (`Kode: 123456`). */
function otpFromEmail(rawMessage: string): string {
    const match = /Kode: (\d{6})/.exec(rawMessage);

    if (!match) {
        throw new Error(
            `OTP not found in email: ${rawMessage}`
        );
    }

    return match[1];
}

/** The OTP in the WhatsApp body (`Kode: *123456*`). */
function otpFromWhatsApp(rawMessage: string): string {
    const match = /Kode: \*(\d{6})\*/.exec(rawMessage);

    if (!match) {
        throw new Error(
            `OTP not found in WhatsApp message: ${rawMessage}`
        );
    }

    return match[1];
}

beforeEach(() => {
    jest.clearAllMocks();

    mockedOrder.update.mockResolvedValue({});
    mockedChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockSendRawNotificationNow.mockResolvedValue({
        success: true,
        notificationId: 7,
    });
});

/* ==========================================
 * PHASE 1 — EMAIL CHANNEL
 * ========================================== */

describe("startGuestRecovery — email channel", () => {
    test("mails the address ON THE ORDER and records channel=email", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
            channel: "email",
        });

        expect(result).toMatchObject({
            ok: true,
            challengeId: expect.any(String),
        });

        /* Knowledge of order number + contact is still NOT ownership. */
        expect(mockedOrder.update).not.toHaveBeenCalled();

        const created =
            mockedChallenge.create.mock.calls[0][0].data;

        expect(created.channel).toBe("email");
        expect(created.contactChannel).toBe("email");
        expect(created.contactHash).toBe(
            hashContact(contact.email)
        );

        expect(
            mockSendRawNotificationNow
        ).toHaveBeenCalledTimes(1);

        const notification =
            mockSendRawNotificationNow.mock.calls[0][0];

        expect(notification.notificationType).toBe(
            "GUEST_RECOVERY_OTP"
        );
        expect(notification.channel).toBe("email");
        /* The ORDER's address — not merely \"the address that matched\". */
        expect(notification.recipient).toBe(contact.email);
        expect(notification.idempotencyKey).toContain(
            (result as { challengeId: string }).challengeId
        );

        /* The emailed code IS the code whose hash was persisted. */
        const rawCode = otpFromEmail(
            notification.rawMessage
        );

        expect(rawCode).toMatch(/^\d{6}$/);
        expect(created.codeHash).toBe(
            hashRecoveryCode(created.id, rawCode)
        );

        /* Plain-text email body, not the WhatsApp markdown one. */
        expect(notification.rawMessage).not.toContain(
            `Kode: *${rawCode}*`
        );
        expect(JSON.stringify(created)).not.toContain(rawCode);
        expect(JSON.stringify(created)).not.toContain(
            contact.email
        );
    });

    test("keeps the TTL and attempt budget of the WhatsApp flow", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const before = Date.now();

        await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
            channel: "email",
        });

        const created =
            mockedChallenge.create.mock.calls[0][0].data;

        expect(created.maxAttempts).toBe(
            RECOVERY_CODE_MAX_ATTEMPTS
        );

        const ttl =
            created.expiresAt.getTime() - before;

        expect(ttl).toBeGreaterThanOrEqual(
            RECOVERY_CODE_TTL_MS - 1000
        );
        expect(ttl).toBeLessThanOrEqual(
            RECOVERY_CODE_TTL_MS + 1000
        );
    });

    test("refuses a PHONE-only match (uniform NOT_FOUND, nothing mailed)", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                phone: contact.phone,
                channel: "email",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
        expect(mockedChallenge.create).not.toHaveBeenCalled();
    });

    test("ignores a caller-supplied address that is NOT the order's", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        /*
         * The attacker knows the order number and the phone (both sit in
         * an old confirmation) but not the email — and wants the code
         * mailed to THEIR mailbox.
         */
        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: "attacker-controlled@example.com",
                phone: contact.phone,
                channel: "email",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "NOT_FOUND",
        });

        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
    });

    test("does not depend on the order having a usable phone", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact, { phone: "not-a-phone" })
        );

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
            channel: "email",
        });

        expect(result.ok).toBe(true);
        expect(
            mockSendRawNotificationNow.mock.calls[0][0]
                .recipient
        ).toBe(contact.email);
    });

    test("a mail failure BURNS the challenge and mints no token", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockSendRawNotificationNow.mockResolvedValue({
            success: false,
            errorCode: "SMTP_AUTH_FAILED",
        });

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: contact.email,
                channel: "email",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "DELIVERY_FAILED",
        });

        expect(mockedChallenge.updateMany).toHaveBeenCalledWith({
            where: { id: expect.any(String) },
            data: expect.objectContaining({
                consumedAt: expect.any(Date),
                deliveryError: "SMTP_AUTH_FAILED",
            }),
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * PHASE 1 — WHATSAPP CHANNEL (regression)
 * ========================================== */

describe("startGuestRecovery — whatsapp channel", () => {
    test("remains the DEFAULT when no channel is given", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const result = await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
        });

        expect(result.ok).toBe(true);

        const created =
            mockedChallenge.create.mock.calls[0][0].data;
        const notification =
            mockSendRawNotificationNow.mock.calls[0][0];

        expect(created.channel).toBe("whatsapp");
        expect(notification.channel).toBe("whatsapp");

        /* The checkout phone, normalized to international form. */
        expect(notification.recipient).toBe(
            "62" + contact.phone.slice(1)
        );

        /* The WhatsApp body, with the code whose hash was stored. */
        const rawCode = otpFromWhatsApp(
            notification.rawMessage
        );

        expect(created.codeHash).toBe(
            hashRecoveryCode(created.id, rawCode)
        );
    });

    test("still FAILS CLOSED when the order has no usable phone", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact, { phone: "not-a-phone" })
        );

        await expect(
            startGuestRecovery({
                orderNumber: "PAY-CART-4242",
                email: contact.email,
                phone: contact.phone,
                channel: "whatsapp",
            })
        ).resolves.toEqual({
            ok: false,
            reason: "DELIVERY_FAILED",
        });

        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
    });

    test("an EXPLICIT whatsapp channel keeps mailing the order phone", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        await startGuestRecovery({
            orderNumber: "PAY-CART-4242",
            email: contact.email,
            channel: "whatsapp",
        });

        const notification =
            mockSendRawNotificationNow.mock.calls[0][0];

        expect(notification.channel).toBe("whatsapp");
        expect(notification.recipient).toBe(
            "62" + contact.phone.slice(1)
        );
    });
});

/* ==========================================
 * PHASE 2 — CONFIRM (both channels)
 * ========================================== */

describe("confirmGuestRecovery — channel-independent redemption", () => {
    test("an EMAIL challenge mints the token and still requires the email", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                contactHash: hashContact(contact.email),
            })
        );

        const result = await confirmGuestRecovery({
            challengeId: "challenge-email-1",
            code: "123456",
            email: contact.email,
        });

        expect(result).toMatchObject({
            ok: true,
            orderId: ORDER_ID,
            orderNumber: "PAY-CART-4242",
        });

        /* Hash + window persisted in one write; raw token never stored. */
        expect(mockedOrder.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ORDER_ID },
            })
        );

        const persisted = JSON.stringify(
            mockedOrder.update.mock.calls[0][0]
        );

        expect(persisted).not.toContain(
            (result as { token: string }).token
        );
    });

    test("a PHONE contact cannot redeem an EMAIL-bound challenge", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                contactHash: hashContact(contact.email),
            })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-email-1",
                code: "123456",
                phone: contact.phone,
            })
        ).resolves.toEqual({
            ok: false,
            reason: "INVALID",
        });

        expect(mockedOrder.update).not.toHaveBeenCalled();
    });

    test("a WhatsApp challenge still redeems with the phone contact", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                channel: "whatsapp",
                contactChannel: "phone",
                /*
                 * Phase 1 hashes the NORMALIZED checkout phone
                 * (0812... → 62812...), so the binding must be built
                 * the same way here.
                 */
                contactHash: hashContact(
                    normalizePhone(contact.phone) ??
                        contact.phone
                ),
            })
        );

        await expect(
            confirmGuestRecovery({
                challengeId: "challenge-email-1",
                code: "123456",
                phone: contact.phone,
            })
        ).resolves.toMatchObject({ ok: true });
    });
});

/* ==========================================
 * ROUTES
 * ========================================== */

describe("POST /api/orders/recover — channel selection", () => {
    test("channel=email answers 200, names the channel and leaks no code", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                    channel: "email",
                },
                nextIp()
            )
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.message).toMatch(/email/i);
        expect(body.data.channel).toBe("email");

        const rawCode = otpFromEmail(
            mockSendRawNotificationNow.mock.calls[0][0]
                .rawMessage
        );

        expect(JSON.stringify(body)).not.toContain(rawCode);
        expect(JSON.stringify(body)).not.toContain(
            contact.email
        );
    });

    test("channel=whatsapp is the default and keeps its copy", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                },
                nextIp()
            )
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.channel).toBe("whatsapp");
        expect(body.message).toMatch(/WhatsApp/i);
    });

    test("channel=email with a PHONE-only match answers 404", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    phone: contact.phone,
                    channel: "email",
                },
                nextIp()
            )
        );

        expect(response.status).toBe(404);
        expect(
            mockSendRawNotificationNow
        ).not.toHaveBeenCalled();
    });

    test("channel=email delivery failure answers 502 and says email", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockSendRawNotificationNow.mockResolvedValue({
            success: false,
            errorCode: "SMTP_NOT_CONFIGURED",
        });

        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: contact.email,
                    channel: "email",
                },
                nextIp()
            )
        );
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.message).toMatch(/email/i);
        expect(
            response.headers.get("set-cookie")
        ).toBeNull();
    });

    test("an unknown channel is rejected before any lookup", async () => {
        const response = await recoverPOST(
            jsonRequest(
                "http://test/api/orders/recover",
                {
                    orderNumber: "PAY-CART-4242",
                    email: "someone@example.com",
                    channel: "sms",
                },
                nextIp()
            )
        );

        expect(response.status).toBe(400);
        expect(mockedOrder.findUnique).not.toHaveBeenCalled();
    });
});

describe("POST /api/orders/recover/confirm — email challenge", () => {
    test("issues the access-token COOKIE and never the raw token", async () => {
        const contact = nextContact();
        mockedOrder.findUnique.mockResolvedValue(
            orderFixture(contact)
        );
        mockedChallenge.findUnique.mockResolvedValue(
            challengeFixture({
                contactHash: hashContact(contact.email),
            })
        );

        const response = await confirmPOST(
            jsonRequest(
                "http://test/api/orders/recover/confirm",
                {
                    challengeId: "challenge-email-1",
                    code: "123456",
                    email: contact.email,
                },
                nextIp()
            )
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        const cookie = response.headers.get("set-cookie");

        expect(cookie).toBeTruthy();
        expect(cookie).toContain("HttpOnly");
        expect(
            response.headers.get("set-cookie")
        ).toContain(String(ORDER_ID));

        /* The raw token lives ONLY in the cookie. */
        const rawToken = JSON.stringify(
            mockedOrder.update.mock.calls[0][0]
        ).match(/[a-f0-9]{32,}/gi);

        expect(JSON.stringify(body)).not.toContain(
            rawToken ? rawToken[0] : "___"
        );
    });
});
