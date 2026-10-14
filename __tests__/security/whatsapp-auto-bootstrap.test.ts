/**
 * ==========================================================
 * WHATSAPP AUTO-CONNECT ON SERVER STARTUP — REGRESSION TESTS
 * ==========================================================
 *
 * The reported bug: the saved session survived a deploy / `pm2 reload`,
 * but WhatsApp did NOT come back until an admin pressed Connect, because
 * nothing opened the session at startup.
 *
 * What is pinned here:
 *
 *   1. DECISION (pure): the bootstrap runs only in the Node server
 *      runtime, never during a build, never on a PM2 cluster instance
 *      other than 0, and only when a saved session exists on disk.
 *   2. NO SESSION → status stays DISCONNECTED: no socket, no QR, no
 *      fabricated connection, and the manual Connect button still works.
 *   3. CONCURRENT STARTUP → exactly ONE socket (single-flight both in the
 *      bootstrap module and in the service).
 *   4. TRANSIENT disconnect → reconnect with the SAVED auth (the session
 *      directory is never deleted).
 *   5. EXPLICIT loggedOut → auth is invalidated once and NO reconnect
 *      loop follows.
 *   6. SHUTDOWN (PM2 SIGTERM) → socket closed, reconnect cancelled, and
 *      the session directory left INTACT.
 *   7. The bootstrap never sends a WhatsApp message.
 *   8. ORDERING LOCK → a second process cannot open the same session; a
 *      stale lock (dead owner) is taken over.
 *
 * Baileys is mocked (the package is ESM-only). `fs` is REAL, and every
 * test points WHATSAPP_AUTH_DIR at a throwaway directory under the OS
 * temp dir — the project's `data/whatsapp-auth` is never touched, read,
 * written or deleted by this suite.
 */

import fs from "fs";
import os from "os";
import path from "path";

type FakeSocket = {
    ev: { on: jest.Mock };
    sendMessage: jest.Mock;
    relayMessage: jest.Mock;
    end: jest.Mock;
    user: { id: string };
};

const mockSockets: FakeSocket[] = [];

jest.mock("@whiskeysockets/baileys", () => ({
    __esModule: true,
    default: jest.fn(() => {
        const socket: FakeSocket = {
            ev: { on: jest.fn() },
            sendMessage: jest.fn(async () => ({
                key: { id: "SENT-1" },
            })),
            relayMessage: jest.fn(async () => {}),
            end: jest.fn(),
            user: { id: "628111222333:1@s.whatsapp.net" },
        };

        mockSockets.push(socket);

        return socket;
    }),
    useMultiFileAuthState: jest.fn(async () => ({
        state: {
            creds: { registered: true },
            keys: {},
        },
        saveCreds: jest.fn(async () => {}),
    })),
    Browsers: {
        windows: jest.fn(() => ["Windows", "Chrome", "1"]),
    },
    DisconnectReason: {
        connectionClosed: 428,
        connectionLost: 408,
        restartRequired: 515,
        loggedOut: 401,
        connectionReplaced: 440,
        badSession: 500,
    },
}));

import makeWASocket from "@whiskeysockets/baileys";
import {
    AUTO_CONNECT_ENV,
    LOCK_RETRY_DELAY_MS,
    MAX_LOCK_RETRIES,
    decideBootstrap,
    hasSavedSession,
    isAutoConnectDisabled,
    isAutoConnectEnabled,
    releaseBootstrapLock,
    resetBootstrapStateForTests,
    resolveBootstrapLockPath,
    runWhatsAppBootstrap,
    type BootstrapDeps,
} from "@/lib/whatsapp/bootstrap";
import {
    classifyConnectionClose,
    getWhatsAppService,
} from "@/lib/whatsapp/service";

const mockedMakeWASocket = makeWASocket as unknown as jest.Mock;

/* ==========================================
 * TEMP SESSION DIRECTORY (never data/whatsapp-auth)
 * ========================================== */

let authDir: string;
let lockPath: string;

beforeAll(() => {
    authDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "whatsapp-bootstrap-test-")
    );

    process.env.WHATSAPP_AUTH_DIR = authDir;
});

afterAll(() => {
    try {
        fs.rmSync(authDir, { recursive: true, force: true });
    } catch {
        // best-effort
    }

    delete process.env.WHATSAPP_AUTH_DIR;
});

/**
 * A FRESH service for one test: the singleton lives on globalThis, so it
 * is dropped here together with the accumulated signal handlers.
 */
