/**
 * FAVICON + PAGE TITLE TESTS
 *
 * Two concerns, both new in this feature:
 *
 *  1. The admin-managed website favicon: upload validation,
 *     storage URL handling, safe serving and global usage.
 *  2. The per-route browser tab title: every important route
 *     declares a human-readable title and no route falls back
 *     to a framework default.
 *
 * Validation logic is exercised directly (real assertions on
 * real behaviour). Wiring that lives inside route handlers /
 * server components — which cannot run under plain Jest — is
 * asserted against the source, the same approach the
 * `__tests__/security/*` suites already use.
 */

import * as fs from "fs";
import * as path from "path";

import {
    FAVICON_ALLOWED_EXTENSIONS,
    FAVICON_MAX_BYTES,
    detectFaviconExtension,
    extensionForFaviconMime,
    faviconFilenameFromUrl,
    faviconMimeTypeFor,
    getFaviconPublicUrl,
} from "@/lib/store-favicon";
import {
    ADMIN_SITE_NAME,
    SITE_NAME,
    adminPageMetadata,
    pageMetadata,
    toMetaText,
} from "@/lib/site-metadata";

function readFile(relPath: string): string {
    return fs.readFileSync(
        path.resolve(process.cwd(), relPath),
        "utf-8"
    );
}

const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);
const ico = Buffer.from([
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x20, 0x20,
]);
const webp = (() => {
    const buffer = Buffer.alloc(16);
    buffer.write("RIFF", 0, "ascii");
    buffer.write("WEBP", 8, "ascii");
    return buffer;
})();
const html = Buffer.from("<svg><script>alert(1)</script>");
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("Favicon — accepted formats", () => {
    test("allows only PNG/JPG/WEBP/ICO", () => {
        expect(FAVICON_ALLOWED_EXTENSIONS.sort()).toEqual(
            [".ico", ".jpeg", ".jpg", ".png", ".webp"].sort()
        );
    });

    test("SVG is not accepted (no safe sanitizer, not needed)", () => {
        expect(FAVICON_ALLOWED_EXTENSIONS).not.toContain(
            ".svg"
        );
        expect(
            extensionForFaviconMime("image/svg+xml")
        ).toBeNull();
    });

    test("maps browser MIME types to extensions", () => {
        expect(extensionForFaviconMime("image/png")).toBe("png");
        expect(extensionForFaviconMime("image/jpeg")).toBe("jpg");
        expect(extensionForFaviconMime("image/webp")).toBe("webp");
        expect(extensionForFaviconMime("image/x-icon")).toBe("ico");
        expect(
            extensionForFaviconMime("image/vnd.microsoft.icon")
        ).toBe("ico");
        expect(
            extensionForFaviconMime("text/html")
        ).toBeNull();
    });

    test("size limit is 1MB", () => {
        expect(FAVICON_MAX_BYTES).toBe(1024 * 1024);
    });
});

describe("Favicon — magic byte validation", () => {
    test("detects real PNG/JPEG/WEBP/ICO content", () => {
        expect(detectFaviconExtension(png)).toBe("png");
        expect(detectFaviconExtension(jpeg)).toBe("jpg");
        expect(detectFaviconExtension(webp)).toBe("webp");
        expect(detectFaviconExtension(ico)).toBe("ico");
    });

    test("rejects HTML / SVG / arbitrary content", () => {
        expect(detectFaviconExtension(html)).toBeNull();
        expect(detectFaviconExtension(svg)).toBeNull();
        expect(
            detectFaviconExtension(Buffer.from("hello"))
        ).toBeNull();
        expect(
            detectFaviconExtension(Buffer.alloc(0))
        ).toBeNull();
    });

    test("does not trust a .png extension on non-PNG content", () => {
        // No extension is ever passed in — detection is content only.
        expect(detectFaviconExtension(svg)).toBeNull();
    });
});

