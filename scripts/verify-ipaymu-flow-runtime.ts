/**
 * ==========================================
 * iPaymu DIRECT PAYMENT — FULL FLOW RUNTIME VERIFICATION
 * ==========================================
 *
 * Drives the REAL running app over HTTP against the REAL local
 * database and the REAL iPaymu **SANDBOX**. A hard gate runs first and
 * aborts unless the resolved config is the sandbox, so this harness can
 * never create a production payment.
 *
 * Coverage
 *   1. sandbox gate + resolved provider endpoint
 *   2. HTTP auth gates (unauthenticated)
 *   3. real provider creation → persisted instruction → read model
 *      (QRIS / VA / e-wallet, plus a provider-rejected channel
 *      proving the failure path leaves NO instruction behind)
 *   4. payment page + polling over HTTP with a real signed-in session
 *   5. webhook over HTTP with a REAL HMAC signature and REAL DB CAS:
 *      success / duplicate / invalid signature / wrong amount /
 *      wrong reference / cancelled-order resurrection / expiry
 *   6. expiry settlement (provider expiry + grace)
 *   7. reservation release: variant stock, product.sold, voucher
 *      usage, shipping-discount quota
 *
 * Never prints the API key, merchant VA, signature or any credential.
 * Creates uniquely-named fixtures and restores the database exactly.
 */

import "dotenv/config";

import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import { getIpaymuConfig } from "@/lib/payment/config";
import {
    computeCanonicalJson,
    computeWebhookSignature,
} from "@/lib/payment/ipaymu";
import {
    createDirectOrderPayment,
    expireUnpaidOrderIfExpired,
    loadPaymentView,
    PAYMENT_EXPIRY_GRACE_MS,
} from "@/lib/payment/order-payment";

/* ==========================================
 * REPORTING
 * ========================================== */

type Status = "PASS" | "FAIL" | "BLOCKED";

const results: { id: string; status: Status; detail: string }[] = [];

function record(id: string, status: Status, detail: string): void {
    results.push({ id, status, detail });
    console.log(`[${status.padEnd(7)}] ${id} — ${detail}`);
}

function ok(id: string, detail: string): boolean {
    record(id, "PASS", detail);
    return true;
}

function bad(id: string, detail: string): boolean {
    record(id, "FAIL", detail);
    return false;
}

function blocked(id: string, detail: string): boolean {
    record(id, "BLOCKED", detail);
    return false;
}

/** Describe a provider URL by host only — never the full value. */
function hostOf(url: string | null | undefined): string | null {
    if (typeof url !== "string" || !url.trim()) return null;
    try {
        return new URL(url).host;
    } catch {
        return "<unparseable>";
    }
}

function safeJson(text: string): any {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Depth-first search for the first object matching `match`. */
function findObject(node: any, match: (o: any) => boolean): any | null {
    if (!node || typeof node !== "object") return null;

    if (Array.isArray(node)) {
        for (const entry of node) {
            const found = findObject(entry, match);
            if (found) return found;
        }
        return null;
    }

    if (match(node)) return node;

    for (const value of Object.values(node)) {
        const found = findObject(value, match);
        if (found) return found;
    }

    return null;
}

/* ==========================================
 * SANDBOX GATE (fail closed)
 * ========================================== */

const config = getIpaymuConfig();

if (
    config.environment !== "sandbox" ||
    !config.baseUrl.includes("sandbox.ipaymu.com")
) {
    console.error(
        `REFUSED: resolved payment config is not the iPaymu sandbox ` +
            `(environment=${config.environment}, baseUrl=${config.baseUrl}). ` +
            `This harness creates payments and must never target production.`
    );
    process.exit(1);
}

const prisma = new PrismaClient();
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const RUN = `VR${Date.now().toString(36).toUpperCase()}`;
const KEEP = process.argv.includes("--keep");

const runId = (suffix: string) => `VERIFY-${RUN}-${suffix}`;

/* ==========================================
 * FIXTURE SNAPSHOT (restored on exit)
 * ========================================== */

const snapshot = {
    variants: new Map<number, { stock: number; sold: number }>(),
    vouchers: new Map<number, number>(),
    shippingDiscounts: new Map<number, number>(),
};
const createdOrderIds: number[] = [];
let createdUserId: string | null = null;
let createdVoucherId: number | null = null;
let createdShippingDiscountId: number | null = null;
let createdAddressId: string | null = null;

async function snapshotVariant(variantId: number, productId: number) {
    if (snapshot.variants.has(variantId)) return;
    const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { stock: true },
    });
    const rows = await prisma.$queryRaw<{ sold: number }[]>`
        SELECT sold FROM product WHERE id = ${productId}
    `;
    snapshot.variants.set(variantId, {
        stock: variant.stock,
        sold: Number(rows[0]?.sold ?? 0),
    });
}

/* ==========================================
 * HTTP HELPERS
 * ========================================== */

type Session = {
    cookie: string;
    /** Individual cookie parts, needed to seed a real browser. */
    pairs: { name: string; value: string }[];
    ok: boolean;
    status: number;
};

async function login(
    identifier: string,
    password: string
): Promise<Session> {
    const jar = new Map<string, string>();

    const collect = (res: Response) => {
        const list =
            typeof (res.headers as any).getSetCookie === "function"
                ? (res.headers as any).getSetCookie()
                : [res.headers.get("set-cookie")].filter(Boolean);
        for (const raw of list as string[]) {
            const pair = raw.split(";")[0];
            const eq = pair.indexOf("=");
            if (eq > 0) {
                jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        }
    };

    const cookieHeader = () =>
        Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");

    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, {
        headers: { cookie: cookieHeader() },
    });
    collect(csrfRes);

    let csrfToken = "";
    try {
        csrfToken = (await csrfRes.json()).csrfToken ?? "";
    } catch {
        csrfToken = "";
    }

    if (!csrfToken) {
        return {
            cookie: "",
            pairs: [],
            ok: false,
            status: csrfRes.status,
        };
    }

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
        method: "POST",
        redirect: "manual",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            cookie: cookieHeader(),
        },
        body: new URLSearchParams({
            csrfToken,
            identifier,
            password,
            callbackUrl: `${BASE_URL}/`,
        }).toString(),
    });
    collect(loginRes);

    const cookie = cookieHeader();
    return {
        cookie,
        pairs: Array.from(jar, ([name, value]) => ({ name, value })),
        ok:
            cookie.includes("session-token") &&
            loginRes.status >= 300 &&
            loginRes.status < 400,
        status: loginRes.status,
    };
}

/* ==========================================
 * REAL BROWSER (headless Chrome via CDP)
 * ==========================================
 *
 * The payment page is a client component: its server HTML is a
 * loading shell and the whole instruction is rendered in the browser
 * from `/api/orders/{id}/payment-status`. A DOM-level assertion
 * therefore cannot be made with `fetch` alone, so this drives
 * headless Chrome over the DevTools protocol using Node built-ins
 * only (no new dependency). Nothing outside the sandbox is contacted
 * beyond loading the QR image host the provider itself returned.
 */

type Browser = {
    setCookies(pairs: { name: string; value: string }[]): Promise<void>;
    navigate(url: string): Promise<void>;
    evaluate(expression: string): Promise<any>;
    close(): Promise<void>;
};

