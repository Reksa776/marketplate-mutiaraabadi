/**
 * ==========================================
 * IPAYMU MIN-AMOUNT RULE — TESTS
 * ==========================================
 *
 * iPaymu rejects any payment below Rp10.000 (HTTP 400:
 * "amount harus minimal 10000"). Only QRIS may be used below the
 * threshold. This suite covers:
 *
 *   1. centralized rule: isIpaymuAmountAllowed boundary (9.999/10.000)
 *   2. every non-QRIS method is blocked below the minimum
 *   3. QRIS below the minimum is allowed
 *   4. the IpaymuMinAmountError payload (code / status / suggestion)
 *   5. provider message normalization ("amount harus minimal 10000",
 *      case/punctuation insensitive)
 *   6. backend enforcement: createDirectOrderPayment throws the app
 *      error WITHOUT calling iPaymu for blocked methods, and QRIS
 *      below the minimum DOES reach the provider
 *   7. provider HTTP 400 / business Status with the Indonesian text
 *      is normalized back to the same app error (safety net)
 *   8. UI: checkout + buy-now disable non-QRIS methods below the
 *      minimum and keep QRIS selectable
 *
 * The provider API is ALWAYS mocked — no test can reach iPaymu.
 */

jest.mock("@/lib/prisma", () => {
    const order = {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
    };

    return {
        prisma: {
            order,
        },
    };
});

jest.mock("@/lib/checkout", () => ({
    rollbackCheckoutOrder: jest.fn(async () => undefined),
    createCheckoutOrder: jest.fn(),
}));

import { readFileSync } from "fs";
import { resolve } from "path";

import {
    createDirectPayment,
} from "@/lib/payment/ipaymu";
import * as ipaymuModule from "@/lib/payment/ipaymu";
import { createDirectOrderPayment } from "@/lib/payment/order-payment";
import {
    detectIpaymuMinAmountMessage,
    IpaymuMinAmountError,
    IPAYMU_MIN_AMOUNT,
    IPAYMU_MIN_AMOUNT_CODE,
    IPAYMU_MIN_AMOUNT_FULL_MESSAGE,
    IPAYMU_MIN_AMOUNT_MESSAGE,
    IPAYMU_MIN_AMOUNT_SUGGESTION,
    IPAYMU_MIN_AMOUNT_UI_NOTE,
    isIpaymuAmountAllowed,
    isIpaymuMinAmountError,
} from "@/lib/payment/ipaymu-min-amount";
import { resetIpaymuConfigCache } from "@/lib/payment/config";
import { prisma } from "@/lib/prisma";

/* ==========================================
 * PROVIDER MOCK
 * ========================================== */

const SANDBOX_VA = "1179000899";
const SANDBOX_API_KEY = "sandbox-api-key-1234567890";

const fetchMock = jest.fn();

function providerResponse(data: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            Status: 200,
            Success: true,
            Message: "Success",
            Data: data,
        }),
    };
}

beforeAll(() => {
    process.env.PAYMENT_ENVIRONMENT = "sandbox";
    process.env.IPAYMU_SANDBOX_VA = SANDBOX_VA;
    process.env.IPAYMU_SANDBOX_API_KEY = SANDBOX_API_KEY;
    process.env.IPAYMU_SANDBOX_BASE_URL = "https://sandbox.ipaymu.com";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
    jest.clearAllMocks();
    resetIpaymuConfigCache();
    (prisma.order.update as unknown as jest.Mock).mockResolvedValue(undefined);
});

/* ==========================================
 * 1. CENTRALIZED RULE (boundary + methods)
 * ========================================== */