describe("Favicon — storage URLs", () => {
    test("builds a public URL under /api/favicons", () => {
        expect(getFaviconPublicUrl("abc.ico")).toBe(
            "/api/favicons/abc.ico"
        );
    });

    test("derives Content-Type from the extension", () => {
        expect(faviconMimeTypeFor("abc.ico")).toBe(
            "image/x-icon"
        );
        expect(faviconMimeTypeFor("/api/favicons/abc.png")).toBe(
            "image/png"
        );
        expect(faviconMimeTypeFor("abc.jpg")).toBe("image/jpeg");
        expect(faviconMimeTypeFor("abc.webp")).toBe("image/webp");
        expect(faviconMimeTypeFor("abc.exe")).toBe(
            "application/octet-stream"
        );
    });

    test("only recognises our own stored URLs", () => {
        expect(
            faviconFilenameFromUrl("/api/favicons/abc.ico")
        ).toBe("abc.ico");
        expect(
            faviconFilenameFromUrl(
                "https://evil.example/abc.ico"
            )
        ).toBeNull();
        expect(
            faviconFilenameFromUrl("javascript:alert(1)")
        ).toBeNull();
        expect(faviconFilenameFromUrl(null)).toBeNull();
        expect(faviconFilenameFromUrl("")).toBeNull();
    });

    test("neutralises path traversal to a bare file name", () => {
        // basename strips the traversal; the extension gate then
        // only lets a real image name through.
        expect(
            faviconFilenameFromUrl(
                "/api/favicons/../../etc/passwd"
            )
        ).toBeNull();
        expect(
            faviconFilenameFromUrl(
                "/api/favicons/../../secret.png"
            )
        ).toBe("secret.png");
    });
});

