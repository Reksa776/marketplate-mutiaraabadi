"use client";

/**
 * ==========================================
 * TRACKING LOOKUP (PUBLIC)
 * ==========================================
 *
 * The page entry for `/lacak`, the link the WhatsApp bot sends.
 *
 * HOW IT DECIDES (and why it is safe)
 *
 *   1. `?pesanan=` is a PREFILL HINT only. It is never used to read an
 *      order: the component asks `GET /api/orders`, which returns ONLY
 *      the orders this browser already holds a valid guest access token
 *      for (or the session owner's orders), and then looks the hint up
 *      INSIDE that list. A guessed/forwarded order number therefore
 *      matches nothing.
 *   2. Match found → the read-only tracking panel renders immediately
 *      (zero friction for the customer who ordered on this phone).
 *   3. No match → the SAME two-phase OTP recovery the order history page
 *      uses, pre-filled with the order number. Nothing is unlocked until
 *      the code sent to the checkout contact verifies.
 *
 * No order data is fetched, cached or rendered before step 2/3 resolves.
 */

import { useEffect, useState } from "react";
import { FiPackage } from "react-icons/fi";

import OrderRecovery from "./OrderRecovery";
import ShipmentTrackingPanel from "./ShipmentTrackingPanel";
import { findAccessibleOrder } from "@/lib/tracking/tracking-page";

type Props = {
    /** Sanitized `?pesanan=` prefill hint from the page. */
    initialOrderNumber: string | null;
};

type ResolvedState =
    | { phase: "loading" }
    | { phase: "found"; orderId: number }
    | { phase: "unmatched" };

export default function TrackingLookup({
    initialOrderNumber,
}: Props) {
    /*
     * Without a hint there is nothing to resolve, so no request is made
     * at all: the customer types the order number in the recovery form.
     */
    const [result, setResult] = useState<ResolvedState>(() =>
        initialOrderNumber
            ? { phase: "loading" }
            : { phase: "unmatched" }
    );

    /*
     * Derived, not stored: with no hint there is nothing to resolve, so
     * the form phase is the answer regardless of any earlier attempt
     * (and the effect below then has nothing to do).
     */
    const state: ResolvedState = initialOrderNumber
        ? result
        : { phase: "unmatched" };

    useEffect(() => {
        if (!initialOrderNumber) {
            return;
        }

        let active = true;
        const controller = new AbortController();

        async function resolve() {
            try {
                setResult({ phase: "loading" });

                const response = await fetch("/api/orders", {
                    method: "GET",
                    cache: "no-store",
                    signal: controller.signal,
                });

                const result = await response.json();

                if (!active) return;

                const orders = Array.isArray(result?.data)
                    ? (result.data as {
                          id: number;
                          orderNumber: string;
                      }[])
                    : [];

                const match = findAccessibleOrder(
                    orders,
                    initialOrderNumber
                );

                setResult(
                    match
                        ? { phase: "found", orderId: match.id }
                        : { phase: "unmatched" }
                );
            } catch (error) {
                if (!active) return;

                if (
                    error instanceof Error &&
                    error.name === "AbortError"
                ) {
                    return;
                }

                /*
                 * Fail closed: an unreadable list means "not proven
                 * yours", which is answered by the OTP path rather than
                 * by showing anything.
                 */
                setResult({ phase: "unmatched" });
            }
        }

        resolve();

        return () => {
            active = false;
            controller.abort();
        };
    }, [initialOrderNumber]);

    if (state.phase === "loading") {
        return (
            <div className="border border-gray-200 bg-white px-5 py-6">
                <div className="h-5 w-36 animate-pulse rounded bg-gray-200" />

                <div className="mt-5 grid gap-3">
                    <div className="h-16 animate-pulse rounded-xl bg-gray-100" />

                    <div className="h-16 animate-pulse rounded-xl bg-gray-100" />
                </div>
            </div>
        );
    }

    if (state.phase === "found") {
        return <ShipmentTrackingPanel orderId={state.orderId} />;
    }

    return (
        <div className="space-y-4">
            <div className="border border-gray-200 bg-white px-5 py-6">
                <div className="flex items-center gap-2">
                    <FiPackage
                        size={16}
                        className="text-gray-500"
                    />

                    <h2 className="text-sm font-bold text-gray-900">
                        Lacak pesanan kamu
                    </h2>
                </div>

                <p className="mt-1.5 text-xs leading-5 text-gray-500">
                    Masukkan nomor pesanan dan kontak yang
                    kamu gunakan saat checkout. Kami akan
                    mengirim kode verifikasi ke kontak pada
                    pesanan tersebut — data pesanan hanya
                    tampil setelah kode itu diverifikasi.
                </p>
            </div>

            <OrderRecovery
                defaultOrderNumber={
                    initialOrderNumber ?? ""
                }
            />
        </div>
    );
}