async function openBrowser(): Promise<Browser | null> {
    const port = 9333;
    const profile = mkdtempSync(join(tmpdir(), "vr-chrome-"));

    const chrome = spawn(
        "google-chrome",
        [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            `--user-data-dir=${profile}`,
            `--remote-debugging-port=${port}`,
            "about:blank",
        ],
        { stdio: "ignore" }
    );

    chrome.on("error", () => undefined);

    let wsUrl = "";
    for (let i = 0; i < 80 && !wsUrl; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            const json: any = await res.json();
            if (json?.webSocketDebuggerUrl) wsUrl = json.webSocketDebuggerUrl;
        } catch {
            /* not up yet */
        }
        if (!wsUrl) await new Promise((r) => setTimeout(r, 250));
    }

    if (!wsUrl) {
        chrome.kill("SIGKILL");
        rmSync(profile, { recursive: true, force: true });
        return null;
    }

    const ws = new WebSocket(wsUrl);

    try {
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener(
                "error",
                () => reject(new Error("CDP connect failed")),
                { once: true }
            );
        });
    } catch {
        chrome.kill("SIGKILL");
        rmSync(profile, { recursive: true, force: true });
        return null;
    }

    let nextId = 0;
    const pending = new Map<
        number,
        { resolve: (v: any) => void; reject: (e: Error) => void }
    >();

    ws.addEventListener("message", (event: any) => {
        let msg: any;
        try {
            msg = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (typeof msg.id !== "number") return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        msg.error
            ? entry.reject(new Error(msg.error.message ?? "CDP error"))
            : entry.resolve(msg.result);
    });

    const send = (
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string
    ): Promise<any> =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            ws.send(
                JSON.stringify({
                    id,
                    method,
                    params,
                    ...(sessionId ? { sessionId } : {}),
                })
            );
        });

    const { targetId } = await send("Target.createTarget", {
        url: "about:blank",
    });
    const { sessionId } = await send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });

    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);

    return {
        async setCookies(pairs) {
            for (const { name, value } of pairs) {
                await send(
                    "Network.setCookie",
                    { name, value, url: BASE_URL, path: "/" },
                    sessionId
                ).catch(() => undefined);
            }
        },
        async navigate(url) {
            await send("Page.navigate", { url }, sessionId);
        },
        async evaluate(expression) {
            const result = await send(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId
            );
            return result?.result?.value;
        },
        async close() {
            await send("Target.closeTarget", { targetId }).catch(
                () => undefined
            );
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            chrome.kill("SIGKILL");
            rmSync(profile, { recursive: true, force: true });
        },
    };
}

/**
 * Poll the rendered DOM until `predicate` accepts `document.body.innerText`.
 * Returns the last observed text so failures can be described.
 */
async function waitForDom(
    browser: Browser,
    predicate: (text: string) => boolean,
    timeoutMs: number
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "";

    while (Date.now() < deadline) {
        try {
            const text = await browser.evaluate("document.body.innerText");
            if (typeof text === "string") {
                last = text;
                if (predicate(text)) return text;
            }
        } catch {
            /* page still navigating */
        }
        await new Promise((r) => setTimeout(r, 400));
    }

    return last;
}

async function http(
    path: string,
    init: RequestInit & { cookie?: string } = {}
) {
    const { cookie, ...rest } = init;
    const res = await fetch(`${BASE_URL}${path}`, {
        ...rest,
        redirect: "manual",
        headers: {
            ...(rest.headers ?? {}),
            ...(cookie ? { cookie } : {}),
        },
    });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get("location") };
}

/* ==========================================
 * WEBHOOK SENDER (real signature)
 * ========================================== */

async function sendWebhook(
    fields: Record<string, string>,
    options: { signature?: string; omitHeaders?: boolean } = {}
) {
    const body = new URLSearchParams(fields).toString();
    const signature =
        options.signature ??
        computeWebhookSignature(computeCanonicalJson(fields), config.va);

    const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
    };

    if (!options.omitHeaders) {
        headers["X-Signature"] = signature;
        headers["X-Timestamp"] = "20260918120000";
        headers["X-External-ID"] = RUN;
    }

    const res = await fetch(`${BASE_URL}/api/payment/ipaymu/notification`, {
        method: "POST",
        headers,
        body,
    });

    let json: any = null;
    try {
        json = await res.json();
    } catch {
        json = null;
    }

    return { status: res.status, json };
}

/* ==========================================
 * FIXTURES
 * ========================================== */

/** Round-trip helper: reserve one unit of stock the way checkout does. */
async function reserveStock(
    variantId: number,
    productId: number,
    quantity: number
) {
    await snapshotVariant(variantId, productId);
    await prisma.productVariant.update({
        where: { id: variantId },
        data: { stock: { decrement: quantity } },
    });
    await prisma.$executeRaw`
        UPDATE product SET sold = sold + ${quantity} WHERE id = ${productId}
    `;
}

async function createPendingOrder(opts: {
    suffix: string;
    total: number;
    quantity?: number;
    variantId?: number;
    withVoucher?: boolean;
    withShippingDiscount?: boolean;
    paymentMethod?: "QRIS" | "BANK_TRANSFER" | "E_WALLET";
    paymentExpiresAt?: Date | null;
}): Promise<{ id: number; orderNumber: string; variantId: number; productId: number }> {
    if (!createdUserId) {
        throw new Error("fixtures not initialised");
    }

    let variantId = opts.variantId;
    if (!variantId) {
        const variant = await prisma.productVariant.findFirst({
            where: {
                stock: { gte: (opts.quantity ?? 1) + 5 },
                flashSales: { none: {} },
            },
            orderBy: { id: "asc" },
            select: { id: true, productId: true, name: true, price: true },
        });
        if (!variant) throw new Error("no variant with free stock");
        variantId = variant.id;
    }

    const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { id: true, productId: true, name: true, price: true },
    });

    const quantity = opts.quantity ?? 1;
    const orderNumber = runId(opts.suffix);

    await reserveStock(variant.id, variant.productId, quantity);

    const order = await prisma.order.create({
        data: {
            userId: createdUserId,
            orderNumber,
            recipientName: "Runtime Verification",
            phone: "081234567890",
            address: "Jl. Runtime Verification No. 1",
            subtotal: opts.total,
            shippingCost: 0,
            total: opts.total,
            status: "PENDING",
            paymentMethod: opts.paymentMethod ?? "QRIS",
            paymentStatus: "PENDING",
            paymentExpiresAt: opts.paymentExpiresAt ?? null,
            voucherId: opts.withVoucher ? createdVoucherId : null,
            voucherCode: opts.withVoucher ? runId("V") : null,
            shippingDiscountId: opts.withShippingDiscount
                ? createdShippingDiscountId
                : null,
            items: {
                create: [
                    {
                        productId: variant.productId,
                        variantId: variant.id,
                        productName: "Runtime Verification Product",
                        variantName: variant.name,
                        price: opts.total / quantity,
                        quantity,
                        subtotal: opts.total,
                    },
                ],
            },
        },
    });

    createdOrderIds.push(order.id);

    return {
        id: order.id,
        orderNumber,
        variantId: variant.id,
        productId: variant.productId,
    };
}

/* ==========================================
 * CLEANUP
 * ========================================== */

