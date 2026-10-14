/**
 * ==========================================================
 * WHATSAPP AUTO-CONNECT BOOTSTRAP (SERVER STARTUP)
 * ==========================================================
 *
 * ROOT CAUSE THIS MODULE EXISTS FOR
 *
 *   The Baileys session was only ever opened by an ADMIN ACTION
 *   (`POST /api/admin/whatsapp/connect` → WhatsAppService.connect()).
 *   `initializeWhatsApp()` was exported but never called, and the app had
 *   no server-startup hook, so after a deploy / `pm2 reload` the process
 *   started with status DISCONNECTED and stayed that way until somebody
 *   pressed Connect — even though the saved session on disk was still
 *   valid.
 *
 * WHAT IT DOES
 *
 *   On server startup (see ./instrumentation.ts) it decides whether this
 *   process may open the ONE WhatsApp session, and only then asks the
 *   service to reconnect from the SAVED session:
 *
 *     * only in the Node.js server runtime, never in a build or on Edge,
 *     * only on the primary process (PM2 cluster instances > 0 stay out),
 *     * only when a saved session actually exists on disk — no session
 *       means NO socket and NO QR, and the status stays disconnected
 *       instead of pretending to be connected,
 *     * at most once per process (concurrent callers share one attempt),
 *     * only one process at a time, via an advisory pid lock file placed
 *       NEXT TO the auth directory (the auth directory itself is never
 *       written, moved or deleted by this module),
 *     * never destructive: it does not touch credentials, never logs out,
 *       never clears auth state and never sends a message.
 *
 * FAIL-CLOSED: any unexpected failure is caught, logged without secrets
 * and returned as a result — a bad bootstrap can never stop the HTTP
 * server from starting, and it can never invalidate a working session.
 */

import fs from "fs";
import path from "path";

/* ==========================================
 * ENV CONTRACT
 * ========================================== */

/** Kill switch: set to 0/false/off/no to disable auto-connect entirely. */
export const AUTO_CONNECT_ENV = "WHATSAPP_AUTO_CONNECT";

/**
 * `NODE_ENV` value required for the DEFAULT (opt-out) behaviour.
 *
 * A production shop must resume its session unattended, while a stray
 * `next dev` / staging process on the same host must NOT grab the live
 * WhatsApp session — so outside production the bootstrap stays off
 * unless it is explicitly opted in with WHATSAPP_AUTO_CONNECT=1.
 */
export const PRODUCTION_ENV = "production";

/** Overrides the derived lock path (used by tests / unusual layouts). */
export const BOOTSTRAP_LOCK_ENV = "WHATSAPP_BOOTSTRAP_LOCK";

/** Next.js build phase value that must never trigger a connection. */
export const BUILD_PHASE = "phase-production-build";

/** How many times a locked attempt is re-tried, and how far apart. */
export const MAX_LOCK_RETRIES = 2;
export const LOCK_RETRY_DELAY_MS = 15_000;

export type BootstrapReason =
    | "STARTED"
    | "DISABLED"
    | "NOT_NODE_RUNTIME"
    | "BUILD_PHASE"
    | "NON_PRODUCTION"
    | "NON_PRIMARY_INSTANCE"
    | "NO_SESSION"
    | "ALREADY_ACTIVE"
    | "LOCKED_BY_OTHER_PROCESS"
    | "FAILED";

export type BootstrapResult = {
    started: boolean;
    reason: BootstrapReason;
    /** Connection status reported by the service, when it ran. */
    status?: string;
};

export type BootstrapDecision = {
    action: "SKIP" | "CONNECT";
    reason: BootstrapReason;
};

/* ==========================================
 * DECISION (PURE)
 * ========================================== */

/**
 * Is the automatic connect explicitly disabled?
 *
 * Only an explicit falsy value disables it: an unset variable means
 * "enabled", which is what makes the fix work on a host that never had
 * the variable before.
 */
export function isAutoConnectDisabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    const raw = env?.[AUTO_CONNECT_ENV];

    if (typeof raw !== "string") {
        return false;
    }

    return ["0", "false", "off", "no"].includes(
        raw.trim().toLowerCase()
    );
}

/**
 * Was auto-connect EXPLICITLY turned on?
 *
 * This is what lets a non-production process (a deliberate verification
 * run, a staging box) opt in while every other dev/staging/stray process
 * stays out of the live session.
 */
