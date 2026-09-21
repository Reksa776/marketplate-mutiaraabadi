/**
 * ==========================================
 * QRIS PRESENTATION — SSR TESTS
 * ==========================================
 *
 * The production iPaymu QRIS response returns a QR *page* URL
 * (`https://my.ipaymu.com/qris-basic/<path>`) — an HTML payment/QR
 * page, NOT an image binary. It can be opened in a browser but can
 * NEVER be used as an `<img src>` (that is a broken image).
 *
 * The QR the customer scans is therefore generated LOCALLY by
 * QrisPanel from the raw QRIS payload (`qrString`); the provider URL
 * is kept only as a fallback link.
 *
 * Covered here:
 *   A. qrString + qrisPageUrl → local QR + fallback link
 *   B. qrisPageUrl only       → no broken <img>, fallback link only
 *   C. qrString only          → local QR, no provider link
 *   D. BCA VA                 → unchanged (paymentNo, no QR panel)
 *   E. DANA / ShopeePay       → unchanged (provider action URL)
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import QrisPanel from "@/app/checkout/payment/[id]/QrisPanel";
import { buildPaymentInstruction } from "@/lib/payment/ipaymu";

/** A realistic raw QRIS payload (EMVCo), never to be shown as text. */
const PAYLOAD =
    "00020101021226610014ID.CO.QRIS.WWW0215ID102002116960303" +
    "0IDR5204581253033605802ID5910TOKO%20DEMO6007JAKARTA6304ABCD";

/** The real production shape (pattern, not hardcoded in app code). */
const PROD_PAGE_URL =
    "https://my.ipaymu.com/qris-basic/260921-296289-37614776-225053";

const SANDBOX_PAGE_URL =
    "https://sandbox.ipaymu.com/qris-basic/260921-296289-37614776-225053";

function render(props: {
    qrString: string | null;
    qrisPageUrl: string | null;
}): string {
    return renderToStaticMarkup(createElement(QrisPanel, { ...props }));
}

function paymentPageSource(): string {
    return readFileSync(
        resolve(process.cwd(), "app/checkout/payment/[id]/page.tsx"),
        "utf-8"
    );
}

/* ==========================================
 * A. QRIS with qrString + qrisPageUrl
 * ========================================== */

describe("A. QRIS with qrString + qrisPageUrl", () => {
    test("renders a locally generated QR code from the raw payload", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: PROD_PAGE_URL,
        });

        // A real QR: SVG with module path data.
        expect(html).toContain("<svg");
        expect(html).toContain("<path");
        expect(html).toContain("QRIS pembayaran");
    });

    test("never renders the raw QRIS payload as text", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: PROD_PAGE_URL,
        });

        expect(html).not.toContain(PAYLOAD);
        expect(html).not.toContain("ID.CO.QRIS");
        expect(html).not.toContain("00020101");
    });

    test("offers the provider QRIS page as a fallback link", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: PROD_PAGE_URL,
        });

        expect(html).toContain("Buka QRIS iPaymu");
        expect(html).toContain(`href="${PROD_PAGE_URL}"`);
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test("never uses the provider QRIS page URL as an <img src>", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: PROD_PAGE_URL,
        });

        expect(html).not.toContain("<img");
        expect(html).not.toContain(`src="${PROD_PAGE_URL}"`);
    });

    test("never renders a payment number / code for QRIS", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: PROD_PAGE_URL,
        });

        expect(html).not.toMatch(/Kode Pembayaran/);
        expect(html).not.toMatch(/Nomor Virtual Account/);
        expect(html).not.toMatch(/font-mono/);
        expect(html).not.toContain("paymentNo");
    });

    test("accepts a sandbox QRIS page URL the same way", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: SANDBOX_PAGE_URL,
        });

        expect(html).toContain(`href="${SANDBOX_PAGE_URL}"`);
        expect(html).toContain("<svg");
    });
});

/* ==========================================
 * B. QRIS with qrisPageUrl only
 * ========================================== */

