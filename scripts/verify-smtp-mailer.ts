/**
 * ==========================================
 * SMTP MAILER — APPLICATION-SIDE VERIFICATION
 * ==========================================
 *
 *   npx tsx scripts/verify-smtp-mailer.ts
 *
 * Answers the one question webmail cannot: can THIS APPLICATION open a
 * submission connection to the mailbox, upgrade it to TLS, verify the
 * certificate and authenticate?
 *
 *   transport.verify() → connect → STARTTLS → certificate check → AUTH
 *
 * NO EMAIL IS SENT. verify() disconnects after the handshake, so this is
 * safe to run against production and it cannot deliver anything to a
 * customer. (A separate, explicit send to an APPROVED test address is
 * the only thing that proves end-to-end delivery.)
 *
 * SAFETY
 *   - never prints SMTP_PASSWORD, nor any part of it
 *   - never sends a message
 *   - reads the same .env files the app does, in the same order
 *
 * Exit code 0 = the mailbox is usable from the app; 1 = it is not (the
 * OTP email channel fails closed in that state).
 */

import { loadEnvConfig } from "@next/env";

import {
    getMailFrom,
    isMailerConfigured,
    verifyMailerConnection,
} from "../lib/mailer";

/**
 * Load the project env the way the app does, falling back to the
 * development-style files when no production DATABASE_URL is present.
 * Returns the loaded FILE NAMES only — never their contents.
 */
function loadProjectEnv(): string[] {
    const quiet = {
        info: () => {},
        error: () => {},
    };

    const production = loadEnvConfig(
        process.cwd(),
        false,
        quiet
    );

    if (process.env.DATABASE_URL) {
        return production.loadedEnvFiles.map(
            (file) => file.path
        );
    }

    const development = loadEnvConfig(
        process.cwd(),
        true,
        quiet,
        true
    );

    return development.loadedEnvFiles.map(
        (file) => file.path
    );
}

function line(label: string, value: string): void {
    console.log(`  ${label.padEnd(26)} ${value}`);
}

/**
 * Everything about the configured transport that is safe to print. The
 * password is reported as a boolean, never as a value.
 */
function printTransport(): void {
    const host = process.env.SMTP_HOST?.trim() ?? "";
    const port = process.env.SMTP_PORT?.trim() || "587";
    const secure =
        (process.env.SMTP_SECURE ?? "")
            .trim()
            .toLowerCase() === "true";

    line("SMTP_HOST", host || "(unset)");
    line("SMTP_PORT", port);
    line(
        "SMTP_SECURE",
        `${secure ? "true (implicit TLS)" : "false (STARTTLS upgrade)"}`
    );
    line("STARTTLS required", "yes");
    line("Certificate verify", "yes (rejectUnauthorized)");
    line(
        "SMTP_USER",
        process.env.SMTP_USER?.trim() || "(unset)"
    );
    line(
        "SMTP_PASSWORD",
        process.env.SMTP_PASSWORD ? "set (not shown)" : "MISSING"
    );
    line("MAIL_FROM", getMailFrom());
}

async function main(): Promise<void> {
    const files = loadProjectEnv();

    console.log("");
    console.log(
        "=== SMTP MAILER VERIFICATION (application side) ==="
    );
    console.log("");
    line("env files loaded", files.length ? files.join(", ") : "(none)");
    console.log("");

    printTransport();

    console.log("");

    if (!isMailerConfigured()) {
        console.log(
            "  RESULT: NOT CONFIGURED — the OTP email channel FAILS CLOSED."
        );
        console.log(
            "          Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD on the server."
        );
        console.log("");
        process.exitCode = 1;
        return;
    }

    console.log("  Connecting (no email is sent)...");

    const result = await verifyMailerConnection();

    console.log("");

    if (result.ok) {
        line("connection + STARTTLS", "OK");
        line("certificate", "verified");
        line("SMTP AUTH", "OK");
        console.log("");
        console.log(
            "  RESULT: the application CAN reach and authenticate to this mailbox."
        );
        console.log(
            "          This does NOT prove delivery — confirm the inbox with one"
        );
        console.log(
            "          explicit send to an approved test address."
        );
        console.log("");
        return;
    }

    line("FAILED", result.errorCode);
    line("detail", result.errorMessage);
    console.log("");
    console.log(
        "  RESULT: the OTP email channel FAILS CLOSED until this is fixed."
    );
    console.log(
        "          Roundcube/webmail working is NOT proof that the app can"
    );
    console.log(
        "          send: this check is the one that counts."
    );
    console.log("");

    process.exitCode = 1;
}

main().catch((error) => {
    console.error(
        "[VERIFY SMTP] Unexpected error:",
        error instanceof Error ? error.message : error
    );

    process.exitCode = 1;
});
