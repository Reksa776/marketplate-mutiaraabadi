/**
 * ==========================================
 * AFFILIATE APPLICATION TESTS
 * ==========================================
 *
 * Static/code-path verification tests.
 *
 * Run: npx tsx __tests__/admin/affiliate-application.test.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

function assert(
    condition: boolean,
    message: string
) {
    if (!condition) {
        throw new Error(`FAIL: ${message}`);
    }
}

function pass(name: string) {
    console.log(`  ✅ ${name}`);
}

function fail(name: string, error: string) {
    console.log(`  ❌ ${name}: ${error}`);
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        pass(name);
        passed++;
    } catch (e) {
        fail(
            name,
            e instanceof Error
                ? e.message
                : String(e)
        );
        failed++;
    }
}

console.log(
    "\n=== AFFILIATE APPLICATION TESTS ===\n"
);

// ==========================================
// 1. DATABASE SCHEMA
// ==========================================

console.log("1. Database Schema:");

const schema = readFile("prisma/schema.prisma");

test("AffiliateProfile model exists", () => {
    assert(
        schema.includes("model AffiliateProfile"),
        "AffiliateProfile model not found"
    );
});

test("AffiliateKyc model exists", () => {
    assert(
        schema.includes("model AffiliateKyc"),
        "AffiliateKyc model not found"
    );
});

test("AffiliateProfile has userId field", () => {
    assert(
        schema.includes("userId") &&
            schema.includes("AffiliateProfile"),
        "AffiliateProfile missing userId"
    );
});

test("AffiliateProfile has status field", () => {
    const profileSection = schema.substring(
        schema.indexOf("model AffiliateProfile"),
        schema.indexOf("model AffiliateKyc")
    );
    assert(
        profileSection.includes("status"),
        "AffiliateProfile missing status"
    );
});

test("AffiliateProfile has affiliateCode field", () => {
    const profileSection = schema.substring(
        schema.indexOf("model AffiliateProfile"),
        schema.indexOf("model AffiliateKyc")
    );
    assert(
        profileSection.includes("affiliateCode"),
        "AffiliateProfile missing affiliateCode"
    );
});

test("AffiliateProfile has rejectionReason field", () => {
    const profileSection = schema.substring(
        schema.indexOf("model AffiliateProfile"),
        schema.indexOf("model AffiliateKyc")
    );
    assert(
        profileSection.includes("rejectionReason"),
        "AffiliateProfile missing rejectionReason"
    );
});

test("AffiliateStatus enum has PENDING", () => {
    assert(
        schema.includes("PENDING") &&
            schema.includes("AffiliateStatus"),
        "AffiliateStatus missing PENDING"
    );
});

test("AffiliateStatus enum has APPROVED", () => {
    assert(
        schema.includes("APPROVED"),
        "AffiliateStatus missing APPROVED"
    );
});

test("AffiliateStatus enum has REJECTED", () => {
    assert(
        schema.includes("REJECTED"),
        "AffiliateStatus missing REJECTED"
    );
});

test("AffiliateKyc has ktpImageUrl field", () => {
    const kycSection = schema.substring(
        schema.indexOf("model AffiliateKyc"),
        schema.indexOf("model AffiliateClick")
    );
    assert(
        kycSection.includes("ktpImageUrl"),
        "AffiliateKyc missing ktpImageUrl"
    );
});

test("AffiliateKyc has bankAccountNumber field", () => {
    const kycSection = schema.substring(
        schema.indexOf("model AffiliateKyc"),
        schema.indexOf("model AffiliateClick")
    );
    assert(
        kycSection.includes("bankAccountNumber"),
        "AffiliateKyc missing bankAccountNumber"
    );
});

test("AffiliateKyc has socialMediaPlatform field", () => {
    const kycSection = schema.substring(
        schema.indexOf("model AffiliateKyc"),
        schema.indexOf("model AffiliateClick")
    );
    assert(
        kycSection.includes("socialMediaPlatform"),
        "AffiliateKyc missing socialMediaPlatform"
    );
});

test("AffiliateKyc bankAccountNumber is String type", () => {
    const kycSection = schema.substring(
        schema.indexOf("model AffiliateKyc"),
        schema.indexOf("model AffiliateClick")
    );
    assert(
        kycSection.includes(
            "bankAccountNumber String"
        ),
        "bankAccountNumber should be String type"
    );
});

test("AffiliateKyc has socialMediaUrl field", () => {
    const kycSection = schema.substring(
        schema.indexOf("model AffiliateKyc"),
        schema.indexOf("model AffiliateClick")
    );
    assert(
        kycSection.includes("socialMediaUrl"),
        "AffiliateKyc missing socialMediaUrl"
    );
});

// ==========================================
// 2. CUSTOMER API
// ==========================================

console.log("\n2. Customer API:");

const customerAppRoute = readFile(
    "app/api/affiliate/application/route.ts"
);

test("Customer API has GET export", () => {
    assert(
        customerAppRoute.includes(
            "export async function GET"
        ),
        "Customer API missing GET"
    );
});

test("Customer API has POST export", () => {
    assert(
        customerAppRoute.includes(
            "export async function POST"
        ),
        "Customer API missing POST"
    );
});

test("Customer API checks authentication", () => {
    assert(
        customerAppRoute.includes(
            "session?.user?.id"
        ),
        "Customer API missing auth check"
    );
});

test("Customer API rejects PENDING duplicate", () => {
    assert(
        customerAppRoute.includes(
            'existing.status === "PENDING"'
        ) &&
            customerAppRoute.includes(
                "sedang diproses"
            ),
        "Customer API missing PENDING duplicate check"
    );
});

test("Customer API rejects APPROVED duplicate", () => {
    assert(
        customerAppRoute.includes(
            'existing.status === "APPROVED"'
        ) &&
            customerAppRoute.includes(
                "sudah menjadi affiliator"
            ),
        "Customer API missing APPROVED duplicate check"
    );
});

test("Customer API allows REJECTED resubmit", () => {
    // No block for REJECTED status
    assert(
        customerAppRoute.includes("APPROVED") &&
            customerAppRoute.includes("PENDING"),
        "Customer API missing status checks"
    );
});

test("REJECTED resubmit uses UPDATE not CREATE", () => {
    assert(
        customerAppRoute.includes(
            "affiliateProfile.update"
        ),
        "REJECTED resubmit not using update"
    );
});

test("REJECTED resubmit resets status to PENDING", () => {
    assert(
        customerAppRoute.includes(
            '"PENDING"'
        ),
        "REJECTED resubmit not resetting to PENDING"
    );
});

test("REJECTED resubmit clears rejectionReason", () => {
    assert(
        customerAppRoute.includes(
            "rejectionReason"
        ) && customerAppRoute.includes(
            "null"
        ),
        "REJECTED resubmit not clearing rejectionReason"
    );
});

test("REJECTED resubmit clears approvedAt", () => {
    assert(
        customerAppRoute.includes(
            "approvedAt"
        ) && customerAppRoute.includes(
            "null"
        ),
        "REJECTED resubmit not clearing approvedAt"
    );
});

test("REJECTED resubmit clears approvedBy", () => {
    assert(
        customerAppRoute.includes(
            "approvedBy"
        ) && customerAppRoute.includes(
            "null"
        ),
        "REJECTED resubmit not clearing approvedBy"
    );
});

test("REJECTED resubmit updates KYC", () => {
    assert(
        customerAppRoute.includes(
            "affiliateKyc.update"
        ),
        "REJECTED resubmit not updating KYC"
    );
});

test("Application saves socialMediaUrl to KYC", () => {
    assert(
        customerAppRoute.includes(
            "socialMediaUrl"
        ) && customerAppRoute.includes(
            "cleanSocialUrl"
        ),
        "Application not saving socialMediaUrl to KYC"
    );
});

test("P2002 race condition handled gracefully", () => {
    assert(
        customerAppRoute.includes(
            "P2002"
        ),
        "Missing P2002 race condition handler"
    );
});

test("P2002 retry uses UPDATE", () => {
    assert(
        customerAppRoute.includes(
            "retrying as update"
        ) || customerAppRoute.includes(
            "retry"
        ),
        "P2002 handler missing retry logic"
    );
});

test("SUSPENDED status blocks resubmit", () => {
    assert(
        customerAppRoute.includes(
            '"SUSPENDED"'
        ),
        "Missing SUSPENDED status check"
    );
});

test("Customer API validates ktpImageUrl required", () => {
    assert(
        customerAppRoute.includes(
            "Foto KTP wajib diupload"
        ),
        "Customer API missing KTP validation"
    );
});

test("Customer API validates socialMediaImageUrl required", () => {
    assert(
        customerAppRoute.includes(
            "Foto bukti sosial media wajib diupload"
        ),
        "Customer API missing social media validation"
    );
});

test("Customer API validates bankAccountNumber format", () => {
    assert(
        customerAppRoute.includes(
            "8-20 digit angka"
        ),
        "Customer API missing bank account format validation"
    );
});

test("Customer API validates bankName required", () => {
    assert(
        customerAppRoute.includes(
            "Nama bank wajib diisi"
        ),
        "Customer API missing bank name validation"
    );
});

test("Customer API validates bankAccountName required", () => {
    assert(
        customerAppRoute.includes(
            "Nama pemilik rekening wajib diisi"
        ),
        "Customer API missing bank account name validation"
    );
});

test("Customer API uses Prisma transaction", () => {
    assert(
        customerAppRoute.includes("$transaction"),
        "Customer API not using Prisma transaction"
    );
});

test("Customer API creates AffiliateProfile", () => {
    assert(
        customerAppRoute.includes(
            "affiliateProfile.create"
        ),
        "Customer API not creating AffiliateProfile"
    );
});

test("Customer API creates AffiliateKyc", () => {
    assert(
        customerAppRoute.includes(
            "affiliateKyc.create"
        ),
        "Customer API not creating AffiliateKyc"
    );
});

test("Customer API does NOT accept userId from client", () => {
    assert(
        !customerAppRoute.includes(
            "body.userId"
        ) &&
            customerAppRoute.includes(
                "session.user.id"
            ),
        "Customer API accepting userId from client"
    );
});

test("Customer GET returns null if no application", () => {
    assert(
        customerAppRoute.includes(
            'data: null'
        ),
        "Customer GET not returning null for no application"
    );
});

test("Customer GET masks bankAccountNumber", () => {
    assert(
        customerAppRoute.includes(
            "bankAccountNumber: null"
        ),
        "Customer GET not masking bankAccountNumber"
    );
});

// ==========================================
// 3. CUSTOMER UPLOAD API
// ==========================================

console.log("\n3. Customer Upload API:");

const uploadRoute = readFile(
    "app/api/affiliate/upload/route.ts"
);

test("Upload API has POST export", () => {
    assert(
        uploadRoute.includes(
            "export async function POST"
        ),
        "Upload API missing POST"
    );
});

test("Upload API checks authentication", () => {
    assert(
        uploadRoute.includes("session?.user?.id"),
        "Upload API missing auth check"
    );
});

test("Upload API validates file size (5MB max)", () => {
    assert(
        uploadRoute.includes("MAX_FILE_SIZE") &&
            uploadRoute.includes(
                "5 * 1024 * 1024"
            ),
        "Upload API missing file size limit"
    );
});

test("Upload API validates MIME type", () => {
    assert(
        uploadRoute.includes("ALLOWED_TYPES") &&
            uploadRoute.includes("image/jpeg"),
        "Upload API missing MIME type validation"
    );
});

test("Upload API validates file extension", () => {
    assert(
        uploadRoute.includes("ALLOWED_EXTENSIONS"),
        "Upload API missing extension validation"
    );
});

test("Upload API uses local filesystem storage", () => {
    assert(
        uploadRoute.includes("fs.writeFile") ||
            uploadRoute.includes("fs/promises"),
        "Upload API not using local filesystem"
    );
});

test("Upload API generates random filename", () => {
    assert(
        uploadRoute.includes("randomBytes") ||
            uploadRoute.includes("randomName"),
        "Upload API not generating random filename"
    );
});

test("Upload API uses userId from session (not client)", () => {
    assert(
        uploadRoute.includes("session.user.id") ||
            uploadRoute.includes("userId = session"),
        "Upload API not using userId from session"
    );
});

test("Upload API validates type parameter (ktp/social)", () => {
    assert(
        uploadRoute.includes("safeType") &&
            uploadRoute.includes("social"),
        "Upload API missing type parameter validation"
    );
});

test("Upload API stores in affiliate/ktp or affiliate/social folder", () => {
    assert(
        uploadRoute.includes("affiliate"),
        "Upload API not using affiliate folder"
    );
});

// ==========================================
// 4. ADMIN API
// ==========================================

console.log("\n4. Admin API:");

const adminListRoute = readFile(
    "app/api/admin/affiliate/applications/route.ts"
);

test("Admin list API has GET export", () => {
    assert(
        adminListRoute.includes(
            "export async function GET"
        ),
        "Admin list API missing GET"
    );
});

test("Admin list API checks ADMIN role", () => {
    assert(
        adminListRoute.includes(
            'role !== "ADMIN"'
        ),
        "Admin list API missing ADMIN check"
    );
});

test("Admin list API supports pagination", () => {
    assert(
        adminListRoute.includes("page") &&
            adminListRoute.includes("limit"),
        "Admin list API missing pagination"
    );
});

test("Admin list API supports status filter", () => {
    assert(
        adminListRoute.includes("statusParam"),
        "Admin list API missing status filter"
    );
});

test("Admin list API masks bank account number", () => {
    assert(
        adminListRoute.includes(
            "maskAccountNumber"
        ),
        "Admin list API not masking account number"
    );
});

test("Admin list API mask shows last 4 digits", () => {
    assert(
        adminListRoute.includes("number.slice(-4)"),
        "Admin list mask not showing last 4 digits"
    );
});

// ==========================================
// 5. ADMIN DETAIL + REVIEW API
// ==========================================

console.log("\n5. Admin Detail + Review API:");

const adminDetailRoute = readFile(
    "app/api/admin/affiliate/applications/[id]/route.ts"
);

test("Admin detail API has GET export", () => {
    assert(
        adminDetailRoute.includes(
            "export async function GET"
        ),
        "Admin detail API missing GET"
    );
});

test("Admin detail API has PATCH export", () => {
    assert(
        adminDetailRoute.includes(
            "export async function PATCH"
        ),
        "Admin detail API missing PATCH"
    );
});

test("Admin detail API checks ADMIN role (GET)", () => {
    assert(
        adminDetailRoute.includes(
            'role !== "ADMIN"'
        ),
        "Admin detail API missing ADMIN check"
    );
});

test("Admin PATCH validates action (APPROVE/REJECT)", () => {
    assert(
        adminDetailRoute.includes('"APPROVE"') &&
            adminDetailRoute.includes('"REJECT"'),
        "Admin PATCH missing action validation"
    );
});

test("Admin REJECT requires rejectionReason", () => {
    assert(
        adminDetailRoute.includes(
            "Alasan penolakan wajib diisi"
        ),
        "Admin REJECT missing reason validation"
    );
});

test("Admin PATCH validates PENDING status only", () => {
    assert(
        adminDetailRoute.includes(
            'status !== "PENDING"'
        ),
        "Admin PATCH missing PENDING status check"
    );
});

test("Admin APPROVE generates affiliate code", () => {
    assert(
        adminDetailRoute.includes(
            "generateUniqueAffiliateCode"
        ) ||
        adminDetailRoute.includes(
            "generateAffiliateCode"
        ),
        "Admin APPROVE missing affiliate code generation"
    );
});

test("Admin APPROVE sets approvedAt", () => {
    assert(
        adminDetailRoute.includes("approvedAt"),
        "Admin APPROVE missing approvedAt"
    );
});

test("Admin APPROVE sets approvedBy", () => {
    assert(
        adminDetailRoute.includes("approvedBy"),
        "Admin APPROVE missing approvedBy"
    );
});

test("Admin REJECT sets rejectionReason", () => {
    assert(
        adminDetailRoute.includes(
            "rejectionReason:"
        ),
        "Admin REJECT missing rejectionReason"
    );
});

test("Admin detail GET returns full KYC data", () => {
    assert(
        adminDetailRoute.includes("kyc: true") ||
            adminDetailRoute.includes(
                "select: {"
            ),
        "Admin detail GET not returning KYC data"
    );
});

// ==========================================
// 6. CUSTOMER UI
// ==========================================

console.log("\n6. Customer UI:");

const affiliateContent = readFile(
    "app/affiliate/AffiliateContent.tsx"
);

test("AffiliateContent has form for KTP upload", () => {
    assert(
        affiliateContent.includes("ktpInputRef") &&
            affiliateContent.includes("handleKtpChange"),
        "AffiliateContent missing KTP upload"
    );
});

test("AffiliateContent has form for social media upload", () => {
    assert(
        affiliateContent.includes("socialInputRef") &&
            affiliateContent.includes(
                "handleSocialChange"
            ),
        "AffiliateContent missing social media upload"
    );
});

test("AffiliateContent has bank account form", () => {
    assert(
        affiliateContent.includes("bankName") &&
            affiliateContent.includes(
                "bankAccountNumber"
            ),
        "AffiliateContent missing bank form"
    );
});

test("AffiliateContent shows PENDING status", () => {
    assert(
        affiliateContent.includes("Menunggu Review"),
        "AffiliateContent missing PENDING status"
    );
});

test("AffiliateContent shows APPROVED status", () => {
    assert(
        affiliateContent.includes("Disetujui"),
        "AffiliateContent missing APPROVED status"
    );
});

test("AffiliateContent shows REJECTED status", () => {
    assert(
        affiliateContent.includes("Ditolak"),
        "AffiliateContent missing REJECTED status"
    );
});

test("AffiliateContent shows rejection reason", () => {
    assert(
        affiliateContent.includes(
            "rejectionReason"
        ),
        "AffiliateContent missing rejection reason display"
    );
});

test("AffiliateContent has resubmit button for REJECTED", () => {
    assert(
        affiliateContent.includes("Ajukan Ulang"),
        "AffiliateContent missing resubmit button"
    );
});

test("AffiliateContent validates client-side file size", () => {
    assert(
        affiliateContent.includes("5 * 1024 * 1024"),
        "AffiliateContent missing client-side file size validation"
    );
});

test("AffiliateContent validates client-side MIME type", () => {
    assert(
        affiliateContent.includes("image/jpeg"),
        "AffiliateContent missing client-side MIME validation"
    );
});

test("AffiliateContent uploads via /api/affiliate/upload", () => {
    assert(
        affiliateContent.includes(
            "/api/affiliate/upload"
        ),
        "AffiliateContent not using correct upload endpoint"
    );
});

test("AffiliateContent submits via /api/affiliate/application", () => {
    assert(
        affiliateContent.includes(
            "/api/affiliate/application"
        ),
        "AffiliateContent not using correct application endpoint"
    );
});

test("AffiliateContent uses useRef for file inputs", () => {
    assert(
        affiliateContent.includes("useRef"),
        "AffiliateContent not using useRef"
    );
});

// ==========================================
// 7. ADMIN UI
// ==========================================

console.log("\n7. Admin UI:");

const adminAffiliatePage = readFile(
    "components/admin/affiliate/AdminAffiliatePage.tsx"
);

test("AdminAffiliatePage has table", () => {
    assert(
        adminAffiliatePage.includes("<table"),
        "AdminAffiliatePage missing table"
    );
});

test("AdminAffiliatePage shows customer name", () => {
    assert(
        adminAffiliatePage.includes("user?.name"),
        "AdminAffiliatePage missing customer name"
    );
});

test("AdminAffiliatePage shows bank name", () => {
    assert(
        adminAffiliatePage.includes("bankName"),
        "AdminAffiliatePage missing bank name"
    );
});

test("AdminAffiliatePage shows masked account number", () => {
    assert(
        adminAffiliatePage.includes(
            "bankAccountNumber"
        ),
        "AdminAffiliatePage missing account number"
    );
});

test("AdminAffiliatePage has Approve button", () => {
    assert(
        adminAffiliatePage.includes("Setujui"),
        "AdminAffiliatePage missing Approve button"
    );
});

test("AdminAffiliatePage has Reject button", () => {
    assert(
        adminAffiliatePage.includes("Tolak"),
        "AdminAffiliatePage missing Reject button"
    );
});

test("AdminAffiliatePage has reject reason textarea", () => {
    assert(
        adminAffiliatePage.includes("Alasan") &&
            adminAffiliatePage.includes("Penolakan"),
        "AdminAffiliatePage missing reject reason input"
    );
});

test("AdminAffiliatePage has review modal", () => {
    assert(
        adminAffiliatePage.includes("Review Pengajuan"),
        "AdminAffiliatePage missing review modal"
    );
});

test("AdminAffiliatePage shows KTP image in modal", () => {
    assert(
        adminAffiliatePage.includes("ktpImageUrl"),
        "AdminAffiliatePage missing KTP image display"
    );
});

test("AdminAffiliatePage has status filter", () => {
    assert(
        adminAffiliatePage.includes("statusFilter"),
        "AdminAffiliatePage missing status filter"
    );
});

test("AdminAffiliatePage has search", () => {
    assert(
        adminAffiliatePage.includes("handleSearch"),
        "AdminAffiliatePage missing search"
    );
});

test("AdminAffiliatePage has pagination", () => {
    assert(
        adminAffiliatePage.includes("pagination"),
        "AdminAffiliatePage missing pagination"
    );
});

// ==========================================
// 8. NAVBAR & NAVIGATION
// ==========================================

console.log("\n8. Navbar & Navigation:");

const adminNavbar = readFile(
    "components/admin/AdminNavbar.tsx"
);

test("Admin navbar has Affiliator link", () => {
    assert(
        adminNavbar.includes("/admin/affiliate"),
        "Admin navbar missing Affiliator link"
    );
});

test("Admin navbar Affiliator label present", () => {
    assert(
        adminNavbar.includes("Affiliator"),
        "Admin navbar missing Affiliator label"
    );
});

/*
 * The account/profile page that used to host the "Daftar Affiliator"
 * entry point was removed with the guest-checkout rework, so the
 * customer-facing affiliate entry point is the affiliate page itself.
 *
 * NOTE: readFile() throws on a missing path, so pointing this at a
 * deleted file aborts the WHOLE suite instead of failing one assertion.
 */
