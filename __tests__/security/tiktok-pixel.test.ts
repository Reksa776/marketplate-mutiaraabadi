/**
 * ==========================================
 * TIKTOK PIXEL — ADMIN MANAGED PIXEL CODE
 * ==========================================
 *
 * Phase 12 coverage:
 *   1. non-admin cannot modify
 *   2. non-admin cannot read the raw Pixel Code
 *   3. admin can save the Pixel ID / name
 *   4. admin can save a multiline Pixel Code unchanged
 *   5. disabled -> no Pixel Code rendered
 *   6. enabled -> Pixel Code rendered on the storefront
 *   7. admin route -> pixel not rendered
 *   8. API routes -> pixel not rendered
 *   9. no duplicate / hardcoded pixel initialisation
 *  10. Pixel ID <-> code mismatch detected (warning only)
 *  11. empty / broken code handled safely
 *  12. audit log never stores the raw Pixel Code
 *  13. CSP stays specific (no wildcards)
 *  14. existing analytics events unaffected
 */

import {
    existsSync,
    readFileSync,
    readdirSync,
} from "fs";
import { resolve } from "path";

/* ==========================================
 * MOCKS
 * ========================================== */

const mockPrisma = {
    storeSetting: {
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
    },
    adminAuditLog: {
        create: jest.fn(),
    },
};

jest.mock("@/lib/prisma", () => ({
    prisma: mockPrisma,
}));

jest.mock("next/navigation", () => ({
    usePathname: jest.fn(() => "/"),
}));

/**
 * next/script hanya menyuntikkan script di browser, jadi untuk
 * pengujian render kita ganti dengan elemen <script> biasa supaya
 * markup-nya bisa diperiksa.
 */
