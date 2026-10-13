"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  FiHome,
  FiCoffee,
  FiShoppingBag,
} from "react-icons/fi";
import { LiaShippingFastSolid } from "react-icons/lia";

const menus = [
  {
    title: "Beranda",
    href: "/home",
    icon: FiHome,
  },
  {
    title: "Menu",
    href: "/products",
    icon: FiCoffee,
  },
  {
    title: "Orders",
    href: "/orders",
    icon: LiaShippingFastSolid,
  },
  {
    title: "Keranjang",
    href: "/cart",
    icon: FiShoppingBag,
  },
];

/*
 * NOTE: the "Saya" → /profile entry was removed together with the
 * customer account area. Customers browse and buy as guests, so every
 * remaining entry points at a public page that works without a
 * session.
 */

export default function BottomNavbar() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white/95 px-4 py-2 backdrop-blur-md">
      <div className="mx-auto flex max-w-lg items-center justify-around py-2">
        {menus.map((menu) => {
          const Icon = menu.icon;

          const active =
            pathname === menu.href;

          return (
            <Link
              key={menu.title}
              href={menu.href}
              className="flex w-16 flex-col items-center justify-center gap-1 py-1"
            >
              <Icon
                size={20}
                className={`transition-colors duration-150 ${
                  active ? "text-rose-600" : "text-gray-400"
                }`}
              />

              <span
                className={`text-[11px] font-medium transition-colors duration-150 ${
                  active ? "text-rose-600" : "text-gray-500"
                }`}
              >
                {menu.title}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}