describe("IPAYMU min-amount rule", () => {
    test("constant is 10000", () => {
        expect(IPAYMU_MIN_AMOUNT).toBe(10000);
    });

    test("amount 9999 allows only QRIS, blocks every other method", () => {
        expect(isIpaymuAmountAllowed(9999, "QRIS")).toBe(true);
        expect(isIpaymuAmountAllowed(9999, "BANK_TRANSFER")).toBe(false);
        expect(isIpaymuAmountAllowed(9999, "E_WALLET")).toBe(false);
        expect(isIpaymuAmountAllowed(9999, "CREDIT_CARD")).toBe(false);
    });

    test("amount 10000 keeps existing behavior for every method", () => {
        expect(isIpaymuAmountAllowed(10000, "QRIS")).toBe(true);
        expect(isIpaymuAmountAllowed(10000, "BANK_TRANSFER")).toBe(true);
        expect(isIpaymuAmountAllowed(10000, "E_WALLET")).toBe(true);
        expect(isIpaymuAmountAllowed(10000, "CREDIT_CARD")).toBe(true);
    });

    test("amount above the minimum is allowed for every method", () => {
        expect(isIpaymuAmountAllowed(15000, "BANK_TRANSFER")).toBe(true);
        expect(isIpaymuAmountAllowed(15000, "QRIS")).toBe(true);
    });

    test("IpaymuMinAmountError carries structured fields", () => {
        const error = new IpaymuMinAmountError(9999, "BANK_TRANSFER");

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe(IPAYMU_MIN_AMOUNT_CODE);
        expect(error.status).toBe(400);
        expect(error.message).toBe(IPAYMU_MIN_AMOUNT_FULL_MESSAGE);
        expect(error.suggestion).toBe(IPAYMU_MIN_AMOUNT_SUGGESTION);
        expect(error.amount).toBe(9999);
        expect(error.method).toBe("BANK_TRANSFER");

        expect(isIpaymuMinAmountError(error)).toBe(true);
        expect(isIpaymuMinAmountError(new Error("x"))).toBe(false);
        expect(isIpaymuMinAmountError(null)).toBe(false);
    });

    test("user-facing message and suggestion are the friendly copy", () => {
        expect(IPAYMU_MIN_AMOUNT_UI_NOTE).toBe("Minimal transaksi Rp10.000");
        expect(IPAYMU_MIN_AMOUNT_MESSAGE).toContain("Rp10.000");
        expect(IPAYMU_MIN_AMOUNT_SUGGESTION).toContain("QRIS");
        expect(IPAYMU_MIN_AMOUNT_FULL_MESSAGE).toContain(
            IPAYMU_MIN_AMOUNT_MESSAGE
        );
        expect(IPAYMU_MIN_AMOUNT_FULL_MESSAGE).toContain(
            IPAYMU_MIN_AMOUNT_SUGGESTION
        );
    });
});

/* ==========================================
 * 2. PROVIDER MESSAGE NORMALIZATION
 * ========================================== */

describe("provider min-amount message normalization", () => {
    test("matches the Indonesian message case-insensitively", () => {
        const result = detectIpaymuMinAmountMessage(
            "amount harus minimal 10000"
        );
        expect(result).toEqual({
            code: "IPAYMU_MIN_AMOUNT",
            message: IPAYMU_MIN_AMOUNT_MESSAGE,
            detail: IPAYMU_MIN_AMOUNT_SUGGESTION,
        });
    });

    test("matches uppercase and punctuation variants", () => {
        expect(
            detectIpaymuMinAmountMessage("AMOUNT HARUS MINIMAL 10000")
        ).not.toBeNull();
        expect(
            detectIpaymuMinAmountMessage("amount harus minimal 10.000")
        ).not.toBeNull();
        expect(
            detectIpaymuMinAmountMessage("amount harus minimal 10000.")
        ).not.toBeNull();
    });

    test("ignores unrelated messages, empty and non-string input", () => {
        expect(detectIpaymuMinAmountMessage("Sukses")).toBeNull();
        expect(detectIpaymuMinAmountMessage("Sistem sedang sibuk")).toBeNull();
        expect(detectIpaymuMinAmountMessage("")).toBeNull();
        expect(detectIpaymuMinAmountMessage(undefined)).toBeNull();
        expect(detectIpaymuMinAmountMessage(null)).toBeNull();
        expect(detectIpaymuMinAmountMessage(12345)).toBeNull();
    });
});

/* ==========================================
 * 3. BACKEND ENFORCEMENT (createDirectOrderPayment)
 * ========================================== */

