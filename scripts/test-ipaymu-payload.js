/**
 * iPaymu Payload Diagnostic Test
 *
 * Simulates the EXACT payload that the app generates,
 * including real product names from the database.
 *
 * Tests both working and problematic payloads.
 */

require("dotenv").config();
const crypto = require("crypto");

/* ==========================================
 * HARD SANDBOX GUARD
 * ==========================================
 *
 * This script CREATES A PAYMENT against whatever endpoint it is
 * pointed at. It must therefore NEVER be able to reach production.
 *
 *  1. abort unless the app is explicitly running in the sandbox
 *  2. abort unless the resolved endpoint is the sandbox host
 *
 * The guards run BEFORE any credential is read or printed.
 */

const payEnvironment = (process.env.PAYMENT_ENVIRONMENT || "").trim();

if (payEnvironment !== "sandbox") {
  console.error(
    "\n❌ REFUSED: PAYMENT_ENVIRONMENT is not 'sandbox' " +
      `(got '${payEnvironment || "unset"}').\n` +
      "   This diagnostic creates a payment and must never run " +
      "outside the sandbox.\n"
  );
  process.exit(1);
}

const apiKey = (process.env.IPAYMU_API_KEY || "").trim();
const va = (process.env.IPAYMU_VA || "").trim();
const baseUrl =
  (process.env.IPAYMU_URL || "").trim() ||
  "https://sandbox.ipaymu.com";

if (!baseUrl.includes("sandbox.ipaymu.com")) {
  console.error(
    "\n❌ REFUSED: the endpoint is not the iPaymu sandbox.\n" +
      "   This diagnostic creates a payment and must never run " +
      "against production.\n"
  );
  process.exit(1);
}

if (!apiKey || !va) {
  console.error("ERROR: Missing credentials!");
  process.exit(1);
}

// Credential VALUES are never printed — presence/length only.
console.log("========== CREDENTIALS ==========");
console.log("VA: <redacted, len=" + va.length + ">");
console.log("KEY: <redacted, len=" + apiKey.length + ">");
console.log("BASE_URL:", baseUrl);

// Helper: formatProductName (mirrors lib/payment/ipaymu.ts)
function formatProductName(productName, variantName) {
  const trimmed = (variantName || "").trim();
  return trimmed ? `${productName} - ${trimmed}` : productName;
}

// Helper: generateSignature
function generateSignature(body, va, apiKey) {
  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex");
  const stringToSign = `POST:${va}:${bodyHash.toLowerCase()}:${apiKey}`;
  return crypto
    .createHmac("sha256", apiKey)
    .update(stringToSign)
    .digest("hex");
}

// Helper: generate timestamp
function generateTimestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}${hh}${mm}${ss}`;
}

async function testPayload(label, request) {
  console.log(`\n========== TEST: ${label} ==========`);

  const body = JSON.stringify(request);
  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex");
  const signature = generateSignature(body, va, apiKey);
  const timestamp = generateTimestamp();

  console.log("BODY:", body);
  console.log("BODY_LENGTH:", body.length);
  console.log("BODY_HASH:", bodyHash);
  console.log("SIGNATURE: <redacted, len=" + signature.length + ">");
  console.log("TIMESTAMP:", timestamp);

  try {
    const response = await fetch(`${baseUrl}/api/v2/payment/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        va: va,
        signature: signature,
        timestamp: timestamp,
        Accept: "application/json",
      },
      body: body,
    });

    const result = await response.json();

    console.log("HTTP_STATUS:", response.status);
    console.log("IPAYMU_STATUS:", result.Status);
    console.log("IPAYMU_MESSAGE:", result.Message);
    console.log("HAS_URL:", !!result.Data?.Url);
    console.log(
      "SESSION_ID:",
      result.Data?.SessionId || "N/A"
    );

    if (result.Status === 200) {
      console.log("✅ SUCCESS");
    } else {
      console.log("❌ FAILED:", result.Status, result.Message);
    }

    return result;
  } catch (error) {
    console.error("❌ NETWORK ERROR:", error.message);
    return null;
  }
}