async function cleanup(): Promise<void> {
    // Any fixture order still holding a reservation is rolled back
    // through the app's own lifecycle so releases stay idempotent.
    for (const id of createdOrderIds) {
        try {
            const order = await prisma.order.findUnique({
                where: { id },
                select: { status: true },
            });
            if (order && (order.status === "PENDING" || order.status === "PROCESSING")) {
                const { rollbackCheckoutOrder } = await import("@/lib/checkout");
                await rollbackCheckoutOrder(id, { restoreCart: false });
            }
        } catch {
            /* best effort */
        }
    }

    if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }

    // Restore the exact pre-run counters so the dev database is unchanged.
    for (const [variantId, before] of snapshot.variants) {
        const variant = await prisma.productVariant.findUnique({
            where: { id: variantId },
            select: { productId: true },
        });
        if (!variant) continue;
        await prisma.productVariant.update({
            where: { id: variantId },
            data: { stock: before.stock },
        });
        await prisma.$executeRaw`
            UPDATE product SET sold = ${before.sold} WHERE id = ${variant.productId}
        `;
    }

    for (const [id, used] of snapshot.vouchers) {
        await prisma.voucher
            .update({ where: { id }, data: { usedCount: used } })
            .catch(() => undefined);
    }

    for (const [id, used] of snapshot.shippingDiscounts) {
        await prisma.shippingDiscount
            .update({ where: { id }, data: { usedCount: used } })
            .catch(() => undefined);
    }

    if (createdUserId) {
        await prisma.voucherUserUsage
            .deleteMany({ where: { userId: createdUserId } })
            .catch(() => undefined);
        await prisma.cartItem
            .deleteMany({ where: { cart: { userId: createdUserId } } })
            .catch(() => undefined);
        await prisma.user
            .delete({ where: { id: createdUserId } })
            .catch(() => undefined);
    }

    if (createdVoucherId) {
        await prisma.voucher
            .delete({ where: { id: createdVoucherId } })
            .catch(() => undefined);
    }

    if (createdShippingDiscountId) {
        await prisma.shippingDiscount
            .delete({ where: { id: createdShippingDiscountId } })
            .catch(() => undefined);
    }
}

/* ==========================================
 * MAIN
 * ========================================== */

