/**
 * ==========================================
 * EMAIL NOTIFICATION PROVIDER — FOCUSED TESTS
 * ==========================================
 *
 * Pins the two things that make the email OTP a SAFE alternative to
 * WhatsApp rather than a second, weaker door:
 *
 *   1. The provider refuses to be a blind relay. A recipient that is
 *      not an email address is rejected (INVALID_RECIPIENT) and a
 *      mailbox that is not provisioned fails closed
 *      (PROVIDER_NOT_CONFIGURED) — an undelivered code is never
 *      reported as sent.
 *   2. The NOTIFICATION SERVICE routes by CHANNEL. An "email" payload
 *      may only leave through the email transport; without one it fails
 *      closed instead of silently falling back to WhatsApp (which would
 *      send the code over a medium the buyer did not choose).
 *
 * The mailer itself is mocked here: it is exercised for real (with a
 * mocked nodemailer) in email-smtp-mailer.test.ts.
 */

const mockSendMail = jest.fn();
const mockIsMailerConfigured = jest.fn();

jest.mock("@/lib/mailer", () => ({
    sendMail: (input: unknown) => mockSendMail(input),
    isMailerConfigured: () => mockIsMailerConfigured(),
    getMailFrom: () =>
        "Mutiara Abadi <admin@mutiaraabadisnack.com>",
}));

const mockNotificationFindUnique = jest.fn();
const mockNotificationCreate = jest.fn();
const mockNotificationUpdate = jest.fn();

jest.mock("@/lib/prisma", () => ({
    prisma: {
        notification: {
            findUnique: (...args: unknown[]) =>
                mockNotificationFindUnique(...args),
            create: (...args: unknown[]) =>
                mockNotificationCreate(...args),
            update: (...args: unknown[]) =>
                mockNotificationUpdate(...args),
        },
    },
}));

import { EmailNotificationProvider } from "@/lib/notification/email-provider";
import { NotificationService } from "@/lib/notification/service";
import type { NotificationProvider } from "@/lib/notification/provider";
import type { RawMessageNotificationPayload } from "@/lib/notification/types";

const CODE = "730451";
const RECIPIENT = "buyer@example.com";
const RECOVERY_BODY = [
    "Kode Verifikasi Akses Pesanan",
    "",
    `Kode: ${CODE}`,
    "",
    "Pesanan: PAY-CART-4242",
].join("\n");

function rawPayload(
    overrides: Partial<RawMessageNotificationPayload> = {}
): RawMessageNotificationPayload {
    return {
        notificationId: 7,
        channel: "email",
        notificationType: "GUEST_RECOVERY_OTP",
        recipient: RECIPIENT,
        orderId: 4242,
        orderNumber: "PAY-CART-4242",
        rawMessage: RECOVERY_BODY,
        ...overrides,
    };
}

/** A stub provider that records calls, for the routing tests. */
type StubProvider = NotificationProvider & {
    send: jest.Mock;
    isConfigured: jest.Mock;
};

function stubProvider(name: string): StubProvider {
    return {
        name,
        isConfigured: jest.fn(() => true),
        send: jest.fn(async () => ({
            success: true,
            providerMessageId: `${name}-1`,
        })),
    };
}

beforeEach(() => {
    jest.clearAllMocks();

    mockIsMailerConfigured.mockReturnValue(true);
    mockSendMail.mockResolvedValue({
        success: true,
        messageId: "<otp-1@mail.mutiaraabadisnack.com>",
    });

    mockNotificationFindUnique.mockResolvedValue(null);
    mockNotificationCreate.mockResolvedValue({
        id: 99,
        status: "QUEUED",
        errorCode: null,
        errorMessage: null,
    });
    mockNotificationUpdate.mockResolvedValue({});
});

/* ==========================================
 * PROVIDER
 * ========================================== */

describe("EmailNotificationProvider", () => {
    test("sends the OTP with the recovery subject and the raw body as text", async () => {
        const provider = new EmailNotificationProvider();

        const result = await provider.send(rawPayload());

        expect(result).toEqual({
            success: true,
            providerMessageId:
                "<otp-1@mail.mutiaraabadisnack.com>",
        });

        expect(mockSendMail).toHaveBeenCalledTimes(1);

        const mail = mockSendMail.mock.calls[0][0];

        expect(mail.to).toBe(RECIPIENT);
        expect(mail.subject).toBe(
            "Kode Verifikasi Akses Pesanan"
        );
        expect(mail.text).toBe(RECOVERY_BODY);
        expect(mail.html).toContain(CODE);
    });

    test("never echoes the OTP back to the caller or into the logs", async () => {
        const provider = new EmailNotificationProvider();
        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});

        const result = await provider.send(rawPayload());

        const output = JSON.stringify([
            ...logSpy.mock.calls,
            result,
        ]);

        expect(output).not.toContain(CODE);
        /* The recipient is masked, never logged in full. */
        expect(output).not.toContain(RECIPIENT);

        logSpy.mockRestore();
    });

    test("refuses a recipient that is not an email address (nothing is sent)", async () => {
        const provider = new EmailNotificationProvider();

        const result = await provider.send(
            rawPayload({ recipient: "081234567890" })
        );

        expect(result).toEqual({
            success: false,
            errorCode: "INVALID_RECIPIENT",
            errorMessage: expect.any(String),
        });

        expect(mockSendMail).not.toHaveBeenCalled();
    });

    test("is NOT configured while the mailbox is unprovisioned", () => {
        mockIsMailerConfigured.mockReturnValue(false);

        expect(
            new EmailNotificationProvider().isConfigured()
        ).toBe(false);
    });

    test("reports a mailer failure instead of swallowing it", async () => {
        mockSendMail.mockResolvedValue({
            success: false,
            errorCode: "SMTP_AUTH_FAILED",
            errorMessage: "Autentikasi SMTP ditolak.",
        });

        const result = await new EmailNotificationProvider().send(
            rawPayload()
        );

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe("SMTP_AUTH_FAILED");
    });

    test("escapes the body when rendering the HTML part", async () => {
        const provider = new EmailNotificationProvider();

        await provider.send(
            rawPayload({
                rawMessage:
                    "Kode: 123456<script>alert(1)</script>",
            })
        );

        const html = mockSendMail.mock.calls[0][0].html as string;

        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });
});

