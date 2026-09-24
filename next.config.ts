import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    headers: async () => {
        // ==========================================
        // ENVIRONMENT-AWARE CSP
        // ==========================================
        //
        // React 19 development mode requires eval() for
        // debugging features like reconstructing callstacks.
        // This MUST NOT be enabled in production.
        //
        // 'unsafe-eval' is ONLY added when NODE_ENV=development.
        // Evaluated at call time so NODE_ENV changes take effect immediately.
        const isDevelopment = process.env.NODE_ENV === "development";
        const scriptSrcDirectives = [
            "'self'",
            "'unsafe-inline'",
            "https://analytics.tiktok.com",
            ...(isDevelopment ? ["'unsafe-eval'"] : []),
        ];

        // TikTok Pixel mengirim event (fetch/beacon) ke
        // analytics.tiktok.com, jadi origin itu WAJIB ada di
        // connect-src. Tidak ada wildcard — hanya origin TikTok.
        const connectSrcDirectives = [
            "'self'",
            "https://analytics.tiktok.com",
        ];

        return [
            {
                source: "/(.*)",
                headers: [
                    {
                        key: "X-Content-Type-Options",
                        value: "nosniff",
                    },
                    {
                        key: "X-Frame-Options",
                        value: "DENY",
                    },
                    {
                        key: "Referrer-Policy",
                        value: "strict-origin-when-cross-origin",
                    },
                    {
                        key: "X-XSS-Protection",
                        value: "1; mode=block",
                    },
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=()",
                    },
                    {
                        // HSTS: applied to all responses globally
                        // Ensures browsers always use HTTPS in production
                        key: "Strict-Transport-Security",
                        value: "max-age=31536000; includeSubDomains",
                    },
                    {
                        // CSP: Content Security Policy
                        // Restricts resource loading to known-safe origins.
                        //
                        // SECURITY: 'unsafe-eval' is ONLY included when
                        // NODE_ENV=development (React dev mode requirement).
                        // Production CSP NEVER contains 'unsafe-eval'.
                        //
                        // NOTE: script-src uses 'unsafe-inline' because the TikTok
                        // Pixel base code (and Next.js' own inline bootstrap) is
                        // inline. Refactoring to nonce-based CSP is recommended for
                        // stronger XSS protection.
                        //
                        // All domains below are verified in the codebase:
                        //   - analytics.tiktok.com → TikTok Pixel (components/analytics/TikTokPixel.tsx)
                        //   - *.tile.openstreetmap.org → Leaflet map tiles (app/addresses/new/LocationPickerMap.tsx)
                        //   - unpkg.com → Leaflet marker images (app/addresses/new/LocationPickerMap.tsx)
                        //   - down-id.img.susercontent.com → Product images (next.config.ts images.remotePatterns)
                        //   - my.ipaymu.com / sandbox.ipaymu.com → iPaymu QRIS
                        //     QR image URL rendered on our own payment page
                        //     (app/checkout/payment/[id])
                        key: "Content-Security-Policy",
                        value: [
                            "default-src 'self'",
                            `script-src ${scriptSrcDirectives.join(" ")}`,
                            "style-src 'self' 'unsafe-inline'",
                            "img-src 'self' https://down-id.img.susercontent.com https://unpkg.com https://*.tile.openstreetmap.org https://my.ipaymu.com https://sandbox.ipaymu.com data:",
                            "font-src 'self'",
                            `connect-src ${connectSrcDirectives.join(" ")}`,
                            "frame-src 'none'",
                            "object-src 'none'",
                            "base-uri 'self'",
                            "form-action 'self'",
                            "frame-ancestors 'none'",
                        ].join("; "),
                    },
                ],
            },
        ];
    },
    allowedDevOrigins: [
        "192.168.99.247",
        "103.93.132.214",
        "202.73.25.122",
        "demosolusisejalan.my.id",
        "mutiaraabadisnack.com",
    ],
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "down-id.img.susercontent.com",
            },
        ],
    },
    /**
     * Server-only external packages.
     *
     * These packages are NOT bundled by Turbopack/
     * webpack on the server side. They are resolved
     * at runtime from node_modules.
     *
     * Baileys must be externalized because:
     * 1. It pulls in jimp (image processing) which
     *    Turbopack cannot resolve
     * 2. It has native/optional dependencies that
     *    should not be bundled
     * 3. We only use text messaging — no media deps
     *    needed at bundle time
     *
     * tesseract.js MUST be externalized because it
     * spawns a worker_threads Worker whose path is
     * computed at runtime as
     *
     *   path.join(__dirname, '..', '..',
     *             'worker-script', 'node', 'index.js')
     *
     * When the package is bundled, `__dirname` is
     * frozen to the build machine's location, so the
     * deployed server tries to load a worker script
     * that no longer exists there and the process
     * dies with:
     *   Cannot find module
     *   '<root>/node_modules/tesseract.js/src/
     *     worker-script/node/index.js'
     *
     * Externalizing keeps `require('tesseract.js')`
     * pointing at the runtime node_modules, so both
     * the worker script and tesseract.js-core resolve
     * from real paths on the server. Never import
     * tesseract.js internals (src/**, dist/**) or
     * hardcode workerPath instead.
     *
     * pdf-parse / pdfjs-dist MUST be externalized for
     * the same class of reason: pdf.js resolves its
     * worker with a RELATIVE runtime import
     *
     *   GlobalWorkerOptions.workerSrc ||= './pdf.worker.mjs'
     *   await import('./pdf.worker.mjs')
     *
     * (pdfjs-dist/legacy/build/pdf.mjs). A relative
     * specifier resolves against the module that runs
     * it — legitimately
     * node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs,
     * but when pdfjs-dist is bundled it runs from a
     * generated chunk instead and resolves to
     *
     *   <project>/.next/server/chunks/pdf.worker.mjs
     *
     * which Turbopack never emits, so PDF parsing dies
     * with:
     *   Setting up fake worker failed: Cannot find
     *   module '<project>/.next/server/chunks/
     *     pdf.worker.mjs'
     *
     * pdfjs-dist is the package that owns the worker
     * import, so it is externalized explicitly (it is
     * otherwise pulled into the server bundle as a
     * plain dependency of pdf-parse).
     *
     * @napi-rs/canvas is a native addon required by
     * pdf.js (`createRequire(...)('@napi-rs/canvas')`)
     * for the page-render path used to OCR scanned
     * PDFs; native modules must stay unbundled.
     */
    serverExternalPackages: [
        "@whiskeysockets/baileys",
        "tesseract.js",
        "pdf-parse",
        "pdfjs-dist",
        "@napi-rs/canvas",
    ],
    /**
     * Runtime assets that tracing cannot discover on
     * its own, needed by the OCR worker when the app
     * is deployed as a traced/standalone build.
     *
     * The tesseract worker script is referenced only
     * through a runtime `path.join(__dirname, ...)`,
     * and tesseract.js-core loads its .wasm files
     * dynamically, so neither is statically visible
     * to the file tracer.
     *
     * The pdf.js worker is requested through a runtime
     * relative import and @napi-rs/canvas loads a
     * prebuilt .node binary, so both are invisible to
     * the tracer as well. They are traced here so a
     * traced/standalone deploy keeps the real package
     * layout the worker path is resolved from.
     */
    outputFileTracingIncludes: {
        "/api/admin/resi-scan": [
            // worker script + its runtime deps (node-fetch,
            // wasm-feature-detect) and the WASM core
            "./node_modules/tesseract.js/**/*",
            "./node_modules/tesseract.js-core/**/*",
            // pdf.js text engine + its runtime worker
            // asset (legacy/build/pdf.worker.mjs) and the
            // cmaps/standard fonts it loads lazily
            "./node_modules/pdf-parse/**/*",
            "./node_modules/pdfjs-dist/**/*",
            // native canvas addon (page render for scanned
            // PDFs) + its platform-specific binary
            "./node_modules/@napi-rs/canvas/**/*",
            "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
        ],
    },
};

export default nextConfig;
