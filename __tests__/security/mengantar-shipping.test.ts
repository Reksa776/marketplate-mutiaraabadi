/**
 * ==========================================
 * MENGANTAR SHIPPING INTEGRATION TESTS
 * ==========================================
 *
 * Run: npx jest __tests__/security/mengantar-shipping.test.ts
 *
 * Covers:
 * - Courier mapping (internal ↔ Mengantar casing)
 * - Webhook HMAC-SHA256 verification against the OFFICIAL test vector
 * - API-key redaction
 * - Server-only key handling (never NEXT_PUBLIC_*, never in responses)
 * - Proxy protection: estimate protected, webhook public
 * - Server-authoritative price: client cost is never trusted
 * - RajaOngkir retained for address + as the legacy fallback
 * - Payment/shipping-payment separation
 * - Additive-only DB migration
 */

import { readFileSync } from "fs";

function readFile(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

/*
 * ==========================================================
 * PURE FUNCTIONS (dynamic import so env is set first)
 * ==========================================================
 */

let mengantar: typeof import("@/lib/mengantar");

beforeAll(async () => {
    process.env.MENGANTAR_WEBHOOK_SECRET = "testsecret";
    jest.resetModules();
    mengantar = await import("@/lib/mengantar");
});

describe("Mengantar courier mapping", () => {
    it("maps internal codes to exact Mengantar courier casing", () => {
        expect(mengantar.toMengantarCourier("jne")).toBe("JNE");
        expect(mengantar.toMengantarCourier("JNT")).toBe("JT");
        expect(mengantar.toMengantarCourier("sicepat")).toBe(
            "SiCepat"
        );
        expect(mengantar.toMengantarCourier("idexpress")).toBe(
            "iDexpress"
        );
        expect(mengantar.toMengantarCourier("anteraja")).toBe(
            "anteraja"
        );
        expect(mengantar.toMengantarCourier("pos")).toBe("pos");
    });

    it("rejects unsupported/discontinued couriers (Ninja)", () => {
        expect(mengantar.toMengantarCourier("ninja")).toBeNull();
        expect(mengantar.toMengantarCourier("")).toBeNull();
        expect(mengantar.toMengantarCourier(null)).toBeNull();
        expect(
            mengantar.toMengantarCourier("unknown-courier")
        ).toBeNull();
    });

    it("maps Mengantar names back to internal codes", () => {
        expect(mengantar.toInternalCourier("JT")).toBe("jnt");
        expect(mengantar.toInternalCourier("JNE")).toBe("jne");
        expect(mengantar.toInternalCourier("SiCepat")).toBe(
            "sicepat"
        );
    });
});

describe("Mengantar webhook signature (official test vector)", () => {
    // https://api-public.mengantar.com/docs — Webhook section
    const rawBody =
        '{"cnote_no":"JNE1234567890","order_id":"ORD-000123","courier":"JNE","status_category":"DELIVERED"}';
    const timestamp = "1787548800000";
    const expectedSignature =
        "05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111";

    it("accepts the official test vector", () => {
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody,
                timestamp,
                signature: expectedSignature,
            })
        ).toBe(true);
    });

    it("rejects a tampered body", () => {
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody: rawBody.replace(
                    "DELIVERED",
                    "UNDELIVERED"
                ),
                timestamp,
                signature: expectedSignature,
            })
        ).toBe(false);
    });

    it("rejects a forged signature", () => {
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody,
                timestamp,
                signature: "deadbeef",
            })
        ).toBe(false);
    });

    it("fails closed on missing timestamp/signature/body", () => {
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody,
                timestamp: "",
                signature: expectedSignature,
            })
        ).toBe(false);
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody,
                timestamp,
                signature: "",
            })
        ).toBe(false);
        expect(
            mengantar.verifyMengantarWebhookSignature({
                rawBody: "",
                timestamp,
                signature: expectedSignature,
            })
        ).toBe(false);
    });
});

describe("Mengantar API key handling", () => {
    it("redacts the configured key from arbitrary text", () => {
        const original = process.env.MENGANTAR_API_KEY;
        process.env.MENGANTAR_API_KEY = "SUPERSECRETKEY";

        jest.resetModules();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fresh =
            require("@/lib/mengantar") as typeof import("@/lib/mengantar");

        expect(
            fresh.redactMengantarKey(
                "https://api-public.mengantar.com/api/public/SUPERSECRETKEY/order"
            )
        ).not.toContain("SUPERSECRETKEY");
        expect(
            fresh.redactMengantarKey(
                "https://api-public.mengantar.com/api/public/SUPERSECRETKEY/order"
            )
        ).toContain("[REDACTED]");

        process.env.MENGANTAR_API_KEY = original;
        jest.resetModules();
    });
});

/*
 * ==========================================================
 * SOURCE / WIRING ASSERTIONS
 * ==========================================================
 */

