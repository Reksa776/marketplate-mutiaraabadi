"use client";

import { QRCodeSVG } from "qrcode.react";

/* ==========================================
 * QRIS PANEL
 * ==========================================
 *
 * Renders the scannable QRIS for the customer.
 *
 *  1. `qrString` (PRIMARY) → the raw QRIS payload is rendered INTO a QR
 *     locally with qrcode.react. This is the only scannable source: it
 *     never depends on the provider page being loadable/embeddable.
 *     The payload is drawn as QR modules — it is never visible text.
 *
 *  2. `qrisPageUrl` (FALLBACK) → the provider URL is an HTML QR/payment
 *     page (`https://my.ipaymu.com/qris-basic/...`), NOT an image
 *     binary, so it is only offered as a link the customer can open in
 *     a new tab. It is NEVER used as an `<img src>` and is never
 *     iframed or proxied.
 *
 *  3. Neither → a safe "QR belum tersedia" state.
 *
 * `paymentNo` is intentionally absent here: a QRIS payload is never a
 * payment number and must never be shown to the customer as a code.
 */

type QrisPanelProps = {
    /** Raw QRIS payload — rendered locally into a QR image. */
    qrString: string | null;
    /** iPaymu QRIS page URL — fallback link only, never an image. */
    qrisPageUrl: string | null;
};

function QrisPageLink({ href }: { href: string }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
            Buka QRIS iPaymu
        </a>
    );
}

export default function QrisPanel({
    qrString,
    qrisPageUrl,
}: QrisPanelProps) {
    // 1. Primary: QR generated locally from the raw provider payload.
    if (qrString) {
        return (
            <div className="mt-4">
                <div className="mx-auto w-fit rounded-2xl border bg-white p-3">
                    <QRCodeSVG
                        value={qrString}
                        size={280}
                        level="M"
                        marginSize={4}
                        title="QRIS pembayaran"
                        aria-label="QRIS pembayaran"
                        className="h-auto w-full max-w-[280px]"
                    />
                </div>

                {qrisPageUrl && (
                    <>
                        <p className="mt-3 text-xs text-gray-500">
                            Jika QR tidak bisa dipindai, buka halaman QRIS
                            berikut:
                        </p>

                        <QrisPageLink href={qrisPageUrl} />
                    </>
                )}
            </div>
        );
    }

    // 2. Fallback: no raw payload to render → offer the provider page.
    if (qrisPageUrl) {
        return (
            <div className="mt-4">
                <div className="rounded-2xl border border-dashed p-4 text-sm text-gray-500">
                    QR tidak dapat ditampilkan di halaman ini.
                </div>

                <p className="mt-3 text-xs text-gray-500">
                    Buka halaman QRIS iPaymu berikut untuk menampilkan QR
                    pembayaran Anda.
                </p>

                <QrisPageLink href={qrisPageUrl} />
            </div>
        );
    }

    // 3. Nothing usable.
    return (
        <div className="mt-4 rounded-2xl border border-dashed p-4 text-sm text-gray-500">
            QR belum tersedia. Silakan buka halaman pesanan untuk mencoba
            lagi.
        </div>
    );
}