describe("B. QRIS with qrisPageUrl only", () => {
    test("renders no broken <img> and no QR, just the fallback link", () => {
        const html = render({
            qrString: null,
            qrisPageUrl: PROD_PAGE_URL,
        });

        expect(html).not.toContain("<img");
        expect(html).not.toContain("<svg");
        expect(html).toContain("QR tidak dapat ditampilkan");
        expect(html).toContain("Buka QRIS iPaymu");
        expect(html).toContain(`href="${PROD_PAGE_URL}"`);
    });
});

/* ==========================================
 * C. QRIS with qrString only
 * ========================================== */

describe("C. QRIS with qrString only", () => {
    test("renders the local QR without any provider link", () => {
        const html = render({
            qrString: PAYLOAD,
            qrisPageUrl: null,
        });

        expect(html).toContain("<svg");
        expect(html).toContain("<path");
        expect(html).not.toContain(PAYLOAD);
        expect(html).not.toContain("Buka QRIS iPaymu");
        expect(html).not.toContain("my.ipaymu.com");
        expect(html).not.toContain("<img");
    });

    test("shows a safe state when nothing QR-related exists", () => {
        const html = render({ qrString: null, qrisPageUrl: null });

        expect(html).toContain("QR belum tersedia");
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<svg");
    });
});

/* ==========================================
 * D. BCA VA — unchanged
 * ========================================== */

describe("D. BCA Virtual Account is unchanged", () => {
    test("the VA instruction keeps its payment number and carries no QR data", () => {
        const instruction = buildPaymentInstruction(
            {
                Via: "va",
                Channel: "bca",
                PaymentNo: "3811800012345678",
                PaymentName: "BCA Virtual Account",
                Url: PROD_PAGE_URL,
                QrImage: PROD_PAGE_URL,
            },
            "BANK_TRANSFER"
        );

        expect(instruction?.paymentNo).toBe("3811800012345678");
        expect(instruction?.qrString).toBeNull();
        expect(instruction?.qrisPageUrl).toBeNull();
        expect(instruction?.paymentUrl).toBeNull();
    });

    test("the payment page renders the QR panel only for QRIS", () => {
        const page = paymentPageSource();

        // The QR panel lives inside the QRIS branch only…
        const qrisBranchIndex = page.indexOf(
            'instruction.kind === "QRIS"'
        );
        const qrisPanelIndex = page.indexOf("<QrisPanel");

        expect(qrisBranchIndex).toBeGreaterThan(-1);
        expect(qrisPanelIndex).toBeGreaterThan(qrisBranchIndex);

        // …and the VA branch still renders the VA number + copy button.
        expect(page).toContain("Nomor Virtual Account");
        expect(page).toContain("instruction.paymentNo");
        expect(page).toContain("Salin Nomor VA");
    });

    test("the QR panel is never handed a payment number", () => {
        const page = paymentPageSource();

        const panelUsage = page.slice(
            page.indexOf("<QrisPanel"),
            page.indexOf("/>", page.indexOf("<QrisPanel"))
        );

        expect(panelUsage).toContain("qrString");
        expect(panelUsage).toContain("qrisPageUrl");
        expect(panelUsage).not.toContain("paymentNo");
    });
});

/* ==========================================
 * E. DANA / ShopeePay — unchanged
 * ========================================== */

describe("E. E-wallet behavior is unchanged", () => {
    test("an e-wallet instruction keeps only its provider action URL", () => {
        const instruction = buildPaymentInstruction(
            {
                Via: "ewallet",
                Channel: "dana",
                PaymentNo: "DANA-CODE",
                PaymentName: "DANA",
                Url: "https://my.ipaymu.com/ewallet/777",
            },
            "E_WALLET"
        );

        expect(instruction?.paymentUrl).toBe(
            "https://my.ipaymu.com/ewallet/777"
        );
        expect(instruction?.paymentNo).toBe("DANA-CODE");
        expect(instruction?.qrString).toBeNull();
        expect(instruction?.qrisPageUrl).toBeNull();
    });

    test("the payment page still exposes the e-wallet action button", () => {
        const page = paymentPageSource();

        expect(page).toContain("Buka Aplikasi E-Wallet");
        expect(page).toContain("instruction.actionUrl");
        // The e-wallet branch never renders a QR.
        expect(page).not.toContain("<img");
    });
});