jest.mock("next/script", () => ({
    __esModule: true,
    default: (props: {
        id?: string;
        children?: unknown;
        strategy?: string;
        "data-pixel-id"?: string;
        "data-pixel-name"?: string;
    }) =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("react").createElement(
            "script",
            {
                id: props.id,
                strategy: props.strategy,
                "data-pixel-id":
                    props["data-pixel-id"],
                "data-pixel-name":
                    props["data-pixel-name"],
            },
            typeof props.children === "string"
                ? props.children
                : null
        ),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { usePathname } from "next/navigation";

import TikTokPixel from "@/components/analytics/TikTokPixel";

import {
    MAX_TIKTOK_PIXEL_CODE_LENGTH,
    analyzeTikTokPixelCode,
    extractTikTokPixelIds,
    findTikTokPixelIdMismatch,
    normalizeTikTokPixelCode,
    normalizeTikTokPixelName,
} from "@/lib/analytics/tiktok-pixel-code";

import {
    buildTikTokPixelAuditMetadata,
    hasTikTokPixelChanges,
} from "@/lib/analytics/tiktok-pixel-audit";

import {
    isAdminPath,
    normalizeTikTokPixelId,
    trackTikTokEvent,
} from "@/lib/analytics/tiktok";

import { getTikTokPixelConfig } from "@/lib/analytics/tiktok-config";

/* ==========================================
 * FIXTURES
 * ========================================== */

const PIXEL_ID = "C1A2B3C4D5E6F7G8H9J0";
const OTHER_PIXEL_ID = "Z9Y8X7W6V5U4T3S2R1Q0";

const MULTILINE_CODE = [
    "<script>",
    "!function (w, d, t) {",
    "  var ttq = w[t] = w[t] || [];",
    `  ttq.load("${PIXEL_ID}");`,
    "  ttq.page();",
    "}(window, document, 'ttq');",
    "</script>",
].join("\n");

function readFile(relativePath: string): string {
    return readFileSync(
        resolve(process.cwd(), relativePath),
        "utf-8"
    );
}

/**
 * Daftar file (rekursif) di dalam sebuah folder.
 */
function listFiles(
    relativeDir: string
): string[] {
    const root = resolve(
        process.cwd(),
        relativeDir
    );

    const result: string[] = [];

    for (const entry of readdirSync(root, {
        withFileTypes: true,
    })) {
        if (entry.isDirectory()) {
            result.push(
                ...listFiles(
                    `${relativeDir}/${entry.name}`
                )
            );
        } else if (
            entry.name.endsWith(".ts") ||
            entry.name.endsWith(".tsx")
        ) {
            result.push(
                `${relativeDir}/${entry.name}`
            );
        }
    }

    return result;
}

beforeEach(() => {
    jest.clearAllMocks();
});

/* ==========================================
 * 1. PIXEL ID VALIDATION
 * ========================================== */

describe("TikTok Pixel — ID validation", () => {
    test("accepts and normalizes a valid ID", () => {
        expect(
            normalizeTikTokPixelId(
                `  ${PIXEL_ID.toLowerCase()}  `
            )
        ).toBe(PIXEL_ID);
    });

    test("rejects JS / HTML / URL / empty values", () => {
        expect(
            normalizeTikTokPixelId(
                "<script>alert(1)</script>"
            )
        ).toBeNull();
        expect(
            normalizeTikTokPixelId(
                "javascript:alert(1)"
            )
        ).toBeNull();
        expect(
            normalizeTikTokPixelId(
                "https://analytics.tiktok.com/i18n/pixel/events.js"
            )
        ).toBeNull();
        expect(normalizeTikTokPixelId("")).toBeNull();
        expect(normalizeTikTokPixelId(null)).toBeNull();
        expect(normalizeTikTokPixelId("AB12")).toBeNull();
    });
});

/* ==========================================
 * 2. PIXEL CODE NORMALIZATION
 * ========================================== */

describe("TikTok Pixel — code normalization", () => {
    test("keeps a multiline Pixel Code byte-for-byte", () => {
        expect(
            normalizeTikTokPixelCode(
                MULTILINE_CODE
            )
        ).toBe(MULTILINE_CODE);
    });

    test("only trims the outside of the code", () => {
        const normalized = normalizeTikTokPixelCode(
            `\n\n${MULTILINE_CODE}\n  `
        );

        expect(normalized).toBe(MULTILINE_CODE);
        // indentation inside the script must survive
        expect(normalized).toContain(
            "\n  var ttq = w[t]"
        );
    });

    test("rejects non-strings and empty code", () => {
        expect(
            normalizeTikTokPixelCode(null)
        ).toBeNull();
        expect(
            normalizeTikTokPixelCode(undefined)
        ).toBeNull();
        expect(
            normalizeTikTokPixelCode(123)
        ).toBeNull();
        expect(
            normalizeTikTokPixelCode("   \n  ")
        ).toBeNull();
    });

    test("enforces the maximum code length", () => {
        expect(
            normalizeTikTokPixelCode(
                "a".repeat(
                    MAX_TIKTOK_PIXEL_CODE_LENGTH + 1
                )
            )
        ).toBeNull();
        expect(
            normalizeTikTokPixelCode(
                "a".repeat(
                    MAX_TIKTOK_PIXEL_CODE_LENGTH
                )
            )
        ).not.toBeNull();
    });

    test("normalizes the pixel name", () => {
        expect(
            normalizeTikTokPixelName("  Web Tiktok ")
        ).toBe("Web Tiktok");
        expect(
            normalizeTikTokPixelName("")
        ).toBeNull();
        expect(
            normalizeTikTokPixelName("<b>x</b>")
        ).toBe("<b>x</b>");
    });
});

/* ==========================================
 * 3. PIXEL CODE ANALYSIS
 * ========================================== */

describe("TikTok Pixel — code analysis", () => {
    test("extracts the inline JavaScript from the <script> wrapper", () => {
        const analysis =
            analyzeTikTokPixelCode(
                MULTILINE_CODE
            );

        expect(analysis.hasScriptTag).toBe(true);
        expect(analysis.isEmpty).toBe(false);
        expect(analysis.script).not.toContain(
            "<script>"
        );
        expect(analysis.script).not.toContain(
            "</script>"
        );
        expect(analysis.script).toContain(
            `ttq.load("${PIXEL_ID}")`
        );
        expect(analysis.hasLoadCall).toBe(true);
        expect(analysis.hasPageCall).toBe(true);
    });

    test("accepts JavaScript without the <script> wrapper", () => {
        const analysis = analyzeTikTokPixelCode(
            `ttq.load("${PIXEL_ID}"); ttq.page();`
        );

        expect(analysis.hasScriptTag).toBe(false);
        expect(analysis.isEmpty).toBe(false);
        expect(analysis.script).toBe(
            `ttq.load("${PIXEL_ID}"); ttq.page();`
        );
    });

    test("joins multiple script blocks", () => {
        const analysis = analyzeTikTokPixelCode(
            `<script>var a = 1;</script>\n<script>var b = 2;</script>`
        );

        expect(analysis.script).toBe(
            "var a = 1;\nvar b = 2;"
        );
    });

    test("flags an external-only script as empty", () => {
        const analysis = analyzeTikTokPixelCode(
            '<script src="https://example.com/pixel.js"></script>'
        );

        expect(analysis.isEmpty).toBe(true);
        expect(
            analysis.externalScriptSources
        ).toEqual([
            "https://example.com/pixel.js",
        ]);
    });

    test("handles empty and null code safely", () => {
        expect(
            analyzeTikTokPixelCode(null).isEmpty
        ).toBe(true);
        expect(
            analyzeTikTokPixelCode("").isEmpty
        ).toBe(true);
        expect(
            analyzeTikTokPixelCode("   ").isEmpty
        ).toBe(true);
    });

    test("detects ttq.load IDs and ttq.identify", () => {
        expect(
            extractTikTokPixelIds(
                `ttq.load('${PIXEL_ID}'); ttq.load("${OTHER_PIXEL_ID}");`
            )
        ).toEqual([PIXEL_ID, OTHER_PIXEL_ID]);

        expect(
            analyzeTikTokPixelCode(
                `ttq.identify({ email: "a@b.c" });`
            ).hasIdentifyCall
        ).toBe(true);
        expect(
            analyzeTikTokPixelCode(
                "var a = 1;"
            ).hasIdentifyCall
        ).toBe(false);
    });
});

/* ==========================================
 * 4. PIXEL ID <-> CODE CONSISTENCY
 * ========================================== */

describe("TikTok Pixel — ID consistency", () => {
    test("no warning when the configured ID matches the code", () => {
        expect(
            findTikTokPixelIdMismatch(
                PIXEL_ID,
                MULTILINE_CODE
            )
        ).toBeNull();
    });

    test("matching is case insensitive", () => {
        expect(
            findTikTokPixelIdMismatch(
                PIXEL_ID.toLowerCase(),
                MULTILINE_CODE
            )
        ).toBeNull();
    });

    test("reports the ID found in the code when it differs", () => {
        const code = MULTILINE_CODE.replace(
            PIXEL_ID,
            OTHER_PIXEL_ID
        );

        expect(
            findTikTokPixelIdMismatch(
                PIXEL_ID,
                code
            )
        ).toBe(OTHER_PIXEL_ID);
    });

    test("does not rewrite the code it inspects", () => {
        const code = MULTILINE_CODE.replace(
            PIXEL_ID,
            OTHER_PIXEL_ID
        );
        const before = code;

        findTikTokPixelIdMismatch(PIXEL_ID, code);

        expect(code).toBe(before);
    });

    test("no warning when there is no code or no ID", () => {
        expect(
            findTikTokPixelIdMismatch(
                PIXEL_ID,
                "var a = 1;"
            )
        ).toBeNull();
        expect(
            findTikTokPixelIdMismatch(
                null,
                MULTILINE_CODE
            )
        ).toBeNull();
    });
});

/* ==========================================
 * 5. SERVER-SIDE CONFIG RESOLUTION
 * ========================================== */

describe("TikTok Pixel — server config", () => {
    function mockSetting(overrides: {
        tiktokPixelEnabled?: boolean;
        tiktokPixelId?: string | null;
        tiktokPixelName?: string | null;
        tiktokPixelCode?: string | null;
    }) {
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            {
                tiktokPixelEnabled: true,
                tiktokPixelId: PIXEL_ID,
                tiktokPixelName: "Web Tiktok",
                tiktokPixelCode: MULTILINE_CODE,
                ...overrides,
            }
        );
    }

    test("returns the executable script when enabled", async () => {
        mockSetting({});

        const config =
            await getTikTokPixelConfig();

        expect(config.enabled).toBe(true);
        expect(config.pixelId).toBe(PIXEL_ID);
        expect(config.pixelName).toBe("Web Tiktok");
        expect(config.script).toContain(
            `ttq.load("${PIXEL_ID}")`
        );
        // tag pembungkus tidak diteruskan ke browser
        expect(config.script).not.toContain(
            "<script>"
        );
    });

    test("stays disabled when the toggle is off", async () => {
        mockSetting({
            tiktokPixelEnabled: false,
        });

        const config =
            await getTikTokPixelConfig();

        expect(config.enabled).toBe(false);
        expect(config.script).toBe("");
    });

    test("stays disabled when the code is empty", async () => {
        mockSetting({ tiktokPixelCode: "" });

        const config =
            await getTikTokPixelConfig();

        expect(config.enabled).toBe(false);
        expect(config.script).toBe("");
    });

    test("stays disabled when the code has no inline JavaScript", async () => {
        mockSetting({
            tiktokPixelCode:
                '<script src="https://evil.example.com/p.js"></script>',
        });

        const config =
            await getTikTokPixelConfig();

        expect(config.enabled).toBe(false);
    });

    test("stays disabled when the row is missing or the DB fails", async () => {
        mockPrisma.storeSetting.findUnique.mockResolvedValue(
            null
        );
        await expect(
            getTikTokPixelConfig()
        ).resolves.toEqual({
            enabled: false,
            pixelId: null,
            pixelName: null,
            script: "",
        });

        const consoleError = jest
            .spyOn(console, "error")
            .mockImplementation(() => { });

        mockPrisma.storeSetting.findUnique.mockRejectedValue(
            new Error("column not found")
        );

        await expect(
            getTikTokPixelConfig()
        ).resolves.toEqual({
            enabled: false,
            pixelId: null,
            pixelName: null,
            script: "",
        });

        consoleError.mockRestore();
    });

    test("only reads the config — never writes it", async () => {
        mockSetting({});

        await getTikTokPixelConfig();

        expect(
            mockPrisma.storeSetting.update
        ).not.toHaveBeenCalled();
        expect(
            mockPrisma.storeSetting.upsert
        ).not.toHaveBeenCalled();
    });
});

/* ==========================================
 * 6. RENDER GATING
 * ========================================== */

describe("TikTok Pixel — render gating", () => {
    const mockUsePathname =
        usePathname as unknown as jest.Mock;

    function render(
        config: {
            enabled: boolean;
            pixelId: string | null;
            pixelName: string | null;
            script: string;
        },
        pathname: string
    ): string {
        mockUsePathname.mockReturnValue(pathname);

        return renderToStaticMarkup(
            createElement(TikTokPixel, config)
        );
    }

    const enabledConfig = {
        enabled: true,
        pixelId: PIXEL_ID,
        pixelName: "Web Tiktok",
        script: `ttq.load("${PIXEL_ID}"); ttq.page();`,
    };

    test("renders the admin code once on the storefront", () => {
        const markup = render(
            enabledConfig,
            "/products/kaos"
        );

        expect(
            markup.split(
                'id="tiktok-pixel-base"'
            ).length - 1
        ).toBe(1);
        expect(markup).toContain(PIXEL_ID);
        expect(markup).toContain("ttq.page();");
        expect(markup).toContain(
            'strategy="afterInteractive"'
        );
    });

    test("renders nothing on admin pages", () => {
        expect(
            render(enabledConfig, "/admin")
        ).toBe("");
        expect(
            render(
                enabledConfig,
                "/admin/settings"
            )
        ).toBe("");
        expect(
            render(
                enabledConfig,
                "/admin/orders/12"
            )
        ).toBe("");
    });

    test("renders nothing when disabled", () => {
        expect(
            render(
                {
                    ...enabledConfig,
                    enabled: false,
                },
                "/"
            )
        ).toBe("");
    });

    test("renders nothing when the code is empty", () => {
        expect(
            render(
                {
                    ...enabledConfig,
                    script: "",
                },
                "/"
            )
        ).toBe("");
        expect(
            render(
                {
                    ...enabledConfig,
                    script: "   \n ",
                },
                "/"
            )
        ).toBe("");
    });

    test("storefront paths are detected as trackable", () => {
        expect(isAdminPath("/")).toBe(false);
        expect(
            isAdminPath("/products/kaos")
        ).toBe(false);
        expect(isAdminPath("/checkout")).toBe(false);
        expect(
            isAdminPath("/administrator")
        ).toBe(false);
        expect(isAdminPath("/admin/x")).toBe(true);
    });
});

/* ==========================================
 * 7. ADMIN AUTHORIZATION
 * ========================================== */

describe("TikTok Pixel — admin authorization", () => {
    const api = readFile(
        "app/api/admin/settings/route.ts"
    );

    test("write access is ADMIN only, server-side", () => {
        expect(api).toContain(
            "async function getAdminUserId"
        );
        expect(api).toContain(
            'role !== "ADMIN"'
        );
        expect(api).toContain(
            "const adminId =\n            await getAdminUserId();"
        );
        expect(api).toContain(
            "if (!adminId)"
        );
        expect(api).toContain(
            "if (!(await isAdmin()))"
        );
    });

    test("the admin settings page is ADMIN only", () => {
        const page = readFile(
            "app/admin/settings/page.tsx"
        );

        expect(page).toContain(
            'role !== "ADMIN"'
        );
        expect(page).toContain("redirect(");
    });

    test("there is no public endpoint returning the pixel code", () => {
        expect(
            existsSync(
                resolve(
                    process.cwd(),
                    "app/api/analytics/settings/route.ts"
                )
            )
        ).toBe(false);

        expect(
            existsSync(
                resolve(
                    process.cwd(),
                    "app/api/admin/settings/tracking/route.ts"
                )
            )
        ).toBe(false);

        const proxy = readFile("proxy.ts");
        expect(proxy).not.toContain(
            '"/api/analytics/"'
        );
    });

    test("only the ADMIN settings route exposes the pixel fields", () => {
        const files = listFiles("app/api");
        const allowed = "app/api/admin/settings/route.ts";
        const exposing = files.filter(
            (file) =>
                file.replace(/\\/g, "/") !==
                allowed &&
                readFile(file).includes("tiktokPixel")
        );

        expect(exposing).toEqual([]);
    });

    test("client code never fetches settings for the pixel", () => {
        for (const file of [
            "components/analytics/TikTokPixel.tsx",
            "components/analytics/AnalyticsProvider.tsx",
        ]) {
            const code = readFile(file);

            expect(code).not.toContain("fetch(");
            expect(code).not.toContain(
                "/api/admin/settings"
            );
        }
    });
});

/* ==========================================
 * 8. SAVING PIXEL SETTINGS
 * ========================================== */

describe("TikTok Pixel — saving settings", () => {
    const api = readFile(
        "app/api/admin/settings/route.ts"
    );

    test("persists ID, name and code without reformatting", () => {
        expect(api).toContain(
            "normalizeTikTokPixelId("
        );
        expect(api).toContain(
            "normalizeTikTokPixelName("
        );
        expect(api).toContain(
            "normalizeTikTokPixelCode("
        );

        for (const field of [
            "tiktokPixelEnabled,",
            "tiktokPixelId,",
            "tiktokPixelName,",
            "tiktokPixelCode,",
        ]) {
            // create + update branch
            expect(
                api.split(field).length - 1
            ).toBeGreaterThanOrEqual(2);
        }

        // The raw body value is never stored directly
        expect(api).not.toMatch(
            /tiktokPixelCode:\s*body\./
        );
        // No "pretty printing"/minifying of the admin code
        expect(api).not.toMatch(
            /tiktokPixelCode[\s\S]{0,80}replace\(/
        );
    });

    test("rejects invalid IDs, oversized and non-executable code", () => {
        expect(api).toContain(
            "TikTok Pixel ID tidak valid."
        );
        expect(api).toContain(
            "maksimal ${MAX_TIKTOK_PIXEL_CODE_LENGTH} karakter."
        );
        expect(api).toContain(
            "tidak berisi JavaScript inline"
        );
        expect(api).toContain("{ status: 400 }");
    });

    test("enabling requires a pixel code", () => {
        expect(api).toContain(
            "Isi Kode Pixel TikTok sebelum mengaktifkan pixel."
        );
    });

    test("mismatch is reported as a warning, not auto-fixed", () => {
        expect(api).toContain(
            "findTikTokPixelIdMismatch("
        );
        expect(api).toContain(
            "pixelIdMismatch"
        );
        expect(api).toContain("warnings:");
        expect(api).not.toContain(
            ".replace(\n                tiktokPixelCode"
        );
    });

    test("revalidates the layout so static pages follow the toggle", () => {
        expect(api).toContain(
            'revalidatePath("/", "layout")'
        );
    });
});

/* ==========================================
 * 9. AUDIT LOG
 * ========================================== */

describe("TikTok Pixel — audit log", () => {
    test("metadata never contains the raw pixel code", () => {
        const metadata =
            buildTikTokPixelAuditMetadata(
                null,
                {
                    enabled: true,
                    pixelId: PIXEL_ID,
                    pixelName: "Web Tiktok",
                    code: MULTILINE_CODE,
                }
            );

        const serialized =
            JSON.stringify(metadata);

        expect(serialized).not.toContain(
            "<script>"
        );
        expect(serialized).not.toContain(
            "ttq.load"
        );
        expect(serialized).not.toContain(
            "ttq.page"
        );

        expect(metadata.enabled).toBe(true);
        expect(metadata.pixelId).toBe(PIXEL_ID);
        expect(metadata.pixelName).toBe(
            "Web Tiktok"
        );
        expect(metadata.pixelCodeLength).toBe(
            MULTILINE_CODE.length
        );
        expect(
            typeof metadata.pixelCodeHash
        ).toBe("string");
        expect(
            String(metadata.pixelCodeHash)
        ).toHaveLength(16);
    });

    test("hash is stable and does not leak the code", () => {
        const first =
            buildTikTokPixelAuditMetadata(null, {
                enabled: true,
                pixelId: PIXEL_ID,
                pixelName: null,
                code: MULTILINE_CODE,
            });

        const second =
            buildTikTokPixelAuditMetadata(null, {
                enabled: true,
                pixelId: PIXEL_ID,
                pixelName: null,
                code: MULTILINE_CODE,
            });

        expect(first.pixelCodeHash).toBe(
            second.pixelCodeHash
        );
    });

    test("change detection covers every tiktok field", () => {
        const base = {
            enabled: true,
            pixelId: PIXEL_ID,
            pixelName: "Web Tiktok",
            code: MULTILINE_CODE,
        };

        expect(
            hasTikTokPixelChanges(null, base)
        ).toBe(true);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
            })
        ).toBe(false);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
                enabled: false,
            })
        ).toBe(true);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
                code: "var a = 1;",
            })
        ).toBe(true);
        expect(
            hasTikTokPixelChanges(base, {
                ...base,
                pixelId: OTHER_PIXEL_ID,
            })
        ).toBe(true);
    });

    test("the API logs TIKTOK_PIXEL_UPDATED via the safe builder", () => {
        const api = readFile(
            "app/api/admin/settings/route.ts"
        );

        expect(api).toContain(
            'action: "TIKTOK_PIXEL_UPDATED"'
        );
        expect(api).toContain(
            "buildTikTokPixelAuditMetadata("
        );

        // The audit entry receives the builder output only — never the
        // raw code field of the settings row.
        const auditCall = api.slice(
            api.indexOf("await createAuditLog({")
        );

        expect(auditCall).toContain(
            "buildTikTokPixelAuditMetadata("
        );
        expect(auditCall).not.toContain(
            "tiktokPixelCode"
        );
        expect(auditCall).not.toContain(
            "<script>"
        );
    });
});

