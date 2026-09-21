"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

/* ==========================================
 * QRIS PANEL
 * ==========================================
 *
 * Renders the scannable QRIS for the customer.
 *
 * Priority:
 *   1. `qrImageUrl` → the provider QR **image** (<img>). The live
 *      iPaymu shape returns this as `QrImage` (an https URL).
 *   2. `qrString`   → the raw QRIS payload rendered INTO a QR via
 *      qrcode.react. Used when no image URL is present OR the image
 *      fails to load (provider image expired / sandbox page instead
 *      of an image / CSP block). The payload is never rendered as
 *      visible text — only as QR modules.
 *   3. Neither      → a safe "QR belum tersedia" state.
 *
 * `paymentNo` is intentionally absent here: a QRIS payload is never a
 * payment number and must never be shown to the customer as a code.
 */

type QrisPanelProps = {
    /** Provider QR image URL (http(s) or raster data URI). */
    qrImageUrl: string | null;
    /** Raw QRIS payload to render when no image is servable. */
    qrString: string | null;
};

export default function QrisPanel({
    qrImageUrl,
    qrString,
}: QrisPanelProps) {
    const [imageFailed, setImageFailed] = useState(false);

    // 1. Primary: the provider QR image.
    if (qrImageUrl && !imageFailed) {
        return (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
                src={qrImageUrl}
                alt="QRIS pembayaran"
                width={256}
                height={256}
                className="mx-auto mt-4 h-64 w-64 rounded-2xl border bg-white object-contain p-2"
                onError={() => setImageFailed(true)}
            />
        );
    }

    // 2. Fallback: render the QR from the raw provider payload.
    //    The payload is drawn as QR modules — it never appears as text.
    if (qrString) {
        return (
            <div className="mt-4">
                {qrImageUrl && imageFailed && (
                    <p className="mb-2 text-xs text-amber-700">
                        Gambar QR dari penyedia tidak dapat dimuat. QR
                        cadangan ditampilkan dari data pembayaran.
                    </p>
                )}

                <div className="mx-auto h-64 w-64 rounded-2xl border bg-white p-2">
                    <QRCodeSVG
                        value={qrString}
                        size={256}
                        level="M"
                        aria-label="QRIS pembayaran"
                    />
                </div>
            </div>
        );
    }

    // 3. Nothing usable.
    if (qrImageUrl) {
        return (
            <div className="mt-4">
                <div className="rounded-2xl border border-dashed p-4 text-sm text-gray-500">
                    Gambar QR tidak dapat ditampilkan.
                </div>

                <a
                    href={qrImageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block text-sm font-semibold text-rose-600 hover:text-rose-700"
                >
                    Buka gambar QR di tab baru
                </a>
            </div>
        );
    }

    return (
        <div className="mt-4 rounded-2xl border border-dashed p-4 text-sm text-gray-500">
            QR belum tersedia. Silakan buka halaman pesanan untuk mencoba
            lagi.
        </div>
    );
}