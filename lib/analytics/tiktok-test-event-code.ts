/**
 * ==========================================
 * TEST EVENT CODE (TikTok Events Manager)
 * ==========================================
 *
 * TikTok accepts at most one top-level `test_event_code` per
 * event/track request. It is a TESTING-ONLY tag: TikTok routes
 * those events to the "Test Events" view and does not use them
 * for reporting.
 *
 * This is therefore an operational switch, not store data:
 *   - it lives in the environment, NOT in StoreSetting
 *   - it is never exposed through NEXT_PUBLIC_* / the browser
 *   - leaving it unset keeps production exactly as before
 *
 * The code itself is not a credential (it is visible in Events
 * Manager), but it is still treated as an opaque single-line
 * token and never logged.
 *
 * ------------------------------------------------------------------
 * WHY THIS MODULE IS **NOT** `server-only`
 * ------------------------------------------------------------------
 * Unlike lib/analytics/tiktok-events-config.ts (which reads the
 * Access Token from the database), this module reads exactly ONE
 * environment variable and nothing else: no database, no secret,
 * no customer data.
 *
 * Keeping it free of the `server-only` marker is deliberate: Next
 * resolves that marker through its bundler, so outside the Next.js
 * runtime `import "server-only"` cannot even be resolved. A
 * standalone Node/tsx diagnostic (scripts/tiktok-events-api-check.ts)
 * must be able to import the SAME rule the application uses,
 * otherwise the script could report a code as usable while the app
 * skipped it.
 *
 * The application keeps importing these helpers through
 * lib/analytics/tiktok-events-config.ts, which still carries the
 * `server-only` marker and re-exports them.
 */

export const TIKTOK_TEST_EVENT_CODE_ENV =
    "TIKTOK_TEST_EVENT_CODE";

/** Upper bound to reject absurd payloads (real codes are short, e.g. TEST68129). */
export const MAX_TIKTOK_TEST_EVENT_CODE_LENGTH = 64;

/**
 * Normalize a raw test event code.
 *
 * Returns null when the value is absent / blank / too long /
 * not a single opaque token line (whitespace or control
 * characters would corrupt the request or leak a malformed
 * value to TikTok).
 */
export function normalizeTikTokTestEventCode(
    value: unknown
): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const code = value.trim();

    if (!code) {
        return null;
    }

    if (
        code.length >
        MAX_TIKTOK_TEST_EVENT_CODE_LENGTH
    ) {
        return null;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
        return null;
    }

    return code;
}

/**
 * Resolve the configured test event code from the environment.
 *
 * Read at call time so a restart with/without the variable is
 * the only thing that toggles test mode. Fails closed (null)
 * for anything unusable.
 */
export function getTikTokTestEventCode(
    env: NodeJS.ProcessEnv = process.env
): string | null {
    return normalizeTikTokTestEventCode(
        env[TIKTOK_TEST_EVENT_CODE_ENV]
    );
}