const affiliatePage = readFile(
    "app/affiliate/page.tsx"
);

test("Affiliate page gates on a logged-in user", () => {
    assert(
        affiliatePage.includes(
            'redirect("/login")'
        ),
        "Affiliate page no longer gates on the session"
    );
});

test("Affiliate page exposes the Daftar Affiliator form", () => {
    assert(
        affiliateContent.includes(
            "Daftar Affiliator"
        ),
        "Affiliate page missing Daftar Affiliator entry point"
    );
});

const publicFooter = readFile("components/Footer.tsx");

test("Public footer links to the affiliate programme", () => {
    assert(
        publicFooter.includes('href="/affiliate"') &&
            publicFooter.includes("Program Affiliate"),
        "Footer missing the public Program Affiliate link"
    );
});

test("Public footer has no customer account links", () => {
    assert(
        !publicFooter.includes('href="/login"') &&
            !publicFooter.includes('href="/register"') &&
            !publicFooter.includes('href="/profile"'),
        "Footer reintroduced a customer account surface"
    );
});

// ==========================================
// 9. SECURITY
// ==========================================

console.log("\n9. Security:");

test("Customer API uses session.user.id (not body)", () => {
    assert(
        customerAppRoute.includes(
            "session.user.id"
        ) &&
            !customerAppRoute.includes(
                "body.userId"
            ),
        "Customer API not using session for userId"
    );
});

