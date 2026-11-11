import { z } from "zod";

export const registerSchema = z
    .object({
        phone: z.string().trim().min(8).max(24),
        password: z
            .string()
            .min(8)
            .max(72)
            .regex(/[A-Z]/)
            .regex(/[a-z]/)
            .regex(/[0-9]/),
        confirmPassword: z.string().min(1),
    })
    .refine((data) => data.password === data.confirmPassword, {
        path: ["confirmPassword"],
    });
