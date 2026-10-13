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
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";

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

// ==========================================
// CONFIGURATION
// ==========================================

const DEFAULT_AUTH_DIR = "data/whatsapp-auth";
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;

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
    // SHUTDOWN (NO AUTH DELETE)
    // ==========================================
    //
    // Called on SIGINT/SIGTERM.
    // Closes socket but PRESERVES auth for next restart.

    shutdown(): void {
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

            if (statusCode === DisconnectReason.loggedOut) {
                // Permanent logout from phone — invalidate session
                this.handleLoggedOut(generation);
            } else if (
                statusCode === DisconnectReason.connectionReplaced
            ) {
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

    if (service.getStatus().status !== "DISCONNECTED") {
        return;
    }

    service.connect().catch((err) => {
        console.error("[WHATSAPP] Background init error:", err);
    });
}