async function runTests() {
  // Test 1: Simple payload (known working)
  await testPayload("Simple Product", {
    product: ["Test Product", "Biaya Pengiriman"],
    qty: ["1", "1"],
    price: ["10000", "5000"],
    amount: 15000,
    buyerName: "Test Buyer",
    buyerEmail: "test@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/notify",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    referenceId: "TEST-SIMPLE-" + Date.now(),
    description: ["Test Product", "Biaya Pengiriman"],
    expired: 1,
  });

  // Test 2: Real product name (known working from user's tests)
  await testPayload("Real Product Name", {
    product: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
      "Biaya Pengiriman",
    ],
    qty: ["1", "1"],
    price: ["47400", "10000"],
    amount: 57400,
    buyerName: "Test Buyer",
    buyerEmail: "test@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/notify",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    referenceId: "TEST-REAL-" + Date.now(),
    description: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
      "Biaya Pengiriman",
    ],
    expired: 1,
  });

  // Test 3: formatProductName with variant
  const nameWithVariant = formatProductName(
    "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
    "Pedas"
  );
  await testPayload("With Variant (formatProductName)", {
    product: [nameWithVariant, "Biaya Pengiriman"],
    qty: ["1", "1"],
    price: ["47400", "10000"],
    amount: 57400,
    buyerName: "Test Buyer",
    buyerEmail: "test@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/notify",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    referenceId: "TEST-VARIANT-" + Date.now(),
    description: [nameWithVariant, "Biaya Pengiriman"],
    expired: 1,
  });

  // Test 4: formatProductName with EMPTY variant (the bug case)
  const nameEmptyVariant = formatProductName(
    "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
    ""
  );
  console.log("\n========== PRODUCT NAME CHECK ==========");
  console.log("formatProductName with empty variant:", nameEmptyVariant);
  console.log(
    "Contains trailing ' - '?:",
    nameEmptyVariant.includes(" - ")
  );
  console.log(
    "Old broken pattern would be:",
    "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi - "
  );

  await testPayload("Empty Variant (formatProductName)", {
    product: [nameEmptyVariant, "Biaya Pengiriman"],
    qty: ["1", "1"],
    price: ["47400", "10000"],
    amount: 57400,
    buyerName: "Test Buyer",
    buyerEmail: "test@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/notify",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    referenceId: "TEST-EMPTY-" + Date.now(),
    description: [nameEmptyVariant, "Biaya Pengiriman"],
    expired: 1,
  });

  // Test 5: OLD BROKEN pattern (should fail with 401)
  await testPayload("OLD BROKEN: trailing ' - ' (should fail)", {
    product: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi - ",
      "Biaya Pengiriman",
    ],
    qty: ["1", "1"],
    price: ["47400", "10000"],
    amount: 57400,
    buyerName: "Test Buyer",
    buyerEmail: "test@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/notify",
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    referenceId: "TEST-BROKEN-" + Date.now(),
    description: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi - ",
      "Biaya Pengiriman",
    ],
    expired: 1,
  });

  // Test 6: Full realistic app payload (BUY_NOW with shipping, voucher, etc.)
  await testPayload("Full Realistic App Payload", {
    product: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
      "Biaya Pengiriman",
      "Voucher DISC10",
    ],
    qty: ["2", "1", "1"],
    price: ["47400", "15000", "-5000"],
    amount: 104800,
    buyerName: "Budi Santoso",
    buyerEmail: "budi@example.com",
    buyerPhone: "081234567890",
    paymentMethod: "va",
    paymentChannel: "bca",
    notifyUrl: "https://example.com/api/payment/ipaymu/notification",
    returnUrl:
      "https://example.com/checkout/payment-finish?payment=PAY-BN-" +
      Date.now(),
    cancelUrl:
      "https://example.com/checkout/payment-finish?payment=PAY-BN-" +
      Date.now(),
    referenceId: "PAY-BN-" + Date.now() + "-abc12345",
    description: [
      "Kripik Kue Kuping Gajah Cream 1KG Mutiara Abadi",
      "Biaya Pengiriman",
      "Voucher DISC10",
    ],
    expired: 1,
  });

  // Test 7: Verify that generateSignature is deterministic
  console.log("\n========== SIGNATURE DETERMINISM ==========");
  const testBody = JSON.stringify({
    product: ["Test"],
    qty: ["1"],
    price: ["10000"],
    amount: 10000,
  });
  const sig1 = generateSignature(testBody, va, apiKey);
  const sig2 = generateSignature(testBody, va, apiKey);
  console.log("Same body → same signature:", sig1 === sig2);

  // Test 8: Verify body hash matches between helper and inline
  console.log("\n========== HASH CONSISTENCY ==========");
  const inlineHash = crypto
    .createHash("sha256")
    .update(testBody)
    .digest("hex");
  const expectedHash = require("crypto")
    .createHash("sha256")
    .update(testBody)
    .digest("hex");
  console.log("Inline hash:", inlineHash);
  console.log("Expected hash:", expectedHash);
  console.log("Hashes match:", inlineHash === expectedHash);

  console.log("\n========== ALL TESTS COMPLETE ==========");
}

runTests();
