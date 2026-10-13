/**
 * ==========================================
 * ADMIN WHATSAPP NUMBER (QR SESSION)
 * ==========================================
 *
 * SINGLE SOURCE OF TRUTH for "which number may a customer contact?":
 * the number of the WhatsApp account that is ACTUALLY connected to this
 * application through the admin dashboard QR scan
 * (lib/whatsapp/service.ts, Baileys).
 *
 *   - nothing is hardcoded
 *   - no second "admin number" setting is introduced, so the contacted
 *     number can never drift from the account that really holds the
 *     session
 *   - the customer's number is never used as the destination
 *   - when the session is down, we report "unavailable" instead of
 *     inventing a link
 *
 * WHY THE DEVICE SUFFIX MUST BE STRIPPED
 *
 * On login WhatsApp reports the account identifier as
 *
 *   "<phone>:<deviceId>@s.whatsapp.net"     (Baileys `creds.me.id`)
 *
 * and the service stores the part before "@", i.e. "6281234567890:12".
 * Feeding that to normalizePhone() would concatenate the device id onto
 * the phone number and fabricate a number that belongs to nobody — a
 * FAKE link, which is precisely what must never be shown to a customer.
 * The identifier is therefore decoded (host, then device suffix) before
 * it is normalized.
 */

import { normalizePhone } from "./phone";

export type AdminWhatsAppUnavailableReason =
    | "NOT_CONNECTED"
    | "NO_NUMBER"
    | "SERVICE_ERROR";

export type AdminWhatsAppTarget =
    | {
          available: true;
          /** normalized international form, e.g. "6281234567890" */
          phoneNumber: string;
          connectionStatus: "CONNECTED";
      }
    | {
          available: false;
          reason: AdminWhatsAppUnavailableReason;
          connectionStatus: string | null;
      };

/**
 * Decode a Baileys account identifier into a normalized phone number.
 *
 * Accepts "6281234567890:12@s.whatsapp.net", "6281234567890:12",
 * "6281234567890@s.whatsapp.net", "+62 812-3456-7890" and "0812...".
 * Returns null for anything that is not a valid Indonesian mobile
 * number — including a `@lid` identifier, which is NOT dialable.
 */
export function parseAdminPhoneFromSession(
    sessionPhone: string | null | undefined
): string | null {
    if (typeof sessionPhone !== "string") {
        return null;
    }

    const raw = sessionPhone.trim();

    if (!raw) {
        return null;
    }

    const [userPart = "", host = ""] = raw.split("@");

    /*
     * A `@lid` is a WhatsApp internal identifier, NOT a dialable phone
     * number: a LID that happened to look like an Indonesian mobile
     * number would otherwise become a link to a stranger. `me.id` is a
     * phone-number JID (`@s.whatsapp.net`) and `me.lid` is a separate
     * field, so refusing the lid host cannot reject a real number.
     */
    if (host === "lid") {
        return null;
    }

    const numberPart = userPart.split(":")[0] ?? "";

    return normalizePhone(numberPart);
}

/**
 * Resolve the admin destination for ORDER CONFIRMATION.
 *
 * Shaped as a result object, never a throw: the caller's job is to show
 * the customer that the button is unavailable, and a page/endpoint must
 * not 500 because the WhatsApp session happened to be down.
 */
export async function resolveAdminWhatsAppTarget(): Promise<AdminWhatsAppTarget> {
    try {
        /*
         * Dynamic import on purpose. Baileys is ESM-only and heavy and
         * the project deliberately keeps it out of the static server
         * dependency graph (see lib/notification/index.ts). Loading it
         * here also means a broken/missing WhatsApp install degrades to
         * "unavailable" instead of breaking the customer's order page.
         */
        const { getWhatsAppService } = await import(
            "@/lib/whatsapp/service"
        );

        const status = getWhatsAppService().getStatus();

        if (status.status !== "CONNECTED") {
            return {
                available: false,
                reason: "NOT_CONNECTED",
                connectionStatus: status.status,
            };
        }

        const phoneNumber = parseAdminPhoneFromSession(
            status.phoneNumber
        );

        if (!phoneNumber) {
            /*
             * Connected, but the account number is missing or is not a
             * valid international mobile number. Fail closed: no link.
             */
            return {
                available: false,
                reason: "NO_NUMBER",
                connectionStatus: status.status,
            };
        }

        return {
            available: true,
            phoneNumber,
            connectionStatus: "CONNECTED",
        };
    } catch (error) {
        console.error(
            "[WHATSAPP] Admin confirmation number unavailable:",
            error instanceof Error ? error.message : error
        );

        return {
            available: false,
            reason: "SERVICE_ERROR",
            connectionStatus: null,
        };
    }
}
