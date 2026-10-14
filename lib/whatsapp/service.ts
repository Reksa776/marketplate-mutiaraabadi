/**
 * ==========================================
 * WHATSAPP SERVICE
 * ==========================================
 *
 * Complete WhatsApp Web-like session lifecycle.
 *
 * States:
 *   DISCONNECTED — no connection, no auth (after logout)
 *   CONNECTING   — Baileys initializing, waiting for QR
 *   CONNECTED    — active WhatsApp session
 *   RECONNECTING — auto-reconnect after temporary failure
 *   LOGGED_OUT   — Baileys received loggedOut from phone
 *   ERROR        — unrecoverable error or max retries
 *
 * Lifecycle:
 *   Manual connect → CONNECTING → QR → scan → CONNECTED
 *   Network failure → RECONNECTING → CONNECTED (auth preserved)
 *   Logout from phone → DISCONNECTED (auth deleted)
 *   Dashboard disconnect → DISCONNECTED (auth deleted)
 *   Server restart → DISCONNECTED (auth preserved, re-init on connect)
 *   Shutdown → DISCONNECTED (auth preserved, no reconnect)
 */

if (typeof window !== "undefined") {
    throw new Error(
        "@/lib/whatsapp/service must only be imported on the server."
    );
}

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    WASocket,
    ConnectionState,
    WAMessage,
    MessageUpsertType,
    generateWAMessageFromContent,
    proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";

import type { WhatsAppInteractiveContent } from "./inbound/interactive";

// ==========================================
// TYPES
// ==========================================

export type WhatsAppConnectionStatus =
    | "DISCONNECTED"
    | "CONNECTING"
    | "CONNECTED"
    | "RECONNECTING"
    | "LOGGED_OUT"
    | "ERROR";

export type WhatsAppStatusInfo = {
    status: WhatsAppConnectionStatus;
    phoneNumber: string | null;
    connectedAt: Date | null;
    lastDisconnectedAt: Date | null;
    lastError: string | null;
    reconnectAttempts: number;
};

export type SendMessageResult = {
    success: boolean;
    messageId?: string;
    errorCode?: string;
    errorMessage?: string;
};

/**
 * How an interactive send ended.
 *
 * `UNSUPPORTED` is a first-class outcome, not a failure to hide: Baileys
 * 7.x cannot build an interactive message itself, so the caller MUST keep
 * the numbered text menu as the real interface.
 */
export type SendInteractiveResult = SendMessageResult & {
    /** True only when WhatsApp accepted the interactive message. */
    interactive?: boolean;
};

// ==========================================
// CONFIGURATION
// ==========================================

const DEFAULT_AUTH_DIR = "data/whatsapp-auth";
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;

/**
 * How a `connection: "close"` event is treated. PURE.
 *
 *   LOGOUT  — WhatsApp said the session is gone (logged out from the
 *             phone). Auth is cleared ONCE and no reconnect is
 *             scheduled: an explicit logout must never loop.
 *   REPLACED— another device/session took over this account. Retrying
 *             would fight that device, so the service stops and reports
 *             it honestly.
 *   RETRY   — transient (network loss, timeout, restart required,
 *             unavailable service, bad session, unknown codes). Safe to
 *             reconnect with the SAVED auth, bounded by
 *             MAX_RECONNECT_ATTEMPTS — auth is never deleted here.
 */
export function classifyConnectionClose(
    statusCode: number | undefined
): "LOGOUT" | "REPLACED" | "RETRY" {
    if (statusCode === DisconnectReason.loggedOut) {
        return "LOGOUT";
    }

    if (statusCode === DisconnectReason.connectionReplaced) {
        return "REPLACED";
    }

    return "RETRY";
}

export type BootstrapConnectOutcome = {
    started: boolean;
    status: WhatsAppConnectionStatus;
    reason:
        | "STARTED"
        | "ALREADY_ACTIVE"
        | "FAILED";
};

// ==========================================
// SERVICE CLASS
// ==========================================

class WhatsAppService {
    // --- Connection ---
    private socket: WASocket | null = null;
    private authDir: string;

    // --- State ---
    private status: WhatsAppConnectionStatus = "DISCONNECTED";
    private phoneNumber: string | null = null;
    private connectedAt: Date | null = null;
    private lastDisconnectedAt: Date | null = null;
    private lastError: string | null = null;