const proxy = readFile("proxy.ts");
const envExample = readFile(".env.example");
const schema = readFile("prisma/schema.prisma");
const migration = readFile(
    "prisma/migrations/20261001000000_add_mengantar_shipping/migration.sql"
);
const checkout = readFile("lib/checkout.ts");
const mengantarClient = readFile("lib/mengantar.ts");
const mengantarShipping = readFile(
    "lib/mengantar/shipping.ts"
);
const estimateRoute = readFile(
    "app/api/mengantar/estimate/route.ts"
);
const webhookRoute = readFile(
    "app/api/mengantar/webhook/route.ts"
);
const checkoutPage = readFile("app/checkout/CheckoutPage.tsx");
const buyNowPage = readFile("app/buy-now/BuyNowPage.tsx");
const addressUpdate = readFile(
    "app/api/addresses/[id]/route.ts"
);

describe("Proxy route protection", () => {
    it("protects the Mengantar estimate API", () => {
        const protectedBlock = proxy.slice(
            proxy.indexOf("PROTECTED_API_PREFIXES"),
            proxy.indexOf("PAGE-LEVEL PROTECTED")
        );
        expect(protectedBlock).toContain('"/api/mengantar/"');
    });

    it("keeps the Mengantar webhook public (signed, not session-auth)", () => {
        const publicBlock = proxy.slice(
            proxy.indexOf("PUBLIC_API_PREFIXES"),
            proxy.indexOf("PROTECTED_API_PREFIXES")
        );
        expect(publicBlock).toContain(
            '"/api/mengantar/webhook"'
        );
    });
});

describe("Server-authoritative shipping price", () => {
    it("estimate route requires auth and never trusts a client origin", () => {
        expect(estimateRoute).toContain("await auth()");
        expect(estimateRoute).toContain("userId: session.user.id");
        // The client sends addressId only — no origin/destination.
        expect(estimateRoute).not.toContain("origin_id");
        expect(estimateRoute).not.toContain("destination_id");
    });

    it("order creation re-verifies via Mengantar, not the client cost", () => {
        expect(checkout).toContain(
            "verifyMengantarShippingCostOrThrow"
        );
        expect(checkout).toContain(
            "verifyMengantarShippingCost("
        );
        // Provider is selected from the option, price is not.
        expect(checkout).toContain(
            'input.shipping.provider ?? ""'
        );
    });

    it("estimate sends the exact COD_AMOUNT casing", () => {
        expect(mengantarClient).toContain('params.set("COD_AMOUNT"');
    });
});

describe("RajaOngkir retained (address + legacy fallback)", () => {
    it("still verifies via RajaOngkir when the option is not Mengantar", () => {
        expect(checkout).toContain(
            "verifyRajaOngkirShippingCostOrThrow"
        );
        expect(checkout).toContain(
            "storeSetting.rajaOngkirDestinationId"
        );
        expect(checkout).toContain(
            "address.rajaOngkirDestinationId"
        );
    });

    it("keeps the legacy RajaOngkir cost endpoints intact", () => {
        expect(
            readFile("app/api/shipping/cost/route.ts")
        ).toContain("calculateDomesticCost(");
        expect(
            readFile("app/api/buy-now/shipping/route.ts")
        ).toContain("calculateDomesticCost(");
    });

    it("clients prefer Mengantar and fall back on 503", () => {
        expect(checkoutPage).toContain(
            '"/api/mengantar/estimate"'
        );
        expect(checkoutPage).toContain(
            '"/api/shipping/cost"'
        );
        expect(buyNowPage).toContain(
            '"/api/mengantar/estimate"'
        );
        expect(buyNowPage).toContain(
            '"/api/buy-now/shipping"'
        );
    });

    it("never sends rajaOngkirDestinationId as a Mengantar id", () => {
        // No code path may READ/forward the RajaOngkir id (comments may
        // mention it). Assembly of Mengantar ids happens only through
        // the area resolver / address search.
        expect(mengantarShipping).not.toContain(
            ".rajaOngkirDestinationId"
        );
        expect(estimateRoute).not.toContain(
            ".rajaOngkirDestinationId"
        );
    });
});

describe("Payment vs shipping-payment separation", () => {
    it("webhook never mutates the marketplace paymentStatus", () => {
        // Never WRITES paymentStatus (a comment may mention the field).
        expect(webhookRoute).not.toContain("paymentStatus:");
    });

    it("records shippingPaymentStatus separately from paymentStatus", () => {
        expect(checkout).toContain("shippingPaymentStatus");
        expect(checkout).toContain("shipmentStatus");
    });

    it("order creation no longer couples PAID to a paid shipment", () => {
        // Mengantar orders start with shipping payment UNPAID (non-COD)
        // or NOT_APPLICABLE (COD) — never PAID.
        expect(checkout).toContain('"NOT_APPLICABLE"');
        expect(checkout).toContain('"UNPAID"');
    });
});

