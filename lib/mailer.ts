/**
 * ==========================================
 * SMTP MAILER
 * ==========================================
 *
 * The single outbound email path for the app (today: the guest order
 * recovery OTP). It talks to the mailbox that already exists on the
 * VPS, so no new mailbox and no MTA change is involved.
 *
 * TRANSPORT
 * ---------
 *   * submission port 587 with STARTTLS, `requireTLS: true` — the
 *     connection MUST be upgraded to TLS before any AUTH or MAIL FROM,
 *     so credentials are never offered in the clear.
 *   * `secure: false` because 587 is a plaintext port that upgrades
 *     (implicit TLS is 465).
 *   * Certificate verification is ON (Node's default, stated
 *     explicitly): a bad/self-signed/wrong-host certificate FAILS the
 *     send instead of silently continuing.
 *   * Bounded timeouts, so a hanging mail server cannot pin a request.
 *
 * FAIL CLOSED
 * -----------
 * `isMailerConfigured()` is false until SMTP_HOST, SMTP_USER and
 * SMTP_PASSWORD are all present. Callers (see the notification service)
 * treat that as a delivery FAILURE, never as a silent success, so an
 * un-provisioned mailbox can never look like a delivered OTP.
 *
 * SECRETS
 * -------
 * The SMTP password and the message body (which can carry an OTP) are
 * NEVER logged, never returned in an error and never persisted. Only a
 * coarse error CODE reaches the caller.
 */

import type { Transporter } from "nodemailer";

/** Sender identity for every message: name + the existing mailbox. */
const DEFAULT_FROM =
    "Mutiara Abadi <admin@mutiaraabadisnack.com>";

/** Submission port (plaintext + STARTTLS upgrade). */
const DEFAULT_PORT = 587;

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export type SendMailInput = {
    to: string;
    subject: string;
    text: string;
    html?: string;
};

export type SendMailResult =
    | { success: true; messageId: string | null }
    | {
          success: false;
          errorCode: string;
          errorMessage: string;
      };

export type VerifyMailerResult =
    | { ok: true }
    | {
          ok: false;
          errorCode: string;
          errorMessage: string;
      };

type SmtpConfig = {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    user: string;
    password: string;
    from: string;
};

/**
 * Read the SMTP settings from the environment.
 *
 * Returns null when the mailbox is not provisioned — the caller must
 * then fail closed. The password is never trimmed into a log line, and
 * its value never leaves this module.
 */
function readSmtpConfig(): SmtpConfig | null {
    const host = process.env.SMTP_HOST?.trim();
    const user = process.env.SMTP_USER?.trim();
    const password = process.env.SMTP_PASSWORD;

    if (!host || !user || !password) {
        return null;
    }

    /*
     * SMTP_SECURE="true" means implicit TLS (port 465). The configured
     * mailbox uses submission 587 + STARTTLS, so the default is false
     * and TLS is still REQUIRED through `requireTLS`.
     */
    const secure =
        (process.env.SMTP_SECURE || "").trim().toLowerCase() ===
        "true";

    const parsedPort = Number(
        (process.env.SMTP_PORT || "").trim()
    );

    const port =
        Number.isInteger(parsedPort) &&
        parsedPort > 0 &&
        parsedPort <= 65535
            ? parsedPort
            : DEFAULT_PORT;

    return {
        host,
        port,
        secure,
        requireTLS: true,
        user,
        password,
        from:
            process.env.MAIL_FROM?.trim() || DEFAULT_FROM,
    };
}

/**
 * Is the mailbox provisioned? False means "cannot send", never
 * "sent anyway".
 */
export function isMailerConfigured(): boolean {
    return readSmtpConfig() !== null;
}

/**
 * The From header in use (display name + address). Exposed so callers
 * and tests can assert the sender identity WITHOUT touching secrets.
 */
export function getMailFrom(): string {
    return (
        readSmtpConfig()?.from ?? DEFAULT_FROM
    );
}

/**
 * Lazily built transport, reused across sends.
 *
 * `nodemailer` is imported DYNAMICALLY so it never enters the static
 * module graph (same isolation pattern as the Baileys provider) and so
 * the send path stays server-only.
 */
let transportPromise: Promise<Transporter> | null = null;

function getTransport(config: SmtpConfig): Promise<Transporter> {
    if (!transportPromise) {
        transportPromise = (async () => {
            const nodemailer = await import("nodemailer");

            return nodemailer.createTransport({
                host: config.host,
                port: config.port,
                secure: config.secure,
                /*
                 * STARTTLS is mandatory: nodemailer refuses to
                 * continue if the server does not offer it, so AUTH
                 * can never happen on a plaintext connection.
                 */
                requireTLS: true,
                auth: {
                    user: config.user,
                    pass: config.password,
                },
                tls: {
                    /*
                     * Certificate verification ENABLED. An invalid,
                     * expired or wrong-host certificate aborts the
                     * send — it is never downgraded to a warning.
                     */
                    rejectUnauthorized: true,
                },
                connectionTimeout: CONNECTION_TIMEOUT_MS,
                greetingTimeout: GREETING_TIMEOUT_MS,
                socketTimeout: SOCKET_TIMEOUT_MS,
            });
        })().catch((error) => {
            /* A failed build must be retried by the next send. */
            transportPromise = null;

            throw error;
        });
    }

    return transportPromise;
}

