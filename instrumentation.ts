/**
 * ==========================================================
 * SERVER STARTUP INSTRUMENTATION
 * ==========================================================
 *
 * Next.js calls `register()` ONCE when a server instance is initiated
 * (both with `next start` and with the custom `server.js`), which is
 * exactly the missing hook that left WhatsApp disconnected after every
 * deploy / `pm2 reload`: the Baileys session used to be opened only by
 * `POST /api/admin/whatsapp/connect`.
 *
 * This file is deliberately tiny and cannot break the server:
 *
 *   * Edge (and any non-Node runtime) returns immediately — Baileys is
 *     Node-only.
 *   * The bootstrap is NOT awaited: server readiness must never depend on
 *     WhatsApp, and the connect happens in the background.
 *   * Every failure is caught here; a broken session, a missing directory
 *     or a slow network can only ever produce a log line.
 *   * All policy (env kill switch, build phase, PM2 cluster instance,
 *     saved-session check, single-process lock) lives in
 *     lib/whatsapp/bootstrap.ts, which is unit tested — see
 *     __tests__/security/whatsapp-auto-bootstrap.test.ts.
 */

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") {
        return;
    }

    try {
        const { runWhatsAppBootstrap } = await import(
            "./lib/whatsapp/bootstrap"
        );

        /* Fire-and-forget: never block or fail the server start. */
        void runWhatsAppBootstrap();
    } catch (error) {
        console.error(
            "[WHATSAPP BOOTSTRAP] Could not start the bootstrap:",
            error instanceof Error ? error.message : error
        );
    }
}
