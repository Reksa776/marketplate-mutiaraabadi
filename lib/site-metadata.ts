/**
 * ==========================================
 * SITE BRAND IDENTITY (METADATA SOURCE OF TRUTH)
 * ==========================================
 *
 * Shared constants for the App Router metadata API.
 *
 * Why this module exists:
 *  - `app/layout.tsx` owns the storefront title template
 *    and the default title/description.
 *  - `app/admin/layout.tsx` owns the admin title template.
 *  - `app/not-found.tsx` and the dynamic product page need
 *    the same brand name + description.
 *
 * Everything below is a CONSTANT on purpose. None of it
 * queries the database: the root layout metadata is
 * resolved for every route, and hitting Prisma there would
 * force dynamic rendering of the whole app and make the
 * brand depend on a request-time DB round trip.
 *
 * The editable store name itself lives in `StoreSetting`
 * (see `lib/store-settings.ts`) and is rendered inside the
 * page body (header/footer/legal pages). Browser chrome
 * uses the stable brand constants below.
 */

import type { Metadata } from "next";

/** Primary brand. Also the suffix of the storefront title template. */
export const SITE_NAME = "Mutiara Abadi";

/** Brand of the back-office area. */
export const ADMIN_SITE_NAME = "Mutiara Abadi Admin";

/**
 * Default (homepage) title.
 *
 * Deliberately NOT "Home | Mutiara Abadi": the root layout
 * `title.default` is used verbatim for `/`, so a brand-led
 * title reads better in the tab than a generic page label.
 */
export const SITE_DEFAULT_TITLE = "Mutiara Abadi — Belanja Produk Pilihan";

/**
 * Default meta description.
 *
 * Kept factual on purpose: the catalog is Indonesian snacks
 * (keripik, kerupuk, kue) carrying SPP-IRT certification.
 * No delivery/promo/quality promises are made here.
 */
export const SITE_DESCRIPTION =
    "Toko online Mutiara Abadi — camilan pilihan berupa keripik, kerupuk, dan kue bersertifikat SPP-IRT.";

/**
 * Canonical origin used for `metadataBase` and absolute
 * OpenGraph URLs.
 *
 * Prefers NEXT_PUBLIC_APP_URL (same variable the payment
 * callback builder uses) and falls back to the production
 * host so `new URL()` in the root layout can never throw on
 * a malformed or missing value.
 */
export function getSiteUrl(): string {
    const fromEnv = process.env.NEXT_PUBLIC_APP_URL;

    if (fromEnv) {
        try {
            return new URL(fromEnv).origin;
        } catch {
            // Malformed env value — fall through to the default.
        }
    }

    return "https://mutiaraabadisnack.com";
}

/**
 * Normalize free-form catalog text (product names and
 * descriptions are `@db.Text` and often contain newlines,
 * bullet characters and marketing boilerplate) into a single
 * tidy line suitable for `<title>` / `<meta name="description">`.
 *
 * Collapses whitespace and cuts on a word boundary so the tab
 * title never ends mid-word.
 */
export function toMetaText(value: string | null | undefined, maxLength: number): string {
    if (!value) {
        return "";
    }

    const flattened = value.replace(/\s+/g, " ").trim();

    if (flattened.length <= maxLength) {
        return flattened;
    }

    const clipped = flattened.slice(0, maxLength);
    const lastSpace = clipped.lastIndexOf(" ");

    // Only respect the word boundary if it does not throw away
    // most of the text (short values without spaces).
    const cut = lastSpace > maxLength * 0.5 ? clipped.slice(0, lastSpace) : clipped;

    return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}

/* ==========================================
 * METADATA BUILDERS
 * ========================================== */

export interface PageMetadataOptions {
    /** Page-level label. The ancestor layout template brands the `<title>`. */
    title: string;
    /** Omit to inherit the root description. */
    description?: string;
    /** Set when `title` already contains the brand suffix. */
    absolute?: boolean;
    /** Brand used for `og:title` / `twitter:title`. Defaults to `SITE_NAME`. */
    brand?: string;
    /** Absolute or root-relative URL for `og:url`. */
    url?: string;
    /** Exclude from search engines (personal / transactional pages). */
    noindex?: boolean;
}

/**
 * Build a route `Metadata` object whose `<title>`, `og:title`
 * and `twitter:title` always agree.
 *
 * Why a helper instead of a bare `{ title, description }`:
 * App Router metadata is SHALLOWLY merged, so a segment that
 * does not declare `openGraph` INHERITS every field from its
 * ancestors. The root layout declares `openGraph.title` for
 * the homepage, so leaving `openGraph` off a child page makes
 * it publish the homepage title as its own social card title.
 * Declaring it per page is the only correct option, and this
 * helper keeps it to one call.
 *
 * `og:title` carries the brand suffix explicitly because, unlike
 * `<title>`, it is NOT run through the layout template.
 *
 * Keys are spread conditionally: an explicit `description: undefined`
 * would otherwise override the inherited description during the merge.
 */
export function pageMetadata(options: PageMetadataOptions): Metadata {
    const {
        title,
        description,
        absolute = false,
        brand = SITE_NAME,
        url,
        noindex = false,
    } = options;

    const socialTitle = absolute ? title : `${title} | ${brand}`;

    return {
        title: absolute ? { absolute: title } : title,
        ...(description ? { description } : null),
        openGraph: {
            type: "website",
            siteName: SITE_NAME,
            locale: "id_ID",
            title: socialTitle,
            ...(description ? { description } : null),
            ...(url ? { url } : null),
        },
        twitter: {
            card: "summary",
            title: socialTitle,
            ...(description ? { description } : null),
        },
        ...(noindex ? { robots: { index: false, follow: true } } : null),
    };
}

/**
 * `pageMetadata` bound to the back-office brand, so admin routes
 * never publish the storefront suffix. Admin pages are `noindex`
 * via `app/admin/layout.tsx`, so the description only matters for
 * the tab/`<title>` and is a plain label by default.
 */
export function adminPageMetadata(
    title: string,
    description?: string
): Metadata {
    return pageMetadata({
        title,
        description: description ?? `${title} — ${ADMIN_SITE_NAME} Mutiara Abadi.`,
        brand: ADMIN_SITE_NAME,
    });
}
