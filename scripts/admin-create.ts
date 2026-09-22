/**
 * ==========================================
 * ADMIN ACCOUNT BOOTSTRAP — INTERACTIVE CLI
 * ==========================================
 *
 * Run: npm run admin:create
 *
 * Securely creates the first admin account. The password is read from
 * the terminal with echo disabled (raw-mode masking) and exists only
 * in process memory long enough to be hashed by lib/password.
 *
 * Guards:
 *  - never reads the password from .env / source code
 *  - never writes it to logs, files or the database (only the bcrypt
 *    hash is persisted)
 *  - an email that already exists is reported and left untouched —
 *    an existing admin password is never silently reset
 *
 * The token-based password-reset flow remains the only way to change
 * credentials after bootstrap and is independent of this command.
 */

import process from "node:process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

/* ==========================================
 * TERMINAL INPUT (echo masking)
 * ========================================== */

type TtyStdIn = NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode(mode: boolean): unknown;
};

function isTty(stream: NodeJS.ReadStream): boolean {
    return stream.isTTY === true;
}

/**
 * Reads a single line from the terminal. When `hidden` is true the
 * characters are not echoed back (each key is drawn as `*`), so a
 * password typed by the operator cannot be shoulder-read or captured
 * by terminal scrollback.
 *
 * Non-interactive (piped) fallback reads a line without echoing, which
 * is a deliberate last resort for automation — the password is still
 * never persisted or logged.
 */
function promptLine(
    question: string,
    hidden: boolean
): Promise<string> {
    const stdin = process.stdin as TtyStdIn;

    if (!isTty(process.stdin) || !process.stdout.isTTY) {
        return new Promise((resolveLine) => {
            const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question(
                hidden ? `${question}\n` : question,
                (answer) => {
                    rl.close();
                    resolveLine(answer);
                }
            );
        });
    }

    return new Promise((resolveLine) => {
        const previousRaw = stdin.isRaw ?? false;

        let value = "";
        let escapeBytesLeft = 0;

        const cleanup = () => {
            stdin.removeListener("data", onData);
            stdin.setRawMode(previousRaw);
            stdin.pause();
            process.stdout.write("\n");
        };

        const onData = (chunk: Buffer) => {
            for (const byte of chunk) {
                if (escapeBytesLeft > 0) {
                    // Drop the remainder of an escape sequence
                    // (arrow keys, Home/End, ...).
                    escapeBytesLeft -= 1;
                    continue;
                }

                switch (byte) {
                    // Enter
                    case 13:
                    case 10:
                        cleanup();
                        resolveLine(value);
                        return;

                    // Ctrl-C
                    case 3:
                        cleanup();
                        process.exit(130);

                    // Backspace / Delete
                    case 8:
                    case 127:
                        if (value.length > 0) {
                            value = value.slice(0, -1);
                            process.stdout.write("\b \b");
                        }
                        continue;

                    // Escape sequence start
                    case 27:
                        escapeBytesLeft = 2;
                        continue;

                    default:
                        if (byte >= 32 && byte <= 126) {
                            const char =
                                String.fromCharCode(byte);
                            value += char;
                            process.stdout.write(
                                hidden ? "*" : char
                            );
                        }
                }
            }
        };

        stdin.setRawMode(true);
        stdin.resume();
        process.stdout.write(question);
        stdin.on("data", onData);
    });
}

/* ==========================================
 * MAIN
 * ========================================== */

async function main(): Promise<void> {
    /*
     * Load DATABASE_URL from .env / .env.local (if present) BEFORE the
     * Prisma client is imported. Values already exported in the shell
     * are left alone.
     *
     * The bootstrap module must be imported dynamically so this env
     * loading runs first (its static import of @/lib/prisma constructs
     * the client immediately).
     */
    type LoadEnvFileFn = (path?: string) => void;
    const loadEnvFile = (
        process as unknown as {
            loadEnvFile?: LoadEnvFileFn;
        }
    ).loadEnvFile;

    if (typeof loadEnvFile === "function") {
        for (const file of [".env", ".env.local"]) {
            try {
                loadEnvFile(resolve(process.cwd(), file));
            } catch {
                // Optional files, nothing to load.
            }
        }
    }

    const {
        createAdminAccount,
        validateAdminCreateInput,
    } = await import("@/lib/admin-bootstrap");

    const email = (
        await promptLine("Admin email: ", false)
    ).trim();

    if (!email) {
        console.error("Admin email is required.");
        process.exit(1);
    }

    let password = await promptLine(
        "Admin password: ",
        true
    );
    let confirmPassword = await promptLine(
        "Confirm password: ",
        true
    );

    const validation = validateAdminCreateInput({
        email,
        password,
        confirmPassword,
    });

    if (!validation.ok) {
        for (const message of validation.errors) {
            console.error(`Error: ${message}`);
        }

        password = "";
        confirmPassword = "";
        process.exit(1);
    }

    const result = await createAdminAccount(
        validation.email,
        password
    );

    /*
     * Best-effort wipe of the plaintext buffers now that the hash has
     * been computed. The process exits immediately afterwards, so the
     * plaintext can never outlive the run.
     */
    password = "";
    confirmPassword = "";

    if (!result.created) {
        console.error(
            `An account already exists for ${result.email}. No changes were made.`
        );
        process.exit(1);
    }

    console.log("Admin account created successfully.");
}

void main();