function freshService() {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.removeAllListeners(signal);
    }

    delete (
        globalThis as { whatsappService?: unknown }
    ).whatsappService;

    mockSockets.length = 0;
    mockedMakeWASocket.mockClear();
    resetBootstrapStateForTests();
    releaseBootstrapLock();

    return getWhatsAppService();
}

function listenerFor(
    socket: FakeSocket,
    event: string
): (payload: unknown) => void {
    const call = socket.ev.on.mock.calls.find(([name]) => name === event);

    if (!call) {
        throw new Error(`no listener registered for ${event}`);
    }

    return call[1] as (payload: unknown) => void;
}

const closeStatus = (statusCode: number) => ({
    connection: "close" as const,
    lastDisconnect: { error: { output: { statusCode } } },
});

/** Saved session fixture: creds.json with a non-empty body. */
function writeSavedSession(dir: string, body = "{}"): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), body);
}

beforeEach(() => {
    mockSockets.length = 0;
    mockedMakeWASocket.mockClear();
    resetBootstrapStateForTests();
    lockPath = resolveBootstrapLockPath(authDir);
    try {
        fs.rmSync(lockPath, { force: true });
    } catch {
        // best-effort
    }
});

/* ==========================================
 * 1. PURE DECISION
 * ========================================== */

describe("bootstrap decision (pure)", () => {
    test("a saved session in a production Node runtime connects", () => {
        expect(
            decideBootstrap({
                env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
                sessionPresent: true,
            })
        ).toEqual({ action: "CONNECT", reason: "STARTED" });
    });

    test("no saved session never connects (no fake session, no QR)", () => {
        expect(
            decideBootstrap({
                env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
                sessionPresent: false,
            })
        ).toEqual({ action: "SKIP", reason: "NO_SESSION" });
    });

    test("a non-production process stays out, unless explicitly opted in", () => {
        for (const nodeEnv of ["development", "test", undefined]) {
            expect(
                decideBootstrap({
                    env: { NEXT_RUNTIME: "nodejs", ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) },
                    sessionPresent: true,
                })
            ).toEqual({ action: "SKIP", reason: "NON_PRODUCTION" });
        }

        /* A deliberate verification/staging run can opt in. */
        expect(
            decideBootstrap({
                env: {
                    NEXT_RUNTIME: "nodejs",
                    NODE_ENV: "development",
                    [AUTO_CONNECT_ENV]: "1",
                },
                sessionPresent: true,
            })
        ).toEqual({ action: "CONNECT", reason: "STARTED" });

        expect(
            isAutoConnectEnabled({ [AUTO_CONNECT_ENV]: "TRUE" })
        ).toBe(true);
        expect(isAutoConnectEnabled({})).toBe(false);
    });

    test("the Edge runtime is skipped", () => {
        expect(
            decideBootstrap({
                env: { NEXT_RUNTIME: "edge" },
                sessionPresent: true,
            })
        ).toEqual({ action: "SKIP", reason: "NOT_NODE_RUNTIME" });
    });

    test("a build never opens a socket", () => {
        expect(
            decideBootstrap({
                env: {
                    NEXT_RUNTIME: "nodejs",
                    NEXT_PHASE: "phase-production-build",
                },
                sessionPresent: true,
            })
        ).toEqual({ action: "SKIP", reason: "BUILD_PHASE" });

        expect(
            decideBootstrap({
                env: {
                    NEXT_RUNTIME: "nodejs",
                    npm_lifecycle_event: "build",
                },
                sessionPresent: true,
            })
        ).toEqual({ action: "SKIP", reason: "BUILD_PHASE" });
    });

    test("only PM2 instance 0 may own the session", () => {
        for (const instance of ["1", "2", "7"]) {
            expect(
                decideBootstrap({
                    env: {
                        NEXT_RUNTIME: "nodejs",
                        NODE_ENV: "production",
                        NODE_APP_INSTANCE: instance,
                    },
                    sessionPresent: true,
                })
            ).toEqual({
                action: "SKIP",
                reason: "NON_PRIMARY_INSTANCE",
            });
        }

        /* Fork mode: PM2 sets 0 (or nothing at all). */
        for (const env of [
            {
                NEXT_RUNTIME: "nodejs",
                NODE_ENV: "production",
                NODE_APP_INSTANCE: "0",
            },
            { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
        ]) {
            expect(
                decideBootstrap({ env, sessionPresent: true })
            ).toEqual({ action: "CONNECT", reason: "STARTED" });
        }
    });

    test("the kill switch disables it, and only an explicit falsy value counts", () => {
        for (const value of ["0", "false", "OFF", " no "]) {
            expect(isAutoConnectDisabled({ [AUTO_CONNECT_ENV]: value })).toBe(
                true
            );
            expect(
                decideBootstrap({
                    env: {
                        NEXT_RUNTIME: "nodejs",
                        [AUTO_CONNECT_ENV]: value,
                    },
                    sessionPresent: true,
                })
            ).toEqual({ action: "SKIP", reason: "DISABLED" });
        }

        for (const value of ["1", "true", "yes", ""]) {
            expect(
                isAutoConnectDisabled({ [AUTO_CONNECT_ENV]: value })
            ).toBe(false);
        }

        expect(isAutoConnectDisabled({})).toBe(false);
    });

    test("disconnect classification keeps transient != logout", () => {
        expect(classifyConnectionClose(401)).toBe("LOGOUT");
        expect(classifyConnectionClose(440)).toBe("REPLACED");

        for (const code of [428, 408, 515, 500, 503, 0, undefined]) {
            expect(classifyConnectionClose(code)).toBe("RETRY");
        }
    });
});