    // --- Lifecycle guards ---
    private initializing: boolean = false;
    private manuallyDisconnected: boolean = false;
    private connectionGeneration: number = 0;

    // --- Reconnect ---
    private reconnectAttempts: number = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // --- QR ---
    private currentQr: string | null = null;
    private qrCallback: ((qr: string) => void) | null = null;

    constructor() {
        this.authDir =
            process.env.WHATSAPP_AUTH_DIR || DEFAULT_AUTH_DIR;
    }

    // ==========================================
    // PUBLIC API
    // ==========================================

    getQrCode(): string | null {
        return this.currentQr;
    }

    /**
     * The session directory this process uses (env override or default).
     *
     * Exposed so the startup bootstrap inspects the SAME directory the
     * service will open — one source of truth, no second copy of the
     * `WHATSAPP_AUTH_DIR` rule.
     */
    getAuthDir(): string {
        return this.authDir;
    }

    getStatus(): WhatsAppStatusInfo {
        return {
            status: this.status,
            phoneNumber: this.phoneNumber,
            connectedAt: this.connectedAt,
            lastDisconnectedAt: this.lastDisconnectedAt,
            lastError: this.lastError,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    isConnected(): boolean {
        return this.status === "CONNECTED";
    }

    onQrCode(callback: (qr: string) => void): void {
        this.qrCallback = callback;
    }

    clearQrCallback(): void {
        this.qrCallback = null;
    }

    // ==========================================
    // CONNECT
    // ==========================================
    //
    // Handles 3 cases:
    //   A. Already CONNECTED → return
    //   B. CONNECTING/RECONNECTING → return (don't duplicate)
    //   C. DISCONNECTED/LOGGED_OUT/ERROR → fresh connection

    async connect(): Promise<void> {
        // Case A: already connected
        if (this.status === "CONNECTED") {
            return;
        }

        // Case B: already connecting/reconnecting
        if (
            this.status === "CONNECTING" ||
            this.status === "RECONNECTING"
        ) {
            return;
        }

        // Case C: fresh connection
        this.manuallyDisconnected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.socket = null;
        this.initializing = false;
        this.reconnectAttempts = 0;

        await this.initialize();
    }

    // ==========================================
    // BOOTSTRAP CONNECT (SERVER STARTUP)
    // ==========================================
    //
    // The startup path (see ./bootstrap + ./instrumentation.ts) calls
    // THIS method instead of `connect()`, so a deploy / PM2 restart
    // resumes the saved session without an admin opening the dashboard.
    //
    // It is deliberately idempotent and non-destructive:
    //   * already connected / connecting / reconnecting, or a socket or
    //     an initialization already in flight → NOTHING happens (this is
    //     what makes concurrent startups share one socket),
    //   * it re-arms the service (a previous shutdown must not block a
    //     fresh process), clears a pending reconnect timer and resets the
    //     attempt counter,
    //   * it never deletes auth, never logs out and never sends anything —
    //     it only opens the socket from the SAVED credentials.

    async bootstrapFromSavedSession(): Promise<BootstrapConnectOutcome> {
        if (
            this.socket ||
            this.initializing ||
            this.status === "CONNECTED" ||
            this.status === "CONNECTING" ||
            this.status === "RECONNECTING"
        ) {
            return {
                started: false,
                status: this.status,
                reason: "ALREADY_ACTIVE",
            };
        }

        this.manuallyDisconnected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.reconnectAttempts = 0;

        await this.initialize();

        if (this.status === "ERROR") {
            return {
                started: false,
                status: this.status,
                reason: "FAILED",
            };
        }

        return {
            started: true,
            status: this.status,
            reason: "STARTED",
        };
    }

    // ==========================================
    // DISCONNECT (REAL LOGOUT)
    // ==========================================
    //
    // Admin clicked "Disconnect WhatsApp".
    // Equivalent to logging out from WhatsApp phone.
    // Deletes auth credentials so next connect requires fresh QR.

    async disconnect(): Promise<void> {
        this.manuallyDisconnected = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.end(undefined);
            } catch {
                // best-effort
            }
        }

        this.socket = null;
        this.currentQr = null;
        this.phoneNumber = null;
        this.connectedAt = null;
        this.lastDisconnectedAt = new Date();
        this.lastError = null;
        this.reconnectAttempts = 0;
        this.initializing = false;
        this.status = "DISCONNECTED";

        this.clearAuthState();

        console.log("[WHATSAPP] Disconnected");
    }