describe("Favicon — admin API security", () => {
    const uploadRoute = readFile(
        "app/api/admin/settings/favicon/route.ts"
    );
    const serveRoute = readFile(
        "app/api/favicons/[filename]/route.ts"
    );

    test("requires an ADMIN session server-side", () => {
        expect(uploadRoute).toMatch(/auth\(\)/);
        expect(uploadRoute).toMatch(/!==\s*\n?\s*"ADMIN"/);
        expect(uploadRoute).toMatch(/status:\s*401/);
        expect(uploadRoute).toMatch(/status:\s*403|Unauthorized/);
    });

    test("rejects oversized files", () => {
        expect(uploadRoute).toMatch(/FAVICON_MAX_BYTES/);
    });

    test("validates content with magic bytes, not the client MIME", () => {
        expect(uploadRoute).toMatch(
            /detectFaviconExtension\(/
        );
        expect(uploadRoute).toMatch(
            /extensionForFaviconMime\(/
        );
    });

    test("uses server-generated file names (no user path)", () => {
        expect(uploadRoute).toMatch(
            /randomBytes\(16\)/
        );
        expect(uploadRoute).toMatch(
            /getFaviconStorageDir\(\)/
        );
        // Never trusts a client-supplied filename.
        expect(uploadRoute).not.toMatch(
            /file\.name/
        );
    });

    test("revalidates the root layout so the icon applies everywhere", () => {
        expect(uploadRoute).toMatch(
            /revalidatePath\(\s*"\/",\s*"layout"\s*\)/
        );
    });

    test("serving route blocks traversal and unknown extensions", () => {
        expect(serveRoute).toMatch(/path\.basename\(/);
        expect(serveRoute).toMatch(
            /FAVICON_ALLOWED_EXTENSIONS/
        );
        expect(serveRoute).toMatch(/status:\s*404/);
    });
});

describe("Favicon — global usage without duplicates", () => {
    test("root layout reads the settings favicon for metadata", () => {
        const layout = readFile("app/layout.tsx");
        expect(layout).toMatch(/getStoreFaviconUrl\(\)/);
        expect(layout).toMatch(/export async function generateMetadata/);
        expect(layout).toMatch(/icons:\s*\{/);
    });

    test("falls back to bundled icons when settings fail", () => {
        const layout = readFile("app/layout.tsx");
        // Returns base metadata untouched when no custom favicon.
        expect(layout).toMatch(/return baseMetadata;/);
        // The getter swallows DB errors and returns null.
        const lib = readFile("lib/store-favicon.ts");
        expect(lib).toMatch(/catch \(error\)/);
        expect(lib).toMatch(/return null;/);
    });

    test("no root app/favicon.ico (Next would inject it ahead of the custom icon)", () => {
        expect(
            fs.existsSync(
                path.resolve(process.cwd(), "app/favicon.ico")
            )
        ).toBe(false);
        expect(
            fs.existsSync(
                path.resolve(process.cwd(), "app/icon.ico")
            )
        ).toBe(true);
    });

    test("legacy /favicon.ico keeps working", () => {
        const config = readFile("next.config.ts");
        expect(config).toMatch(/"\/favicon\.ico"/);
        expect(config).toMatch(/"\/icon\.ico"/);
    });

    test("settings UI exposes favicon upload without wiping it on save", () => {
        const form = readFile(
            "app/admin/settings/AdminSettingsForm.tsx"
        );
        expect(form).toMatch(/Favicon Website/);
        expect(form).toMatch(
            /\/api\/admin\/settings\/favicon/
        );
        expect(form).toMatch(/handleFaviconUpload/);
        expect(form).toMatch(/handleFaviconRemove/);

        // The generic settings PUT must not write faviconUrl.
        const settingsRoute = readFile(
            "app/api/admin/settings/route.ts"
        );
        expect(settingsRoute).toMatch(/faviconUrl: true/);
        expect(settingsRoute).toMatch(
            /faviconUrl: setting\.faviconUrl/
        );
    });
});

describe("Page titles — metadata builders", () => {
    test("storefront pages inherit the brand template", () => {
        const meta = pageMetadata({ title: "Keranjang" });
        expect(meta.title).toBe("Keranjang");
        expect(meta.openGraph?.title).toBe(
            `Keranjang | ${SITE_NAME}`
        );
    });

    test("absolute title bypasses the template", () => {
        const meta = pageMetadata({
            title: "Absolute",
            absolute: true,
        });
        expect(meta.title).toEqual({ absolute: "Absolute" });
        expect(meta.openGraph?.title).toBe("Absolute");
    });

    test("admin pages use the admin brand", () => {
        const meta = adminPageMetadata("Pengaturan");
        expect(meta.title).toBe("Pengaturan");
        expect(meta.openGraph?.title).toBe(
            `Pengaturan | ${ADMIN_SITE_NAME}`
        );
    });

    test("noindex is opt-in", () => {
        expect(
            pageMetadata({ title: "X", noindex: true }).robots
        ).toEqual({ index: false, follow: true });
        expect(
            pageMetadata({ title: "X" }).robots
        ).toBeUndefined();
    });

    test("toMetaText flattens and clips long catalog text", () => {
        expect(
            toMetaText("  Keripik\n\nManis  ", 100)
        ).toBe("Keripik Manis");
        const clipped = toMetaText("a ".repeat(200), 30);
        expect(clipped.length).toBeLessThanOrEqual(31);
        expect(clipped.endsWith("…")).toBe(true);
        expect(toMetaText(null, 10)).toBe("");
    });
});

describe("Page titles — every important route", () => {
    const routes: Array<[string, RegExp | string]> = [
        ["app/layout.tsx", /SITE_DEFAULT_TITLE/],
        ["app/page.tsx", /SITE_DEFAULT_TITLE/],
        ["app/products/[slug]/page.tsx", /generateMetadata/],
        ["app/products/[slug]/page.tsx", /toMetaText\(product\.name/],
        ["app/products/page.tsx", /title:\s*"Produk"/],
        ["app/cart/page.tsx", /title:\s*"Keranjang"/],
        ["app/checkout/page.tsx", /title:\s*"Checkout"/],
        ["app/login/page.tsx", /title:\s*"Masuk"/],
        ["app/register/page.tsx", /title:\s*"Daftar"/],
        ["app/orders/page.tsx", /title:\s*"Pesanan Saya"/],
        ["app/orders/[id]/layout.tsx", /generateMetadata/],
        ["app/profile/page.tsx", /title:\s*"Profil Saya"/],
        ["app/admin/layout.tsx", /ADMIN_SITE_NAME/],
        ["app/admin/page.tsx", /adminPageMetadata\(\s*"Dashboard"/],
        ["app/admin/settings/page.tsx", /"Pengaturan"/],
        ["app/admin/products/page.tsx", /Metadata/],
        ["app/admin/orders/page.tsx", /Metadata/],
    ];

    test.each(routes)(
        "%s declares a title",
        (file, pattern) => {
            expect(readFile(file)).toMatch(pattern);
        }
    );

    test("no route falls back to a framework default title", () => {
        const appFiles: string[] = [];

        (function walk(dir: string) {
            for (const entry of fs.readdirSync(dir, {
                withFileTypes: true,
            })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(tsx?|mdx)$/.test(entry.name)) {
                    appFiles.push(full);
                }
            }
        })(path.resolve(process.cwd(), "app"));

        const genericTitles = /Create Next App|untitled/i;

        for (const file of appFiles) {
            expect(readFile(file)).not.toMatch(genericTitles);
        }
    });
});