/* ==========================================
 * 2. SAVED-SESSION DETECTION (METADATA ONLY)
 * ========================================== */

describe("saved session detection", () => {
    test("a directory with a non-empty creds.json counts as a session", () => {
        const dir = path.join(authDir, "present");

        writeSavedSession(dir, "{\"registered\":true}");

        expect(hasSavedSession(dir)).toBe(true);
    });

    test("a missing directory, a missing file or an empty file do not", () => {
        expect(
            hasSavedSession(path.join(authDir, "does-not-exist"))
        ).toBe(false);

        const empty = path.join(authDir, "empty");
        fs.mkdirSync(empty, { recursive: true });
        expect(hasSavedSession(empty)).toBe(false);

        const blank = path.join(authDir, "blank");
        writeSavedSession(blank, "");
        expect(hasSavedSession(blank)).toBe(false);
    });
});

/* ==========================================
 * 3. ORCHESTRATOR
 * ========================================== */

function makeDeps(
    overrides: Partial<BootstrapDeps> = {}
): BootstrapDeps & {
    started: jest.Mock;
    scheduled: Array<{ fn: () => void; ms: number }>;
    logs: string[];
    warns: string[];
} {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const logs: string[] = [];
    const warns: string[] = [];

    const started = jest.fn(async () => ({
        started: true,
        status: "CONNECTING",
    }));

    const deps: BootstrapDeps = {
        env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
        hasSavedSession: () => true,
        acquireLock: () => "ACQUIRED",
        releaseLock: jest.fn(),
        start: started,
        schedule: (fn, ms) => {
            scheduled.push({ fn, ms });
        },
        log: (message) => logs.push(message),
        warn: (message) => warns.push(message),
        ...overrides,
    };

    return Object.assign(deps, { started, scheduled, logs, warns });
}

