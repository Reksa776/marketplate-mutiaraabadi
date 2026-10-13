"use client";

/**
 * ==========================================
 * KONFIRMASI PESANAN VIA WHATSAPP
 * ==========================================
 *
 * The customer-facing half of the order-confirmation hand-off.
 *
 * The link itself is built ON THE SERVER
 * (GET /api/orders/[id]/whatsapp-confirm) because the destination
 * number must come from the connected admin session and the draft must
 * be derived from the authorized order row. This component therefore
 * NEVER composes a wa.me url on its own:
 *
 *   - it renders the server-provided url as a plain anchor, so the
 *     customer decides when to open WhatsApp (no automatic redirect, no
 *     hidden send),
 *   - when the server reports the destination as unavailable it shows
 *     an explanation instead of a link — a link to a guessed number
 *     would silently open a chat with a stranger,
 *   - a failed/aborted request is treated the same way (fail closed).
 */

import { useEffect, useState } from "react";
import { FaWhatsapp } from "react-icons/fa";

type ConfirmState =
    | { phase: "loading" }
    | { phase: "available"; url: string }
    | { phase: "unavailable" };

type WhatsAppConfirmButtonProps = {
    /** Order primary key; ownership is re-checked by the endpoint. */
    orderId: number;
    className?: string;
};

export default function WhatsAppConfirmButton({
    orderId,
    className = "",
}: WhatsAppConfirmButtonProps) {
    const [state, setState] = useState<ConfirmState>({
        phase: "loading",
    });

    useEffect(() => {
        /*
         * `active` guards against a state update after unmount (the
         * order pages can navigate away while the request is in
         * flight).
         */
        let active = true;
        const controller = new AbortController();

        async function load() {
            try {
                const response = await fetch(
                    `/api/orders/${orderId}/whatsapp-confirm`,
                    {
                        method: "GET",
                        headers: {
                            Accept: "application/json",
                        },
                        signal: controller.signal,
                    }
                );

                const result = await response.json();

                if (!active) return;

                const url =
                    response.ok &&
                    result?.success === true &&
                    result?.data?.available === true &&
                    typeof result.data.url === "string"
                        ? result.data.url
                        : null;

                setState(
                    url
                        ? { phase: "available", url }
                        : { phase: "unavailable" }
                );
            } catch {
                // Network error or abort — never invent a link.
                if (!active) return;

                setState({ phase: "unavailable" });
            }
        }

        load();

        return () => {
            active = false;
            controller.abort();
        };
    }, [orderId]);

    if (state.phase === "loading") {
        return (
            <span
                className={`inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-400 ${className}`}
            >
                Memuat WhatsApp Admin...
            </span>
        );
    }

    if (state.phase === "available") {
        return (
            <div className={`flex flex-col gap-2 ${className}`}>
                <a
                    href={state.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-5 py-3 text-sm font-semibold text-white hover:bg-[#1DA851] sm:w-auto"
                >
                    <FaWhatsapp
                        className="h-5 w-5"
                        aria-hidden="true"
                    />
                    Konfirmasi Pesanan via WhatsApp
                </a>

                <p className="text-xs text-gray-500">
                    Pesan sudah terisi otomatis (nomor
                    pesanan, nama, dan status pesanan).
                    Tekan Kirim di WhatsApp untuk
                    menghubungi admin.
                </p>
            </div>
        );
    }

    return (
        <div
            className={`flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 ${className}`}
            role="status"
        >
            <span aria-hidden="true">ℹ️</span>

            <span>
                WhatsApp Admin sedang tidak tersedia,
                jadi konfirmasi lewat WhatsApp belum bisa
                dilakukan. Silakan coba lagi nanti.
            </span>
        </div>
    );
}
