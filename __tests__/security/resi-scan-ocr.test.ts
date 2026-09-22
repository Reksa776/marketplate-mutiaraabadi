/* ==========================================
 * RESI SCAN — OCR ADAPTER TESTS
 * ==========================================
 *
 * Locks down the contract that the production
 * worker-resolution fix must not break:
 *
 *   - one worker per call, terminates on every
 *     path (success, init failure, timeout)
 *   - a hard timeout that kills the worker and
 *     returns a controlled failure (never throws)
 *   - pixel/dimension bomb rejected BEFORE a
 *     worker is spawned
 *   - OCR concurrency bounded
 *   - the module stays server-only and never
 *     points at tesseract.js internals (src/**,
 *     dist/**, workerPath/corePath), which is what
 *     made the bundled build crash in production
 *
 * tesseract.js and sharp are mocked so the suite
 * is fast and offline; the real engine is
 * exercised separately.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import sharp from "sharp";
import {
    extractImageText,
    OCR_MAX_CONCURRENCY,
    OCR_MAX_PIXELS,
    OCR_MAX_SIDE,
    OCR_TIMEOUT_MS,
} from "@/lib/resi-scan/ocr";

const mockCreateWorker = jest.fn();

jest.mock("tesseract.js", () => ({
    __esModule: true,
    OEM: { LSTM_ONLY: 1 },
    createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

interface SharpState {
    width: number;
    height: number;
    metadataThrows: boolean;
}

jest.mock("sharp", () => {
    const state: SharpState = {
        width: 1200,
        height: 900,
        metadataThrows: false,
    };

    const chain = {
        rotate: () => chain,
        resize: () => chain,
        grayscale: () => chain,
        normalize: () => chain,
        sharpen: () => chain,
        toBuffer: async () => Buffer.from("ocr-input"),
    };

    const sharpMock = () => ({
        ...chain,
        metadata: async () => {
            if (state.metadataThrows) {
                throw new Error("broken image");
            }
            return {
                width: state.width,
                height: state.height,
            };
        },
    });

    (
        sharpMock as unknown as { state: SharpState }
    ).state = state;

    return { __esModule: true, default: sharpMock };
});

const sharpState = (
    sharp as unknown as { state: SharpState }
).state;

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/** Let pending microtasks + mock async work settle. */
function flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
}

const image = Buffer.from("fake-image-bytes");

