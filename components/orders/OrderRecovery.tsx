"use client";

import { useState } from "react";
import { FiKey } from "react-icons/fi";
import toast from "react-hot-toast";

/**
 * ==========================================
 * GUEST ORDER RECOVERY (TWO-PHASE OTP)
 * ==========================================
 *
 * A guest order is normally reachable through the httpOnly access
 * token cookie set at checkout. When that cookie is gone (cleared
 * browser, new device) or its 30-day window has expired, the buyer
 * restores access in TWO steps:
 *
 *   1. order number + the email/phone used at checkout → the server
 *      sends a one-time code to the contact on the order, over the
 *      channel the buyer picked (Email or WhatsApp), and
 *   2. the code (plus the same contact, kept in component state so the
 *      buyer never retypes it) → the server mints a fresh access token
 *      into an httpOnly cookie and the list reloads.
 *
 * The token is never issued before the code verifies, so this form can
 * never hand an order to someone who merely knows the order number.
 *
 * The channel is only a CHOICE OF TRANSPORT: the email option always
 * mails the address stored on the order (never the typed one), and
 * both options share the same code, expiry and attempt rules.
 */

/** Where the one-time code is delivered. */
type RecoveryChannel = "email" | "whatsapp";

type Props = {
    /**
     * Prefill for the order-number field.
     *
     * Used by the public tracking page (`/lacak`), where the bot already
     * put the order number in the link. It is ONLY a convenience: nothing
     * is unlocked by it — the two-phase OTP below still has to verify
     * against the contact stored on the order.
     */
    defaultOrderNumber?: string;
};