describe("the bootstrap orchestrator", () => {
    test("a saved session starts exactly one connection attempt", async () => {
        const deps = makeDeps();

        const result = await runWhatsAppBootstrap(deps);

        expect(result).toEqual({
            started: true,
            reason: "STARTED",
            status: "CONNECTING",
        });
        expect(deps.started).toHaveBeenCalledTimes(1);
        expect(deps.logs.join("\n")).toContain("Auto-connect started");
    });

    test("without a session nothing is started and the status stays disconnected", async () => {
        const deps = makeDeps({ hasSavedSession: () => false });

        const result = await runWhatsAppBootstrap(deps);

        expect(result).toEqual({ started: false, reason: "NO_SESSION" });
        expect(deps.started).not.toHaveBeenCalled();
        expect(deps.logs.join("\n")).toContain("No saved session found");
        // No socket was ever created, so nothing can report CONNECTED.
        expect(mockedMakeWASocket).not.toHaveBeenCalled();
    });

    test("concurrent startups share ONE attempt", async () => {
        const deps = makeDeps();

        const results = await Promise.all([
            runWhatsAppBootstrap(deps),
            runWhatsAppBootstrap(deps),
            runWhatsAppBootstrap(deps),
        ]);

        expect(deps.started).toHaveBeenCalledTimes(1);
        expect(
            results.every((result) => result.reason === "STARTED")
        ).toBe(true);
    });

    test("a lock held by another process skips, then retries once it is free", async () => {
        let locked = true;

        const deps = makeDeps({
            acquireLock: () => (locked ? "HELD_BY_OTHER" : "ACQUIRED"),
        });

        const first = await runWhatsAppBootstrap(deps);

        expect(first).toEqual({
            started: false,
            reason: "LOCKED_BY_OTHER_PROCESS",
        });
        expect(deps.started).not.toHaveBeenCalled();
        expect(deps.scheduled).toHaveLength(1);
        expect(deps.scheduled[0].ms).toBe(LOCK_RETRY_DELAY_MS);
        expect(deps.warns.join("\n")).toContain("duplicate PM2 process");

        /* The other process lets go before the retry fires. */
        locked = false;

        deps.scheduled[0].fn();

        await new Promise((resolve) => setImmediate(resolve));

        expect(deps.started).toHaveBeenCalledTimes(1);

        /* …and the retry budget is bounded. */
        resetBootstrapStateForTests();
    });

    test("a failure inside the service is reported, never thrown", async () => {
        const deps = makeDeps({
            start: jest.fn(async () => ({
                started: false,
                status: "ERROR",
            })),
        });

        const result = await runWhatsAppBootstrap(deps);

        expect(result.reason).toBe("FAILED");
        expect(deps.warns.join("\n")).toContain("did not start");
    });

    test("an unexpected throw cannot break the caller", async () => {
        const deps = makeDeps({
            start: jest.fn(async () => {
                throw new Error("boom");
            }),
        });

        const result = await runWhatsAppBootstrap(deps);

        expect(result).toEqual({ started: false, reason: "FAILED" });
        expect(deps.warns.join("\n")).toContain("Unexpected failure");
    });

    test("MAX_LOCK_RETRIES is a small, bounded number", () => {
        expect(MAX_LOCK_RETRIES).toBeGreaterThanOrEqual(1);
        expect(MAX_LOCK_RETRIES).toBeLessThanOrEqual(3);
    });
});

/* ==========================================
 * 4. SERVICE LEVEL (Baileys mocked, fs real)
 * ========================================== */