export function isAutoConnectEnabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    const raw = env?.[AUTO_CONNECT_ENV];

    if (typeof raw !== "string") {
        return false;
    }

    return ["1", "true", "on", "yes"].includes(
        raw.trim().toLowerCase()
    );
}

/**
 * Decide whether this process may open the session. PURE.
 *
 * Order matters: the cheapest and most absolute gates come first, so a
 * disabled/edge/build/cluster process never even touches the filesystem.
 */
export function decideBootstrap(input: {
    env?: Record<string, string | undefined>;
    sessionPresent: boolean;
}): BootstrapDecision {
    const env = input.env ?? process.env;

    if (isAutoConnectDisabled(env)) {
        return { action: "SKIP", reason: "DISABLED" };
    }

    /*
     * `NEXT_RUNTIME` is "nodejs" in the Node server and "edge" in the
     * Edge runtime. An absent value (plain Node scripts, tests) is
     * treated as Node — the module is only reachable from the server.
     */
    const runtime = env?.NEXT_RUNTIME;

    if (typeof runtime === "string" && runtime && runtime !== "nodejs") {
        return { action: "SKIP", reason: "NOT_NODE_RUNTIME" };
    }

    /* A build must never open a socket (no session, no QR, no network). */
    if (env?.NEXT_PHASE === BUILD_PHASE) {
        return { action: "SKIP", reason: "BUILD_PHASE" };
    }

    if (
        typeof env?.npm_lifecycle_event === "string" &&
        env.npm_lifecycle_event === "build"
    ) {
        return { action: "SKIP", reason: "BUILD_PHASE" };
    }

    /*
     * Production only, unless explicitly opted in: a dev/staging process
     * sharing the host must never take over the live session (the lock
     * would then keep the REAL production process out).
     */
    if (
        env?.NODE_ENV !== PRODUCTION_ENV &&
        !isAutoConnectEnabled(env)
    ) {
        return { action: "SKIP", reason: "NON_PRODUCTION" };
    }

    /*
     * PM2 sets NODE_APP_INSTANCE=0..n-1 in CLUSTER mode. Only instance 0
     * may own the session: two Baileys sockets on one auth directory
     * would fight over it (connectionReplaced) and can corrupt creds.
     */
    const instance = env?.NODE_APP_INSTANCE;

    if (
        typeof instance === "string" &&
        instance.trim() !== "" &&
        instance.trim() !== "0"
    ) {
        return { action: "SKIP", reason: "NON_PRIMARY_INSTANCE" };
    }

    if (!input.sessionPresent) {
        return { action: "SKIP", reason: "NO_SESSION" };
    }

    return { action: "CONNECT", reason: "STARTED" };
}

/* ==========================================
 * SAVED SESSION DETECTION (METADATA ONLY)
 * ========================================== */

/** Baileys' credential file inside the multi-file auth directory. */
export const CREDS_FILE = "creds.json";

/**
 * Does a saved session exist?
 *
 * ONLY file METADATA is inspected (existence + non-empty size): the
 * contents of `creds.json` are never read, parsed, logged or returned —
 * the session file is treated as opaque. Whether the credentials are
 * actually usable is left to Baileys, exactly as before.
 */
export function hasSavedSession(authDir: string): boolean {
    try {
        const resolved = path.resolve(authDir);

        if (!fs.existsSync(resolved)) {
            return false;
        }

        const credsPath = path.join(resolved, CREDS_FILE);

        if (!fs.existsSync(credsPath)) {
            return false;
        }

        const stats = fs.statSync(credsPath);

        return stats.isFile() && stats.size > 0;
    } catch {
        /* An unreadable path is not a session — fail closed. */
        return false;
    }
}

/* ==========================================
 * SINGLE-PROCESS LOCK (ADVISORY)
 * ========================================== */

/**
 * The lock lives NEXT TO the auth directory, never inside it: the
 * session data stays exactly as Baileys left it.
 *
 *   data/whatsapp-auth        ← session (untouched)
 *   data/.whatsapp-bootstrap-owner.json  ← this lock (ours)
 */
export function resolveBootstrapLockPath(authDir: string): string {
    const override = process.env?.[BOOTSTRAP_LOCK_ENV];

    if (typeof override === "string" && override.trim()) {
        return path.resolve(override.trim());
    }

    const resolved = path.resolve(authDir);

    return path.join(
        path.dirname(resolved),
        `.${path.basename(resolved)}-bootstrap-owner.json`
    );
}

