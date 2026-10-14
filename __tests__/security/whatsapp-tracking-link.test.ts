/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — OFFICIAL TRACKING LINK — FOCUSED TESTS
 * ==========================================================
 *
 * Pins the WhatsApp → website tracking hand-off:
 *
 *   - the ONLY url the bot may emit is the official tracking page on an
 *     allowlisted HTTPS origin (./tracking-url), and an absent/invalid
 *     origin degrades to the PREVIOUS text-only reply instead of a
 *     broken or third-party link,
 *   - the link carries at most an order-number PREFILL hint — never a
 *     guest access token, OTP, cookie, hash, phone, e-mail, address or
 *     payment reference,
 *   - a typed tracking word ("resi", "lacak", "tracking") reaches the
 *     tracking flow, while a problem report still wins (COMPLAINT) and
 *     the website confirmation draft / bare order number keep their
 *     existing priority,
 *   - with a link the full manifest moves to the website, and WITHOUT a
 *     link the previous in-chat history comes back (never a downgrade).
 *
 * Everything here is a pure module: no WhatsApp connection, no database,
 * no network, no message is ever sent.
 */

import { parseInboundMessage } from "@/lib/whatsapp/inbound/parse";
import * as menu from "@/lib/whatsapp/inbound/menu";
import {
    buildHistoryReply,
    buildStatusReply,
    buildTrackingReply,
    type BotOrder,
} from "@/lib/whatsapp/inbound/replies";
import type { TrackingView } from "@/lib/whatsapp/inbound/tracking";
import {
    TRACKING_ORDER_PARAM,
    TRACKING_PAGE_PATH,
    buildOrderTrackingUrl,
    buildTrackingLink,
    resetTrackingUrlWarningThrottle,
    resolveTrackingBaseUrl,
} from "@/lib/whatsapp/inbound/tracking-url";

const ORIGIN = "https://mutiaraabadisnack.com";

/** Same shape the bot's ORDER_SELECT produces. */
const ORDER: BotOrder = {
    id: 41,
    orderNumber: "ORD-1700000000000-ab12cd34",
    status: "SHIPPED",
    paymentStatus: "PAID",
    createdAt: new Date("2026-10-01T03:00:00.000Z"),
    shippingProvider: "MENGANTAR",
    providerCourier: "JT",
    shippingCourier: "JT",
    shippingService: "REG",
    trackingNumber: "JT1234567890",
    trackingUrl: null,
    shipmentStatus: "IN_TRANSIT",
    shippingPaymentStatus: "PAID",
};

const VIEW: TrackingView = {
    source: "MENGANTAR",
    providerRead: true,
    available: true,
    courier: "JT",
    trackingNumber: "JT1234567890",
    providerStatus: "IN_TRANSIT",
    history: [
        {
            date: "2026-10-02 09:00",
            description: "Paket diterima Budi",
        },
        {
            date: "2026-10-02 07:00",
            description: "Paket dalam perjalanan",
        },
    ],
    note: null,
};

const LINK = `${ORIGIN}${TRACKING_PAGE_PATH}?${TRACKING_ORDER_PARAM}=${ORDER.orderNumber}`;

const SENSITIVE = [
    "gos_",
    "guestAccessToken",
    "guestAccessTokenHash",
    "AUTH_SECRET",
    "/api/",
    "paymentNo",
    "qrString",
    "PAY-REF-999",
    "buyer@example.com",
    "08123456789",
    "Jl. Contoh Alamat",
];

beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    resetTrackingUrlWarningThrottle();
});

afterEach(() => {
    /*
     * Never leak the origin into another suite: Jest shares
     * `process.env` between test files in a worker, and the other
     * WhatsApp suites pin the text-only fallback on purpose.
     */
    delete process.env.NEXT_PUBLIC_APP_URL;
    resetTrackingUrlWarningThrottle();
});

/* ==========================================
 * 1. ORIGIN VALIDATION
 * ========================================== */

describe("tracking origin validation", () => {
    test("an allowlisted https origin is accepted", () => {
        expect(resolveTrackingBaseUrl()).toBe(ORIGIN);
    });

    test("a trailing slash does not produce a double slash", () => {
        expect(
            buildTrackingLink({
                baseUrl: `${ORIGIN}/`,
                orderNumber: ORDER.orderNumber,
            })
        ).toBe(LINK);
    });

    test("a missing origin yields no url at all", () => {
        delete process.env.NEXT_PUBLIC_APP_URL;

        expect(resolveTrackingBaseUrl()).toBeNull();
        expect(buildOrderTrackingUrl(ORDER.orderNumber)).toBeNull();
    });

    test("a hostile or unrelated origin is refused", () => {
        for (const value of [
            "https://evil.example.com",
            "https://mutiaraabadisnack.com.evil.example",
            "not-a-url",
            "ftp://mutiaraabadisnack.com",
            "javascript:alert(1)",
            "",
        ]) {
            expect(resolveTrackingBaseUrl({ NEXT_PUBLIC_APP_URL: value })).toBeNull();
        }
    });

    test("plain http is refused on a public host but tolerated on loopback", () => {
        expect(
            resolveTrackingBaseUrl({
                NEXT_PUBLIC_APP_URL: "http://mutiaraabadisnack.com",
            })
        ).toBeNull();

        expect(
            resolveTrackingBaseUrl({
                NEXT_PUBLIC_APP_URL: "http://localhost:3000",
            })
        ).toBe("http://localhost:3000");
    });

    test("credentials embedded in the origin never reach the link", () => {
        const url = buildTrackingLink({
            baseUrl:
                resolveTrackingBaseUrl({
                    NEXT_PUBLIC_APP_URL:
                        "https://user:secret@mutiaraabadisnack.com/",
                }) ?? "",
            orderNumber: ORDER.orderNumber,
        });

        expect(url).toBe(LINK);
        expect(url).not.toContain("@");
        expect(url).not.toContain("secret");
    });
});

