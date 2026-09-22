/**
 * ==========================================
 * ADMIN BOOTSTRAP
 * ==========================================
 *
 * Logic used by `npm run admin:create`. It is kept separate from the
 * CLI so the behaviour can be unit-tested without spawning an
 * interactive terminal.
 *
 * SECURITY RULES (enforced here):
 *  - the plaintext password exists only in process memory and only for
 *    as long as it takes to hash it — it is never stored, logged or
 *    printed
 *  - an account whose email already exists is NEVER touched: its
 *    password is never overwritten, silently or otherwise
 *  - the stored credential is a bcrypt hash produced by the exact same
 *    mechanism the sign-in flow verifies against (lib/password)
 *
 * The token-based password reset flow for normal users/admins is
 * independent of this module and is intentionally untouched.
 */

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

/* ==========================================
 * RESULT TYPES
 * ========================================== */

export type AdminCreateSuccess = {
    ok: true;
    created: true;
    email: string;
};

export type AdminCreateAlreadyExists = {
    ok: true;
    created: false;
    reason: "ALREADY_EXISTS";
    email: string;
};

export type AdminCreateResult =
    | AdminCreateSuccess
    | AdminCreateAlreadyExists;

export type AdminCreateValidation =
    | {
          ok: true;
          email: string;
      }
    | {
          ok: false;
          errors: string[];
      };

/* ==========================================
 * VALIDATION
 * ========================================== */

/**
 * Password rules mirror the existing account registration rules
 * (lib/validations/register.ts): minimum 8 characters plus at least
 * one uppercase letter, one lowercase letter and one digit.
 */

const adminEmailSchema = z
    .string()
    .trim()
    .min(1, "Admin email is required.")
    .email("Admin email is invalid.");

const adminPasswordSchema = z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .regex(
        /[A-Z]/,
        "Password must contain at least 1 uppercase letter."
    )
    .regex(
        /[a-z]/,
        "Password must contain at least 1 lowercase letter."
    )
    .regex(/[0-9]/, "Password must contain at least 1 digit.");

export function validateAdminCreateInput(input: {
    email: string;
    password: string;
    confirmPassword: string;
}): AdminCreateValidation {
    const errors: string[] = [];
    let email: string | null = null;

    const emailCheck = adminEmailSchema.safeParse(input.email);
    if (emailCheck.success) {
        email = emailCheck.data;
    } else {
        errors.push(
            ...emailCheck.error.issues.map((issue) => issue.message)
        );
    }

    const passwordCheck = adminPasswordSchema.safeParse(
        input.password
    );
    if (!passwordCheck.success) {
        errors.push(
            ...passwordCheck.error.issues.map(
                (issue) => issue.message
            )
        );
    }

    if (!input.confirmPassword) {
        errors.push("Confirm password is required.");
    } else if (input.password !== input.confirmPassword) {
        errors.push(
            "Password and confirm password do not match."
        );
    }

    if (errors.length > 0 || email === null) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        email,
    };
}

/* ==========================================
 * CREATE
 * ========================================== */

export async function createAdminAccount(
    email: string,
    password: string
): Promise<AdminCreateResult> {
    const normalizedEmail = email.trim().toLowerCase();

    /*
     * Email already exists → report it and do nothing.
     *
     * Deliberately NEVER overwrites the password of an existing user
     * (admin or otherwise).
     */
    const existing = await prisma.user.findUnique({
        where: { email: normalizedEmail },
    });

    if (existing) {
        return {
            ok: true,
            created: false,
            reason: "ALREADY_EXISTS",
            email: normalizedEmail,
        };
    }

    /*
     * The plaintext password leaves the caller, enters the bcrypt
     * hasher and is immediately out of scope. Only the hash is ever
     * persisted.
     */
    const hashedPassword = await hashPassword(password);

    const user = await prisma.user.create({
        data: {
            email: normalizedEmail,
            password: hashedPassword,
            role: "ADMIN",
            name: "Administrator",
        },
    });

    return {
        ok: true,
        created: true,
        email: user.email ?? normalizedEmail,
    };
}