    // ==========================================
    // SEND MESSAGE
    // ==========================================

    async sendMessage(
        jid: string,
        text: string
    ): Promise<SendMessageResult> {
        if (this.status !== "CONNECTED") {
            return {
                success: false,
                errorCode: "NOT_CONNECTED",
                errorMessage: `WhatsApp is ${this.status.toLowerCase()}`,
            };
        }

        if (!this.socket) {
            return {
                success: false,
                errorCode: "NO_SOCKET",
                errorMessage: "Socket not available",
            };
        }

        try {
            const result = await this.socket.sendMessage(jid, { text });
            const messageId = result?.key?.id || undefined;
            return { success: true, messageId };
        } catch (error) {
            return {
                success: false,
                errorCode: "SEND_FAILED",
                errorMessage:
                    error instanceof Error ? error.message : "Send failed",
            };
        }
    }

    // ==========================================
    // SEND INTERACTIVE MESSAGE (OPT-IN, BEST EFFORT)
    // ==========================================
    //
    // Sends an `interactiveMessage` (native flow buttons) over the SAME
    // socket as every other send — `relayMessage` is used because
    // Baileys' own `sendMessage` has no supported way to express an
    // interactive message.
    //
    // A rejection here is EXPECTED behaviour, not an incident: the
    // greeting/customer pipeline treats a non-success result as "use the
    // numbered text menu" and never retries the interactive form.

    async sendInteractiveMessage(
        jid: string,
        content: WhatsAppInteractiveContent
    ): Promise<SendInteractiveResult> {
        if (this.status !== "CONNECTED") {
            return {
                success: false,
                interactive: false,
                errorCode: "NOT_CONNECTED",
                errorMessage: `WhatsApp is ${this.status.toLowerCase()}`,
            };
        }

        if (!this.socket) {
            return {
                success: false,
                interactive: false,
                errorCode: "NO_SOCKET",
                errorMessage: "Socket not available",
            };
        }

        try {
            /*
             * The cast is structural, not a widening escape hatch: the
             * payload above mirrors `proto.Message.InteractiveMessage`
             * field for field, but proto marks every member optional
             * (`T | null`), which our literal builder does not.
             */
            const generated = generateWAMessageFromContent(
                jid,
                content as unknown as proto.IMessage,
                { userJid: jid }
            );

            const message = generated?.message;
            const messageId = generated?.key?.id ?? undefined;

            if (!message) {
                return {
                    success: false,
                    interactive: false,
                    errorCode: "INTERACTIVE_BUILD_FAILED",
                    errorMessage: "Interactive message could not be built",
                };
            }

            await this.socket.relayMessage(jid, message, {
                ...(messageId ? { messageId } : {}),
            });

            return { success: true, interactive: true, messageId };
        } catch (error) {
            return {
                success: false,
                interactive: false,
                errorCode: "INTERACTIVE_SEND_FAILED",
                errorMessage:
                    error instanceof Error
                        ? error.message
                        : "Interactive send failed",
            };
        }
    }

    // ==========================================
    // SHUTDOWN (NO AUTH DELETE)
    // ==========================================
    //
    // Called on SIGINT/SIGTERM.
    // Closes socket but PRESERVES auth for next restart.

