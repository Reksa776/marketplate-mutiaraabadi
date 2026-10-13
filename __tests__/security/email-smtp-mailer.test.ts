/**
 * ==========================================
 * SMTP MAILER — TRANSPORT CONFIGURATION
 * ==========================================
 *
 * The guest recovery OTP is delivered over SMTP through the mailbox
 * that already exists on the VPS. Two properties decide whether that
 * delivery is trustworthy, and both are pinned here without any network
 * call (the nodemailer transport is mocked, so nothing connects):
 *
 *   1. TLS is MANDATORY — submission port 587 is plaintext until it is
 *      upgraded, so `requireTLS` must be on and the server certificate
 *      must be VERIFIED. A rejected certificate has to abort the send,
 *      never be downgraded to a warning.
 *   2. The mailbox is REQUIRED — with SMTP_HOST/SMTP_USER/SMTP_PASSWORD
 *      incomplete, every send fails closed with SMTP_NOT_CONFIGURED. An
 *      un-provisioned mailbox can never look like a delivered code.
 *
 * SECRETS: the SMTP password and the message body (which carries the
 * OTP) must never appear in a result or a log line.
 */

const mockSendMail = jest.fn();
const mockVerify = jest.fn();
const mockCreateTransport = jest.fn();

jest.mock("nodemailer", () => ({
    createTransport: (options: unknown) => {
        mockCreateTransport(options);

        return {
            sendMail: (message: unknown) =>
                mockSendMail(message),
            verify: () => mockVerify(),
        };
    },
}));

const ENV_KEYS = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "MAIL_FROM",
] as const;

const HOST = "mail.mutiaraabadisnack.com";
const USER = "admin@mutiaraabadisnack.com";
const PASSWORD = "super-secret-smtp-password";
const CODE = "481920";

function clearSmtpEnv(): void {
    ENV_KEYS.forEach((key) => {
        delete process.env[key];
    });
}

function setSmtpEnv(overrides: Partial<Record<string, string>> = {}) {
    process.env.SMTP_HOST = HOST;
    process.env.SMTP_PORT = "587";
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_USER = USER;
    process.env.SMTP_PASSWORD = PASSWORD;

    Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
}

/**
 * A FRESH module instance per test: lib/mailer caches its transport, so
 * sharing the module would leak one test's configuration into the next.
 */
async function loadMailer() {
    return import("@/lib/mailer");
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    clearSmtpEnv();
    setSmtpEnv();
    mockSendMail.mockResolvedValue({
        messageId: "<otp-1@mail.mutiaraabadisnack.com>",
    });
    mockVerify.mockResolvedValue(true);
});

afterAll(() => {
    clearSmtpEnv();
});

describe("SMTP configuration", () => {
    test("is NOT configured until host, user and password are all present", async () => {
        const mailer = await loadMailer();

        expect(mailer.isMailerConfigured()).toBe(true);

        delete process.env.SMTP_PASSWORD;

        expect(mailer.isMailerConfigured()).toBe(false);

        const result = await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(result).toEqual({
            success: false,
            errorCode: "SMTP_NOT_CONFIGURED",
            errorMessage: expect.any(String),
        });

        /* Nothing was even attempted. */
        expect(mockCreateTransport).not.toHaveBeenCalled();
        expect(mockSendMail).not.toHaveBeenCalled();
    });

    test("uses submission 587 with MANDATORY STARTTLS and certificate verification", async () => {
        const mailer = await loadMailer();

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(mockCreateTransport).toHaveBeenCalledTimes(1);

        const options = mockCreateTransport.mock
            .calls[0][0] as Record<string, unknown>;

        expect(options).toMatchObject({
            host: HOST,
            port: 587,
            /* 587 upgrades to TLS, so implicit TLS is off... */
            secure: false,
            /* ...but the upgrade is REQUIRED (never a plaintext AUTH). */
            requireTLS: true,
            auth: { user: USER, pass: PASSWORD },
            tls: { rejectUnauthorized: true },
        });

        /* Bounded timeouts, so a hung mail server cannot pin a request. */
        expect(
            Number(options.connectionTimeout)
        ).toBeGreaterThan(0);
        expect(
            Number(options.greetingTimeout)
        ).toBeGreaterThan(0);
        expect(
            Number(options.socketTimeout)
        ).toBeGreaterThan(0);
    });

    test("honours SMTP_SECURE=true (implicit TLS) when configured that way", async () => {
        setSmtpEnv({ SMTP_SECURE: "true", SMTP_PORT: "465" });

        const mailer = await loadMailer();

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(mockCreateTransport).toHaveBeenCalledWith(
            expect.objectContaining({
                port: 465,
                secure: true,
                requireTLS: true,
                tls: { rejectUnauthorized: true },
            })
        );
    });

    test("falls back to 587 when SMTP_PORT is missing or nonsense", async () => {
        setSmtpEnv({ SMTP_PORT: "not-a-port" });

        const mailer = await loadMailer();

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(mockCreateTransport).toHaveBeenCalledWith(
            expect.objectContaining({ port: 587 })
        );
    });
});

