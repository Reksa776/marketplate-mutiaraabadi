/* ==========================================
 * RESI SCAN — CONFIDENCE SCORING
 * ==========================================
 *
 * Pure scoring helper. A document derives its
 * confidence from extraction source quality,
 * order match, tracking validity and conflict
 * signals.
 *
 * Tiers:
 *   HIGH   >= 0.65 → MATCHED_READY (auto-assignable)
 *   MEDIUM 0.35..0.64 → NEEDS_REVIEW (admin confirm)
 *   LOW    < 0.35 → NOT_FOUND / INVALID / CONFLICT
 *                    (never auto-assigned)
 */

import type { ScanSource } from "./types";

export type ConfidenceTier = "LOW" | "MEDIUM" | "HIGH";

export interface ScoreInput {
    source: ScanSource;
    orderFound: boolean;
    trackingValid: boolean;
    orderEligible: boolean;
    alreadyHasTracking: boolean;
    matchingExistingTracking: boolean;
    trackingInUseByOtherOrder: boolean;
    referenceMissing: boolean;
}

export const HIGH_CONFIDENCE = 0.65;

export function clampScore(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function classifyConfidence(
    score: number
): ConfidenceTier {
    if (score >= HIGH_CONFIDENCE) return "HIGH";
    if (score >= 0.35) return "MEDIUM";
    return "LOW";
}

export function computeConfidence(
    input: ScoreInput
): { score: number; tier: ConfidenceTier } {
    // PDF text is deterministic; OCR is a heuristic
    // and is deliberately under-weighted so scanned
    // docs land in NEEDS_REVIEW (admin confirms).
    let score = input.source === "pdf-text" ? 0.55 : 0.15;

    if (input.orderFound) {
        score += 0.25;
    } else {
        score -= 0.45;
    }

    if (input.trackingValid) {
        score += 0.2;
    } else {
        score -= 0.3;
    }

    if (input.orderFound && !input.orderEligible) {
        score -= 0.15;
    }

    if (
        input.alreadyHasTracking &&
        !input.matchingExistingTracking
    ) {
        score -= 0.25;
    }

    if (input.trackingInUseByOtherOrder) {
        score -= 0.4;
    }

    if (input.referenceMissing) {
        score -= 0.1;
    }

    const clamped = clampScore(score);
    return {
        score: clamped,
        tier: classifyConfidence(clamped),
    };
}