export type LockOutcome =
    | "ACQUIRED"
    | "HELD_BY_OTHER"
    | "UNKNOWN_ERROR";

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    if (pid === process.pid) {
        return true;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        /* EPERM means "alive but not ours" — still alive. */
        return (
            (error as { code?: string })?.code === "EPERM"
        );
    }
}

function readLockPid(lockPath: string): number {
    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: unknown };

        return typeof parsed?.pid === "number" ? parsed.pid : -1;
    } catch {
        /* Unreadable/garbled lock = no owner we can trust. */
        return -1;
    }
}

/**
 * Default lock implementation.
 *
 * `wx` gives an ATOMIC create: in a start race exactly one process wins.
 * A lock whose owner is GONE (crash, SIGKILLed reload) is taken over, so
 * a stale file can never strand the app without a session.
 */
function defaultAcquireLock(lockPath: string): LockOutcome {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(lockPath, "wx");

            try {
                fs.writeSync(
                    fd,
                    JSON.stringify({
                        pid: process.pid,
                        startedAt: new Date().toISOString(),
                    })
                );
            } finally {
                fs.closeSync(fd);
            }

            /* Release on the way out (best effort, synchronous). */
            process.once("exit", () => {
                try {
                    fs.rmSync(lockPath, { force: true });
                } catch {
                    // best-effort
                }
            });

            return "ACQUIRED";
        } catch (error) {
            const code = (error as { code?: string })?.code;

            if (code !== "EEXIST") {
                return "UNKNOWN_ERROR";
            }

            const owner = readLockPid(lockPath);

            if (owner > 0 && isProcessAlive(owner)) {
                return "HELD_BY_OTHER";
            }

            /* Stale: the owner is gone. Take it over. */
            try {
                fs.rmSync(lockPath, { force: true });
            } catch {
                return "UNKNOWN_ERROR";
            }
        }
    }

    return "HELD_BY_OTHER";
}

function defaultReleaseLock(lockPath: string): void {
    try {
        fs.rmSync(lockPath, { force: true });
    } catch {
        // best-effort
    }
}

/* ==========================================
 * DEPS (INJECTABLE FOR TESTS)
 * ========================================== */

export type BootstrapDeps = {
    env: Record<string, string | undefined>;
    hasSavedSession: () => boolean;
    acquireLock: () => LockOutcome;
    releaseLock: () => void;
    start: () => Promise<{ started: boolean; status?: string }>;
    schedule: (fn: () => void, ms: number) => void;
    log: (message: string) => void;
    warn: (message: string) => void;
};

function defaultDeps(): BootstrapDeps {
    const env = process.env;
    const authDir = env.WHATSAPP_AUTH_DIR || "data/whatsapp-auth";
    const lockPath = resolveBootstrapLockPath(authDir);

    return {
        env,
        hasSavedSession: () => hasSavedSession(authDir),
        acquireLock: () => defaultAcquireLock(lockPath),
        releaseLock: () => defaultReleaseLock(lockPath),
        /*
         * Imported lazily: the bootstrap must not drag Baileys into the
         * graph of anything that merely imports this module, and a broken
         * import must fail INSIDE the bootstrap, never at server start.
         */
        start: async () => {
            const { getWhatsAppService } = await import(
                "@/lib/whatsapp/service"
            );

            const outcome =
                await getWhatsAppService().bootstrapFromSavedSession();

            return {
                started: outcome.started,
                status: outcome.status,
            };
        },
        schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            timer.unref?.();
        },
        log: (message) => console.log(message),
        warn: (message) => console.warn(message),
    };
}

/* ==========================================
 * ORCHESTRATOR
 * ========================================== */

let inFlight: Promise<BootstrapResult> | null = null;
let lockOwned = false;
let lockRetries = 0;
let retryScheduled = false;

/**
 * Run the startup bootstrap. Safe to call several times: every caller
 * shares the SAME attempt, so a second trigger can never open a second
 * socket.
 */
export function runWhatsAppBootstrap(
    overrides: Partial<BootstrapDeps> = {}
): Promise<BootstrapResult> {
    if (inFlight) {
        return inFlight;
    }

    const deps: BootstrapDeps = { ...defaultDeps(), ...overrides };

    const attempt = runOnce(deps)
        .catch((error) => {
            deps.warn(
                "[WHATSAPP BOOTSTRAP] Unexpected failure: " +
                    (error instanceof Error
                        ? error.message
                        : "unknown error")
            );

            return { started: false, reason: "FAILED" } as BootstrapResult;
        })
        .finally(() => {
            if (inFlight === attempt) {
                inFlight = null;
            }
        });

    inFlight = attempt;

    return attempt;
}