describe("Webhook safety", () => {
    it("is idempotent and only maps shipment status", () => {
        expect(webhookRoute).toContain(
            "verifyMengantarWebhookSignature"
        );
        // Increment 3: the mapping moved to the shared pure module
        // and the duplicate/out-of-order check is CAS-based.
        expect(webhookRoute).toContain(
            "decideMengantarShipmentTransition"
        );
        expect(webhookRoute).toContain("updated.count === 0");
    });

    it("does not auto-refund on RTS/COD refusal", () => {
        expect(webhookRoute).not.toContain(
            "executeRefundCompletion"
        );
        expect(webhookRoute).not.toContain(
            "createRefundRequest"
        );
    });
});

describe("Secrets stay server-side", () => {
    it("does not expose Mengantar credentials via NEXT_PUBLIC_*", () => {
        expect(envExample).not.toContain(
            "NEXT_PUBLIC_MENGANTAR"
        );
        expect(estimateRoute).not.toContain("NEXT_PUBLIC");
        expect(estimateRoute).not.toContain("MENGANTAR_API_KEY =");
    });

    it("documents the Mengantar env vars in .env.example", () => {
        expect(envExample).toContain("MENGANTAR_API_KEY");
        expect(envExample).toContain(
            "MENGANTAR_WEBHOOK_SECRET"
        );
    });

    it("does not store a Mengantar secret on the Order model", () => {
        const orderModel = schema.slice(
            schema.indexOf("model Order {"),
            schema.indexOf("model OrderItem {")
        );
        expect(orderModel).not.toContain("apiKey");
        expect(orderModel).not.toContain("webhookSecret");
    });
});

describe("Database changes are additive and nullable", () => {
    it("adds the Mengantar fields as nullable columns", () => {
        for (const field of [
            "shippingProvider",
            "providerShipmentId",
            "providerBatchId",
            "shippingPaymentStatus",
            "shipmentStatus",
            "codAmount",
            "mengantarDestinationAreaId",
            "mengantarOriginAreaId",
            "mengantarPickupAddressId",
            "mengantarPickupTimeId",
        ]) {
            expect(migration).toContain(field);
        }
        // Nullable only — no NOT NULL / no default rewrite of existing rows.
        expect(migration).not.toContain("NOT NULL");
    });

    it("invalidates the cached Mengantar area when an address changes", () => {
        expect(addressUpdate).toContain(
            "mengantarDestinationAreaId = null"
        );
    });
});

describe("Shipment lifecycle (create + pay unpaid)", () => {
    const shipmentLib = readFile("lib/mengantar/shipment.ts");
    const createRoute = readFile(
        "app/api/admin/orders/[id]/shipment/route.ts"
    );
    const payRoute = readFile(
        "app/api/admin/orders/[id]/shipment/pay/route.ts"
    );

    it("is idempotent — a duplicate create is a no-op", () => {
        expect(shipmentLib).toContain("order.providerShipmentId");
        expect(shipmentLib).toContain(
            "Shipment sudah dibuat."
        );
    });

    it("marks an unpaid (balance-insufficient) shipment instead of shipping it", () => {
        expect(shipmentLib).toContain(
            "WAITING_SHIPPING_PAYMENT"
        );
        // Never invents tracking: cnote_no is null when unpaid.
        expect(shipmentLib).toContain(
            "created.cnote_no ?? null"
        );
    });

    it("resolves COD eligibility per courier/destination, not by name", () => {
        // COD-capable couriers come from the provider estimate via the
        // shared options builder; a courier that does not support COD
        // is resolved to an alternative BEFORE any provider POST.
        expect(shipmentLib).toContain(
            "buildMengantarShippingOptions"
        );
        expect(shipmentLib).toContain("supportsCod");
        expect(shipmentLib).toContain(
            "Kurir tidak melayani tujuan ini untuk COD."
        );
    });

    it("never writes the marketplace paymentStatus", () => {
        // Reads via `paymentStatus: true` in a select are fine; a WRITE
        // would assign a value (`paymentStatus: "..."`).
        expect(shipmentLib).not.toContain('paymentStatus: "');
        expect(createRoute).not.toContain('paymentStatus: "');
        expect(payRoute).not.toContain('paymentStatus: "');
    });

    it("pay-unpaid only flips the shipping payment state", () => {
        expect(shipmentLib).toContain("payMengantarUnpaid");
        expect(shipmentLib).toContain(
            'shippingPaymentStatus: "PAID"'
        );
    });

    it("admin shipment endpoints require ADMIN", () => {
        for (const route of [createRoute, payRoute]) {
            expect(route).toContain('session.user.role !== "ADMIN"');
        }
    });
});