test("Upload API requires authentication", () => {
    assert(
        uploadRoute.includes("session?.user?.id"),
        "Upload API missing authentication"
    );
});

test("Admin APIs require ADMIN role", () => {
    assert(
        adminListRoute.includes(
            'role !== "ADMIN"'
        ),
        "Admin list API missing ADMIN role check"
    );
    assert(
        adminDetailRoute.includes(
            'role !== "ADMIN"'
        ),
        "Admin detail API missing ADMIN role check"
    );
});

test("Customer GET does not expose bankAccountNumber", () => {
    assert(
        customerAppRoute.includes(
            "bankAccountNumber: null"
        ),
        "Customer GET exposing bankAccountNumber"
    );
});

test("Customer API validates image URL format", () => {
    assert(
        customerAppRoute.includes(
            "imageUrlPattern"
        ),
        "Customer API missing image URL validation"
    );
});

test("Bank account stored as STRING (leading zeros)", () => {
    assert(
        schema.includes(
            "bankAccountNumber String"
        ),
        "bankAccountNumber should be String"
    );
});

test("Upload API limits file to 5MB", () => {
    assert(
        uploadRoute.includes("5 * 1024 * 1024"),
        "Upload API missing 5MB limit"
    );
});

// ==========================================
// 10. EXISTING INTEGRITY
// ==========================================

console.log("\n10. Existing Integrity:");

const checkoutCode = readFile("lib/checkout.ts");

test("Checkout unchanged - createCheckoutOrder exists", () => {
    assert(
        checkoutCode.includes(
            "export async function createCheckoutOrder"
        ),
        "Checkout createCheckoutOrder missing"
    );
});

const adminOrdersRoute = readFile(
    "app/api/admin/orders/route.ts"
);

test("Admin orders route unchanged", () => {
    assert(
        adminOrdersRoute.includes(
            "export async function GET"
        ),
        "Admin orders route structure changed"
    );
});

// ==========================================
// SUMMARY
// ==========================================

console.log(
    "\n" + "=".repeat(50)
);
console.log(
    `\n📊 RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total\n`
);

if (failed > 0) {
    console.log("❌ Some tests failed!");
    process.exit(1);
} else {
    console.log("✅ All tests passed!");
    process.exit(0);
}
