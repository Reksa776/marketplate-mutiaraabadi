/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/$1",
        // Next.js resolves the `server-only` marker internally; Jest
        // runs in plain Node and needs the empty stub instead.
        "^server-only$": "<rootDir>/__mocks__/server-only.js",
    },
    testMatch: [
        "**/__tests__/auth/*.test.ts",
        "**/__tests__/ipaymu/*.test.ts",
        "**/__tests__/marketing/*.test.ts",
        "!**/__tests__/marketing/pricing-engine.test.ts",
        "**/__tests__/p0/*.test.ts",
        "**/__tests__/order-refund/*.test.ts",
        "**/__tests__/security/*.test.ts",
    ],
    testPathIgnorePatterns: [
        "/node_modules/",
        // Standalone tsx audit/verification scripts (each declares its own
        // test() helper and exits the process); not Jest suites.
        "__tests__/auth/register-rate-limit.test.ts",
        "__tests__/ipaymu/production-hardening.test.ts",
        "__tests__/marketing/address-shipping-ux.test.ts",
        "__tests__/marketing/campaign-optional-audit.test.ts",
        "__tests__/marketing/m7-audit-fixes.test.ts",
        "__tests__/marketing/profile-phone-shipping.test.ts",
        "__tests__/marketing/pricing-engine.test.ts",
    ],
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                tsconfig: "tsconfig.json",
            },
        ],
    },
};
