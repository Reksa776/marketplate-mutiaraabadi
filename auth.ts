import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

/**
 * ==========================================
 * AUTHENTICATION — ADMIN & AFFILIATE ONLY
 * ==========================================
 *
 * The marketplace no longer has customer accounts: buying is guest-only
 * (see lib/checkout.ts + lib/guest-identity.ts). NextAuth therefore
 * exists ONLY to authenticate:
 *
 *   ADMIN      → the /admin dashboard and /api/admin/**
 *   AFFILIATE  → the /affiliate dashboard, referral code and payouts
 *
 * WHY THE ROLE CHECK IS NOT JUST `role !== "CUSTOMER"`
 * ---------------------------------------------------
 * In THIS schema a real affiliate is stored as `role = CUSTOMER` with an
 * `AffiliateProfile` row (verified against the live data, not assumed
 * from the `Role` enum). Filtering purely on the enum would lock every
 * working affiliate out of their own dashboard.
 *
 * Login is allowed when the user is ANY of:
 *   1. role = ADMIN                     → dashboard operator
 *   2. role = AFFILIATOR                → explicit affiliate role
 *   3. has an AffiliateProfile row      → the affiliate identity this
 *                                         schema actually uses
 *   4. role = SELLER                    → staff enum kept working
 *
 * A plain `role = CUSTOMER` account with NO affiliate profile can no
 * longer sign in. This is enforced in `authorize()` — NOT by a UI
 * redirect — so it cannot be bypassed by calling the API directly.
 *
 * The Google provider has been removed: it existed only for customer
 * sign-in and is not used by admin/affiliate, and removing it also
 * removes the OAuth account-linking attack surface entirely.
 */

/** Re-validate the stored role at most this often (ms). */
const ROLE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

type AllowedRole = "ADMIN" | "AFFILIATOR" | "SELLER";

const ALLOWED_ROLES: AllowedRole[] = [
    "ADMIN",
    "AFFILIATOR",
    "SELLER",
];

/**
 * Does this account still hold an allowed role?
 * Fails closed: an unknown/deleted account is never allowed.
 */
async function isAuthorizedAccount(userId: string): Promise<{
    allowed: boolean;
    role: string | null;
}> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            role: true,
            affiliateProfile: {
                select: { id: true },
            },
        },
    });

    if (!user) {
        return { allowed: false, role: null };
    }

    const hasAffiliateProfile = Boolean(
        user.affiliateProfile
    );

    const allowed =
        hasAffiliateProfile ||
        ALLOWED_ROLES.includes(
            user.role as AllowedRole
        );

    return {
        allowed,
        role: user.role,
    };
}