/* ==========================================
 * 2. THE PREFILL HINT
 * ========================================== */

describe("the link carries a prefill hint and nothing else", () => {
    test("a valid order number becomes the pesanan parameter", () => {
        expect(buildOrderTrackingUrl(ORDER.orderNumber)).toBe(LINK);
    });

    test("no order number yields the BARE page (unverified paths)", () => {
        expect(buildOrderTrackingUrl(null)).toBe(
            `${ORIGIN}${TRACKING_PAGE_PATH}`
        );

        expect(buildOrderTrackingUrl(undefined)).toBe(
            `${ORIGIN}${TRACKING_PAGE_PATH}`
        );
    });

    test("a value that is not an order number is never reflected", () => {
        for (const value of [
            "bukan-nomor",
            "0812-3456-7890",
            "ORD-1-a",
            "javascript:alert(1)",
            "ORD-1700000000000-ab12cd34#frag",
            "<script>",
        ]) {
            const url = buildOrderTrackingUrl(value);

            expect(url).toBe(`${ORIGIN}${TRACKING_PAGE_PATH}`);
            expect(url).not.toContain("#");
            expect(url).not.toContain("<");
            expect(url).not.toContain("alert");
        }
    });
});

/* ==========================================
 * 3. INTENT PRIORITY
 * ========================================== */

describe("tracking words reach the tracking flow without stealing priority", () => {
    test("resi / lacak / tracking are TRACK", () => {
        for (const text of [
            "resi",
            "Resi",
            "  resi  ",
            "lacak",
            "lacak resi",
            "cek resi",
            "posisi paket",
            "tracking",
            "track",
        ]) {
            expect(parseInboundMessage(text).command).toBe("TRACK");
        }
    });

    test("a problem report still wins over a tracking word", () => {
        for (const text of [
            "resi belum saya terima",
            "komplain resi",
            "lacak tapi paket tidak sampai",
            "resi salah kirim",
        ]) {
            expect(parseInboundMessage(text).command).toBe(
                "COMPLAINT"
            );
        }
    });

    test("the confirmation draft and a bare order number keep their priority", () => {
        const draft = parseInboundMessage(
            [
                "Halo Admin, saya ingin konfirmasi pesanan saya.",
                "",
                `Nomor Pesanan: ${ORDER.orderNumber}`,
                "Nama: Budi",
                "Status Pesanan: Sedang Diproses",
            ].join("\n")
        );

        expect(draft.command).toBe("ORDER_NUMBER");
        expect(draft.confirmDraft).toBe(true);
        expect(draft.orderNumber).toBe(ORDER.orderNumber);

        const bare = parseInboundMessage(ORDER.orderNumber);

        expect(bare.command).toBe("ORDER_NUMBER");
        expect(bare.orderNumber).toBe(ORDER.orderNumber);

        /* "resi <nomor>" is an order lookup, not an unknown command. */
        const withWord = parseInboundMessage(
            `resi ${ORDER.orderNumber}`
        );

        expect(withWord.command).toBe("ORDER_NUMBER");
        expect(withWord.orderNumber).toBe(ORDER.orderNumber);
    });

    test("menu keys, menu words and anything else are untouched", () => {
        expect(parseInboundMessage("1").command).toBe("DIGIT");
        expect(parseInboundMessage("0").command).toBe("DIGIT");
        expect(parseInboundMessage("menu").command).toBe("MENU");
        expect(parseInboundMessage("halo").command).toBe("MENU");
        expect(parseInboundMessage("batal").command).toBe("CANCEL");
        expect(parseInboundMessage("apa ya").command).toBe("OTHER");
    });
});

/* ==========================================
 * 4. REPLY CONTENT
 * ========================================== */