describe("sender identity", () => {
    test("defaults to the store mailbox with the \"Mutiara Abadi\" display name", async () => {
        delete process.env.MAIL_FROM;

        const mailer = await loadMailer();

        expect(mailer.getMailFrom()).toBe(
            "Mutiara Abadi <admin@mutiaraabadisnack.com>"
        );

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(mockSendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                from: "Mutiara Abadi <admin@mutiaraabadisnack.com>",
            })
        );
    });

    test("uses MAIL_FROM when the operator sets it", async () => {
        setSmtpEnv({
            MAIL_FROM:
                "Mutiara Abadi <no-reply@mutiaraabadisnack.com>",
        });

        const mailer = await loadMailer();

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: "body",
        });

        expect(mockSendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                from: "Mutiara Abadi <no-reply@mutiaraabadisnack.com>",
            })
        );
    });
});

describe("sending", () => {
    test("passes the body through unchanged and reuses one transport", async () => {
        const mailer = await loadMailer();
        const body = `Kode: ${CODE}\n\nBerlaku 10 menit.`;

        const result = await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode Verifikasi Akses Pesanan",
            text: body,
        });

        expect(result).toEqual({
            success: true,
            messageId:
                "<otp-1@mail.mutiaraabadisnack.com>",
        });

        expect(mockSendMail).toHaveBeenCalledWith({
            from: "Mutiara Abadi <admin@mutiaraabadisnack.com>",
            to: "buyer@example.com",
            subject: "Kode Verifikasi Akses Pesanan",
            text: body,
            /*
             * The mailer is transport-only: it forwards the HTML part
             * the caller supplies (the provider renders it) and never
             * invents body content of its own.
             */
            html: undefined,
        });

        await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode",
            text: body,
        });

        /* A second send must NOT build a second connection pool. */
        expect(mockCreateTransport).toHaveBeenCalledTimes(1);
        expect(mockSendMail).toHaveBeenCalledTimes(2);
    });

    test("refuses an empty recipient without touching the server", async () => {
        const mailer = await loadMailer();

        const result = await mailer.sendMail({
            to: "   ",
            subject: "Kode",
            text: "body",
        });

        expect(result).toEqual({
            success: false,
            errorCode: "INVALID_RECIPIENT",
            errorMessage: expect.any(String),
        });

        expect(mockSendMail).not.toHaveBeenCalled();
    });
});

describe("application-side verification (no email sent)", () => {
    test("passes only after connect + STARTTLS + certificate + AUTH", async () => {
        const mailer = await loadMailer();

        await expect(
            mailer.verifyMailerConnection()
        ).resolves.toEqual({ ok: true });

        expect(mockVerify).toHaveBeenCalledTimes(1);
        /* Verification never sends a message. */
        expect(mockSendMail).not.toHaveBeenCalled();
    });

    test("fails closed while the mailbox is unprovisioned", async () => {
        delete process.env.SMTP_PASSWORD;

        const mailer = await loadMailer();

        await expect(
            mailer.verifyMailerConnection()
        ).resolves.toEqual({
            ok: false,
            errorCode: "SMTP_NOT_CONFIGURED",
            errorMessage: expect.any(String),
        });

        expect(mockVerify).not.toHaveBeenCalled();
    });

    test("reports an AUTH rejection as a failure, not a success", async () => {
        const mailer = await loadMailer();

        mockVerify.mockRejectedValue(
            Object.assign(new Error("auth"), {
                code: "EAUTH",
            })
        );

        await expect(
            mailer.verifyMailerConnection()
        ).resolves.toEqual({
            ok: false,
            errorCode: "SMTP_AUTH_FAILED",
            errorMessage: expect.any(String),
        });
    });

    test("reports a certificate/TLS rejection as a failure", async () => {
        const mailer = await loadMailer();

        mockVerify.mockRejectedValue(
            Object.assign(new Error("tls"), {
                code: "ERR_TLS_CERT_ALTNAME_INVALID",
            })
        );

        await expect(
            mailer.verifyMailerConnection()
        ).resolves.toMatchObject({
            ok: false,
            errorCode: "SMTP_TLS_FAILED",
        });
    });
});

