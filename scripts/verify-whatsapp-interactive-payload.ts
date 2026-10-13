/**
 * ==========================================================
 * VERIFY: WHATSAPP INTERACTIVE (NATIVE FLOW) PAYLOAD
 * ==========================================================
 *
 * Run:  npx tsx scripts/verify-whatsapp-interactive-payload.ts
 *
 * WHAT THIS PROVES
 *
 *   The payload the bot would hand to `relayMessage()` is a REAL
 *   protobuf `interactiveMessage`: this builds it exactly as production
 *   does, wraps it with Baileys' own `generateWAMessageFromContent`, and
 *   round-trips it through `proto.Message.encode/decode` to show the
 *   structure survives the wire format intact.
 *
 * WHAT THIS DOES NOT PROVE — READ THIS BEFORE TRUSTING THE FEATURE
 *
 *   * It does NOT prove that WhatsApp renders a button. Rendering is
 *     decided by the recipient's client and by WhatsApp's handling of a
 *     non-official sender; Android has been reported to show nothing
 *     while iOS/Web draw them, and a receiver can be shown
 *     "message not compatible".
 *   * It does NOT send anything. No socket, no session, no network.
 *
 * The only real acceptance test is a manual send to a test device on
 * BOTH Android and iPhone with WHATSAPP_INTERACTIVE_BUTTONS=1.
 */

import {
    buildInteractiveContent,
    isInteractiveButtonsEnabled,
    MAIN_MENU_BUTTONS,
    POST_DELIVERY_BUTTONS,
    type WhatsAppInteractiveContent,
} from "../lib/whatsapp/inbound/interactive";
import {
    MAIN_MENU_TEXT,
    POST_DELIVERY_MENU_TEXT,
} from "../lib/whatsapp/inbound/menu";

/* Baileys is ESM-only; load it dynamically so this script can run under
 * tsx/Node without converting the whole project. */
type ProtoMessage = {
    encode: (message: unknown) => { finish: () => Uint8Array };
    decode: (bytes: Uint8Array) => Record<string, unknown>;
};

type BaileysModule = {
    generateWAMessageFromContent: (
        jid: string,
        message: unknown,
        options: { userJid: string }
    ) => {
        key?: { id?: string | null };
        message?: unknown;
    };
    proto: {
        Message: ProtoMessage;
        IMessage: unknown;
    };
};

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
    if (condition) {
        console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
        return;
    }

    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
    const jid = "6281234567890@s.whatsapp.net";

    const baileys = (await import(
        "@whiskeysockets/baileys"
    )) as unknown as BaileysModule;

    console.log("=== flag posture ===");
    check(
        "flag is OFF when unset (production default)",
        isInteractiveButtonsEnabled({}) === false
    );
    check(
        "flag is ON only for an explicit opt-in",
        isInteractiveButtonsEnabled({
            WHATSAPP_INTERACTIVE_BUTTONS: "1",
        }) === true
    );

    console.log("\n=== payload round trip (MAIN) ===");

    const content = buildInteractiveContent({
        menu: "MAIN",
        bodyText: MAIN_MENU_TEXT,
    });

    const generated = baileys.generateWAMessageFromContent(
        jid,
        content as unknown as BaileysModule["proto"]["IMessage"],
        { userJid: jid }
    );

    check("message id generated", Boolean(generated?.key?.id));
    check("message content generated", Boolean(generated?.message));

    const encoded = baileys.proto.Message.encode(
        generated.message
    ).finish();

    const decoded = baileys.proto.Message.decode(encoded) as {
        interactiveMessage?: {
            body?: { text?: string | null };
            footer?: { text?: string | null };
            nativeFlowMessage?: {
                buttons?: Array<{
                    name?: string | null;
                    buttonParamsJson?: string | null;
                }>;
            };
        };
    };

    const interactive = decoded.interactiveMessage;
    const buttons =
        interactive?.nativeFlowMessage?.buttons ?? [];

    check("interactiveMessage survived encoding", Boolean(interactive));
    check(
        "body carries the FULL numbered menu (the fallback)",
        interactive?.body?.text === MAIN_MENU_TEXT,
        `${(interactive?.body?.text ?? "").length} chars`
    );
    check("footer present", Boolean(interactive?.footer?.text));
    check(
        "one button per main-menu option",
        buttons.length === MAIN_MENU_BUTTONS.length,
        `${buttons.length} buttons`
    );
    check(
        "encoded payload size is sane",
        encoded.length > 0,
        `${encoded.length} bytes`
    );

    console.log("\n=== every button id/label survives ===");

    for (const button of MAIN_MENU_BUTTONS) {
        const encodedButton = buttons.find((candidate) => {
            try {
                return (
                    JSON.parse(candidate.buttonParamsJson ?? "{}") as {
                        id?: string;
                    }
                ).id === button.id;
            } catch {
                return false;
            }
        });

        check(
            `button "${button.label}" → ${button.id}`,
            Boolean(encodedButton),
            encodedButton ? "round-tripped" : "MISSING"
        );
        check(
            `button "${button.id}" uses quick_reply`,
            encodedButton?.name === "quick_reply"
        );
    }

    console.log("\n=== payload round trip (POST_DELIVERY) ===");

    const postContent: WhatsAppInteractiveContent =
        buildInteractiveContent({
            menu: "POST_DELIVERY",
            bodyText: POST_DELIVERY_MENU_TEXT,
        });

    const postDecoded = baileys.proto.Message.decode(
        baileys.proto.Message.encode(
            baileys.generateWAMessageFromContent(
                jid,
                postContent as unknown as BaileysModule["proto"]["IMessage"],
                { userJid: jid }
            ).message
        ).finish()
    ) as typeof decoded;

    const postIds = (
        postDecoded.interactiveMessage?.nativeFlowMessage?.buttons ?? []
    ).map((button) => {
        try {
            return (
                JSON.parse(button.buttonParamsJson ?? "{}") as {
                    id?: string;
                }
            ).id;
        } catch {
            return null;
        }
    });

    check(
        "post-delivery buttons use their own id namespace",
        JSON.stringify(postIds) ===
            JSON.stringify(
                POST_DELIVERY_BUTTONS.map((button) => button.id)
            ),
        postIds.join(", ")
    );

    console.log(
        "\nNOTE: this verifies the PAYLOAD, not that WhatsApp draws a\n" +
            "      button. Confirm on a real Android device AND a real\n" +
            "      iPhone with WHATSAPP_INTERACTIVE_BUTTONS=1 before\n" +
            "      enabling it for customers.\n"
    );

    if (failures > 0) {
        console.error(`VERIFY FAILED — ${failures} check(s) failed.`);
        process.exit(1);
    }

    console.log("VERIFY OK — interactive payload encodes correctly.");
}

main().catch((error) => {
    console.error("VERIFY ERROR:", error);
    process.exit(1);
});
