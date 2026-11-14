import type { Metadata } from "next";
import LoginForm from "@/components/auth/LoginForm";

export const metadata: Metadata = {
    title: "Login Admin",
    robots: { index: false, follow: false },
};

export default function AdminLoginPage() {
    return (
        <main className="min-h-screen bg-gradient-to-b from-rose-50 via-white to-white">
            <LoginForm adminMode />
        </main>
    );
}