export default function OrderRecovery({
    defaultOrderNumber = "",
}: Props = {}) {
    const [orderNumber, setOrderNumber] =
        useState(defaultOrderNumber);
    const [contact, setContact] = useState("");
    const [code, setCode] = useState("");
    const [channel, setChannel] =
        useState<RecoveryChannel>("whatsapp");
    const [challengeId, setChallengeId] =
        useState<string | null>(null);
    /*
     * The channel the ACTIVE challenge was sent over — kept separately
     * from the selector so the phase-2 copy can never describe a
     * different transport than the one the code actually used.
     */
    const [sentChannel, setSentChannel] =
        useState<RecoveryChannel>("whatsapp");
    const [loading, setLoading] =
        useState(false);

    const isEmailChannel = channel === "email";

    /*
     * For the email channel the field is an email, full stop.
     *
     * On WhatsApp the single field keeps its original dual meaning: an
     * "@" means email, anything else is treated as a phone number. Both
     * are normalized again — and bound to the challenge — on the
     * server.
     */
    function contactPayload() {
        if (isEmailChannel) {
            return { email: contact.trim() };
        }

        const looksLikeEmail = contact.includes("@");

        return looksLikeEmail
            ? { email: contact.trim() }
            : { phone: contact.trim() };
    }

    async function requestCode(
        event: React.FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        if (!orderNumber.trim() || !contact.trim()) {
            toast.error(
                isEmailChannel
                    ? "Isi nomor pesanan dan email."
                    : "Isi nomor pesanan dan email atau nomor telepon."
            );

            return;
        }

        if (
            isEmailChannel &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                contact.trim()
            )
        ) {
            toast.error(
                "Masukkan alamat email yang valid."
            );

            return;
        }

        try {
            setLoading(true);

            const response = await fetch(
                "/api/orders/recover",
                {
                    method: "POST",
                    headers: {
                        "content-type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        orderNumber:
                            orderNumber.trim(),
                        channel,
                        ...contactPayload(),
                    }),
                }
            );

            const data = await response.json();

            if (!response.ok) {
                toast.error(
                    data.message ??
                        "Pesanan tidak ditemukan."
                );

                return;
            }

            const nextChallengeId =
                data?.data?.challengeId;

            if (!nextChallengeId) {
                toast.error(
                    "Gagal meminta kode verifikasi."
                );

                return;
            }

            setChallengeId(nextChallengeId);
            setSentChannel(channel);
            setCode("");

            toast.success(
                data.message ??
                    "Kode verifikasi telah dikirim."
            );
        } catch (error) {
            console.error(error);

            toast.error(
                "Terjadi kesalahan. Coba lagi nanti."
            );
        } finally {
            setLoading(false);
        }
    }

    async function confirmCode(
        event: React.FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        if (!challengeId) {
            return;
        }

        if (!/^\d{6}$/.test(code.trim())) {
            toast.error(
                "Masukkan 6 digit kode verifikasi."
            );

            return;
        }

        try {
            setLoading(true);

            const response = await fetch(
                "/api/orders/recover/confirm",
                {
                    method: "POST",
                    headers: {
                        "content-type":
                            "application/json",
                    },
                    body: JSON.stringify({
                        challengeId,
                        code: code.trim(),
                        ...contactPayload(),
                    }),
                }
            );

            const data = await response.json();

            if (!response.ok) {
                toast.error(
                    data.message ??
                        "Kode verifikasi salah."
                );

                return;
            }

            toast.success(
                data.message ??
                    "Akses pesanan berhasil dipulihkan."
            );

            /*
             * Reload so the list is fetched with the freshly issued
             * access-token cookie (Next caches client fetches).
             */
            window.location.reload();
        } catch (error) {
            console.error(error);

            toast.error(
                "Terjadi kesalahan. Coba lagi nanti."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <section className="mt-4 border border-gray-200 bg-white px-5 py-6 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <div className="flex items-center gap-2">
                <FiKey
                    size={16}
                    className="text-gray-500"
                />

                <h3 className="text-sm font-bold text-gray-900">
                    Sudah pernah pesan? Pulihkan pesanan
                </h3>
            </div>

            {!challengeId ? (
                <>
                    <p className="mt-1.5 text-xs leading-5 text-gray-500">
                        Masukkan nomor pesanan dan kontak
                        yang Anda gunakan saat checkout.
                        {isEmailChannel
                            ? " Kami akan mengirim kode verifikasi ke email pada pesanan tersebut."
                            : " Kami akan mengirim kode verifikasi ke nomor WhatsApp pada pesanan tersebut."}
                    </p>

                    {/*
                     * Transport selector. Both options run the SAME
                     * challenge flow — this only decides where the
                     * code is delivered.
                     */}
                    <div
                        role="group"
                        aria-label="Pilih metode pengiriman kode"
                        className="mt-3 flex flex-wrap gap-2"
                    >
                        <button
                            type="button"
                            aria-pressed={isEmailChannel}
                            disabled={loading}
                            onClick={() => {
                                setChannel("email");
                                setContact("");
                            }}
                            className={`h-9 rounded-lg border px-3 text-xs font-semibold transition disabled:opacity-60 ${
                                isEmailChannel
                                    ? "border-gray-900 bg-gray-900 text-white"
                                    : "border-gray-300 bg-white text-gray-600 hover:border-gray-500"
                            }`}
                        >
                            Pulihkan via Email
                        </button>

                        <button
                            type="button"
                            aria-pressed={!isEmailChannel}
                            disabled={loading}
                            onClick={() => {
                                setChannel("whatsapp");
                                setContact("");
                            }}
                            className={`h-9 rounded-lg border px-3 text-xs font-semibold transition disabled:opacity-60 ${
                                !isEmailChannel
                                    ? "border-gray-900 bg-gray-900 text-white"
                                    : "border-gray-300 bg-white text-gray-600 hover:border-gray-500"
                            }`}
                        >
                            Pulihkan via WhatsApp
                        </button>
                    </div>

                    <form
                        onSubmit={requestCode}
                        className="mt-4 grid gap-3 sm:grid-cols-2"
                    >
                        <label className="block">
                            <span className="text-xs font-medium text-gray-600">
                                Nomor pesanan
                            </span>

                            <input
                                value={orderNumber}
                                onChange={(event) =>
                                    setOrderNumber(
                                        event.target
                                            .value
                                    )
                                }
                                placeholder="PAY-CART-101"
                                autoComplete="off"
                                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-800 outline-none transition focus:border-gray-500"
                            />
                        </label>

                        <label className="block">
                            <span className="text-xs font-medium text-gray-600">
                                {isEmailChannel
                                    ? "Email"
                                    : "Email atau nomor telepon"}
                            </span>

                            <input
                                value={contact}
                                onChange={(event) =>
                                    setContact(
                                        event.target
                                            .value
                                    )
                                }
                                type={
                                    isEmailChannel
                                        ? "email"
                                        : "text"
                                }
                                placeholder={
                                    isEmailChannel
                                        ? "nama@email.com"
                                        : "nama@email.com / 0812..."
                                }
                                autoComplete="off"
                                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-800 outline-none transition focus:border-gray-500"
                            />
                        </label>

                        <button
                            type="submit"
                            disabled={loading}
                            className="h-10 rounded-lg border border-gray-900 bg-white px-5 text-sm font-semibold text-gray-900 transition hover:bg-gray-50 disabled:opacity-60 sm:col-span-2 sm:w-fit"
                        >
                            {loading
                                ? "Mengirim..."
                                : "Kirim Kode Verifikasi"}
                        </button>
                    </form>
                </>
            ) : (
                <>
                    <p className="mt-1.5 text-xs leading-5 text-gray-500">
                        Kami mengirim kode 6 digit ke
                        {sentChannel === "email"
                            ? " email"
                            : " nomor WhatsApp"}{" "}
                        pada pesanan{" "}
                        <span className="font-semibold text-gray-700">
                            {orderNumber.trim()}
                        </span>
                        . Kode berlaku 10 menit dan
                        hanya dapat dipakai sekali.
                    </p>

                    <form
                        onSubmit={confirmCode}
                        className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
                    >
                        <label className="block">
                            <span className="text-xs font-medium text-gray-600">
                                Kode verifikasi
                            </span>

                            <input
                                value={code}
                                onChange={(event) =>
                                    setCode(
                                        event.target.value
                                            .replace(
                                                /\D/g,
                                                ""
                                            )
                                            .slice(0, 6)
                                    )
                                }
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="123456"
                                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm tracking-[0.3em] text-gray-800 outline-none transition focus:border-gray-500 sm:w-40"
                            />
                        </label>

                        <button
                            type="submit"
                            disabled={loading}
                            className="h-10 rounded-lg border border-gray-900 bg-white px-5 text-sm font-semibold text-gray-900 transition hover:bg-gray-50 disabled:opacity-60"
                        >
                            {loading
                                ? "Memverifikasi..."
                                : "Verifikasi & Pulihkan"}
                        </button>

                        <button
                            type="button"
                            disabled={loading}
                            onClick={() => {
                                setChallengeId(null);
                                setCode("");
                            }}
                            className="h-10 rounded-lg px-3 text-sm font-medium text-gray-500 transition hover:text-gray-800 disabled:opacity-60"
                        >
                            Minta kode baru
                        </button>
                    </form>
                </>
            )}
        </section>
    );
}