describe("failure classification (fail closed)", () => {
    test.each([
        ["EAUTH", "SMTP_AUTH_FAILED"],
        ["535", "SMTP_AUTH_FAILED"],
        ["CERT_HAS_EXPIRED", "SMTP_TLS_FAILED"],
        [
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "SMTP_TLS_FAILED",
        ],
        ["ECONNECTION", "SMTP_CONNECTION_FAILED"],
        ["ETIMEDOUT", "SMTP_CONNECTION_FAILED"],
        ["SOMETHING_ELSE", "MAIL_SEND_FAILED"],
    ])(
        "maps provider error %s to %s",
        async (providerCode, expectedCode) => {
            const mailer = await loadMailer();
            const error = Object.assign(
                new Error("provider said no"),
                { code: providerCode }
            );

            mockSendMail.mockRejectedValue(error);

            const result = await mailer.sendMail({
                to: "buyer@example.com",
                subject: "Kode",
                text: `Kode: ${CODE}`,
            });

            expect(result.success).toBe(false);
            expect(
                (result as { errorCode: string }).errorCode
            ).toBe(expectedCode);
        }
    );

    test("ESOCKET is classified by its message: TLS vs plain connectivity", async () => {
        const mailer = await loadMailer();

        /* A failed STARTTLS upgrade surfaces as the generic ESOCKET. */
        mockSendMail.mockRejectedValueOnce(
            Object.assign(
                new Error(
                    "write EPROTO wrong version number"
                ),
                { code: "ESOCKET" }
            )
        );

        await expect(
            mailer.sendMail({
                to: "buyer@example.com",
                subject: "Kode",
                text: "body",
            })
        ).resolves.toMatchObject({
            success: false,
            errorCode: "SMTP_TLS_FAILED",
        });

        /* A plain socket failure must NOT be reported as a TLS problem. */
        mockSendMail.mockRejectedValueOnce(
            Object.assign(
                new Error("connection reset by peer"),
                { code: "ESOCKET" }
            )
        );

        await expect(
            mailer.sendMail({
                to: "buyer@example.com",
                subject: "Kode",
                text: "body",
            })
        ).resolves.toMatchObject({
            success: false,
            errorCode: "SMTP_CONNECTION_FAILED",
        });
    });

    test("never logs or returns the OTP body or the SMTP password", async () => {
        const mailer = await loadMailer();

        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        mockSendMail.mockRejectedValue(
            Object.assign(new Error("boom"), {
                code: "EAUTH",
            })
        );

        const result = await mailer.sendMail({
            to: "buyer@example.com",
            subject: "Kode Verifikasi Akses Pesanan",
            text: `Kode: ${CODE}`,
        });

        const output = JSON.stringify([
            ...logSpy.mock.calls,
            ...errorSpy.mock.calls,
            result,
        ]);

        expect(output).not.toContain(CODE);
        expect(output).not.toContain(PASSWORD);

        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test("a verify failure never logs the password either", async () => {
        const mailer = await loadMailer();

        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});

        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        mockVerify.mockRejectedValue(
            Object.assign(new Error("nope"), {
                code: "EAUTH",
            })
        );

        const result = await mailer.verifyMailerConnection();

        const output = JSON.stringify([
            ...logSpy.mock.calls,
            ...errorSpy.mock.calls,
            result,
        ]);

        expect(output).not.toContain(PASSWORD);

        logSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