async function runOnce(
    deps: BootstrapDeps
): Promise<BootstrapResult> {
    const sessionPresent = deps.hasSavedSession();

    const decision = decideBootstrap({
        env: deps.env,
        sessionPresent,
    });

    if (decision.action === "SKIP") {
        /*
         * NO_SESSION is the one skip worth naming explicitly: the status
         * must stay DISCONNECTED (no socket, no QR) and the admin decides
         * whether to pair a device — we never invent a session.
         */
        if (decision.reason === "NO_SESSION") {
            deps.log(
                "[WHATSAPP BOOTSTRAP] No saved session found — staying disconnected, waiting for a manual Connect."
            );
        } else {
            deps.log(
                `[WHATSAPP BOOTSTRAP] Skipped (${decision.reason}).`
            );
        }

        return { started: false, reason: decision.reason };
    }

    const lock = deps.acquireLock();

    if (lock === "HELD_BY_OTHER") {
        deps.warn(
            "[WHATSAPP BOOTSTRAP] Another process owns the WhatsApp session; not connecting from here. Check for a duplicate PM2 process (`pm2 list`, and that the app runs in FORK mode with 1 instance)."
        );

        scheduleLockRetry(deps);

        return {
            started: false,
            reason: "LOCKED_BY_OTHER_PROCESS",
        };
    }

    if (lock === "UNKNOWN_ERROR") {
        /*
         * Best effort: the lock is defence in depth, while the
         * NODE_APP_INSTANCE guard is the primary cluster gate. A
         * read-only data directory must not leave the shop without
         * WhatsApp.
         */
        deps.warn(
            "[WHATSAPP BOOTSTRAP] Could not create the ownership lock; continuing (the primary cluster guard still applies)."
        );
    } else {
        lockOwned = true;
    }

    const outcome = await deps.start();

    if (!outcome.started) {
        /* Nothing is connecting, so the lock must not be held. */
        if (lockOwned) {
            deps.releaseLock();
            lockOwned = false;
        }

        const reason: BootstrapReason =
            outcome.status === "CONNECTED" ||
            outcome.status === "CONNECTING" ||
            outcome.status === "RECONNECTING"
                ? "ALREADY_ACTIVE"
                : "FAILED";

        deps.warn(
            `[WHATSAPP BOOTSTRAP] Auto-connect did not start (${outcome.status ?? "unknown"}).`
        );

        return { started: false, reason, status: outcome.status };
    }

    deps.log(
        `[WHATSAPP BOOTSTRAP] Auto-connect started from the saved session (status: ${outcome.status ?? "unknown"}).`
    );

    return { started: true, reason: "STARTED", status: outcome.status };
}

/**
 * A lock holder can also be a DYING process (`pm2 reload` overlap). One
 * bounded retry later the session is usually free again, so the fix does
 * not depend on an admin noticing.
 */
function scheduleLockRetry(deps: BootstrapDeps): void {
    if (retryScheduled || lockRetries >= MAX_LOCK_RETRIES) {
        return;
    }

    retryScheduled = true;

    deps.schedule(() => {
        retryScheduled = false;
        lockRetries += 1;

        void runWhatsAppBootstrap({
            env: deps.env,
            hasSavedSession: deps.hasSavedSession,
            acquireLock: deps.acquireLock,
            releaseLock: deps.releaseLock,
            start: deps.start,
            schedule: deps.schedule,
            log: deps.log,
            warn: deps.warn,
        });
    }, LOCK_RETRY_DELAY_MS);
}

/**
 * Did THIS process take the session ownership lock?
 * Used by shutdown to free it for the next start.
 */
export function ownsBootstrapLock(): boolean {
    return lockOwned;
}

/** Release the ownership lock if this process holds it. */
export function releaseBootstrapLock(): void {
    if (!lockOwned) {
        return;
    }

    lockOwned = false;

    const authDir =
        process.env.WHATSAPP_AUTH_DIR || "data/whatsapp-auth";

    defaultReleaseLock(resolveBootstrapLockPath(authDir));
}

/** Test hook: forget the in-flight/single-flight state. */
export function resetBootstrapStateForTests(): void {
    inFlight = null;
    lockOwned = false;
    lockRetries = 0;
    retryScheduled = false;
}