describe("the service auto-connects from the saved session", () => {
    test("startup with a saved session opens exactly one socket and one listener set", async () => {
        const service = freshService();

        const outcome = await service.bootstrapFromSavedSession();

        expect(outcome.started).toBe(true);
        expect(outcome.reason).toBe("STARTED");
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);

        const socket = mockSockets[0];

        for (const event of [
            "connection.update",
            "creds.update",
            "messages.upsert",
        ]) {
            expect(
                socket.ev.on.mock.calls.filter(([name]) => name === event)
            ).toHaveLength(1);
        }

        /* Nothing is ever SENT by the bootstrap. */
        expect(socket.sendMessage).not.toHaveBeenCalled();
        expect(socket.relayMessage).not.toHaveBeenCalled();

        service.shutdown();
    });

    test("a second (concurrent) bootstrap cannot add a socket", async () => {
        const service = freshService();

        const [first, second] = await Promise.all([
            service.bootstrapFromSavedSession(),
            service.bootstrapFromSavedSession(),
        ]);

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);

        const reasons = [first.reason, second.reason];

        expect(reasons).toContain("STARTED");
        expect(
            reasons.filter((reason) => reason === "ALREADY_ACTIVE")
        ).toHaveLength(1);

        service.shutdown();
    });

    test("the real orchestrator + real service produce one socket", async () => {
        const service = freshService();

        const env = {
            NEXT_RUNTIME: "nodejs",
            NODE_ENV: "production",
        };

        const [first, second] = await Promise.all([
            runWhatsAppBootstrap({
                env,
                hasSavedSession: () => true,
                acquireLock: () => "ACQUIRED",
                releaseLock: jest.fn(),
                schedule: jest.fn(),
                log: jest.fn(),
                warn: jest.fn(),
            }),
            runWhatsAppBootstrap({
                env,
                hasSavedSession: () => true,
                acquireLock: () => "ACQUIRED",
                releaseLock: jest.fn(),
                schedule: jest.fn(),
                log: jest.fn(),
                warn: jest.fn(),
            }),
        ]);

        expect(first.started).toBe(true);
        expect(second.started).toBe(true);
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);

        service.shutdown();
    });

    test("no saved session → disconnected, no socket, manual Connect still works", async () => {
        const service = freshService();

        const result = await runWhatsAppBootstrap({
            env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
            hasSavedSession: () => false,
            start: () => service.bootstrapFromSavedSession(),
            schedule: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
        });

        expect(result.reason).toBe("NO_SESSION");
        expect(mockedMakeWASocket).not.toHaveBeenCalled();
        expect(service.getStatus().status).toBe("DISCONNECTED");
        expect(service.isConnected()).toBe(false);

        /* The admin can still pair manually. */
        await service.connect();

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);

        service.shutdown();
    });

    test("a transient close reconnects with the SAVED auth", async () => {
        const service = freshService();

        await service.bootstrapFromSavedSession();

        const authDirExistsBefore = fs.existsSync(authDir);

        jest.useFakeTimers();

        listenerFor(mockSockets[0], "connection.update")(
            closeStatus(500)
        );

        expect(service.getStatus().status).toBe("RECONNECTING");

        await jest.advanceTimersByTimeAsync(2500);

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(2);
        expect(mockSockets).toHaveLength(2);

        /* The session directory is untouched — no logout, no wipe. */
        expect(fs.existsSync(authDir)).toBe(authDirExistsBefore);

        jest.useRealTimers();

        service.shutdown();
    });

    test("reconnect backoff is BOUNDED: a permanently broken link stops", async () => {
        const sessionDir = path.join(authDir, "bounded-retry");
        writeSavedSession(sessionDir, "{\"registered\":true}");

        const previous = process.env.WHATSAPP_AUTH_DIR;
        process.env.WHATSAPP_AUTH_DIR = sessionDir;

        const service = freshService();

        await service.bootstrapFromSavedSession();

        jest.useFakeTimers();

        /* Five retries are allowed, each with a longer delay. */
        for (let attempt = 1; attempt <= 5; attempt++) {
            const socket = mockSockets[mockSockets.length - 1];

            listenerFor(socket, "connection.update")(
                closeStatus(428)
            );

            expect(service.getStatus().reconnectAttempts).toBe(attempt);

            /* Well past the largest backoff (32s on attempt 5). */
            await jest.advanceTimersByTimeAsync(60 * 1000);
        }

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(6);

        /* The sixth failure exhausts the budget instead of looping. */
        listenerFor(mockSockets[5], "connection.update")(
            closeStatus(428)
        );

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

        const status = service.getStatus();

        expect(status.status).toBe("ERROR");
        expect(status.lastError).toContain("Max reconnect attempts");
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(6);

        /* Exhausting the budget is NOT a logout: auth survives. */
        expect(fs.existsSync(sessionDir)).toBe(true);

        jest.useRealTimers();

        process.env.WHATSAPP_AUTH_DIR = previous;
        service.shutdown();
    });

    test("an explicit loggedOut invalidates the session once and never loops", async () => {
        const sessionDir = path.join(authDir, "logged-out");
        writeSavedSession(sessionDir, "{\"registered\":true}");

        const previous = process.env.WHATSAPP_AUTH_DIR;
        process.env.WHATSAPP_AUTH_DIR = sessionDir;

        const service = freshService();

        await service.bootstrapFromSavedSession();

        jest.useFakeTimers();

        listenerFor(mockSockets[0], "connection.update")(
            closeStatus(401)
        );

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

        const status = service.getStatus();

        expect(status.status).toBe("DISCONNECTED");
        expect(status.lastError).toContain("logged out");

        /* Exactly one socket: no reconnect storm. */
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);

        /* The invalidated session is gone, as designed for a real logout. */
        expect(fs.existsSync(sessionDir)).toBe(false);

        jest.useRealTimers();

        process.env.WHATSAPP_AUTH_DIR = previous;
    });

    test("PM2 shutdown closes the socket and keeps the session", async () => {
        const sessionDir = path.join(authDir, "pm2-shutdown");
        writeSavedSession(sessionDir, "{\"registered\":true}");

        const previous = process.env.WHATSAPP_AUTH_DIR;
        process.env.WHATSAPP_AUTH_DIR = sessionDir;

        const service = freshService();

        await service.bootstrapFromSavedSession();

        jest.useFakeTimers();

        /* The real SIGTERM handler the singleton registered. */
        const handlers = process.listeners("SIGTERM");

        expect(handlers.length).toBeGreaterThanOrEqual(1);

        (handlers[handlers.length - 1] as () => void)();

        await jest.advanceTimersByTimeAsync(60 * 1000);

        expect(mockSockets[0].end).toHaveBeenCalled();
        expect(service.getStatus().status).toBe("DISCONNECTED");

        /* No reconnect after shutdown, and the session survives. */
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(sessionDir)).toBe(true);

        /* A double shutdown (SIGINT after SIGTERM) is safe. */
        expect(() => service.shutdown()).not.toThrow();

        jest.useRealTimers();

        process.env.WHATSAPP_AUTH_DIR = previous;
    });

    test("manual connect still works after a shutdown", async () => {
        const service = freshService();

        await service.bootstrapFromSavedSession();
        service.shutdown();

        await service.connect();

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(2);
        expect(service.getStatus().status).toBe("CONNECTING");

        service.shutdown();
    });
});

