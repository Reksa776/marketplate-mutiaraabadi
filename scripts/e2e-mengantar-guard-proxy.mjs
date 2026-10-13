/**
 * ==========================================
 * LOCAL E2E GUARD PROXY — MENGANTAR (READ-ONLY)
 * ==========================================
 *
 * Point a LOCAL dev server at this proxy with
 *
 *   MENGANTAR_BASE_URL=http://127.0.0.1:3199
 *
 * and the real `MENGANTAR_API_KEY` is left intact, so the app performs
 * its REAL shipping estimate (the exact call the checkout UI makes)
 * while ANY call that would create, schedule or pay a real shipment is
 * refused with 503.
 *
 * WHY THIS EXISTS
 * ---------------
 * A COD checkout enqueues a ShipmentJob and nudges the worker in the
 * same request, so a functional end-to-end run against the real API
 * would create a real Mengantar shipment for a synthetic order. This
 * proxy keeps the customer-facing path faithful (same key, same
 * upstream host, same endpoints) while guaranteeing that NO shipment,
 * pickup schedule or shipping payment can ever be created by the test.
 *
 * ALLOWED (read-only):
 *   GET /api/public/<KEY>/address/search     (area lookup)
 *   GET /api/public/<KEY>/order/estimate     (shipping quote)
 *
 * BLOCKED (everything else), notably:
 *   POST /api/public/<KEY>/order             (creates a shipment)
 *   POST /api/public/<KEY>/order/pay/unpaid
 *   POST /api/public/<KEY>/time              (pickup schedule)
 *
 * The API key travels in the URL PATH, so this proxy NEVER logs a path:
 * it logs the endpoint suffix with the key replaced by `{KEY}`.
 */

import http from "node:http";

const PORT = Number(process.env.GUARD_PORT ?? 3199);

const UPSTREAM = (
    process.env.GUARD_UPSTREAM ??
    "https://api-public.mengantar.com"
).replace(/\/+$/, "");

/** Endpoints that only READ provider state. */
const READ_ONLY = [
    /^\/api\/public\/[^/]+\/address\/search$/,
    /^\/api\/public\/[^/]+\/order\/estimate$/,
];

/** Replace the key segment so it can never reach a log. */
function redact(path) {
    return path.replace(
        /^\/api\/public\/[^/]+/,
        "/api/public/{KEY}"
    );
}

const server = http.createServer(async (req, res) => {
    const [path] = (req.url ?? "/").split("?");

    const allowed =
        req.method === "GET" &&
        READ_ONLY.some((pattern) => pattern.test(path));

    if (!allowed) {
        console.log(
            `[guard] BLOCKED ${req.method} ${redact(path)}`
        );

        res.writeHead(503, {
            "content-type": "application/json",
        });

        res.end(
            JSON.stringify({
                success: false,
                message:
                    "Diblokir oleh guard proxy E2E lokal (read-only).",
            })
        );

        return;
    }

    console.log(
        `[guard] ALLOW ${req.method} ${redact(path)}`
    );

    /*
     * A transient upstream blip must not surface as a provider error to
     * the app under test: the app would treat a 502 as Mengantar being
     * unavailable and abort the checkout. Retry a couple of times
     * before giving up.
     */
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const upstream = await fetch(
                `${UPSTREAM}${req.url}`,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                }
            );

            const body = await upstream.text();

            res.writeHead(upstream.status, {
                "content-type":
                    upstream.headers.get("content-type") ??
                    "application/json",
            });

            res.end(body);

            return;
        } catch (error) {
            lastError = error;

            console.error(
                `[guard] upstream failure (attempt ${attempt}/3):`,
                error instanceof Error
                    ? error.message
                    : error
            );

            await new Promise((resolve) =>
                setTimeout(resolve, 250 * attempt)
            );
        }
    }

    console.error(
        "[guard] upstream unreachable after retries:",
        lastError instanceof Error
            ? lastError.message
            : lastError
    );

    res.writeHead(502, {
        "content-type": "application/json",
    });

    res.end(
        JSON.stringify({
            success: false,
            message: "Upstream guard proxy gagal.",
        })
    );
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(
        `[guard] read-only Mengantar guard listening on http://127.0.0.1:${PORT} → ${UPSTREAM}`
    );
});