    shutdown(): void {
        /*
         * Idempotent: PM2 may deliver SIGINT and SIGTERM in sequence, and
         * a double shutdown must not throw or leave a half-closed state.
         * Auth is PRESERVED here — the session has to survive the
         * restart, which is the whole point of this flow.
         */
        if (this.manuallyDisconnected && !this.socket) {
            return;
        }

        this.manuallyDisconnected = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.end(undefined);
            } catch {
                // best-effort
            }
            this.socket = null;
        }

        this.currentQr = null;
        this.status = "DISCONNECTED";
        this.initializing = false;
    }

    // ==========================================
    // INITIALIZE (PRIVATE)
    // ==========================================

    private async initialize(): Promise<void> {
        if (this.initializing || this.socket) {
            return;
        }

        this.initializing = true;
        this.status = "CONNECTING";
        this.currentQr = null;

        const generation = ++this.connectionGeneration;

        try {
            const resolvedAuthDir = path.resolve(this.authDir);

            if (!fs.existsSync(resolvedAuthDir)) {
                fs.mkdirSync(resolvedAuthDir, { recursive: true });
            }

            const { state, saveCreds } =
                await useMultiFileAuthState(resolvedAuthDir);

            // Stale check: if generation changed during async auth load
            if (generation !== this.connectionGeneration) {
                /*
                 * Release the in-flight flag before bailing out: a leaked
                 * `initializing = true` would make every later
                 * connect/bootstrap a silent no-op.
                 */
                this.initializing = false;

                return;
            }

            const hasCreds = state.creds && state.creds.registered;

            if (hasCreds) {
                console.log("[WHATSAPP] Reconnecting with saved session...");
            } else {
                console.log("[WHATSAPP] No saved session, waiting for QR...");
            }

            this.socket = makeWASocket({
                auth: state,
                browser: Browsers.windows("Toko Admin"),
                printQRInTerminal: false,
                syncFullHistory: false,
                markOnlineOnConnect: false,
            });

            this.socket.ev.on("connection.update", (update) => {
                this.handleConnectionUpdate(update, saveCreds, generation);
            });

            this.socket.ev.on("creds.update", saveCreds);

            /*
             * ==========================================
             * INCOMING MESSAGES → AUTO-REPLY BOT
             * ==========================================
             *
             * Registered on the SAME socket as every other listener
             * above, so the bot shares this exact session (auth dir,
             * reconnect logic, lifecycle) — there is no second socket
             * and no second QR session.
             *
             * This handler never throws into the emitter: the inbound
             * pipeline reports its own failures internally, and a
             * broken/down bot degrades to "no reply", never to a
             * disturbed WhatsApp session.
             */
            this.socket.ev.on("messages.upsert", (event) => {
                this.handleIncomingMessages(event);
            });

            this.initializing = false;

            console.log("[WHATSAPP] Connecting...");
        } catch (error) {
            this.initializing = false;

            if (generation !== this.connectionGeneration) {
                return;
            }

            this.status = "ERROR";
            this.lastError =
                error instanceof Error
                    ? error.message
                    : "Initialization failed";

            console.error("[WHATSAPP] Initialization error:", error);
        }
    }

    // ==========================================
    // HANDLE INCOMING MESSAGES (AUTO-REPLY)
    // ==========================================
    //
    // Delegates to the inbound pipeline through a DYNAMIC import for the
    // same reason the notification provider does: Baileys must stay out
    // of the static graph, and the bot must never be able to break the
    // session by failing to load.
    //
    // Both upsert types are forwarded. "append" carries messages that
    // were queued while the session was down (e.g. a PM2 reload), and
    // the pipeline drops anything older than its freshness window, so
    // history replay is filtered there rather than silently lost here.

    private handleIncomingMessages(event: {
        messages?: WAMessage[];
        type?: MessageUpsertType;
    }): void {
        const messages = event?.messages;

        if (!Array.isArray(messages) || messages.length === 0) {
            return;
        }

        void import("./inbound/handler")
            .then(({ handleIncomingMessages }) =>
                handleIncomingMessages(messages)
            )
            .catch((error) => {
                console.error(
                    "[WHATSAPP] Auto-reply handler unavailable:",
                    error instanceof Error ? error.message : error
                );
            });
    }

    // ==========================================
    // HANDLE CONNECTION UPDATE
    // ==========================================

    private handleConnectionUpdate(
        update: Partial<ConnectionState>,
        saveCreds: () => Promise<void>,
        generation: number
    ): void {
        // Stale event from old socket
        if (generation !== this.connectionGeneration) {
            return;
        }

        const { connection, lastDisconnect, qr } = update;

        // --- QR received ---
        if (qr) {
            console.log("[WHATSAPP] QR received");
            this.status = "CONNECTING";
            this.currentQr = qr;

            if (this.qrCallback) {
                this.qrCallback(qr);
            }
        }

        // --- Connection closed ---
        if (connection === "close") {
            const statusCode = (lastDisconnect?.error as Boom)?.output
                ?.statusCode;

            this.lastDisconnectedAt = new Date();

            const outcome = classifyConnectionClose(statusCode);

            if (outcome === "LOGOUT") {
                // Permanent logout from phone — invalidate session ONCE.
                this.handleLoggedOut(generation);
            } else if (outcome === "REPLACED") {
                // Another device took over
                this.status = "ERROR";
                this.lastError =
                    "Connection replaced by another device";
                this.socket = null;
                console.log("[WHATSAPP] Connection replaced by another device");
            } else {
                // Temporary failure — reconnect
                this.scheduleReconnect(generation);
            }
        }

        // --- Connection opened ---
        if (connection === "open") {
            if (generation !== this.connectionGeneration) {
                return;
            }

            this.status = "CONNECTED";
            this.currentQr = null;
            this.connectedAt = new Date();
            this.lastDisconnectedAt = null;
            this.reconnectAttempts = 0;
            this.lastError = null;

            console.log("[WHATSAPP] Connected successfully");

            this.extractPhoneNumber();
        }
    }

    // ==========================================
    // HANDLE LOGGED OUT (PERMANENT)
    // ==========================================

    private handleLoggedOut(generation: number): void {
        if (generation !== this.connectionGeneration) {
            return;
        }

        this.status = "DISCONNECTED";
        this.lastError = "WhatsApp session logged out";
        this.socket = null;
        this.currentQr = null;
        this.phoneNumber = null;
        this.connectedAt = null;
        this.reconnectAttempts = 0;
        this.initializing = false;

        this.clearAuthState();

        console.log("[WHATSAPP] Logged out — session invalidated");
    }

    // ==========================================
    // EXTRACT PHONE NUMBER
    // ==========================================

    private extractPhoneNumber(): void {
        try {
            if (!this.socket) return;
            const me = this.socket.user;
            if (me?.id) {
                const number = me.id.split("@")[0];
                if (number) {
                    this.phoneNumber = number;
                    console.log(`[WHATSAPP] Phone: ${number}`);
                }
            }
        } catch {
            // best-effort
        }
    }

    // ==========================================
    // SCHEDULE RECONNECT
    // ==========================================

    private scheduleReconnect(generation: number): void {
        // Don't reconnect if manually disconnected
        if (this.manuallyDisconnected) {
            return;
        }

        // Don't reconnect if generation has moved on
        if (generation !== this.connectionGeneration) {
            return;
        }

        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.status = "ERROR";
            this.lastError = `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`;
            this.socket = null;
            console.error(
                `[WHATSAPP] Max reconnect attempts reached (${MAX_RECONNECT_ATTEMPTS})`
            );
            return;
        }

        this.status = "RECONNECTING";
        this.reconnectAttempts++;

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS *
                Math.pow(2, this.reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );

        console.log(
            `[WHATSAPP] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
        );

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(async () => {
            if (
                this.manuallyDisconnected ||
                generation !== this.connectionGeneration
            ) {
                return;
            }

            this.socket = null;
            this.initializing = false;
            await this.initialize();
        }, delay);
    }

    // ==========================================
    // CLEAR AUTH STATE
    // ==========================================
    //
    // Deletes the persisted Baileys auth directory.
    // Called on: manual disconnect, loggedOut from phone.
    // NOT called on: shutdown, temporary reconnect.

    private clearAuthState(): void {
        const resolvedAuthDir = path.resolve(this.authDir);

        if (!fs.existsSync(resolvedAuthDir)) {
            return;
        }

        try {
            fs.rmSync(resolvedAuthDir, {
                recursive: true,
                force: true,
            });
            console.log("[WHATSAPP] Auth state cleared");
        } catch (error) {
            console.error("[WHATSAPP] Failed to clear auth state:", error);
        }
    }
}

// ==========================================
// SINGLETON
// ==========================================

const globalForWhatsApp = globalThis as unknown as {
    whatsappService: WhatsAppService | undefined;
};

export function getWhatsAppService(): WhatsAppService {
    if (!globalForWhatsApp.whatsappService) {
        globalForWhatsApp.whatsappService = new WhatsAppService();

        const service = globalForWhatsApp.whatsappService;

        const shutdown = () => {
            console.log("[WHATSAPP] Shutting down...");
            service.shutdown();
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
    return globalForWhatsApp.whatsappService;
}

// ==========================================
// BACKGROUND INITIALIZATION
// ==========================================

export async function initializeWhatsApp(): Promise<void> {
    const service = getWhatsAppService();

    /*
     * Delegates to the SAME idempotent startup path the instrumentation
     * bootstrap uses, so there is exactly one auto-connect implementation
     * (and one set of guards). Failures stay inside: this helper is called
     * from request paths, where it must never throw.
     */
    try {
        await service.bootstrapFromSavedSession();
    } catch (err) {
        console.error("[WHATSAPP] Background init error:", err);
    }
}