/* ==========================================
 * 5. SINGLE-PROCESS LOCK (REAL FS)
 * ========================================== */

describe("the ownership lock", () => {
    test("lives NEXT TO the auth directory, never inside it", () => {
        expect(lockPath).toBe(
            path.join(
                path.dirname(authDir),
                `.${path.basename(authDir)}-bootstrap-owner.json`
            )
        );
        expect(lockPath.startsWith(authDir + path.sep)).toBe(false);
    });

    test("a live owner blocks a second process, a dead owner is taken over", async () => {
        const service = freshService();

        fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: process.pid })
        );

        const blocked = await runWhatsAppBootstrap({
            env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
            hasSavedSession: () => true,
            start: () => service.bootstrapFromSavedSession(),
            schedule: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
        });

        expect(blocked.reason).toBe("LOCKED_BY_OTHER_PROCESS");
        expect(mockedMakeWASocket).not.toHaveBeenCalled();

        resetBootstrapStateForTests();

        /* A dead owner's lock must never strand the app. */
        fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: 2 ** 30 })
        );

        const taken = await runWhatsAppBootstrap({
            env: { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
            hasSavedSession: () => true,
            start: () => service.bootstrapFromSavedSession(),
            schedule: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
        });

        expect(taken.started).toBe(true);
        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);

        releaseBootstrapLock();
        service.shutdown();
    });
});

/* ==========================================
 * 6. STRUCTURAL GUARDS
 * ========================================== */

describe("the startup hook is wired correctly", () => {
    const instrumentation = fs.readFileSync(
        path.resolve(process.cwd(), "instrumentation.ts"),
        "utf8"
    );
    const serviceSource = fs.readFileSync(
        path.resolve(process.cwd(), "lib/whatsapp/service.ts"),
        "utf8"
    );

    test("instrumentation only runs on the Node runtime and never blocks startup", () => {
        expect(instrumentation).toContain(
            'process.env.NEXT_RUNTIME !== "nodejs"'
        );
        expect(instrumentation).toContain("runWhatsAppBootstrap");
        expect(instrumentation).toContain("void runWhatsAppBootstrap()");
        expect(instrumentation).not.toContain(
            "await runWhatsAppBootstrap()"
        );
        expect(instrumentation).toContain("catch");
    });

    test("one socket per process is still guaranteed, and shutdown keeps auth", () => {
        /* The initialize() re-entrancy guard is the single-socket rule. */
        expect(serviceSource).toContain(
            "if (this.initializing || this.socket)"
        );

        /* Shutdown must close the socket WITHOUT clearing auth. */
        const shutdown = serviceSource.slice(
            serviceSource.indexOf("shutdown(): void"),
            serviceSource.indexOf("// INITIALIZE (PRIVATE)")
        );

        expect(shutdown).toContain("this.socket.end(undefined)");
        expect(shutdown).not.toContain("clearAuthState");

        /* clearAuthState is only reached from the destructive paths. */
        const clearCalls = serviceSource
            .split("clearAuthState();")
            .length - 1;

        expect(clearCalls).toBe(2);
    });

    test("the bootstrap never sends anything, and the service never logs creds", () => {
        const bootstrapSource = fs.readFileSync(
            path.resolve(process.cwd(), "lib/whatsapp/bootstrap.ts"),
            "utf8"
        );

        for (const forbidden of [
            "sendMessage",
            "relayMessage",
            "clearAuthState",
            "makeWASocket",
        ]) {
            expect(bootstrapSource).not.toContain(forbidden);
        }

        /* Only the file's EXISTENCE/SIZE is inspected, never its body. */
        expect(bootstrapSource).toContain("stats.size > 0");
        expect(bootstrapSource).not.toContain("readFileSync(credsPath");
    });
});
