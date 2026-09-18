/**
 * Safe iPaymu SANDBOX Diagnostic Test
 *
 * Loads credentials from .env via dotenv.
 * Makes a minimal DIRECT PAYMENT request
 * (POST /api/v2/payment/direct — the endpoint the app now uses).
 * Reports sanitized results.
 *
 * SAFETY
 *  - refuses to run against a non-sandbox base URL, so it can never
 *    create a real payment in production
 *  - NEVER prints the full API key
 */

require("dotenv").config();
const crypto = require("crypto");

// ========== LOAD & VALIDATE CREDENTIALS ==========
const apiKey = (process.env.IPAYMU_API_KEY || "").trim();
const va = (process.env.IPAYMU_VA || "").trim();
const baseUrl = (process.env.IPAYMU_URL || "").trim() || "https://sandbox.ipaymu.com";

console.log("========== CREDENTIAL CHECK ==========");
console.log("KEY_LEN:", apiKey.length);
console.log("KEY_FIRST4:", apiKey.substring(0, 4));
console.log("KEY_LAST4:", apiKey.substring(apiKey.length - 4));
console.log("KEY_HAS_CR:", apiKey.includes("\r"));
console.log("KEY_HAS_NEWLINE:", apiKey.includes("\n"));
console.log("KEY_HAS_SPACE:", apiKey !== apiKey.trim());
console.log("VA_LEN:", va.length);
console.log("VA_VALUE:", va);
console.log("BASE_URL:", baseUrl);

if (!apiKey || !va) {
  console.error("ERROR: Missing credentials!");
  process.exit(1);
}

/* ========== PRODUCTION GUARD ==========
 *
 * This script CREATES A PAYMENT. It must never be pointed at the
 * production endpoint, so any non-sandbox URL aborts immediately.
 */
if (!baseUrl.includes("sandbox.ipaymu.com")) {
  console.error(
    "\n❌ REFUSED: BASE_URL is not the iPaymu sandbox endpoint.\n" +
      "   This diagnostic creates a real payment and must never run " +
      "against production.\n"
  );
  process.exit(1);
}

// ========== BUILD TEST REQUEST ==========
// Direct payment contract: only the documented fields are sent.
const testBody = {
  name: "Test Buyer",
  phone: "081234567890",
  email: "test@example.com",
  amount: 10000,
  notifyUrl: "https://example.com/api/payment/ipaymu/notification",
  referenceId: "TEST-DIRECT-" + Date.now(),
  paymentMethod: "va",
  paymentChannel: "bca",
  comments: "Sandbox diagnostic",
};

const body = JSON.stringify(testBody);

// ========== COMPUTE SIGNATURE ==========
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const stringToSign = `POST:${va}:${bodyHash.toLowerCase()}:${apiKey}`;
const signature = crypto.createHmac("sha256", apiKey).update(stringToSign).digest("hex");

// Generate timestamp
const now = new Date();
const timestamp =
  now.getFullYear().toString() +
  String(now.getMonth() + 1).padStart(2, "0") +
  String(now.getDate()).padStart(2, "0") +
  String(now.getHours()).padStart(2, "0") +
  String(now.getMinutes()).padStart(2, "0") +
  String(now.getSeconds()).padStart(2, "0");

console.log("\n========== REQUEST DETAILS ==========");
console.log("ENDPOINT:", `${baseUrl}/api/v2/payment/direct`);
console.log("BODY_LENGTH:", body.length);
console.log("BODY_HASH:", bodyHash);
console.log("VA_LEN:", va.length);
console.log("KEY_LEN:", apiKey.length);
console.log("SIGNATURE_LEN:", signature.length);
console.log("SIGNATURE_FIRST8:", signature.substring(0, 8));
console.log("TIMESTAMP:", timestamp);
console.log("CONTENT_TYPE:", "application/json");
console.log("BODY:", body);

// Show stringToSign with API key redacted
console.log("\nSTRING_TO_SIGN:", `POST:${va}:${bodyHash.toLowerCase()}:<REDACTED>`);

// ========== MAKE REQUEST ==========
console.log("\n========== SENDING REQUEST ==========");

async function testRequest() {
  try {
    const response = await fetch(`${baseUrl}/api/v2/payment/direct`, {
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

    console.log("\n========== RESPONSE ==========");
    console.log("HTTP_STATUS:", response.status);
    console.log("IPAYMU_STATUS:", result.Status);
    console.log("IPAYMU_MESSAGE:", result.Message);
    console.log("TRANSACTION_ID:", result.Data?.TransactionId || "N/A");
    console.log("VIA / CHANNEL:", result.Data?.Via, "/", result.Data?.Channel);
    console.log("PAYMENT_NO:", result.Data?.PaymentNo || "N/A");
    console.log("PAYMENT_NAME:", result.Data?.PaymentName || "N/A");
    console.log("EXPIRED:", result.Data?.Expired || "N/A");
    console.log("HAS_URL:", !!result.Data?.Url);

    if (result.Status === 200) {
      console.log("\n✅ SUCCESS: iPaymu sandbox accepted the direct payment request!");
      if (!result.Data?.PaymentNo && !result.Data?.Url) {
        console.log(
          "⚠️  NOTE: no PaymentNo and no Url returned — the app would reject " +
            "this response and roll the order back."
        );
      }
    } else {
      console.log("\n❌ FAILED: iPaymu returned status", result.Status, "-", result.Message);
    }

    return result;
  } catch (error) {
    console.error("\n❌ NETWORK ERROR:", error.message);
    return null;
  }
}

testRequest();
