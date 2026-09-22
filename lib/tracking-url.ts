/* ==========================================
 * TRACKING URL BUILDER (shared)
 * ==========================================
 *
 * Generates clickable tracking URLs based on
 * courier name. Used by the resi-scan pipeline
 * (lib/resi-scan/apply.ts). Mirrors the same
 * courier map that lives in the tracking-import
 * route (kept there for its source-level tests).
 */

export function createTrackingUrl(
    courier: string,
    trackingNumber: string
): string | null {
    const normalizedCourier = courier
        .toLowerCase()
        .trim();

    const encoded = encodeURIComponent(
        trackingNumber
    );

    if (
        normalizedCourier.includes("jne")
    ) {
        return `https://www.jne.co.id/id/tracking/trace/tracking?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("jnt") ||
        normalizedCourier.includes("j&t") ||
        normalizedCourier.includes("j&t express")
    ) {
        return `https://www.jet.co.id/track?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("sicepat") ||
        normalizedCourier.includes("si cepat")
    ) {
        return `https://www.sicepat.com/checkAwb?awb=${encoded}`;
    }

    if (
        normalizedCourier.includes("anteraja") ||
        normalizedCourier.includes("anter aja")
    ) {
        return `https://anteraja.id/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("pos")
    ) {
        return `https://www.posindonesia.co.id/id/tracking?code=${encoded}`;
    }

    if (
        normalizedCourier.includes("tiki")
    ) {
        return `https://www.tiki.id/tracking?airwaybill=${encoded}`;
    }

    if (
        normalizedCourier.includes("ninja")
    ) {
        return `https://www.ninjavan.co/en-id/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("idexpress")
    ) {
        return `https://idexpress.com/en/tracking?tracking_number=${encoded}`;
    }

    if (
        normalizedCourier.includes("wahana")
    ) {
        return `https://www.wahana.com/info/tracking/?noresi=${encoded}`;
    }

    return null;
}