beforeEach(() => {
    mockCreateWorker.mockReset();
    sharpState.width = 1200;
    sharpState.height = 900;
    sharpState.metadataThrows = false;
    jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/* ==========================================
 * WORKER LIFECYCLE
 * ========================================== */

describe("OCR worker lifecycle", () => {
    test("returns text and terminates the worker", async () => {
        const terminate = jest
            .fn()
            .mockResolvedValue(undefined);
        mockCreateWorker.mockResolvedValue({
            recognize: jest.fn().mockResolvedValue({
                data: { text: "JNE1234567890" },
            }),
            terminate,
        });

        const result = await extractImageText(image);

        expect(result).toEqual({
            ok: true,
            text: "JNE1234567890",
        });
        expect(mockCreateWorker).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    test("uses the supported public API — no internal worker path", async () => {
        const terminate = jest
            .fn()
            .mockResolvedValue(undefined);
        mockCreateWorker.mockResolvedValue({
            recognize: jest.fn().mockResolvedValue({
                data: { text: "ok" },
            }),
            terminate,
        });

        await extractImageText(image);

        const [lang, oem, options] =
            mockCreateWorker.mock.calls[0];

        expect(lang).toBe("eng");
        expect(oem).toBe(1); // OEM.LSTM_ONLY
        // workerPath/corePath must not be overridden —
        // tesseract.js derives the worker itself.
        expect(options.workerPath).toBeUndefined();
        expect(options.corePath).toBeUndefined();
    });

    test("worker init failure returns a controlled failure", async () => {
        mockCreateWorker.mockRejectedValue(
            new Error(
                "Cannot find module '/app/node_modules/tesseract.js/src/worker-script/node/index.js'"
            )
        );

        const result = await extractImageText(image);

        expect(result).toEqual({
            ok: false,
            error: "OCR tidak tersedia di server ini.",
        });
    });

    test("recognize failure returns a controlled failure", async () => {
        const terminate = jest
            .fn()
            .mockResolvedValue(undefined);
        mockCreateWorker.mockResolvedValue({
            recognize: jest
                .fn()
                .mockRejectedValue(new Error("boom")),
            terminate,
        });

        const result = await extractImageText(image);

        expect(result).toEqual({
            ok: false,
            error: "OCR gagal memproses dokumen.",
        });
        expect(terminate).toHaveBeenCalledTimes(1);
    });
});

/* ==========================================
 * TIMEOUT
 * ========================================== */

describe("OCR timeout", () => {
    test("timeout terminates the worker, returns ok:false and frees the slot", async () => {
        jest.useFakeTimers();
        jest.setTimeout(15_000);

        const terminate = jest
            .fn()
            .mockResolvedValue(undefined);
        mockCreateWorker.mockResolvedValue({
            recognize: () => new Promise(() => {}),
            terminate,
        });

        const pending = extractImageText(image);

        // Let dimension check + preprocessing +
        // createWorker settle so the hard timeout is
        // armed before we advance time.
        for (let i = 0; i < 10; i++) {
            await jest.advanceTimersByTimeAsync(0);
        }

        expect(mockCreateWorker).toHaveBeenCalledTimes(1);
        expect(terminate).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(
            OCR_TIMEOUT_MS
        );

        const result = await pending;

        expect(result).toEqual({
            ok: false,
            error: "OCR gagal memproses dokumen.",
        });
        expect(terminate).toHaveBeenCalledTimes(1);

        // The concurrency slot must be released even
        // though the worker hung.
        mockCreateWorker.mockResolvedValue({
            recognize: jest.fn().mockResolvedValue({
                data: { text: "after-timeout" },
            }),
            terminate: jest.fn().mockResolvedValue(undefined),
        });

        const next = extractImageText(image);

        for (let i = 0; i < 10; i++) {
            await jest.advanceTimersByTimeAsync(0);
        }

        expect(mockCreateWorker).toHaveBeenCalledTimes(2);
        expect(await next).toEqual({
            ok: true,
            text: "after-timeout",
        });
    });
});

/* ==========================================
 * IMAGE GUARDS
 * ========================================== */

describe("OCR image guards", () => {
    test("rejects an oversized side before spawning a worker", async () => {
        sharpState.width = OCR_MAX_SIDE + 1;

        const result = await extractImageText(image);

        expect(result.ok).toBe(false);
        expect(mockCreateWorker).not.toHaveBeenCalled();
    });

    test("rejects a pixel bomb before spawning a worker", async () => {
        sharpState.width = 6000;
        sharpState.height = 5000; // 30 MP > OCR_MAX_PIXELS

        expect(6000 * 5000).toBeGreaterThan(
            OCR_MAX_PIXELS
        );

        const result = await extractImageText(image);

        expect(result.ok).toBe(false);
        expect(mockCreateWorker).not.toHaveBeenCalled();
    });

    test("unreadable image returns a controlled failure", async () => {
        sharpState.metadataThrows = true;

        const result = await extractImageText(image);

        expect(result.ok).toBe(false);
        expect(mockCreateWorker).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * CONCURRENCY
 * ========================================== */

describe("OCR concurrency", () => {
    test(`never runs more than ${OCR_MAX_CONCURRENCY} workers at once`, async () => {
        const resolvers: Array<
            (value: { data: { text: string } }) => void
        > = [];

        mockCreateWorker.mockImplementation(
            async () => ({
                recognize: () =>
                    new Promise((res) => {
                        resolvers.push(res);
                    }),
                terminate: jest
                    .fn()
                    .mockResolvedValue(undefined),
            })
        );

        const runs = [
            extractImageText(image),
            extractImageText(image),
            extractImageText(image),
        ];

        await flush();
        await flush();

        expect(mockCreateWorker).toHaveBeenCalledTimes(
            OCR_MAX_CONCURRENCY
        );

        resolvers[0]({ data: { text: "one" } });
        await flush();
        await flush();

        expect(mockCreateWorker).toHaveBeenCalledTimes(
            OCR_MAX_CONCURRENCY + 1
        );

        resolvers[1]({ data: { text: "two" } });
        resolvers[2]({ data: { text: "three" } });
        await flush();

        const results = await Promise.all(runs);

        expect(
            results.every((r) => r.ok)
        ).toBe(true);
    });
});

/* ==========================================
 * DEPLOYMENT GUARDS
 * ==========================================
 *
 * These are the checks that keep the production
 * worker resolvable: the module must be
 * server-only, must use only the public API, and
 * tesseract.js must be excluded from bundling.
 */

describe("OCR deployment guards", () => {
    const ocrSource = readFile("lib/resi-scan/ocr.ts");
    const nextConfig = readFile("next.config.ts");

    test("OCR module is marked server-only", () => {
        expect(ocrSource).toMatch(
            /^\s*import\s+"server-only";/m
        );
    });

    test("OCR module imports only the public tesseract.js entry", () => {
        expect(ocrSource).toMatch(
            /from\s+"tesseract\.js"/
        );
        expect(ocrSource).not.toMatch(
            /from\s+"tesseract\.js\//
        );
        expect(ocrSource).not.toMatch(
            /require\(\s*"tesseract\.js\//
        );
    });

    test("OCR module does not hardcode internal worker paths", () => {
        expect(ocrSource).not.toMatch(
            /workerPath\s*[:=]/
        );
        expect(ocrSource).not.toMatch(/corePath\s*[:=]/);
        expect(ocrSource).not.toContain("createRequire");
        expect(ocrSource).not.toContain(
            "tesseract.js/dist"
        );
    });

    test("tesseract.js is excluded from server bundling", () => {
        const block = nextConfig.slice(
            nextConfig.indexOf(
                "serverExternalPackages"
            )
        );
        expect(block).toContain('"tesseract.js"');
    });

    test("worker script + WASM core are traced for standalone deploys", () => {
        const block = nextConfig.slice(
            nextConfig.indexOf(
                "outputFileTracingIncludes"
            )
        );
        expect(block).toContain(
            "node_modules/tesseract.js"
        );
        expect(block).toContain(
            "node_modules/tesseract.js-core"
        );
    });
});
