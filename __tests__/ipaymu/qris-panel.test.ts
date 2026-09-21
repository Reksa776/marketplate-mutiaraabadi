import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QrisPanel from "@/app/checkout/payment/[id]/QrisPanel";

const PAYLOAD = "00020101021226610014ID.CO.QRIS.WWW";

/** SSR the panel for a given instruction (server = no client state yet). */
function render(props: {
    qrImageUrl: string | null;
    qrString: string | null;
}): string {
    return renderToStaticMarkup(
        createElement(QrisPanel, { ...props })
    );
}

describe("QrisPanel (SSR of the checkout payment page QR block)", () => {
    test("renders the provider QR image when available", () => {
        const html = render({
            qrImageUrl: "https://sandbox.ipaymu.com/qris/1789707975553.png",
            qrString: PAYLOAD,
        });

        expect(html).toContain(
            "src=\"https://sandbox.ipaymu.com/qris/1789707975553.png\""
        );
        // Image first — no fallback QR is emitted while the image is set.
        expect(html).not.toContain("<svg");
    });

    test("renders a scannable QR when only the raw payload exists", () => {
        const html = render({ qrImageUrl: null, qrString: PAYLOAD });

        // A real QR is generated (SVG path data), NOT the payload shown.
        expect(html).toContain("<svg");
        expect(html).toContain("<path");
        expect(html).not.toContain(PAYLOAD);
        expect(html).not.toContain("paymentNo");
        expect(html).toContain("QRIS pembayaran");
    });

    test("falls back to the payload QR when the image fails", () => {
        const html = render({
            qrImageUrl: "https://my.ipaymu.com/qris/1.png",
            qrString: PAYLOAD,
        });

        // On the server the image is still the primary source; the client
        // swaps to the SVG fallback once onError fires. The raw payload is
        // never serialized as visible text.
        expect(html).toContain("src=");
        expect(html).not.toContain(PAYLOAD);
    });

    test("never reveals the raw QRIS payload or a payment code", () => {
        const html = render({ qrImageUrl: null, qrString: PAYLOAD });

        expect(html).not.toContain("ID.CO.QRIS");
        expect(html).not.toMatch(/Kode Pembayaran/);
        expect(html).not.toMatch(/font-mono/);
    });

    test("shows a safe state when nothing QR-related exists", () => {
        const html = render({ qrImageUrl: null, qrString: null });

        expect(html).toContain("QR belum tersedia");
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<svg");
    });

    test("image-only case still renders the primary image, never a code", () => {
        const html = render({
            qrImageUrl: "https://my.ipaymu.com/qris/2.png",
            qrString: null,
        });

        expect(html).toContain(
            "src=\"https://my.ipaymu.com/qris/2.png\""
        );
        // The provider-quick fallback (image-link branch) is a client-side
        // onError state; without a payload nothing scary is ever shown.
        expect(html).not.toContain("ID.CO.QRIS");
        expect(html).not.toMatch(/Kode Pembayaran/);
        expect(html).not.toMatch(/font-mono/);
    });
});