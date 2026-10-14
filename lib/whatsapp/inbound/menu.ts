/**
 * ==========================================================
 * WHATSAPP AUTO-REPLY — MENU & COPY (PURE)
 * ==========================================================
 *
 * Every customer-facing sentence the bot can send lives here, so the
 * wording can be reviewed in one place and reused by the tests.
 *
 * DESIGN RULES
 *
 *   * Plain text only. Baileys 7.x has no supported send-side API for
 *     interactive buttons, so the numbered text menu IS the interface.
 *     The opt-in native-flow buttons in ./interactive are attached as an
 *     ADDITION (only when explicitly enabled) and their payload body is
 *     this very text — so the numbered menu remains complete and usable
 *     even when WhatsApp draws no button at all.
 *   * A URL is allowed, a CREDENTIAL never is. The only link the bot may
 *     send is the official tracking page on our own origin
 *     (`/lacak`, built by ./tracking-url) — and it carries at most an
 *     order-number PREFILL hint, which grants nothing on its own: the
 *     page still needs the guest access token cookie or the two-phase
 *     OTP recovery. No access token, OTP, cookie, hash, payment
 *     reference, order id, phone number or address is ever put in a
 *     message or in a link.
 *   * Indonesian, short lines, no internal jargon (no "shipmentStatus",
 *     no courier codes, no database ids).
 *   * Nothing here ever states a package has been received unless the
 *     DATA says the courier marked it delivered.
 */

/** The first message a customer gets (also the "0. Menu Utama" target). */
export const MAIN_MENU_TEXT = [
    "Halo! Selamat datang di Mutiara Abadi 👋",
    "",
    "Terima kasih sudah menghubungi kami.",
    "",
    "Silakan pilih layanan yang kamu butuhkan:",
    "",
    "1. 📦 Lacak Resi",
    "2. 📋 Status Pesanan",
    "3. 👨‍💼 Hubungi Admin",
    "0. 🏠 Menu Utama",
    "",
    "Balas dengan angka pilihan kamu.",
].join("\n");

/** Sub-menu shown once a package is delivered / the order is finished. */
export const POST_DELIVERY_MENU_TEXT = [
    "Pilihan layanan:",
    "",
    "1. Lihat Riwayat Pengiriman",
    "2. Ada Masalah dengan Pesanan",
    "3. Belanja Lagi",
    "0. Menu Utama",
].join("\n");

export function mainMenu(): string {
    return MAIN_MENU_TEXT;
}

export function postDeliveryMenu(): string {
    return POST_DELIVERY_MENU_TEXT;
}

/**
 * "1. 📦 Lacak Resi" — the tracking page hand-off.
 *
 * The bot does NOT collect a resi in chat any more: the customer is sent
 * to the official tracking page, which does exactly that and keeps the
 * data behind the page's own rules. Nothing about any order is read,
 * matched or disclosed here — this reply is IDENTICAL whether or not an
 * order is bound to the chat, which is what keeps it from becoming a
 * hint about somebody else's parcel.
 *
 * `linkUrl` is the official tracking page (./tracking-url). The caller
 * always passes a usable url — the canonical production page is the
 * fail-safe — so the customer is never told to click a missing link.
 */
export function trackingInstruction(
    linkUrl?: string | null
): string {
    const url =
        typeof linkUrl === "string" ? linkUrl.trim() : "";

    return [
        "*📦 LACAK PENGIRIMAN — MUTIARA ABADI*",
        "",
        "Halo Kak! Untuk mengetahui posisi paket, silakan gunakan halaman pelacakan resmi kami:",
        "",
        `🌐 ${url}`,
        "",
        "*Cara melacak paket:*",
        "1. Klik link di atas.",
        "2. Masukkan nomor resi pengiriman.",
        "3. Tekan tombol *Lacak Resi*.",
        "4. Status dan perjalanan paket akan ditampilkan di website.",
        "",
        "Nomor resi dapat dilihat pada informasi pesanan setelah paket berhasil dibuatkan pengiriman.",
        "",
        "Jika resi belum tersedia, kemungkinan pengiriman masih dalam proses persiapan.",
        "",
        "Ketik *0* untuk kembali ke Menu Utama.",
        "",
        "Terima kasih sudah berbelanja di Mutiara Abadi! 🙏",
    ].join("\n");
}

/* ==========================================
 * OFFICIAL TRACKING PAGE LINK
 * ==========================================
 *
 * The ONLY url this module will ever emit. `url` comes from
 * ./tracking-url, which already refused anything that is not our own
 * HTTPS origin, so an empty/absent value simply renders no section — the
 * reply stays exactly as it was before the link existed.
 */

/** Label used next to the tracking page link. */
export const TRACKING_LINK_LABEL =
    "Lihat detail & riwayat lengkap di halaman tracking resmi:";

/**
 * Label used when the customer must first prove ownership on the page
 * (no order is bound to this chat), so the wording must not promise an
 * immediate result.
 */
export const TRACKING_RECOVERY_LINK_LABEL =
    "Buka halaman tracking resmi (di sana kamu bisa memulihkan akses dengan kode verifikasi):";

export function trackingLinkSection(
    url?: string | null,
    label: string = TRACKING_LINK_LABEL
): string[] {
    const value =
        typeof url === "string" ? url.trim() : "";

    if (!value) {
        return [];
    }

    return ["", label, value];
}

/**
 * Asked when the customer picked a service but no order is bound yet.
 * Says nothing about whether any particular order exists.
 *
 * The link here is deliberately the BARE page: nothing has been verified
 * for this chat, so no order number may be attached to it.
 */
