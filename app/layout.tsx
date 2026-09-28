import "./globals.css";

import type { Metadata } from "next";
import { Toaster } from "react-hot-toast";
import AuthProvider from "@/components/providers/AuthProvider";
import AnalyticsProvider from "@/components/analytics/AnalyticsProvider";
import { DialogProvider } from "@/components/ui/Dialog";
import Footer from "@/components/Footer";
import {
    SITE_DEFAULT_TITLE,
    SITE_DESCRIPTION,
    SITE_NAME,
    getSiteUrl,
} from "@/lib/site-metadata";
import {
    faviconMimeTypeFor,
    getStoreFaviconUrl,
} from "@/lib/store-favicon";

/**
 * ==========================================
 * ROOT METADATA — SOURCE OF TRUTH
 * ==========================================
 *
 * The bundled icons (`app/icon.ico`, `app/icon.svg`,
 * `app/apple-icon.png`) live in this segment and are picked
 * up by the App Router file conventions. They stay the
 * FALLBACK favicon: `icons` is only emitted when an admin has
 * uploaded a custom favicon (see `generateMetadata` below).
 *
 * The branded ICO is named `icon.ico` and NOT `favicon.ico`
 * on purpose: Next.js always injects a root `app/favicon.ico`
 * as the first `<link rel="icon">`, which would compete with
 * the uploaded favicon. `next.config.ts` rewrites
 * `/favicon.ico` → `/icon.ico` to keep the old URL working.
 *
 * Child routes only declare `title`; the template appends
 * the brand. `app/admin/layout.tsx` re-declares its own
 * template so the back office never shows the storefront
 * suffix.
 */
const baseMetadata: Metadata = {
    metadataBase: new URL(getSiteUrl()),
    title: {
        // Verbatim title for `/` — never becomes "Home | ...".
        default: SITE_DEFAULT_TITLE,
        // Applies to every descendant EXCEPT segments that
        // declare their own template (e.g. the admin layout).
        template: `%s | ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: {
        type: "website",
        siteName: SITE_NAME,
        locale: "id_ID",
        url: "/",
        title: SITE_DEFAULT_TITLE,
        description: SITE_DESCRIPTION,
    },
    twitter: {
        card: "summary",
        title: SITE_DEFAULT_TITLE,
        description: SITE_DESCRIPTION,
    },
};

/**
 * ==========================================
 * DYNAMIC FAVICON
 * ==========================================
 *
 * When the admin has uploaded a favicon it replaces the whole
 * static icon set; otherwise `baseMetadata` is returned
 * untouched and the bundled files remain the fallback.
 *
 * `getStoreFaviconUrl` swallows database errors and returns
 * null, so a settings outage degrades to the default icon
 * instead of failing every page. The lookup runs at build
 * time for prerendered routes and is refreshed after a save
 * by `revalidatePath("/", "layout")` in the settings/favicon
 * API — it does not force the app fully dynamic.
 */
export async function generateMetadata(): Promise<Metadata> {
    const faviconUrl = await getStoreFaviconUrl();

    if (!faviconUrl) {
        return baseMetadata;
    }

    const type = faviconMimeTypeFor(faviconUrl);

    return {
        ...baseMetadata,
        icons: {
            icon: [{ url: faviconUrl, type }],
            shortcut: [{ url: faviconUrl, type }],
            apple: [{ url: faviconUrl, type }],
        },
    };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>

        <AuthProvider>
          <AnalyticsProvider />
          <DialogProvider>

          {children}

          <Footer />

          <Toaster
            position="top-right"
            toastOptions={{
              duration: 3000,
            }}
          />

          </DialogProvider>
        </AuthProvider>

      </body>
    </html>
  );
}