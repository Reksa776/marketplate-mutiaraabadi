"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
    FiBox,
    FiGrid,
    FiLogOut,
    FiSettings,
    FiShoppingBag,
    FiUsers,
    FiMenu,
    FiX,
    FiFileText,
    FiTag,
    FiMessageCircle,
    FiZap,
    FiTarget,
    FiImage,
    FiChevronDown,
    FiChevronRight,
    FiPercent,
    FiTruck,
    FiPackage,
    FiDollarSign,
    FiUserPlus,
    FiUserCheck,
    FiCodesandbox,
    FiShoppingCart,
    FiPercent as FiBulkDiscount,
    FiMail,
    FiStar,
    FiTrendingUp,
    FiClock,
    FiSearch,
    FiShoppingBag as FiCartReminder,
    FiArrowRight,
    FiHeart,
    FiDisc,
    FiRefreshCw,
} from "react-icons/fi";
import { useState } from "react";

type MenuItem = {
    label: string;
    href: string;
    icon: any;
};

type MenuGroup = {
    label: string;
    icon: any;
    children: MenuItem[];
};

type NavItem = MenuItem | MenuGroup;

function isMenuGroup(item: NavItem): item is MenuGroup {
    return "children" in item;
}

const menuItems: NavItem[] = [
    {
        label: "Dashboard",
        href: "/admin",
        icon: FiGrid,
    },
    {
        label: "Produk",
        href: "/admin/products",
        icon: FiBox,
    },
    {
        label: "Orderan",
        href: "/admin/orders",
        icon: FiShoppingBag,
    },
    {
        label: "Scan Resi",
        href: "/admin/scan-resi",
        icon: FiSearch,
    },
    {
        label: "Refund",
        href: "/admin/refunds",
        icon: FiRefreshCw,
    },
    {
        label: "Marketing",
        icon: FiTarget,
        children: [
            { label: "Flash Sale", href: "/admin/flash-sales", icon: FiZap },
            { label: "Kampanye", href: "/admin/campaigns", icon: FiTarget },
            { label: "Diskon Produk", href: "/admin/discounts", icon: FiPercent },
            { label: "Voucher & Promo Code", href: "/admin/vouchers", icon: FiTag },
            { label: "Beli Banyak Lebih Hemat", href: "/admin/bulk-discounts", icon: FiShoppingCart },
            { label: "Diskon Ongkir", href: "/admin/shipping-discounts", icon: FiTruck },
            { label: "Promosi / Banner", href: "/admin/promotions", icon: FiImage },
            { label: "Spin Wheel", href: "/admin/spin-wheel", icon: FiDisc },
        ],
    },
    {
        label: "Broadcast",
        icon: FiMail,
        children: [
            { label: "Produk Terlaris", href: "/admin/broadcasts?type=BEST_SELLER", icon: FiStar },
            { label: "Produk Baru", href: "/admin/broadcasts?type=NEW_PRODUCT", icon: FiPackage },
            { label: "Beli Lagi", href: "/admin/broadcasts?type=BUY_AGAIN", icon: FiArrowRight },
            { label: "Pembeli Tidak Aktif", href: "/admin/broadcasts?type=INACTIVE_BUYER", icon: FiClock },
            { label: "Harga Turun", href: "/admin/broadcasts?type=PRICE_DROP", icon: FiTrendingUp },
            { label: "Keranjang", href: "/admin/broadcasts?type=CART_REMINDER", icon: FiShoppingBag },
            { label: "Reminder Checkout", href: "/admin/broadcasts?type=CHECKOUT_REMINDER", icon: FiDollarSign },
            { label: "Terima Kasih", href: "/admin/broadcasts?type=THANK_YOU", icon: FiHeart },
        ],
    },
    {
        label: "Reports",
        href: "/admin/reports",
        icon: FiFileText,
    },
    {
        label: "Pengguna",
        href: "/admin/users",
        icon: FiUsers,
    },
    {
        label: "Affiliator",
        icon: FiUserPlus,
        children: [
            { label: "Pengajuan", href: "/admin/affiliate", icon: FiUserPlus },
            { label: "Management", href: "/admin/affiliate/manage", icon: FiUserCheck },
            { label: "Payouts", href: "/admin/affiliate/payouts", icon: FiDollarSign },
            { label: "Audit Log", href: "/admin/affiliate/audit-log", icon: FiClock },
        ],
    },
    {
        label: "WhatsApp",
        href: "/admin/whatsapp",
        icon: FiMessageCircle,
    },
    {
        label: "Pengaturan",
        href: "/admin/settings",
        icon: FiSettings,
    },
];