describe("createDirectOrderPayment min-amount enforcement", () => {
    test("blocks BANK_TRANSFER below 10000 and never calls iPaymu", async () => {
        const providerCall = jest.spyOn(
            ipaymuModule,
            "createDirectPayment"
        );

        await expect(
            createDirectOrderPayment({
                orderId: 1,
                orderNumber: "PAY-BT-1",
                buyerName: "Budi",
                buyerPhone: "08123456789",
                buyerEmail: "buyer@example.com",
                amount: 9999,
                paymentMethod: "BANK_TRANSFER",
                paymentChannel: "bca",
                notifyUrl:
                    "https://shop.example.com/api/payment/ipaymu/notification",
            })
        ).rejects.toBeInstanceOf(IpaymuMinAmountError);

        expect(providerCall).not.toHaveBeenCalled();
        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    test("blocks E_WALLET below 10000 and never calls iPaymu", async () => {
        const providerCall = jest.spyOn(
            ipaymuModule,
            "createDirectPayment"
        );

        await expect(
            createDirectOrderPayment({
                orderId: 2,
                orderNumber: "PAY-EW-1",
                buyerName: "Budi",
                buyerPhone: "08123456789",
                buyerEmail: "buyer@example.com",
                amount: 9999,
                paymentMethod: "E_WALLET",
                paymentChannel: "dana",
                notifyUrl:
                    "https://shop.example.com/api/payment/ipaymu/notification",
            })
        ).rejects.toBeInstanceOf(IpaymuMinAmountError);

        expect(providerCall).not.toHaveBeenCalled();
    });

    test("allows QRIS below 10000 and DOES call iPaymu", async () => {
        const providerCall = jest.spyOn(
            ipaymuModule,
            "createDirectPayment"
        );

        fetchMock.mockResolvedValue(
            providerResponse({
                SessionId: "ses_qris_min",
                TransactionId: 555,
                ReferenceId: "PAY-QR-1",
                Via: "qris",
                Channel: "qris",
                PaymentNo: "QR-CODE-PAYLOAD",
                PaymentName: "QRIS",
                Total: 9999,
                Fee: 0,
                Expired: "2026-09-18 12:34:56",
                Url: "https://my.ipaymu.com/qr/555.png",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 3,
            orderNumber: "PAY-QR-1",
            buyerName: "Budi",
            buyerPhone: "08123456789",
            buyerEmail: "buyer@example.com",
            amount: 9999,
            paymentMethod: "QRIS",
            notifyUrl:
                "https://shop.example.com/api/payment/ipaymu/notification",
        });

        expect(providerCall).toHaveBeenCalled();
        expect(result.paymentPageUrl).toBe("/checkout/payment/3");
        expect(result.instruction.qrString).toBe("QR-CODE-PAYLOAD");
    });

    test("keeps existing behavior at 10000 for non-QRIS methods", async () => {
        const providerCall = jest.spyOn(
            ipaymuModule,
            "createDirectPayment"
        );

        fetchMock.mockResolvedValue(
            providerResponse({
                SessionId: "ses_va_ok",
                TransactionId: 556,
                ReferenceId: "PAY-BT-OK",
                Via: "va",
                Channel: "bca",
                PaymentNo: "1179000899",
                PaymentName: "BCA VA",
                Total: 10000,
                Fee: 0,
                Expired: "2026-09-18 12:34:56",
                Url: "",
            })
        );

        const result = await createDirectOrderPayment({
            orderId: 4,
            orderNumber: "PAY-BT-OK",
            buyerName: "Budi",
            buyerPhone: "08123456789",
            buyerEmail: "buyer@example.com",
            amount: 10000,
            paymentMethod: "BANK_TRANSFER",
            paymentChannel: "bca",
            notifyUrl:
                "https://shop.example.com/api/payment/ipaymu/notification",
        });

        expect(providerCall).toHaveBeenCalled();
        expect(result.paymentPageUrl).toBe("/checkout/payment/4");
    });
});

/* ==========================================
 * 4. PROVIDER-LEVEL SAFETY NET
 * ========================================== */

describe("provider min-amount safety net (createDirectPayment)", () => {
    test("HTTP 400 with the Indonesian message is normalized", async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({
                Status: 400,
                Success: false,
                Message: "amount harus minimal 10000",
            }),
        });

        await expect(
            createDirectPayment({
                name: "Budi",
                phone: "08123456789",
                email: "buyer@example.com",
                amount: 9999,
                referenceId: "PAY-HTTP-400",
                notifyUrl:
                    "https://shop.example.com/api/payment/ipaymu/notification",
                paymentMethod: "va",
                paymentChannel: "bca",
            })
        ).rejects.toBeInstanceOf(IpaymuMinAmountError);
    });

    test("business-level Status 400 with the message is normalized", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                Status: 400,
                Success: false,
                Message: "amount harus minimal 10000",
                Data: null,
            }),
        });

        await expect(
            createDirectPayment({
                name: "Budi",
                phone: "08123456789",
                email: "buyer@example.com",
                amount: 9999,
                referenceId: "PAY-BIZ-400",
                notifyUrl:
                    "https://shop.example.com/api/payment/ipaymu/notification",
                paymentMethod: "qris",
                paymentChannel: "qris",
            })
        ).rejects.toBeInstanceOf(IpaymuMinAmountError);
    });

    test("unrelated provider HTTP errors keep their own taxonomy", async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({
                Status: 400,
                Success: false,
                Message: "koneksi terputus",
            }),
        });

        await expect(
            createDirectPayment({
                name: "Budi",
                phone: "08123456789",
                email: "buyer@example.com",
                amount: 9999,
                referenceId: "PAY-HTTP-OTHER",
                notifyUrl:
                    "https://shop.example.com/api/payment/ipaymu/notification",
                paymentMethod: "va",
                paymentChannel: "bca",
            })
        ).rejects.toThrow(/IPAYMU_HTTP_ERROR/);
    });
});