describe("tracking replies", () => {
    test("the linked tracking reply shows identity, status and the link", () => {
        const reply = buildTrackingReply(ORDER, VIEW, {
            trackUrl: LINK,
        });

        expect(reply).toContain(`Nomor Pesanan: ${ORDER.orderNumber}`);
        expect(reply).toContain("Ekspedisi: JT");
        expect(reply).toContain("Nomor Resi: JT1234567890");
        expect(reply).toContain("Paket Dalam Perjalanan");
        expect(reply).toContain(menu.TRACKING_LINK_LABEL);
        expect(reply).toContain(LINK);
    });

    test("the manifest moves to the website when a link exists", () => {
        const linked = buildTrackingReply(ORDER, VIEW, {
            trackUrl: LINK,
        });

        expect(linked).not.toContain("Riwayat terbaru:");
        expect(linked).not.toContain("Paket diterima Budi");
    });

    test("without a link the previous in-chat history comes back", () => {
        const fallback = buildTrackingReply(ORDER, VIEW);

        expect(fallback).toContain("Riwayat terbaru:");
        expect(fallback).toContain("Paket diterima Budi");
        expect(fallback).not.toContain("http");
    });

    test("a provider failure is disclosed either way", () => {
        const failed: TrackingView = {
            ...VIEW,
            available: false,
            history: [],
            note: "Pembaruan terbaru dari ekspedisi belum tersedia saat ini; berikut status terakhir yang tersimpan.",
        };

        expect(
            buildTrackingReply(ORDER, failed, { trackUrl: LINK })
        ).toContain("belum tersedia saat ini");

        expect(
            buildTrackingReply(ORDER, failed)
        ).toContain("belum tersedia saat ini");
    });

    test("the status reply and the history reply carry the link too", () => {
        const status = buildStatusReply(ORDER, {
            trackUrl: LINK,
        });

        expect(status).toContain(`Nomor Pesanan: ${ORDER.orderNumber}`);
        expect(status).toContain(LINK);

        const history = buildHistoryReply(ORDER, VIEW, {
            trackUrl: LINK,
        });

        expect(history).toContain(LINK);
        expect(history).not.toContain("Paket diterima Budi");

        const offlineHistory = buildHistoryReply(ORDER, VIEW);

        expect(offlineHistory).toContain("Paket diterima Budi");
    });

    test("delivered and completed stay trackable with the link", () => {
        const delivered = buildTrackingReply(
            {
                ...ORDER,
                status: "COMPLETED",
                shipmentStatus: "DELIVERED",
            },
            null,
            { trackUrl: LINK }
        );

        expect(delivered).toContain("PAKET TELAH DITERIMA");
        expect(delivered).toContain("Status: Terkirim");
        expect(delivered).toContain(LINK);

        const completed = buildTrackingReply(
            { ...ORDER, status: "COMPLETED" },
            null,
            { trackUrl: LINK }
        );

        expect(completed).toContain("PESANAN SELESAI");
        expect(completed).toContain("Status: Selesai");
        expect(completed).toContain(LINK);
    });

    test("the unverified paths get the BARE link", () => {
        const bare = `${ORIGIN}${TRACKING_PAGE_PATH}`;

        for (const reply of [
            menu.askOrderNumber(bare),
            menu.orderNotFound(bare),
            menu.unverifiableSender(bare),
        ]) {
            expect(reply).toContain(bare);
            expect(reply).not.toContain(`?${TRACKING_ORDER_PARAM}=`);
        }

        /* …and with no link at all they are exactly the old messages. */
        expect(menu.askOrderNumber()).not.toContain("http");
        expect(menu.orderNotFound()).not.toContain("http");
        expect(menu.unverifiableSender()).not.toContain("http");
    });
});

/* ==========================================
 * 5. NO CREDENTIALS IN A LINK OR A REPLY
 * ========================================== */

describe("the link and the replies leak nothing sensitive", () => {
    test("no credential, token or payment reference appears", () => {
        const replies = [
            buildTrackingReply(ORDER, VIEW, { trackUrl: LINK }),
            buildStatusReply(ORDER, { trackUrl: LINK }),
            buildHistoryReply(ORDER, VIEW, { trackUrl: LINK }),
            menu.askOrderNumber(
                `${ORIGIN}${TRACKING_PAGE_PATH}`
            ),
            menu.orderNotFound(
                `${ORIGIN}${TRACKING_PAGE_PATH}`
            ),
            menu.unverifiableSender(
                `${ORIGIN}${TRACKING_PAGE_PATH}`
            ),
        ].join("\n---\n");

        for (const value of SENSITIVE) {
            expect(replies).not.toContain(value);
        }

        expect(replies).not.toMatch(/gos_|AUTH_SECRET|\/api\//);
    });

    test("the url itself contains only the origin, the path and the order number", () => {
        const url = new URL(LINK);

        expect(url.origin).toBe(ORIGIN);
        expect(url.pathname).toBe(TRACKING_PAGE_PATH);
        expect(Array.from(url.searchParams.keys())).toEqual([
            TRACKING_ORDER_PARAM,
        ]);
        expect(url.searchParams.get(TRACKING_ORDER_PARAM)).toBe(
            ORDER.orderNumber
        );
    });
});