/**
 * Map a nodemailer/Node failure to a coarse, non-sensitive code.
 *
 * The raw provider response is deliberately NOT forwarded: it can echo
 * the envelope, and for the OTP path the caller only needs to know that
 * delivery failed (it fails closed on any non-success).
 */
/** Socket/OpenSSL codes that mean "the TLS layer refused". */
const TLS_CODES = [
    "ETLS",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

/**
 * Markers a TLS failure carries in its message.
 *
 * Needed because nodemailer reports a failed TLS upgrade as the generic
 * `ESOCKET` — the operator chasing a TLS problem must not be told it was
 * a plain connectivity problem, and vice versa.
 */
const TLS_MESSAGE_MARKERS =
    /certificate|self[- ]signed|wrong version number|tls|ssl|handshake|starttls/i;

function classifyError(error: unknown): {
    errorCode: string;
    errorMessage: string;
} {
    const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error
            ? String(
                  (error as { code?: unknown }).code ?? ""
              )
            : "";

    const message =
        error instanceof Error
            ? error.message
            : String(error ?? "");

    if (code === "EAUTH" || code === "535") {
        return {
            errorCode: "SMTP_AUTH_FAILED",
            errorMessage:
                "Autentikasi SMTP ditolak. Periksa kredensial mailbox.",
        };
    }

    if (
        TLS_CODES.includes(code) ||
        (code === "ESOCKET" &&
            TLS_MESSAGE_MARKERS.test(message))
    ) {
        return {
            errorCode: "SMTP_TLS_FAILED",
            errorMessage:
                "Koneksi TLS ke server SMTP gagal atau sertifikat tidak terverifikasi.",
        };
    }

    if (
        code === "ETIMEDOUT" ||
        code === "ECONNECTION" ||
        code === "ECONNREFUSED" ||
        code === "ESOCKET" ||
        code === "EDNS" ||
        code === "ENOTFOUND"
    ) {
        return {
            errorCode: "SMTP_CONNECTION_FAILED",
            errorMessage:
                "Tidak dapat terhubung ke server SMTP.",
        };
    }

    return {
        errorCode: "MAIL_SEND_FAILED",
        errorMessage: "Gagal mengirim email.",
    };
}

/**
 * Check the mailbox from the APPLICATION side, without sending mail.
 *
 * `transport.verify()` opens the connection, performs the mandatory
 * STARTTLS upgrade, validates the server certificate and runs SMTP AUTH
 * — then disconnects. Nothing is delivered to anyone, and the password
 * is never returned or logged, which makes this the intended pre-flight
 * check on a freshly configured server:
 *
 *   npx tsx scripts/verify-smtp-mailer.ts
 *
 * A mailbox that only looks healthy in webmail can still fail here, so
 * this is the check that actually clears (or blocks) the OTP email
 * channel.
 */
export async function verifyMailerConnection(): Promise<VerifyMailerResult> {
    const config = readSmtpConfig();

    if (!config) {
        return {
            ok: false,
            errorCode: "SMTP_NOT_CONFIGURED",
            errorMessage:
                "SMTP belum dikonfigurasi (SMTP_HOST/SMTP_USER/SMTP_PASSWORD).",
        };
    }

    try {
        const transport = await getTransport(config);

        await transport.verify();

        return { ok: true };
    } catch (error) {
        const classified = classifyError(error);

        console.error(
            `[MAILER] Verify failed | Code: ${classified.errorCode}`
        );

        return {
            ok: false,
            errorCode: classified.errorCode,
            errorMessage: classified.errorMessage,
        };
    }
}

/**
 * Send one message.
 *
 * Never throws: a delivery failure is reported as
 * `{ success: false, errorCode }` so a caller can fail closed.
 *
 * The `text` body may contain an OTP — it is passed straight to the
 * transport and never logged.
 */
export async function sendMail(
    input: SendMailInput
): Promise<SendMailResult> {
    const config = readSmtpConfig();

    if (!config) {
        return {
            success: false,
            errorCode: "SMTP_NOT_CONFIGURED",
            errorMessage:
                "SMTP belum dikonfigurasi (SMTP_HOST/SMTP_USER/SMTP_PASSWORD).",
        };
    }

    const to = input.to.trim();

    if (!to) {
        return {
            success: false,
            errorCode: "INVALID_RECIPIENT",
            errorMessage: "Alamat email tujuan tidak valid.",
        };
    }

    try {
        const transport = await getTransport(config);

        const info = await transport.sendMail({
            from: config.from,
            to,
            subject: input.subject,
            text: input.text,
            html: input.html,
        });

        return {
            success: true,
            messageId: info?.messageId ?? null,
        };
    } catch (error) {
        const classified = classifyError(error);

        /*
         * Log the CODE only. The message body (which can carry an OTP)
         * and the password are never included.
         */
        console.error(
            `[MAILER] Send failed | Code: ${classified.errorCode}`
        );

        return { success: false, ...classified };
    }
}