/* ==========================================
 * 5. UI (checkout + buy-now)
 * ========================================== */

function readFile(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

describe("UI min-amount handling", () => {
    test("CheckoutPage disables Bank Transfer and E-Wallet below the minimum", () => {
        const code = readFile("app/checkout/CheckoutPage.tsx");

        expect(code).toContain("const iPaymuMinBlocked = grandTotal < IPAYMU_MIN_AMOUNT;");
        expect(code).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
        expect(code).toContain("IPAYMU_MIN_AMOUNT_FULL_MESSAGE");
        expect(code).toContain("isIpaymuAmountAllowed(grandTotal, paymentMethod)");

        // Exactly the two iPaymu non-QRIS radios are disabled.
        const disabledMatches = code.match(/disabled=\{iPaymuMinBlocked\}/g);
        expect(disabledMatches).toHaveLength(2);

        // Both disabled radios are Bank Transfer + E-Wallet.
        const bankCard = code.slice(
            code.indexOf("{/* BANK TRANSFER */}"),
            code.indexOf("{/* E-WALLET */}")
        );
        const walletCard = code.slice(
            code.indexOf("{/* E-WALLET */}"),
            code.indexOf("{/* QRIS */}")
        );
        expect(bankCard).toContain("disabled={iPaymuMinBlocked}");
        expect(bankCard).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
        expect(walletCard).toContain("disabled={iPaymuMinBlocked}");
        expect(walletCard).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");

        // QRIS stays fully selectable below the minimum.
        const qrisCard = code.slice(
            code.indexOf("{/* QRIS */}"),
            code.indexOf("Ringkasan Pesanan")
        );
        expect(qrisCard).not.toContain("disabled={iPaymuMinBlocked}");
        expect(qrisCard).not.toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
    });

    test("BuyNowPage disables Bank Transfer and E-Wallet below the minimum", () => {
        const code = readFile("app/buy-now/BuyNowPage.tsx");

        expect(code).toContain("const iPaymuMinBlocked = grandTotal < IPAYMU_MIN_AMOUNT;");
        expect(code).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
        expect(code).toContain("IPAYMU_MIN_AMOUNT_FULL_MESSAGE");
        expect(code).toContain("isIpaymuAmountAllowed(grandTotal, paymentMethod)");

        // COD orders must stay exempt from the iPaymu min-amount rule.
        expect(code).toContain('paymentMethod !== "COD" &&');

        const disabledMatches = code.match(/disabled=\{iPaymuMinBlocked\}/g);
        expect(disabledMatches).toHaveLength(2);

        const bankCard = code.slice(
            code.indexOf("{/* BANK TRANSFER */}"),
            code.indexOf("{/* E-WALLET */}")
        );
        const walletCard = code.slice(
            code.indexOf("{/* E-WALLET */}"),
            code.indexOf("{/* QRIS */}")
        );
        expect(bankCard).toContain("disabled={iPaymuMinBlocked}");
        expect(bankCard).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
        expect(walletCard).toContain("disabled={iPaymuMinBlocked}");
        expect(walletCard).toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");

        const qrisCard = code.slice(
            code.indexOf("{/* QRIS */}"),
            code.indexOf("Ringkasan")
        );
        expect(qrisCard).not.toContain("disabled={iPaymuMinBlocked}");
        expect(qrisCard).not.toContain("{IPAYMU_MIN_AMOUNT_UI_NOTE}");
    });
});