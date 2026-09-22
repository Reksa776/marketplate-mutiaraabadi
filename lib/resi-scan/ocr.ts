/* ==========================================
 * RESI SCAN — OCR ADAPTER
 * ==========================================
 *
 * tesseract.js is a WASM OCR engine with NO
 * native VPS dependency. Language data is pulled
 * from the project-naptha CDN by default, or from
 * a local directory when OCR_LANG_PATH is set.
 *
 * Production safety:
 *   - One tesseract worker PER CALL (created and
 *     terminated inside the request). No shared
 *     worker to corrupt with interleaved
 *     recognizes, no zombie worker on failure.
 *   - A concurrency semaphore bounds simultaneous
 *     OCR runs (each worker holds traineddata +
 *     WASM in memory).
 *   - A hard timeout per OCR run; on timeout the
 *     worker is terminated to avoid leaks.
 *   - Image dimension bomb guard: dimensions are
 *     checked BEFORE decoding, so a huge-image
 *     pixel bomb cannot exhaust memory.
 *
 * Every failure degrades gracefully to an
 * OcrResult { ok:false } — the scan pipeline marks
 * the item needs-review instead of crashing.
 */

import { createWorker, OEM } from "tesseract.js";
import sharp from "sharp";

export type OcrResult =
    | { ok: true; text: string }
    | { ok: false; error: string };

/** Max concurrent OCR runs in this process. */
export const OCR_MAX_CONCURRENCY = 2;

/** Hard per-run timeout before the worker is killed. */
export const OCR_TIMEOUT_MS = 45_000;

/** Reject images whose pixel count or side may exhaust memory. */
export const OCR_MAX_PIXELS = 25_000_000; // ~25 MP
export const OCR_MAX_SIDE = 10_000; // px

const langPath = process.env.OCR_LANG_PATH?.trim();

let activeOcrRuns = 0;
const ocrWaiters: Array<() => void> = [];

async function acquireOcrSlot(): Promise<() => void> {
    if (activeOcrRuns < OCR_MAX_CONCURRENCY) {
        activeOcrRuns++;
        return () => {
            activeOcrRuns--;
            const next = ocrWaiters.shift();
            if (next) next();
        };
    }

    await new Promise<void>((resolve) => {
        ocrWaiters.push(resolve);
    });
    return acquireOcrSlot();
}

async function checkImageDimensions(
    buffer: Buffer
): Promise<string | null> {
    try {
        const meta = await sharp(buffer).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;

        if (
            width > OCR_MAX_SIDE ||
            height > OCR_MAX_SIDE
        ) {
            return "Dimensi gambar melebihi batas aman.";
        }

        if (width * height > OCR_MAX_PIXELS) {
            return "Resolusi gambar terlalu besar.";
        }
    } catch (error) {
        console.error(
            "OCR_METADATA_ERROR:",
            error instanceof Error
                ? error.message
                : error
        );
        return "Gambar tidak dapat dibaca.";
    }

    return null;
}

/**
 * Lightweight preprocessing before OCR: rotate +
 * resize + grayscale + normalise + sharpen.
 * Falls back to the raw input if sharp fails.
 */
export async function preprocessForOcr(
    input: Buffer
): Promise<Buffer> {
    try {
        return await sharp(input)
            .rotate()
            .resize({
                width: 2000,
                height: 2400,
                fit: "inside",
                withoutEnlargement: false,
            })
            .grayscale()
            .normalize()
            .sharpen()
            .toBuffer();
    } catch (error) {
        console.error(
            "OCR_PREPROCESS_ERROR:",
            error instanceof Error
                ? error.message
                : error
        );
        return input;
    }
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    signal: { timedOut: boolean }
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.timedOut = true;
            reject(new Error("OCR_TIMEOUT"));
        }, ms);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export async function extractImageText(
    buffer: Buffer
): Promise<OcrResult> {
    const release = await acquireOcrSlot();

    // Always terminate the worker and release the
    // slot, even on timeout/error/failure.
    let worker: Awaited<
        ReturnType<typeof createWorker>
    > | null = null;

    try {
        const dimensionError =
            await checkImageDimensions(buffer);
        if (dimensionError) {
            return {
                ok: false,
                error: dimensionError,
            };
        }

        const processed =
            await preprocessForOcr(buffer);

        try {
            const options: Record<string, string> = {};
            if (langPath) {
                // Directory containing eng.traineddata.gz
                options.langPath = langPath;
            }
            worker = await createWorker(
                "eng",
                OEM.LSTM_ONLY,
                options
            );
        } catch (error) {
            console.error(
                "OCR_INIT_ERROR:",
                error instanceof Error
                    ? error.message
                    : error
            );
            return {
                ok: false,
                error: "OCR tidak tersedia di server ini.",
            };
        }

        const timeoutSignal = { timedOut: false };

        try {
            const { data } = await withTimeout(
                worker.recognize(processed),
                OCR_TIMEOUT_MS,
                timeoutSignal
            );
            return { ok: true, text: data.text || "" };
        } catch (error) {
            if (
                timeoutSignal.timedOut ||
                (error instanceof Error &&
                    error.message === "OCR_TIMEOUT")
            ) {
                console.error("OCR_TIMEOUT");
            } else {
                console.error(
                    "OCR_RECOGNIZE_ERROR:",
                    error instanceof Error
                        ? error.message
                        : error
                );
            }
            return {
                ok: false,
                error: "OCR gagal memproses dokumen.",
            };
        }
    } finally {
        if (worker) {
            try {
                await worker.terminate();
            } catch {
                /* best-effort cleanup */
            }
        }
        release();
    }
}