export const {
    handlers,
    auth,
    signIn,
    signOut,
} = NextAuth({
    adapter: PrismaAdapter(prisma),

    session: {
        strategy: "jwt",
    },

    pages: {
        signIn: "/login",
    },

    providers: [
        /*
         * CREDENTIALS
         *
         * The ONLY provider: customer sign-in no longer exists.
         */
        Credentials({
            name: "Credentials",

            credentials: {
                identifier: {
                    label: "Email / Nomor HP",
                    type: "text",
                },

                password: {
                    label: "Password",
                    type: "password",
                },
            },

            async authorize(credentials) {
                /*
                 * Pastikan identifier dan password
                 * dikirim dari form login.
                 */
                if (
                    !credentials?.identifier ||
                    !credentials?.password
                ) {
                    return null;
                }

                const identifier = String(
                    credentials.identifier
                ).trim();

                const password = String(
                    credentials.password
                );

                /*
                 * Cari user berdasarkan:
                 *
                 * email ATAU nomor HP
                 */
                const user =
                    await prisma.user.findFirst({
                        where: {
                            OR: [
                                {
                                    email: identifier,
                                },
                                {
                                    phone: identifier,
                                },
                            ],
                        },
                        include: {
                            affiliateProfile: {
                                select: { id: true },
                            },
                        },
                    });

                /*
                 * SECURITY: Constant-time response
                 * to prevent user enumeration.
                 * Always run verifyPassword even if
                 * user not found, to ensure same
                 * response time.
                 */

                /*
                 * User tidak ditemukan
                 */
                if (!user) {
                    // Run dummy verify to prevent timing attack
                    await verifyPassword(
                        password,
                        "$2a$12$x dummy hash to prevent timing attack"
                    );
                    return null;
                }

                /*
                 * User tidak mempunyai password.
                 *
                 * Biasanya bisa terjadi pada user
                 * yang dibuat melalui OAuth/Google.
                 */
                if (!user.password) {
                    // Run dummy verify to prevent timing attack
                    await verifyPassword(
                        password,
                        "$2a$12$x dummy hash to prevent timing attack"
                    );
                    return null;
                }

                /*
                 * Verifikasi password
                 */
                const valid = await verifyPassword(
                    password,
                    user.password
                );

                if (!valid) {
                    return null;
                }

                /*
                 * ==========================================
                 * ROLE AUTHORIZATION (fail-closed)
                 * ==========================================
                 *
                 * A CUSTOMER account without an affiliate profile is
                 * rejected HERE, at the credential boundary. The UI is
                 * never the authorization mechanism.
                 */
                const hasAffiliateProfile = Boolean(
                    user.affiliateProfile
                );

                const isAllowedRole =
                    ALLOWED_ROLES.includes(
                        user.role as AllowedRole
                    );

                if (
                    !hasAffiliateProfile &&
                    !isAllowedRole
                ) {
                    return null;
                }

                /*
                 * User berhasil login.
                 *
                 * Role ikut dikirim supaya nanti
                 * bisa dimasukkan ke JWT/session.
                 */
                return {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    role: user.role,
                    isAffiliate: hasAffiliateProfile,
                };
            },
        }),
    ],

    callbacks: {
        /*
         * SIGN IN
         *
         * authorize() already enforced the role policy. This is a
         * second, independent check so a future provider cannot slip an
         * unauthorized account through.
         */
        async signIn({ user }) {
            if (!user?.id) {
                return false;
            }

            const check = await isAuthorizedAccount(
                user.id
            );

            return check.allowed;
        },

        /*
         * JWT
         *
         * Simpan ID dan ROLE user ke token, lalu re-validasi secara
         * berkala: kalau akun dihapus atau rolenya dicabut, sesi lama
         * ikut berhenti (bukan hanya mengandalkan redirect UI).
         *
         * With a JWT strategy the session outlives the DB row, so this
         * periodic re-check is what actually keeps an admin/affiliate
         * revocation effective.
         */
        async jwt({ token, user }) {
            if (user) {
                token.id = (user as any).id;

                token.role = (user as any).role;

                token.isAffiliate = Boolean(
                    (user as any).isAffiliate
                );

                (token as any).checkedAt = Date.now();
            }

            const lastCheck = Number(
                (token as any).checkedAt ?? 0
            );

            if (
                typeof token.id === "string" &&
                Date.now() - lastCheck >
                    ROLE_RECHECK_INTERVAL_MS
            ) {
                const check =
                    await isAuthorizedAccount(
                        token.id
                    );

                if (!check.allowed) {
                    /*
                     * Invalidate the token: strip the identity so
                     * downstream `auth()` sees an unauthenticated
                     * session instead of a stale privileged one.
                     */
                    delete (token as any).id;
                    delete (token as any).role;
                    (token as any).isAffiliate = false;
                    (token as any).invalidated = true;

                    return token;
                }

                (token as any).role = check.role;
                (token as any).checkedAt = Date.now();
            }

            return token;
        },

        /*
         * SESSION
         *
         * Masukkan ID dan ROLE dari JWT
         * ke session.user.
         */
        async session({ session, token }) {
            if (session.user) {
                /*
                 * An invalidated token yields no id/role, so
                 * `requireAdmin()` and every role check fail closed.
                 */
                (session.user as any).id = token.id;

                (session.user as any).role =
                    token.role;

                (session.user as any).isAffiliate =
                    Boolean(
                        (token as any).isAffiliate
                    );
            }

            return session;
        },
    },
});
