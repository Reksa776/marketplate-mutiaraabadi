/**
 * ==========================================================
 * WHATSAPP SESSION — AUTO-REPLY LISTENER REGISTRATION
 * ==========================================================
 *
 * Pins the one property that decides whether the auto-reply bot can ever
 * answer a message TWICE for a single delivery:
 *
 *   the `messages.upsert` listener is registered EXACTLY ONCE per
 *   socket, and a reconnect produces a NEW socket (with its own single
 *   listener) instead of stacking another listener on the live one.
 *
 * Baileys itself is mocked (the real package is ESM-only), so this test
 * runs without a session, a QR code or a network. The auth directory is
 * mocked too: the real `data/whatsapp-auth` is never created, read or
 * deleted by this suite.
 */

type FakeSocket = {
    ev: { on: jest.Mock };
    sendMessage: jest.Mock;
    end: jest.Mock;
    user: { id: string };
};

const mockSockets: FakeSocket[] = [];

jest.mock("fs", () => ({
    __esModule: true,
    default: {
        existsSync: jest.fn(() => true),
        mkdirSync: jest.fn(),
        rmSync: jest.fn(),
    },
}));

jest.mock("@whiskeysockets/baileys", () => ({
    __esModule: true,
    default: jest.fn(() => {
        const socket: FakeSocket = {
            ev: { on: jest.fn() },
            sendMessage: jest.fn(),
            end: jest.fn(),
            user: { id: "628111222333:1@s.whatsapp.net" },
        };

        mockSockets.push(socket);

        return socket;
    }),
    useMultiFileAuthState: jest.fn(async () => ({
        state: { creds: { registered: true } },
        saveCreds: jest.fn(async () => {}),
    })),
    Browsers: {
        windows: jest.fn(() => ["Windows", "Chrome", "1"]),
    },
    DisconnectReason: {
        loggedOut: 401,
        connectionReplaced: 440,
    },
}));

import makeWASocket from "@whiskeysockets/baileys";
import { getWhatsAppService } from "@/lib/whatsapp/service";

const mockedMakeWASocket =
    makeWASocket as unknown as jest.Mock;

/** How many times a socket subscribed to one event. */
function listenerCount(
    socket: FakeSocket,
    event: string
): number {
    return socket.ev.on.mock.calls.filter(
        ([name]) => name === event
    ).length;
}

/** The handler the service registered for one event. */
function listenerFor(
    socket: FakeSocket,
    event: string
): (payload: unknown) => void {
    const call = socket.ev.on.mock.calls.find(
        ([name]) => name === event
    );

    if (!call) {
        throw new Error(`no listener registered for ${event}`);
    }

    return call[1] as (payload: unknown) => void;
}

beforeAll(() => {
    /*
     * The service instance is cached on globalThis. Clearing it here
     * gives this suite a fresh instance (and a predictable socket list)
     * without touching any other test file's module state.
     */
    delete (
        globalThis as { whatsappService?: unknown }
    ).whatsappService;

    process.env.WHATSAPP_AUTH_DIR =
        "/tmp/whatsapp-listener-test-auth";
});

afterEach(() => {
    jest.useRealTimers();
});

describe("auto-reply listener registration", () => {
    test("a fresh connect registers exactly one listener per event", async () => {
        const service = getWhatsAppService();

        await service.connect();

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);

        const socket = mockSockets[0];

        expect(listenerCount(socket, "messages.upsert")).toBe(1);
        expect(listenerCount(socket, "connection.update")).toBe(1);
        expect(listenerCount(socket, "creds.update")).toBe(1);
    });

    test("connecting again while CONNECTING does not add a socket or a listener", async () => {
        const service = getWhatsAppService();

        // Status is still CONNECTING (no `open` event was emulated).
        await service.connect();
        await service.connect();

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(1);
        expect(mockSockets).toHaveLength(1);
        expect(
            listenerCount(mockSockets[0], "messages.upsert")
        ).toBe(1);
    });

    test("a reconnect creates a NEW socket with exactly one listener each", async () => {
        const service = getWhatsAppService();

        jest.useFakeTimers();

        const first = mockSockets[0];

        expect(
            listenerCount(first, "messages.upsert")
        ).toBe(1);

        /*
         * A temporary connection failure: the service schedules a
         * reconnect (2s backoff) and initializes a brand-new socket.
         */
        listenerFor(first, "connection.update")({
            connection: "close",
            lastDisconnect: {
                error: { output: { statusCode: 500 } },
            },
        });

        await jest.advanceTimersByTimeAsync(2500);

        expect(mockedMakeWASocket).toHaveBeenCalledTimes(2);
        expect(mockSockets).toHaveLength(2);

        const second = mockSockets[1];

        // The new socket carries its own single auto-reply listener…
        expect(listenerCount(second, "messages.upsert")).toBe(1);
        expect(listenerCount(second, "connection.update")).toBe(1);

        // …and the old one never gained a second registration.
        expect(listenerCount(first, "messages.upsert")).toBe(1);

        service.shutdown();
    });
});