export default function AdminNavbar() {
    const pathname = usePathname();
    const [open, setOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);

    function isActive(href: string) {
        if (href === "/admin") {
            return pathname === "/admin";
        }

        return pathname.startsWith(href);
    }

    async function handleLogout() {
        try {
            setLoggingOut(true);

            await signOut({
                callbackUrl: "/",
            });
        } catch (error) {
            console.error(
                "LOGOUT ERROR:",
                error
            );

            setLoggingOut(false);
        }
    }

    return (
        <>
            {/* MOBILE TOPBAR */}
            <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 lg:hidden">
                <Link
                    href="/admin"
                    className="text-lg font-bold text-gray-900"
                >
                    Admin
                    <span className="text-rose-600">
                        Panel
                    </span>
                </Link>

                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className="rounded-xl p-2 text-gray-700 hover:bg-gray-100"
                >
                    {open ? (
                        <FiX size={22} />
                    ) : (
                        <FiMenu size={22} />
                    )}
                </button>
            </header>

            {/* MOBILE MENU */}
            {open && (
                <div
                    className="fixed inset-0 z-40 bg-black/30 lg:hidden"
                    onClick={() => setOpen(false)}
                >
                    <div
                        className="absolute left-0 top-16 flex h-[calc(100vh-4rem)] w-72 flex-col overflow-hidden border-r border-gray-200 bg-white p-4 shadow-xl"
                        onClick={(e) =>
                            e.stopPropagation()
                        }
                    >
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <AdminMenu
                                pathname={pathname}
                                isActive={isActive}
                                onNavigate={() =>
                                    setOpen(false)
                                }
                            />
                        </div>

                        {/* MOBILE LOGOUT */}
                        <div className="mt-4 shrink-0 border-t border-gray-100 pt-4">
                            <button
                                type="button"
                                onClick={handleLogout}
                                disabled={loggingOut}
                                className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <FiLogOut size={19} />

                                <span>
                                    {loggingOut
                                        ? "Keluar..."
                                        : "Logout"}
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* DESKTOP SIDEBAR */}
            <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-gray-200 bg-white lg:block">
                <div className="flex h-16 items-center border-b border-gray-200 px-6">
                    <Link
                        href="/admin"
                        className="text-xl font-bold text-gray-900"
                    >
                        Admin
                        <span className="text-rose-600">
                            Panel
                        </span>
                    </Link>
                </div>

                <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden p-4">
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <AdminMenu
                            pathname={pathname}
                            isActive={isActive}
                        />
                    </div>

                    <div className="mt-auto shrink-0 space-y-2 border-t border-gray-100 pt-4">
                        {/* KEMBALI KE TOKO */}
                        <Link
                            href="/"
                            className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
                        >
                            <FiLogOut size={18} />

                            <span>
                                Kembali ke Toko
                            </span>
                        </Link>

                        {/* LOGOUT */}
                        <button
                            type="button"
                            onClick={handleLogout}
                            disabled={loggingOut}
                            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <FiLogOut size={18} />

                            <span>
                                {loggingOut
                                    ? "Keluar..."
                                    : "Logout"}
                            </span>
                        </button>
                    </div>
                </div>
            </aside>
        </>
    );
}

function AdminMenu({
    pathname,
    isActive,
    onNavigate,
}: {
    pathname: string;
    isActive: (href: string) => boolean;
    onNavigate?: () => void;
}) {
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

    function toggleGroup(label: string) {
        setExpandedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
    }

    function isGroupActive(group: MenuGroup): boolean {
        return group.children.some((child) => isActive(child.href));
    }

    return (
        <nav className="space-y-1">
            {menuItems.map((item) => {
                if (isMenuGroup(item)) {
                    const group = item;
                    const GroupIcon = group.icon;
                    const expanded = expandedGroups[group.label] ?? isGroupActive(group);
                    const groupActive = isGroupActive(group);

                    return (
                        <div key={group.label}>
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.label)}
                                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${
                                    groupActive && expanded
                                        ? "bg-rose-50 text-rose-600"
                                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                                }`}
                            >
                                <GroupIcon size={19} />
                                <span className="flex-1 text-left">{group.label}</span>
                                {expanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                            </button>
                            {expanded && (
                                <div className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-3">
                                    {group.children.map((child) => {
                                        const ChildIcon = child.icon;
                                        const active = isActive(child.href);
                                        return (
                                            <Link
                                                key={child.href + child.label}
                                                href={child.href}
                                                onClick={onNavigate}
                                                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition ${
                                                    active
                                                        ? "bg-rose-50 text-rose-600"
                                                        : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                                                }`}
                                            >
                                                <ChildIcon size={14} />
                                                <span>{child.label}</span>
                                            </Link>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                }

                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${
                            active
                                ? "bg-rose-50 text-rose-600"
                                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                    >
                        <Icon size={19} />
                        <span>{item.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}