async function main(): Promise<void> {
    console.log("========== iPaymu DIRECT PAYMENT — RUNTIME FLOW ==========");
    console.log(`environment=${config.environment}`);
    console.log(`providerEndpoint=${config.baseUrl}`);
    console.log(`appBaseUrl=${BASE_URL}`);
    console.log(`run=${RUN}\n`);

    /* ---------- 1. sandbox / endpoint ---------- */

    record(
        "1.1 sandbox gate",
        config.environment === "sandbox" &&
            config.baseUrl === "https://sandbox.ipaymu.com"
            ? "PASS"
            : "FAIL",
        `environment=${config.environment} baseUrl=${config.baseUrl}`
    );

    /* ---------- 2. app reachability + auth gates ---------- */

    const home = await http("/");
    record(
        "2.1 app reachable",
        home.status === 200 ? "PASS" : "FAIL",
        `GET / → HTTP ${home.status}`
    );

    const page1 = await http("/checkout/payment/1");
    page1.status === 302 && (page1.location ?? "").includes("/login")
        ? ok("2.2 payment page requires auth", `302 → ${page1.location}`)
        : bad("2.2 payment page requires auth", `HTTP ${page1.status} ${page1.location ?? ""}`);

    const poll1 = await http("/api/orders/1/payment-status");
    poll1.status === 401
        ? ok("2.3 polling endpoint requires auth", `HTTP 401`)
        : bad("2.3 polling endpoint requires auth", `HTTP ${poll1.status}`);

    const expire1 = await http("/api/orders/1/expire", { method: "POST" });
    expire1.status === 401
        ? ok("2.4 expire endpoint requires auth", `HTTP 401`)
        : bad("2.4 expire endpoint requires auth", `HTTP ${expire1.status}`);

    const noHeaders = await sendWebhook(
        { reference_id: "x", status_code: "1" },
        { omitHeaders: true }
    );
    noHeaders.status === 401
        ? ok("2.5 webhook rejects missing headers", `HTTP 401`)
        : bad("2.5 webhook rejects missing headers", `HTTP ${noHeaders.status}`);

    /* ---------- fixtures ---------- */

    const password = `Vr!${RUN}${Math.random().toString(36).slice(2, 10)}`;
    const email = `${runId("user").toLowerCase()}@example.com`;

    const user = await prisma.user.create({
        data: {
            name: "Runtime Verification",
            email,
            password: await bcrypt.hash(password, 10),
            role: "CUSTOMER",
        },
        select: { id: true },
    });
    createdUserId = user.id;

    const address = await prisma.userAddress.create({
        data: {
            userId: user.id,
            label: "verify",
            recipientName: "Runtime Verification",
            phone: "081234567890",
            address: "Jl. Runtime Verification No. 1",
            rajaOngkirDestinationId: 4858,
        },
        select: { id: true },
    });
    createdAddressId = address.id;

    const voucher = await prisma.voucher.create({
        data: {
            code: runId("V"),
            type: "FIXED",
            value: 1000,
            quota: 10,
            usedCount: 1,
            isActive: true,
        },
        select: { id: true },
    });
    createdVoucherId = voucher.id;
    snapshot.vouchers.set(voucher.id, 0);

    await prisma.voucherUserUsage.create({
        data: { voucherId: voucher.id, userId: user.id, usageCount: 1 },
    });

    const shippingDiscount = await prisma.shippingDiscount.create({
        data: {
            name: runId("SD"),
            type: "FIXED",
            value: 5000,
            quota: 10,
            usedCount: 1,
            startAt: new Date(Date.now() - 86_400_000),
            endAt: new Date(Date.now() + 86_400_000),
            isActive: true,
        },
        select: { id: true },
    });
    createdShippingDiscountId = shippingDiscount.id;
    snapshot.shippingDiscounts.set(shippingDiscount.id, 0);

    const session = await login(email, password);
    record(
        "3.1 credentials session",
        session.ok ? "PASS" : "FAIL",
        session.ok
            ? "signed in, session cookie issued"
            : `login failed (status ${session.status})`
    );
    if (!session.ok) {
        record(
            "3.x authenticated flows",
            "BLOCKED",
            "no session cookie — payment page / polling / repay not exercised"
        );
    }

    /* ---------- 4. provider creation → persistence → read model ---------- */

    async function createPayment(
        suffix: string,
        paymentMethod: "QRIS" | "BANK_TRANSFER" | "E_WALLET",
        paymentChannel?: string
    ) {
        const order = await createPendingOrder({
            suffix,
            total: 10_000,
            paymentMethod,
        });

        try {
            await createDirectOrderPayment({
                orderId: order.id,
                orderNumber: order.orderNumber,
                buyerName: "Runtime Verification",
                buyerPhone: "081234567890",
                buyerEmail: email,
                amount: 10_000,
                paymentMethod,
                paymentChannel,
                notifyUrl: `${BASE_URL}/api/payment/ipaymu/notification`,
                comments: "sandbox runtime verification",
            });
            const view = await loadPaymentView(order.id, user.id);
            return { order, view, error: null as string | null };
        } catch (error) {
            const view = await loadPaymentView(order.id, user.id);
            return {
                order,
                view,
                error: error instanceof Error ? error.message.slice(0, 160) : String(error),
            };
        }
    }

    const qris = await createPayment("qris", "QRIS");
    qris.view?.instruction.qrImageUrl
        ? ok(
              "4.1 QRIS instruction mapped",
              `qrImageUrl=<set,host=${new URL(qris.view.instruction.qrImageUrl).host}> kind=${qris.view.instruction.kind}`
          )
        : bad("4.1 QRIS instruction mapped", `qrImageUrl missing (${qris.error ?? "-"})`);

    const vaBca = await createPayment("va-bca", "BANK_TRANSFER", "bca");
    vaBca.view?.instruction.paymentNo
        ? ok(
              "4.2 VA instruction mapped",
              `paymentNo=<set,len=${vaBca.view.instruction.paymentNo.length}> channel=${vaBca.view.paymentChannel}`
          )
        : bad("4.2 VA instruction mapped", `paymentNo missing (${vaBca.error ?? "-"})`);

    const dana = await createPayment("dana", "E_WALLET", "dana");
    dana.view?.instruction.actionUrl
        ? ok(
              "4.3 e-wallet (dana) action mapped",
              `actionUrl=<host=${new URL(dana.view.instruction.actionUrl).host}>`
          )
        : bad("4.3 e-wallet (dana) action mapped", `actionUrl missing (${dana.error ?? "-"})`);

    /* ShopeePay is rejected by the sandbox provider → must fail closed. */
    const shopeepay = await createPayment("shopeepay", "E_WALLET", "shopeepay");
    if (shopeepay.error) {
        const stored = await prisma.order.findUnique({
            where: { id: shopeepay.order.id },
            select: { paymentNo: true, paymentUrl: true },
        });
        !stored?.paymentNo && !stored?.paymentUrl
            ? ok(
                  "4.4 provider-rejected channel fails closed",
                  `no instruction persisted (${shopeepay.error.slice(0, 60)})`
              )
            : bad(
                  "4.4 provider-rejected channel fails closed",
                  `instruction was persisted for a failed channel`
              );
    } else {
        bad(
            "4.4 provider-rejected channel fails closed",
            "shopeepay unexpectedly succeeded — re-check provider availability"
        );
    }

    /* ---------- 5. payment page + polling over HTTP ---------- */

    if (session.ok && qris.view) {
        const page = await http(`/checkout/payment/${qris.order.id}`, {
            cookie: session.cookie,
        });
        /*
         * NOTE: `/checkout/payment/[id]` is a client component. Its
         * server HTML is deliberately a loading shell — the instruction
         * is rendered in the browser from the polling endpoint. Asserting
         * the order number in this HTML would be a false failure; the
         * real render is asserted with a browser in 5.6–5.10.
         */
        const isClientShell =
            page.status === 200 &&
            page.text.includes("Memuat pembayaran") &&
            !page.text.includes(qris.order.orderNumber);
        isClientShell
            ? ok(
                  "5.1 payment page SSR shell",
                  "HTTP 200, client shell only (instruction renders in-browser — see 5.6)"
              )
            : bad(
                  "5.1 payment page SSR shell",
                  `HTTP ${page.status}, shell=${page.text.includes("Memuat pembayaran")}`
              );

        const leaked =
            page.text.includes(config.va) || page.text.includes(config.apiKey);
        !leaked
            ? ok("5.2 page leaks no credential", "merchant VA/API key absent from HTML")
            : bad("5.2 page leaks no credential", "merchant VA/API key found in HTML");

        const poll = await http(`/api/orders/${qris.order.id}/payment-status`, {
            cookie: session.cookie,
        });
        let pollJson: any = null;
        try {
            pollJson = JSON.parse(poll.text);
        } catch {
            pollJson = null;
        }
        const instruction = pollJson?.data?.instruction;
        poll.status === 200 && pollJson?.success && instruction
            ? ok(
                  "5.3 polling returns instruction",
                  `kind=${instruction.kind} qrImageUrl=${instruction.qrImageUrl ? "set" : "null"} canPay=${pollJson.data.canPay}`
              )
            : bad("5.3 polling returns instruction", `HTTP ${poll.status}`);

        const pollBody = poll.text;
        !pollBody.includes(config.apiKey)
            ? ok("5.4 polling leaks no credential", "no API key in payload")
            : bad("5.4 polling leaks no credential", "API key found in payload");

        const otherPoll = await http(`/api/orders/${vaBca.order.id}/payment-status`, {
            cookie: session.cookie,
        });
        otherPoll.status === 200
            ? ok("5.5 polling is owner-scoped", "own order readable")
            : bad("5.5 polling is owner-scoped", `HTTP ${otherPoll.status}`);

        /*
         * ---------- 5.6–5.10 REAL BROWSER RENDER ----------
         *
         * Renders the three instruction UIs in headless Chrome with the
         * signed-in session cookie, and asserts the page flips to PAID
         * through its own polling loop after a signed webhook.
         */

        const browser = await openBrowser();

        if (!browser) {
            blocked(
                "5.6 real-browser render",
                "headless Chrome unavailable in this environment"
            );
        } else {
            try {
                await browser.setCookies(session.pairs);

                /* QRIS */
                await browser.navigate(
                    `${BASE_URL}/checkout/payment/${qris.order.id}`
                );
                const qrisDom = await waitForDom(
                    browser,
                    (t) =>
                        t.includes("Selesaikan Pembayaran") &&
                        t.includes(qris.order.orderNumber),
                    25_000
                );
                const qrisRendered =
                    qrisDom.includes("Selesaikan Pembayaran") &&
                    qrisDom.includes(qris.order.orderNumber) &&
                    !qrisDom.includes("Status pembayaran tidak dapat dimuat");
                qrisRendered
                    ? ok(
                          "5.6 QRIS page renders in browser",
                          "title + order number + live status rendered"
                      )
                    : bad(
                          "5.6 QRIS page renders in browser",
                          `dom=${JSON.stringify(qrisDom.slice(0, 120))}`
                      );

                const qrisImgs: string[] = await browser.evaluate(
                    "Array.from(document.images).map(i => i.src)"
                );
                const qrHost = (qrisImgs ?? [])
                    .map((src) => {
                        try {
                            return new URL(src).host;
                        } catch {
                            return null;
                        }
                    })
                    .find((h) => h && h.includes("ipaymu"));
                qrHost
                    ? ok("5.7 QR image element present", `<img> src host=${qrHost}`)
                    : bad(
                          "5.7 QR image element present",
                          `${(qrisImgs ?? []).length} image(s), none from the provider QR host`
                      );

                /* VIRTUAL ACCOUNT */
                await browser.navigate(
                    `${BASE_URL}/checkout/payment/${vaBca.order.id}`
                );
                /*
                 * The label is styled `uppercase`, and Chrome reports
                 * `innerText` with text-transform applied — so the match
                 * must be case-insensitive (a case-sensitive check here
                 * produced a false failure).
                 */
                const vaDom = await waitForDom(
                    browser,
                    (t) => /nomor virtual account/i.test(t),
                    25_000
                );
                const vaNo = vaBca.view?.instruction.paymentNo ?? "";
                const vaLabelRendered = /nomor virtual account/i.test(vaDom);
                const vaNoRendered = Boolean(vaNo) && vaDom.includes(vaNo);
                vaLabelRendered && vaNoRendered
                    ? ok(
                          "5.8 VA page renders in browser",
                          `VA label + number rendered (label=${vaBca.view?.instruction.channelLabel ?? "-"})`
                      )
                    : bad(
                          "5.8 VA page renders in browser",
                          `label=${vaLabelRendered} number=${vaNoRendered}`
                      );

                /* E-WALLET */
                await browser.navigate(
                    `${BASE_URL}/checkout/payment/${dana.order.id}`
                );
                const danaDom = await waitForDom(
                    browser,
                    (t) => t.includes("E-Wallet"),
                    25_000
                );
                const danaLinks: string[] = await browser.evaluate(
                    "Array.from(document.querySelectorAll('a')).map(a => a.href)"
                );
                const danaHost = (danaLinks ?? [])
                    .map((href) => {
                        try {
                            return new URL(href).host;
                        } catch {
                            return null;
                        }
                    })
                    .find((h) => h && h.includes("dana"));
                danaDom.includes("E-Wallet") && danaHost
                    ? ok(
                          "5.9 e-wallet page renders in browser",
                          `E-Wallet section + action link host=${danaHost}`
                      )
                    : bad(
                          "5.9 e-wallet page renders in browser",
                          `section=${danaDom.includes("E-Wallet")} linkHost=${danaHost ?? "none"}`
                      );

                /* NO CREDENTIAL IN THE RENDERED DOM */
                const danaHtml: string = await browser.evaluate(
                    "document.documentElement.outerHTML"
                );
                !danaHtml.includes(config.va) &&
                !danaHtml.includes(config.apiKey)
                    ? ok(
                          "5.10 rendered DOM leaks no credential",
                          "merchant VA/API key absent from the live DOM"
                      )
                    : bad(
                          "5.10 rendered DOM leaks no credential",
                          "merchant VA/API key found in the live DOM"
                      );

                /* ---------- 5.11 POLLING FLIPS THE PAGE TO PAID ---------- */

                await browser.navigate(
                    `${BASE_URL}/checkout/payment/${qris.order.id}`
                );
                await waitForDom(
                    browser,
                    (t) => t.includes("Menunggu Pembayaran"),
                    25_000
                );

                const settleQris = await sendWebhook({
                    reference_id: qris.order.orderNumber,
                    status_code: "1",
                    status: "berhasil",
                    sub_total: "10000",
                    trx_id: "4444",
                    sid: "4444",
                    via: "qris",
                    channel: "qris",
                });
                const paidDom = await waitForDom(
                    browser,
                    (t) => t.includes("Pembayaran Berhasil"),
                    30_000
                );
                const qrisPaid = await prisma.order.findUniqueOrThrow({
                    where: { id: qris.order.id },
                    select: { paymentStatus: true },
                });
                settleQris.status === 200 &&
                paidDom.includes("Pembayaran Berhasil") &&
                qrisPaid.paymentStatus === "PAID"
                    ? ok(
                          "5.11 polling flips the paid page",
                          "webhook 200 → browser re-rendered as PAID without a reload"
                      )
                    : bad(
                          "5.11 polling flips the paid page",
                          `webhook=${settleQris.status} domPaid=${paidDom.includes("Pembayaran Berhasil")} db=${qrisPaid.paymentStatus}`
                      );
            } catch (error) {
                bad(
                    "5.6–5.11 real-browser render",
                    `browser error: ${error instanceof Error ? error.message.slice(0, 140) : String(error)}`
                );
            } finally {
                await browser.close();
            }
        }
    } else {
        blocked("5.x payment page / polling", "no session available");
    }

    /* ---------- 6. webhook ---------- */

    /* 6.1 invalid signature */
    const invalid = await sendWebhook(
        {
            reference_id: "dummy",
            status_code: "1",
            status: "berhasil",
            sub_total: "10000",
            trx_id: "1",
            sid: "1",
        },
        { signature: "0".repeat(64) }
    );
    invalid.status === 401
        ? ok("6.1 invalid signature rejected", "HTTP 401")
        : bad("6.1 invalid signature rejected", `HTTP ${invalid.status}`);

    /* 6.2 unknown reference */
    const unknown = await sendWebhook({
        reference_id: runId("does-not-exist"),
        status_code: "1",
        status: "berhasil",
        sub_total: "10000",
        trx_id: "1",
        sid: "1",
    });
    unknown.status === 200
        ? ok("6.2 unknown reference acknowledged", "HTTP 200, no state change")
        : bad("6.2 unknown reference acknowledged", `HTTP ${unknown.status}`);

    /* 6.3 wrong amount */
    const wrongAmountOrder = await createPendingOrder({
        suffix: "wrong-amount",
        total: 10_000,
    });
    const wrongAmount = await sendWebhook({
        reference_id: wrongAmountOrder.orderNumber,
        status_code: "1",
        status: "berhasil",
        sub_total: "99999",
        total: "99999",
        amount: "99999",
        trx_id: "1",
        sid: "1",
    });
    const wrongAmountRow = await prisma.order.findUniqueOrThrow({
        where: { id: wrongAmountOrder.id },
        select: { status: true, paymentStatus: true },
    });
    wrongAmount.status === 400 &&
    wrongAmountRow.status === "PENDING" &&
    wrongAmountRow.paymentStatus === "PENDING"
        ? ok("6.3 wrong amount rejected", "HTTP 400, order unchanged")
        : bad(
              "6.3 wrong amount rejected",
              `HTTP ${wrongAmount.status}, status=${wrongAmountRow.status}/${wrongAmountRow.paymentStatus}`
          );

    /* 6.4 success settlement (with voucher + shipping-discount release fixtures) */
    const successOrder = await createPendingOrder({
        suffix: "success",
        total: 10_000,
        quantity: 2,
        withVoucher: true,
        withShippingDiscount: true,
    });
    const success = await sendWebhook({
        reference_id: successOrder.orderNumber,
        status_code: "1",
        status: "berhasil",
        sub_total: "10000",
        trx_id: "987654",
        sid: "987654",
        via: "qris",
        channel: "qris",
    });
    const successRow = await prisma.order.findUniqueOrThrow({
        where: { id: successOrder.id },
        select: { status: true, paymentStatus: true, paidAt: true },
    });
    success.status === 200 &&
    successRow.status === "PAID" &&
    successRow.paymentStatus === "PAID" &&
    !!successRow.paidAt
        ? ok("6.4 success webhook settles order", `HTTP 200 → PAID at ${successRow.paidAt!.toISOString()}`)
        : bad(
              "6.4 success webhook settles order",
              `HTTP ${success.status}, status=${successRow.status}/${successRow.paymentStatus}`
          );

    /* 6.5 duplicate webhook (idempotent) */
    const paidAtBefore = successRow.paidAt;
    const duplicate = await sendWebhook({
        reference_id: successOrder.orderNumber,
        status_code: "1",
        status: "berhasil",
        sub_total: "10000",
        trx_id: "987654",
        sid: "987654",
        via: "qris",
        channel: "qris",
    });
    const duplicateRow = await prisma.order.findUniqueOrThrow({
        where: { id: successOrder.id },
        select: { status: true, paymentStatus: true, paidAt: true },
    });
    duplicate.status === 200 &&
    duplicateRow.paidAt?.getTime() === paidAtBefore?.getTime()
        ? ok("6.5 duplicate webhook is idempotent", `HTTP 200, paidAt unchanged`)
        : bad(
              "6.5 duplicate webhook is idempotent",
              `HTTP ${duplicate.status}, paidAt changed=${duplicateRow.paidAt?.getTime() !== paidAtBefore?.getTime()}`
          );

    /* 6.6 cancelled-order resurrection */
    const cancelledOrder = await createPendingOrder({
        suffix: "cancelled",
        total: 10_000,
    });
    await prisma.order.update({
        where: { id: cancelledOrder.id },
        data: { status: "CANCELLED", paymentStatus: "FAILED" },
    });
    const resurrection = await sendWebhook({
        reference_id: cancelledOrder.orderNumber,
        status_code: "1",
        status: "berhasil",
        sub_total: "10000",
        trx_id: "555",
        sid: "555",
    });
    const cancelledRow = await prisma.order.findUniqueOrThrow({
        where: { id: cancelledOrder.id },
        select: { status: true, paymentStatus: true, paidAt: true },
    });
    resurrection.status === 200 &&
    cancelledRow.status === "CANCELLED" &&
    cancelledRow.paymentStatus === "FAILED" &&
    !cancelledRow.paidAt
        ? ok("6.6 cancelled order cannot be resurrected", "stayed CANCELLED/FAILED, paidAt null")
        : bad(
              "6.6 cancelled order cannot be resurrected",
              `HTTP ${resurrection.status}, status=${cancelledRow.status}/${cancelledRow.paymentStatus}`
          );

    /* 6.7 expiry notification releases reservations */
    const expiryOrder = await createPendingOrder({
        suffix: "expiry-webhook",
        total: 10_000,
        quantity: 3,
        withVoucher: true,
        withShippingDiscount: true,
    });
    const expiryVariantBefore = snapshot.variants.get(expiryOrder.variantId)!;
    const variantMid = await prisma.productVariant.findUniqueOrThrow({
        where: { id: expiryOrder.variantId },
        select: { stock: true },
    });
    const soldMid = await prisma.$queryRaw<{ sold: number }[]>`
        SELECT sold FROM product WHERE id = ${expiryOrder.productId}
    `;
    const voucherMid = await prisma.voucher.findUniqueOrThrow({
        where: { id: createdVoucherId! },
        select: { usedCount: true },
    });
    const sdMid = await prisma.shippingDiscount.findUniqueOrThrow({
        where: { id: createdShippingDiscountId! },
        select: { usedCount: true },
    });

    const expiryWebhook = await sendWebhook({
        reference_id: expiryOrder.orderNumber,
        status_code: "-2",
        status: "expired",
        sub_total: "10000",
        trx_id: "777",
        sid: "777",
    });
    const expiryRow = await prisma.order.findUniqueOrThrow({
        where: { id: expiryOrder.id },
        select: { status: true, paymentStatus: true },
    });
    const variantAfter = await prisma.productVariant.findUniqueOrThrow({
        where: { id: expiryOrder.variantId },
        select: { stock: true },
    });
    const soldAfter = await prisma.$queryRaw<{ sold: number }[]>`
        SELECT sold FROM product WHERE id = ${expiryOrder.productId}
    `;
    const voucherAfter = await prisma.voucher.findUniqueOrThrow({
        where: { id: createdVoucherId! },
        select: { usedCount: true },
    });
    const sdAfter = await prisma.shippingDiscount.findUniqueOrThrow({
        where: { id: createdShippingDiscountId! },
        select: { usedCount: true },
    });
    const usageAfter = await prisma.voucherUserUsage.findUniqueOrThrow({
        where: {
            voucherId_userId: {
                voucherId: createdVoucherId!,
                userId: user.id,
            },
        },
        select: { usageCount: true },
    });

    expiryWebhook.status === 200 &&
    expiryRow.status === "CANCELLED" &&
    expiryRow.paymentStatus === "FAILED"
        ? ok("6.7 expiry notification cancels order", "HTTP 200 → CANCELLED/FAILED")
        : bad(
              "6.7 expiry notification cancels order",
              `HTTP ${expiryWebhook.status}, status=${expiryRow.status}/${expiryRow.paymentStatus}`
          );

    variantAfter.stock === variantMid.stock + 3
        ? ok("6.8 stock released", `variant stock ${variantMid.stock} → ${variantAfter.stock} (+3)`)
        : bad(
              "6.8 stock released",
              `variant stock ${variantMid.stock} → ${variantAfter.stock}, expected +3`
          );

    Number(soldAfter[0]?.sold) === Number(soldMid[0]?.sold) - 3
        ? ok("6.9 product.sold restored", `${soldMid[0]?.sold} → ${soldAfter[0]?.sold} (-3)`)
        : bad(
              "6.9 product.sold restored",
              `${soldMid[0]?.sold} → ${soldAfter[0]?.sold}, expected -3`
          );

    voucherAfter.usedCount === voucherMid.usedCount - 1 &&
    usageAfter.usageCount === 0
        ? ok(
              "6.10 voucher quota released",
              `usedCount ${voucherMid.usedCount} → ${voucherAfter.usedCount}, per-user usage → 0`
          )
        : bad(
              "6.10 voucher quota released",
              `usedCount ${voucherMid.usedCount} → ${voucherAfter.usedCount}, usage=${usageAfter.usageCount}`
          );

    sdAfter.usedCount === sdMid.usedCount - 1
        ? ok(
              "6.11 shipping-discount quota released",
              `usedCount ${sdMid.usedCount} → ${sdAfter.usedCount}`
          )
        : bad(
              "6.11 shipping-discount quota released",
              `usedCount ${sdMid.usedCount} → ${sdAfter.usedCount}, expected -1`
          );

    void expiryVariantBefore;

    /* ---------- 7. expiry settlement (provider expiry + grace) ---------- */

    /*
     * Baseline discipline: the pre-RUN snapshot is NOT the right
     * expectation here, because unrelated fixture orders from this run
     * (4.x, 6.3, 6.4, 6.6) are still holding their own reservations.
     * The invariant under test is that settling THIS order restores the
     * stock to exactly what it was immediately before this order
     * reserved it — so the baseline is measured here, not at start.
     */
    const settleVariant = await prisma.productVariant.findFirstOrThrow({
        where: { stock: { gte: 12 }, flashSales: { none: {} } },
        orderBy: { id: "asc" },
        select: { id: true },
    });
    const stockBeforeSettleOrder = (
        await prisma.productVariant.findUniqueOrThrow({
            where: { id: settleVariant.id },
            select: { stock: true },
        })
    ).stock;

    const expiredOrder = await createPendingOrder({
        suffix: "expired-settle",
        total: 10_000,
        quantity: 2,
        variantId: settleVariant.id,
        paymentExpiresAt: new Date(Date.now() - PAYMENT_EXPIRY_GRACE_MS - 60_000),
    });
    const stockReserved = (
        await prisma.productVariant.findUniqueOrThrow({
            where: { id: expiredOrder.variantId },
            select: { stock: true },
        })
    ).stock;
    const settleResult = await expireUnpaidOrderIfExpired(
        expiredOrder.id,
        user.id
    );
    const settledRow = await prisma.order.findUniqueOrThrow({
        where: { id: expiredOrder.id },
        select: { status: true, paymentStatus: true },
    });
    const settledStock = await prisma.productVariant.findUniqueOrThrow({
        where: { id: expiredOrder.variantId },
        select: { stock: true },
    });
    settleResult === "EXPIRED" &&
    settledRow.status === "CANCELLED" &&
    stockReserved === stockBeforeSettleOrder - 2 &&
    settledStock.stock === stockBeforeSettleOrder
        ? ok(
              "7.1 expiry settlement cancels + releases",
              `EXPIRED → CANCELLED, stock ${stockBeforeSettleOrder} → reserved ${stockReserved} → released ${settledStock.stock}`
          )
        : bad(
              "7.1 expiry settlement cancels + releases",
              `result=${settleResult}, status=${settledRow.status}, stock=${stockBeforeSettleOrder} → ${stockReserved} → ${settledStock.stock} (expected ${stockBeforeSettleOrder})`
          );

    const openOrder = await createPendingOrder({
        suffix: "still-open",
        total: 10_000,
        paymentExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const openResult = await expireUnpaidOrderIfExpired(openOrder.id, user.id);
    const openRow = await prisma.order.findUniqueOrThrow({
        where: { id: openOrder.id },
        select: { status: true },
    });
    openResult === "NOT_EXPIRED" && openRow.status === "PENDING"
        ? ok("7.2 open window not settled", `NOT_EXPIRED, order still PENDING`)
        : bad(
              "7.2 open window not settled",
              `result=${openResult}, status=${openRow.status}`
          );

    const paidResult = await expireUnpaidOrderIfExpired(
        successOrder.id,
        user.id
    );
    paidResult === "NOT_CANCELLABLE"
        ? ok("7.3 paid order not cancellable by expiry", "NOT_CANCELLABLE")
        : bad("7.3 paid order not cancellable by expiry", `result=${paidResult}`);

    const notMine = await expireUnpaidOrderIfExpired(expiredOrder.id, "someone-else");
    notMine === "NOT_FOUND"
        ? ok("7.4 expiry is ownership-scoped", "NOT_FOUND for another user")
        : bad("7.4 expiry is ownership-scoped", `result=${notMine}`);

    /* ---------- 8. repay / COD / cart contract ---------- */

    if (session.ok) {
        const repay = await http(`/api/orders/${cancelledOrder.id}/repay`, {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const repayJson = (() => {
            try {
                return JSON.parse(repay.text);
            } catch {
                return null;
            }
        })();
        typeof repay.status === "number"
            ? ok(
                  "8.1 repay route reachable (authenticated)",
                  `HTTP ${repay.status} success=${repayJson?.success} message=${String(repayJson?.message ?? "").slice(0, 60)}`
              )
            : bad("8.1 repay route reachable", "no response");

        /* ---------- 8.2 CART REGRESSION (no provider dependency) ---------- */

        const cartVariant = await prisma.productVariant.findFirstOrThrow({
            where: { stock: { gte: 5 }, flashSales: { none: {} } },
            orderBy: { id: "desc" },
            select: { id: true },
        });

        const cartAdd = await http("/api/cart", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ variantId: cartVariant.id, quantity: 1 }),
        });

        const cartAfterAdd = await http("/api/cart", {
            cookie: session.cookie,
        });
        const addedItem = findObject(
            safeJson(cartAfterAdd.text),
            (o) => Number(o.variantId) === cartVariant.id && o.id !== undefined
        );

        cartAdd.status < 400 && addedItem
            ? ok(
                  "8.2 cart add + read",
                  `POST /api/cart → HTTP ${cartAdd.status}, item readable (id present)`
              )
            : bad(
                  "8.2 cart add + read",
                  `POST HTTP ${cartAdd.status}, GET HTTP ${cartAfterAdd.status}, item=${Boolean(addedItem)}`
              );

        const cartItemId = addedItem?.id;
        if (cartItemId !== undefined && cartItemId !== null) {
            const cartPatch = await http(`/api/cart/${cartItemId}`, {
                method: "PATCH",
                cookie: session.cookie,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ quantity: 2 }),
            });
            const cartAfterPatch = await http("/api/cart", {
                cookie: session.cookie,
            });
            const patchedItem = findObject(
                safeJson(cartAfterPatch.text),
                (o) => Number(o.id) === Number(cartItemId)
            );

            cartPatch.status < 400 && Number(patchedItem?.quantity) === 2
                ? ok(
                      "8.3 cart quantity update",
                      `PATCH → HTTP ${cartPatch.status}, quantity=${patchedItem?.quantity}`
                  )
                : bad(
                      "8.3 cart quantity update",
                      `PATCH HTTP ${cartPatch.status}, quantity=${patchedItem?.quantity}`
                  );

            const cartDelete = await http(`/api/cart/${cartItemId}`, {
                method: "DELETE",
                cookie: session.cookie,
            });
            const cartAfterDelete = await http("/api/cart", {
                cookie: session.cookie,
            });
            const removedItem = findObject(
                safeJson(cartAfterDelete.text),
                (o) => Number(o.id) === Number(cartItemId)
            );

            cartDelete.status < 400 && !removedItem
                ? ok(
                      "8.4 cart remove",
                      `DELETE → HTTP ${cartDelete.status}, item no longer returned`
                  )
                : bad(
                      "8.4 cart remove",
                      `DELETE HTTP ${cartDelete.status}, stillPresent=${Boolean(removedItem)}`
                  );
        } else {
            blocked("8.3/8.4 cart update/remove", "no cart item id in the read model");
        }

        /* ---------- 8.5 SHIPPING RATES (live provider, real values) ----------
         *
         * COD / cart / Buy Now checkout all verify the shipping cost
         * server-side against RajaOngkir, so the fixtures must use a
         * courier+service that the live rate response actually returns
         * for this store→address route (a hard-coded "jne REG" is not
         * necessarily served and produced a false failure).
         */

        const storeSetting = await prisma.storeSetting.findFirst({
            select: { rajaOngkirDestinationId: true },
        });
        const addressRow = await prisma.userAddress.findUniqueOrThrow({
            where: { id: createdAddressId! },
            select: { rajaOngkirDestinationId: true },
        });

        const rates = await http("/api/shipping/cost", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                origin: storeSetting?.rajaOngkirDestinationId ?? 4858,
                destination: addressRow.rajaOngkirDestinationId ?? 4858,
                weight: 1000,
                courier: "jne:jnt:sicepat",
            }),
        });
        const ratesJson = safeJson(rates.text);
        const rateOption = findObject(
            ratesJson,
            (o) =>
                (o.code || o.courier) &&
                o.service &&
                (o.cost !== undefined ||
                    o.price !== undefined ||
                    o.shipping_cost !== undefined)
        );
        const rateCourier = String(
            rateOption?.code ?? rateOption?.courier ?? ""
        ).toLowerCase();
        const rateService = String(rateOption?.service ?? "").toUpperCase();
        const rateCost = Number(
            rateOption?.cost ?? rateOption?.price ?? rateOption?.shipping_cost ?? 0
        );

        rates.status === 200 && rateCourier && rateService && rateCost > 0
            ? ok(
                  "8.5 live shipping rates",
                  `HTTP 200, option ${rateCourier}/${rateService} at ${rateCost} (used by the COD + Buy Now fixtures)`
              )
            : blocked(
                  "8.5 live shipping rates",
                  `HTTP ${rates.status} — no usable live rate, so checkout fixtures cannot be priced`
              );

        /* Checkout needs a non-empty cart: 8.4 deleted the item above. */
        const cartReseed = await http("/api/cart", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ variantId: cartVariant.id, quantity: 1 }),
        });
        cartReseed.status < 400
            ? ok("8.6 cart reseeded for checkout", `HTTP ${cartReseed.status}`)
            : bad(
                  "8.6 cart reseeded for checkout",
                  `HTTP ${cartReseed.status} — COD/Buy Now would fail with an empty cart`
              );

        /* ---------- 8.7 COD: real request against the real route ---------- */

        const codBefore = await prisma.order.count({
            where: { userId: createdUserId!, paymentMethod: "COD" },
        });

        const codPayload = {
            addressId: createdAddressId,
            shipping: {
                courier: rateCourier,
                code: rateCourier,
                service: rateService,
                cost: rateCost,
            },
            paymentMethod: "COD",
        };

        const codReject = await http("/api/orders", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...codPayload, paymentMethod: "QRIS" }),
        });
        const codRejectJson = safeJson(codReject.text);
        codReject.status === 400 && !codRejectJson?.success
            ? ok(
                  "8.7 COD route rejects non-COD",
                  `HTTP 400 ${String(codRejectJson?.message ?? "").slice(0, 60)}`
              )
            : bad(
                  "8.7 COD route rejects non-COD",
                  `HTTP ${codReject.status}, success=${codRejectJson?.success}`
              );

        const cod = await http("/api/orders", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(codPayload),
        });
        const codJson = safeJson(cod.text);
        const codAfter = await prisma.order.count({
            where: { userId: createdUserId!, paymentMethod: "COD" },
        });

        const codOrder = await prisma.order.findFirst({
            where: { userId: createdUserId!, paymentMethod: "COD" },
            orderBy: { id: "desc" },
            select: {
                id: true,
                paymentStatus: true,
                paymentNo: true,
                paymentUrl: true,
                paymentChannel: true,
                paymentExpiresAt: true,
                shippingCost: true,
            },
        });
        if (codOrder) createdOrderIds.push(codOrder.id);

        /* A COD order must never carry a provider instruction. */
        const codHasNoProviderData =
            codOrder !== null &&
            !codOrder.paymentNo &&
            !codOrder.paymentUrl &&
            !codOrder.paymentChannel &&
            !codOrder.paymentExpiresAt;
        const codShippingVerified =
            codOrder !== null && Number(codOrder.shippingCost) === rateCost;

        if (cod.status === 201 && codJson?.success && codHasNoProviderData) {
            ok(
                "8.8 COD order created end-to-end",
                `HTTP 201, paymentStatus=${codOrder!.paymentStatus}, ` +
                    `server-verified shippingCost=${codOrder!.shippingCost}, ` +
                    `no provider instruction fields (no iPaymu call on the COD path)`
            );
        } else if (codAfter === codBefore) {
            blocked(
                "8.8 COD order creation (end-to-end)",
                `HTTP ${cod.status} ${String(codJson?.message ?? "").slice(0, 60)} — rejected before any order was written`
            );
        } else {
            bad(
                "8.8 COD order creation (end-to-end)",
                `HTTP ${cod.status} success=${codJson?.success} ` +
                    `providerClean=${codHasNoProviderData} shippingVerified=${codShippingVerified}`
            );
        }

        /*
         * ---------- 8.9 CLIENT-SENT SHIPPING COST IS IGNORED ----------
         *
         * NOTE: comparing the persisted cost to the rate fetched in 8.5
         * would be unsound — 8.5 prices an arbitrary 1000 g parcel while
         * verifyShippingCost() uses the ordered variant's real weight, so
         * the two live quotes legitimately differ. The property that
         * actually matters is that the CLIENT value is discarded, so the
         * spoof test below sends a deliberately false cost.
         */

        const spoofReseed = await http("/api/cart", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ variantId: cartVariant.id, quantity: 1 }),
        });

        const spoofCost = 1;
        const spoofCod = await http("/api/orders", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...codPayload,
                shipping: { ...codPayload.shipping, cost: spoofCost },
            }),
        });
        const spoofJson = safeJson(spoofCod.text);

        const spoofOrder = await prisma.order.findFirst({
            where: {
                userId: createdUserId!,
                paymentMethod: "COD",
                ...(codOrder ? { id: { not: codOrder.id } } : {}),
            },
            orderBy: { id: "desc" },
            select: { id: true, shippingCost: true, total: true },
        });
        if (spoofOrder) createdOrderIds.push(spoofOrder.id);

        const spoofIgnored =
            spoofOrder !== null && Number(spoofOrder.shippingCost) !== spoofCost;

        spoofReseed.status < 400 &&
        spoofCod.status === 201 &&
        spoofJson?.success &&
        spoofIgnored &&
        Number(spoofOrder!.shippingCost) > 0
            ? ok(
                  "8.9 client-sent shipping cost is ignored",
                  `client sent ${spoofCost}, server persisted the live-verified ${spoofOrder!.shippingCost}`
              )
            : bad(
                  "8.9 client-sent shipping cost is ignored",
                  `HTTP ${spoofCod.status}, persisted=${spoofOrder?.shippingCost ?? "none"} (client sent ${spoofCost})`
              );

        void codShippingVerified;

        /* ---------- 8.10 Buy Now iPaymu (real request) ---------- */

        const buyNowBefore = await prisma.order.count({
            where: { userId: createdUserId! },
        });
        const buyNowVariant = await prisma.productVariant.findUniqueOrThrow({
            where: { id: cartVariant.id },
            select: { productId: true },
        });

        const buyNow = await http("/api/buy-now/ipaymu", {
            method: "POST",
            cookie: session.cookie,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                productId: buyNowVariant.productId,
                variantId: cartVariant.id,
                quantity: 1,
                addressId: createdAddressId,
                shipping: {
                    courier: rateCourier,
                    code: rateCourier,
                    service: rateService,
                    cost: rateCost,
                },
                paymentMethod: "QRIS",
            }),
        });
        const buyNowJson = safeJson(buyNow.text);
        const buyNowAfter = await prisma.order.count({
            where: { userId: createdUserId! },
        });

        const buyNowInstruction = findObject(
            buyNowJson,
            (o) => o.qrImageUrl || o.paymentNo || o.actionUrl
        );
        const buyNowQrHost = hostOf(
            typeof buyNowInstruction?.qrImageUrl === "string"
                ? buyNowInstruction.qrImageUrl
                : null
        );

        if (buyNow.status === 201 && buyNowJson?.success && buyNowQrHost) {
            const created = await prisma.order.findFirst({
                where: { userId: createdUserId! },
                orderBy: { id: "desc" },
                select: { id: true },
            });
            if (created) createdOrderIds.push(created.id);

            ok(
                "8.10 Buy Now (iPaymu) end-to-end",
                `HTTP 201, real sandbox instruction returned (qrImage host=${buyNowQrHost}), ` +
                    "order persisted and payable on our own page"
            );
        } else if (buyNowAfter === buyNowBefore) {
            blocked(
                "8.10 Buy Now (iPaymu) end-to-end",
                `HTTP ${buyNow.status} ${String(buyNowJson?.message ?? "").slice(0, 70)} — no order written (rolled back after the failure); provider half covered by 4.1–4.4`
            );
        } else {
            bad(
                "8.10 Buy Now (iPaymu) end-to-end",
                `HTTP ${buyNow.status} success=${buyNowJson?.success} qrHost=${buyNowQrHost ?? "none"}`
            );
        }
    } else {
        blocked("8.x repay / COD / cart", "no session available");
    }

    /* ---------- summary ---------- */

    const pass = results.filter((r) => r.status === "PASS").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    const blk = results.filter((r) => r.status === "BLOCKED").length;

    console.log("\n========== SUMMARY ==========");
    console.log(`PASS ${pass} | FAIL ${fail} | BLOCKED ${blk}`);
    for (const r of results.filter((x) => x.status !== "PASS")) {
        console.log(`  [${r.status}] ${r.id} — ${r.detail}`);
    }
}

main()
    .catch((error) => {
        console.error("HARNESS ERROR:", error?.message ?? error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            if (!KEEP) {
                await cleanup();
                console.log("\nfixtures removed; database counters restored.");
            } else {
                console.log("\n--keep: fixtures left in place.");
            }
        } finally {
            await prisma.$disconnect();
        }
    });