export function askOrderNumber(
    linkUrl?: string | null
): string {
    return [
        "Baik, silakan kirim *nomor pesanan* kamu",
        "(contoh: ORD-1234567890-ab12cd34).",
        "",
        "Nomor pesanan ada di halaman pesanan atau pesan konfirmasi dari kami.",
        ...trackingLinkSection(
            linkUrl,
            TRACKING_RECOVERY_LINK_LABEL
        ),
        "",
        "Ketik 0 untuk kembali ke Menu Utama.",
    ].join("\n");
}

/**
 * ONE uniform answer for "no such order" AND "that order is not yours".
 *
 * The two cases are indistinguishable on purpose: replying differently
 * would turn this menu into an order-number oracle.
 */
export function orderNotFound(
    linkUrl?: string | null
): string {
    return [
        "Mohon maaf, kami tidak menemukan pesanan dengan nomor tersebut",
        "untuk nomor WhatsApp ini.",
        "",
        "Pastikan nomor pesanan sudah benar, atau gunakan nomor WhatsApp",
        "yang kamu pakai saat memesan.",
        ...trackingLinkSection(
            linkUrl,
            TRACKING_RECOVERY_LINK_LABEL
        ),
        "",
        "Ketik 0 untuk kembali ke Menu Utama.",
    ].join("\n");
}

/**
 * Shown after repeated failed lookups from the same chat. The bot then
 * stays silent for a while (see HANDOFF/BLOCK windows in state.ts).
 */
export function tooManyAttempts(): string {
    return [
        "Terlalu banyak percobaan pencarian pesanan.",
        "",
        "Untuk keamanan, silakan coba lagi beberapa saat lagi, atau",
        "hubungi admin kami.",
    ].join("\n");
}

/**
 * FAIL-CLOSED answer when the sender's phone number cannot be derived
 * (LID addressing) — no order data of any kind is released.
 */
export function unverifiableSender(
    linkUrl?: string | null
): string {
    return [
        "Mohon maaf, kami belum bisa memverifikasi pesanan dari chat ini.",
        "",
        "Silakan buka website Mutiara Abadi, lalu gunakan menu pemulihan",
        "pesanan (kode verifikasi) untuk melihat pesanan kamu.",
        ...trackingLinkSection(
            linkUrl,
            TRACKING_RECOVERY_LINK_LABEL
        ),
        "",
        "Ketik 3 jika ingin dibantu admin kami.",
    ].join("\n");
}

/** Hand-off to a human when the customer picks "3. Hubungi Admin". */
export function handoffNotice(): string {
    return [
        "Baik, kami sambungkan ke admin kami 👨‍💼",
        "",
        "Silakan tuliskan pertanyaan atau kendala kamu di chat ini.",
        "Admin Mutiara Abadi akan membalas langsung dari nomor ini.",
        "",
        "Balasan otomatis kami hentikan sementara. Ketik *menu* kapan saja",
        "untuk kembali ke Menu Utama.",
    ].join("\n");
}

/**
 * Hand-off for a problem report. Deliberately does NOT decide the
 * dispute, promise a resolution, or change anything on the order.
 */
export function complaintHandoffNotice(input: {
    deliveredPerCourier: boolean;
}): string {
    const lines = input.deliveredPerCourier
        ? [
              "Kami melihat bahwa ekspedisi telah menandai pesanan Anda sebagai terkirim.",
              "",
              "Jika paket belum Anda terima atau terdapat kendala dengan pesanan,",
              "kami siap membantu.",
          ]
        : [
              "Mohon maaf atas kendalanya 🙏",
              "",
              "Kami siap membantu mengecek pesanan Anda.",
          ];

    return [
        ...lines,
        "",
        "Silakan tuliskan kendala yang dialami. Tim Admin Mutiara Abadi akan",
        "membantu melakukan pengecekan lebih lanjut.",
        "",
        "Balasan otomatis kami hentikan sementara. Ketik *menu* kapan saja",
        "untuk kembali ke Menu Utama.",
    ].join("\n");
}

/** Unrecognized text while a menu is open. */
export function unknownCommand(): string {
    return [
        "Balas dengan angka pilihan:",
        "",
        "1. 📦 Lacak Resi",
        "2. 📋 Status Pesanan",
        "3. 👨‍💼 Hubungi Admin",
        "0. 🏠 Menu Utama",
    ].join("\n");
}

/** A message that carried no readable text (photo, sticker, …). */
export function nonTextHint(): string {
    return [
        "Pesan kamu belum bisa kami baca 🙂",
        "",
        "Silakan ketik *menu* untuk melihat pilihan layanan.",
    ].join("\n");
}

/** "3. Belanja Lagi" — no link, so no URL can drift out of date. */
export function shopAgain(): string {
    return [
        "Terima kasih sudah berbelanja di Mutiara Abadi 🎉",
        "",
        "Silakan buka website Mutiara Abadi untuk belanja lagi ya.",
        "",
        "Ketik 0 untuk kembali ke Menu Utama.",
    ].join("\n");
}

/** Order data restored after the customer follows the website recovery. */
export function backToWebsiteHint(): string {
    return [
        "Untuk data pesanan yang lebih lengkap (alamat, rincian item, atau",
        "tindakan pada pesanan), silakan buka website Mutiara Abadi dan",
        "pulihkan akses pesanan dengan kode verifikasi.",
        "",
        "Demi keamanan, data tersebut tidak kami kirim lewat WhatsApp.",
    ].join("\n");
}
