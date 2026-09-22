/**
 * ==========================================
 * ADMIN BOOTSTRAP — SECURITY TESTS
 * ==========================================
 *
 * Verifies the `lib/admin-bootstrap` behaviour used by
 * `npm run admin:create`:
 *
 *   1. validation: email format, password requirements (mirroring the
 *      existing registration rules), confirm-password match
 *   2. creation: hashes the password with the existing mechanism,
 *      stores the hash (never the plaintext), assigns role ADMIN
 *   3. idempotency: an existing email is reported and its password is
 *      NEVER overwritten
 *
 * The database is always mocked — no test touches a real DB and no
 * real credentials are used.
 */

jest.mock("@/lib/prisma", () => {
    const user = {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };

    return {
        prisma: { user },
    };
});

import {
    createAdminAccount,
    validateAdminCreateInput,
} from "@/lib/admin-bootstrap";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const mockedUser = prisma.user as unknown as {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
};

beforeEach(() => {
    jest.clearAllMocks();
    mockedUser.findUnique.mockResolvedValue(null);
    mockedUser.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => ({
            id: "admin-1",
            email: args.data.email,
        })
    );
});

describe("validateAdminCreateInput", () => {
    test("accepts a valid email and password pair", () => {
        const result = validateAdminCreateInput({
            email: "  admin@example.com  ",
            password: "Admin1234",
            confirmPassword: "Admin1234",
        });

        expect(result).toEqual({
            ok: true,
            email: "admin@example.com",
        });
    });

    test("rejects an invalid email", () => {
        const result = validateAdminCreateInput({
            email: "not-an-email",
            password: "Admin1234",
            confirmPassword: "Admin1234",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(
                "Admin email is invalid."
            );
        }
    });

    test("rejects an empty email", () => {
        const result = validateAdminCreateInput({
            email: "   ",
            password: "Admin1234",
            confirmPassword: "Admin1234",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(
                "Admin email is required."
            );
        }
    });

    test("enforces the existing password requirements", () => {
        const cases: Array<[string, string]> = [
            ["short", "Password must be at least 8 characters."],
            ["upperlower123", "Password must contain at least 1 uppercase letter."],
            ["UPPERR123", "Password must contain at least 1 lowercase letter."],
            ["Uppercaseabc", "Password must contain at least 1 digit."],
        ];

        for (const [password, expected] of cases) {
            const result = validateAdminCreateInput({
                email: "admin@example.com",
                password,
                confirmPassword: password,
            });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.errors).toContain(expected);
            }
        }
    });

    test("rejects a password that does not match the confirmation", () => {
        const result = validateAdminCreateInput({
            email: "admin@example.com",
            password: "Admin1234",
            confirmPassword: "Admin9999",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(
                "Password and confirm password do not match."
            );
        }
    });

    test("rejects an empty confirmation", () => {
        const result = validateAdminCreateInput({
            email: "admin@example.com",
            password: "Admin1234",
            confirmPassword: "",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(
                "Confirm password is required."
            );
        }
    });
});

describe("createAdminAccount", () => {
    test("creates an ADMIN user storing a bcrypt hash, never the plaintext", async () => {
        const plaintext = "Admin1234";

        const result = await createAdminAccount(
            " admin@example.com ",
            plaintext
        );

        expect(result).toEqual({
            ok: true,
            created: true,
            email: "admin@example.com",
        });

        expect(mockedUser.findUnique).toHaveBeenCalledWith({
            where: { email: "admin@example.com" },
        });

        const createArgs = mockedUser.create.mock.calls[0][0];
        expect(createArgs.data.email).toBe("admin@example.com");
        expect(createArgs.data.role).toBe("ADMIN");
        expect(createArgs.data.password).not.toBe(plaintext);
        expect(createArgs.data.password).not.toContain(plaintext);
        expect(createArgs.data.password).toMatch(/^\$2[aby]\$/);

        await expect(
            verifyPassword(plaintext, createArgs.data.password)
        ).resolves.toBe(true);
    });

    test("returned result never exposes the password", async () => {
        const result = await createAdminAccount(
            "admin@example.com",
            "Admin1234"
        );

        expect(Object.keys(result)).not.toContain("password");
        expect(JSON.stringify(result)).not.toContain("Admin1234");
    });

    test("existing email is reported and the password is never overwritten", async () => {
        mockedUser.findUnique.mockResolvedValue({
            id: "existing-admin",
            email: "admin@example.com",
            role: "ADMIN",
        });

        const result = await createAdminAccount(
            "admin@example.com",
            "NewPassword123"
        );

        expect(result).toEqual({
            ok: true,
            created: false,
            reason: "ALREADY_EXISTS",
            email: "admin@example.com",
        });

        expect(mockedUser.create).not.toHaveBeenCalled();
        expect(mockedUser.update).not.toHaveBeenCalled();
    });

    test("existing non-admin with the same email is also left untouched", async () => {
        mockedUser.findUnique.mockResolvedValue({
            id: "existing-customer",
            email: "admin@example.com",
            role: "CUSTOMER",
        });

        const result = await createAdminAccount(
            "admin@example.com",
            "NewPassword123"
        );

        expect(result.created).toBe(false);
        expect(mockedUser.create).not.toHaveBeenCalled();
        expect(mockedUser.update).not.toHaveBeenCalled();
    });
});