/* ==========================================
 * SERVICE ROUTING BY CHANNEL
 * ========================================== */

describe("NotificationService — channel routing", () => {
    test("an email payload is delivered by the EMAIL provider", async () => {
        const whatsapp = stubProvider("whatsapp");
        const email = stubProvider("email");

        const service = new NotificationService({
            provider: whatsapp,
            channel: "whatsapp",
            emailProvider: email,
        });

        const result = await service.sendRawMessageNow({
            orderId: 4242,
            channel: "email",
            notificationType: "GUEST_RECOVERY_OTP",
            recipient: RECIPIENT,
            orderNumber: "PAY-CART-4242",
            idempotencyKey: "notif_recovery_otp_email_1",
            rawMessage: RECOVERY_BODY,
        });

        expect(result.success).toBe(true);
        expect(email.send).toHaveBeenCalledTimes(1);
        expect(whatsapp.send).not.toHaveBeenCalled();

        /* The record is auditable: channel + purpose, never the body. */
        expect(mockNotificationCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    channel: "email",
                    notificationType: "GUEST_RECOVERY_OTP",
                    recipient: RECIPIENT,
                }),
            })
        );

        expect(
            JSON.stringify(
                mockNotificationCreate.mock.calls[0][0]
            )
        ).not.toContain(CODE);
    });

    test("a whatsapp payload still uses the default provider", async () => {
        const whatsapp = stubProvider("whatsapp");
        const email = stubProvider("email");

        const service = new NotificationService({
            provider: whatsapp,
            channel: "whatsapp",
            emailProvider: email,
        });

        await service.sendRawMessageNow({
            orderId: 4242,
            channel: "whatsapp",
            notificationType: "GUEST_RECOVERY_OTP",
            recipient: "6281234567890",
            orderNumber: "PAY-CART-4242",
            idempotencyKey: "notif_recovery_otp_wa_1",
            rawMessage: `Kode: *${CODE}*`,
        });

        expect(whatsapp.send).toHaveBeenCalledTimes(1);
        expect(email.send).not.toHaveBeenCalled();
    });

    test("without an email provider an email send FAILS CLOSED (no fallback)", async () => {
        const whatsapp = stubProvider("whatsapp");

        const service = new NotificationService({
            provider: whatsapp,
            channel: "whatsapp",
        });

        const result = await service.sendRawMessageNow({
            orderId: 4242,
            channel: "email",
            notificationType: "GUEST_RECOVERY_OTP",
            recipient: RECIPIENT,
            orderNumber: "PAY-CART-4242",
            idempotencyKey: "notif_recovery_otp_email_2",
            rawMessage: RECOVERY_BODY,
        });

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(
            "CHANNEL_NOT_SUPPORTED"
        );

        /* The code was NOT sent over the other channel as a \"fallback\". */
        expect(whatsapp.send).not.toHaveBeenCalled();

        /* ...and the record is marked FAILED, not left as SENT. */
        expect(mockNotificationUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "FAILED",
                    errorCode: "CHANNEL_NOT_SUPPORTED",
                }),
            })
        );
    });

    test("an unconfigured email provider fails closed with PROVIDER_NOT_CONFIGURED", async () => {
        const whatsapp = stubProvider("whatsapp");
        const email = stubProvider("email");
        email.isConfigured.mockReturnValue(false);

        const service = new NotificationService({
            provider: whatsapp,
            channel: "whatsapp",
            emailProvider: email,
        });

        const result = await service.sendRawMessageNow({
            orderId: 4242,
            channel: "email",
            notificationType: "GUEST_RECOVERY_OTP",
            recipient: RECIPIENT,
            orderNumber: "PAY-CART-4242",
            idempotencyKey: "notif_recovery_otp_email_3",
            rawMessage: RECOVERY_BODY,
        });

        expect(result.errorCode).toBe(
            "PROVIDER_NOT_CONFIGURED"
        );
        expect(email.send).not.toHaveBeenCalled();
        expect(whatsapp.send).not.toHaveBeenCalled();
    });

    test("a SENT record under the same key is not sent twice", async () => {
        const whatsapp = stubProvider("whatsapp");
        const email = stubProvider("email");

        mockNotificationFindUnique.mockResolvedValue({
            id: 99,
            status: "SENT",
            errorCode: null,
            errorMessage: null,
        });

        const service = new NotificationService({
            provider: whatsapp,
            channel: "whatsapp",
            emailProvider: email,
        });

        const result = await service.sendRawMessageNow({
            orderId: 4242,
            channel: "email",
            notificationType: "GUEST_RECOVERY_OTP",
            recipient: RECIPIENT,
            orderNumber: "PAY-CART-4242",
            idempotencyKey: "notif_recovery_otp_email_1",
            rawMessage: RECOVERY_BODY,
        });

        expect(result.success).toBe(true);
        expect(email.send).not.toHaveBeenCalled();
    });
});
