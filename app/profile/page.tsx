import type { Metadata } from "next";

import { pageMetadata } from "@/lib/site-metadata";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import ProfileContent from "./ProfileContent";

export const metadata: Metadata = pageMetadata({
    title: "Profil Saya",
    description:
        "Kelola data profil, alamat pengiriman, dan preferensi akun Anda di Mutiara Abadi.",
    noindex: true,
});

export default async function ProfilePage() {
    const session = await auth();

    if (!session?.user?.id) {
        redirect("/login");
    }

    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
            name: true,
            email: true,
            phone: true,
        },
    });

    if (!user) {
        redirect("/login");
    }

    return <ProfileContent user={user} />;
}