/* ==========================================
 * 10. DUPLICATE / HARDCODED PIXEL
 * ========================================== */

describe("TikTok Pixel — single initialisation", () => {
    test("the pixel is mounted from the root layout only", () => {
        const layout = readFile("app/layout.tsx");

        expect(layout).toContain(
            "<AnalyticsProvider />"
        );

        // No admin layout injection
        const adminLayout = readFile(
            "app/admin/layout.tsx"
        );
        expect(adminLayout).not.toContain(
            "TikTokPixel"
        );
        expect(adminLayout).not.toContain(
            "AnalyticsProvider"
        );
    });

    test("no API route renders the pixel component", () => {
        const files = listFiles("app/api");

        for (const file of files) {
            const code = readFile(file);

            expect(code).not.toContain(
                "components/analytics/"
            );
            expect(code).not.toContain(
                'from "next/script"'
            );
        }
    });

    test("application code never initialises the pixel itself", () => {
        for (const file of [
            "components/analytics/TikTokPixel.tsx",
            "components/analytics/AnalyticsProvider.tsx",
            "lib/analytics/tiktok-config.ts",
        ]) {
            const code = readFile(file);

            // The admin base code owns ttq.load / ttq.page
            expect(code).not.toContain("ttq.load(");
            expect(code).not.toContain("ttq.page();");
            expect(code).not.toContain(
                "analytics.tiktok.com"
            );
        }
    });

    test("the old built-in base code builder is gone", () => {
        const lib = readFile(
            "lib/analytics/tiktok.ts"
        );

        expect(lib).not.toContain(
            "buildTikTokPixelBaseCode"
        );
        expect(lib).not.toContain(
            "TiktokAnalyticsObject"
        );
    });

    test("no real Pixel ID is hardcoded in application code", () => {
        const files = [
            "components/analytics/TikTokPixel.tsx",
            "components/analytics/AnalyticsProvider.tsx",
            "lib/analytics/tiktok.ts",
            "lib/analytics/tiktok-config.ts",
            "lib/analytics/tiktok-pixel-code.ts",
            "app/layout.tsx",
            "app/api/admin/settings/route.ts",
            "app/admin/settings/AdminSettingsForm.tsx",
        ];

        for (const file of files) {
            const code = readFile(file);

            // the ID from the request + the ID currently in the store
            expect(code).not.toContain(
                "DAP1TLRC77U28JP39TVG"
            );
            expect(code).not.toContain(
                "DA2N6IBC77U575JEFETG"
            );
        }
    });

    test("the admin UI shows the code and the trust warning", () => {
        const form = readFile(
            "app/admin/settings/AdminSettingsForm.tsx"
        );

        expect(form).toContain("textarea");
        expect(form).toContain("tiktokPixelCode");
        expect(form).toContain(
            "Kode ini akan dijalankan pada"
        );
        expect(form).toContain("ttq.load:");
        expect(form).toContain("ttq.page:");
        expect(form).toContain(
            "Pixel ID berbeda dengan ID yang"
        );
    });
});

/* ==========================================
 * 11. CSP
 * ========================================== */

describe("TikTok Pixel — CSP", () => {
    test("allows the TikTok origin without wildcards", async () => {
        const nextConfig = (
            await import("../../next.config")
        ).default;

        const headersFn =
            nextConfig.headers as () => Promise<unknown>;

        const result = await headersFn();

        const headersArray = result as Array<{
            source: string;
            headers: Array<{
                key: string;
                value: string;
            }>;
        }>;

        let csp = "";

        for (const entry of headersArray) {
            for (const header of entry.headers) {
                if (
                    header.key ===
                    "Content-Security-Policy"
                ) {
                    csp = header.value;
                }
            }
        }

        const scriptSrc = csp.match(
            /script-src\s+([^;]+)/
        );
        const connectSrc = csp.match(
            /connect-src\s+([^;]+)/
        );

        expect(scriptSrc?.[1]).toContain(
            "https://analytics.tiktok.com"
        );
        expect(connectSrc?.[1]).toContain(
            "https://analytics.tiktok.com"
        );

        // No wildcard script/connect sources, no unsafe-eval
        expect(scriptSrc?.[1]).not.toContain("*");
        expect(connectSrc?.[1]).not.toContain("*");
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("object-src 'none'");
    });
});

/* ==========================================
 * 12. EXISTING ANALYTICS UNAFFECTED
 * ========================================== */

describe("TikTok Pixel — existing analytics events", () => {
    test("trackTikTokEvent still forwards to window.ttq", () => {
        const track = jest.fn();

        (globalThis as { window?: unknown }).window = {
            ttq: { track },
        };

        trackTikTokEvent("ViewContent", {
            content_id: "1",
        });

        expect(track).toHaveBeenCalledWith(
            "ViewContent",
            { content_id: "1" }
        );

        delete (globalThis as { window?: unknown })
            .window;
    });

    test("trackTikTokEvent is a no-op without the pixel", () => {
        (globalThis as { window?: unknown }).window =
            {};

        expect(() =>
            trackTikTokEvent("AddToCart")
        ).not.toThrow();

        delete (globalThis as { window?: unknown })
            .window;
    });

    test("existing storefront event callers still import the helper", () => {
        const callers = [
            "components/products/ProductDetail.tsx",
            "app/checkout/CheckoutPage.tsx",
            "app/buy-now/BuyNowPage.tsx",
        ];

        for (const file of callers) {
            const code = readFile(file);

            expect(code).toContain(
                "trackTikTokEvent"
            );
            expect(code).not.toContain(
                "ttq.identify("
            );
        }
    });
});
