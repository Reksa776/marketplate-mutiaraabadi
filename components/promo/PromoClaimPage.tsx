"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FiCheck, FiGift, FiShoppingBag } from "react-icons/fi";

type PromoState = {
    active: boolean;
    claimed: boolean;
    dailyQuota: number;
    claimedCount: number;
    remaining: number;
    claimable: boolean;
    quotaDate: string;
};

export default function PromoClaimPage({
    slug,
    productId,
    variantId,
    title,
    description,
    product,
}: {
    slug: string;
    productId: number | null;
    variantId: number | null;
    title: string;
    description: string | null;
    product: {
        name: string;
        slug: string;
        image: string | null;
        variant: string;
        regularPrice: number;
        promoPrice: number;
    } | null;
}) {
    const router = useRouter();
    const [status, setStatus] = useState<PromoState | null>(null);
    const [loading, setLoading] = useState(true);
    const [claiming, setClaiming] = useState(false);
    const [error, setError] = useState("");
    const fireworksCanvasRef = useRef<HTMLCanvasElement>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`/api/promos/${encodeURIComponent(slug)}/claim`, {
                cache: "no-store",
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Promo belum bisa dimuat.");
            }
            setStatus(result.data);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Promo belum bisa dimuat.");
        } finally {
            setLoading(false);
        }
    }, [slug]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!status?.active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }

        const canvas = fireworksCanvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        let width = window.innerWidth;
        let height = window.innerHeight;
        let animationFrame = 0;
        let pendingBursts = 3;
        const timers: number[] = [];
        const particles: Array<{
            x: number;
            y: number;
            vx: number;
            vy: number;
            gravity: number;
            life: number;
            maxLife: number;
            color: string;
            radius: number;
        }> = [];

        const resizeCanvas = () => {
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = Math.round(width * pixelRatio);
            canvas.height = Math.round(height * pixelRatio);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        };

        const launchBurst = (position: number) => {
            const centerX = width * position;
            const centerY = height * (0.22 + Math.random() * 0.24);
            const color = `hsl(${Math.floor(Math.random() * 360)} 95% 58%)`;
            const count = 46;

            for (let index = 0; index < count; index += 1) {
                const angle = (Math.PI * 2 * index) / count;
                const speed = 1.5 + Math.random() * 3.2;
                const life = 48 + Math.floor(Math.random() * 28);
                particles.push({
                    x: centerX,
                    y: centerY,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    gravity: 0.035,
                    life,
                    maxLife: life,
                    color,
                    radius: 1.5 + Math.random() * 1.5,
                });
            }
        };

        const drawFrame = () => {
            context.clearRect(0, 0, width, height);

            for (let index = particles.length - 1; index >= 0; index -= 1) {
                const particle = particles[index];
                particle.x += particle.vx;
                particle.y += particle.vy;
                particle.vy += particle.gravity;
                particle.life -= 1;

                if (particle.life <= 0) {
                    particles.splice(index, 1);
                    continue;
                }

                context.globalAlpha = particle.life / particle.maxLife;
                context.fillStyle = particle.color;
                context.beginPath();
                context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
                context.fill();
            }

            context.globalAlpha = 1;
            if (pendingBursts > 0 || particles.length > 0) {
                animationFrame = window.requestAnimationFrame(drawFrame);
            }
        };

        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
        [0.22, 0.5, 0.78].forEach((position, index) => {
            timers.push(
                window.setTimeout(() => {
                    launchBurst(position);
                    pendingBursts -= 1;
                    if (!animationFrame) {
                        animationFrame = window.requestAnimationFrame(drawFrame);
                    }
                }, 120 + index * 420)
            );
        });

        return () => {
            timers.forEach(window.clearTimeout);
            window.cancelAnimationFrame(animationFrame);
            window.removeEventListener("resize", resizeCanvas);
            context.clearRect(0, 0, width, height);
        };
    }, [status?.active]);

    useEffect(() => {
        // Keep a page that stays open across midnight in sync with the
        // next Jakarta quota day, without polling the endpoint.
        const now = Date.now();
        const wibNow = new Date(now + 7 * 60 * 60 * 1000);
        const nextMidnightWib = Date.UTC(
            wibNow.getUTCFullYear(),
            wibNow.getUTCMonth(),
            wibNow.getUTCDate() + 1
        );
        const timer = window.setTimeout(
            () => void refresh(),
            Math.max(1000, nextMidnightWib - now - 7 * 60 * 60 * 1000 + 1000)
        );
        return () => window.clearTimeout(timer);
    }, [refresh, status?.quotaDate]);

    async function claim() {
        setClaiming(true);
        setError("");
        try {
            const response = await fetch(`/api/promos/${encodeURIComponent(slug)}/claim`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const result = await response.json();
            if (response.status === 409 || response.status === 410) {
                await refresh();
                return;
            }
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Promo belum bisa diklaim.");
            }
            if (product?.slug && productId && variantId) {
                router.replace(`/products/${encodeURIComponent(product.slug)}?promo=${encodeURIComponent(slug)}&promoVariantId=${variantId}`);
                return;
            }
            await refresh();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Promo belum bisa diklaim.");
        } finally {
            setClaiming(false);
        }
    }

    const expired = !loading && status && !status.active;

    return (
        <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-rose-50 via-white to-amber-50 px-4 py-12">
            <canvas
                ref={fireworksCanvasRef}
                aria-hidden="true"
                className="pointer-events-none fixed inset-0 z-10"
            />
            <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-rose-200/40 blur-3xl" />
            <div aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-amber-200/40 blur-3xl" />

            <section className="relative z-20 w-full max-w-xl rounded-3xl border border-white bg-white/90 p-7 text-center shadow-xl shadow-rose-900/5 backdrop-blur sm:p-10">
                {loading ? (
                    <div className="py-12 text-sm text-gray-500">Memuat voucher...</div>
                ) : expired ? (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                            <FiGift size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-600">{title}</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">Kamu terlambat</h1>
                        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-600">
                            Periode voucher ini telah berakhir. Lihat voucher dan promo lainnya di menu produk.
                        </p>
                        <Link href="/products" className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gray-950 px-6 text-sm font-bold text-white transition hover:bg-gray-800">
                            <FiShoppingBag /> Lihat promo lainnya
                        </Link>
                    </>
                ) : status?.claimed ? (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                            <FiCheck size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Voucher berhasil diklaim</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950">Selamat, harga voucher sudah aktif!</h1>
                        <p className="mt-3 text-sm leading-6 text-gray-600">Harga promo untuk produk ini otomatis diterapkan saat checkout hari ini di browser ini.</p>
                        {product && <ProductPriceCard product={product} />}
                        <Link href={product && variantId ? `/products/${product.slug}?promo=${encodeURIComponent(slug)}&promoVariantId=${variantId}` : "/products"} className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gray-950 px-6 text-sm font-bold text-white transition hover:bg-gray-800">
                            <FiShoppingBag /> {product ? `Beli ${product.name}` : "Lihat produk"}
                        </Link>
                    </>
                ) : (
                    <>
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-rose-700">
                            <FiGift size={30} />
                        </div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-600">Voucher spesial untuk kamu</p>
                        <h1 className="mt-3 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">Selamat!</h1>
                        <h2 className="mt-2 text-xl font-bold text-gray-800">{title}</h2>
                        {description && <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-600">{description}</p>}
                        {product && <ProductPriceCard product={product} />}
                        <p className="mt-5 text-sm text-gray-500">Klaim voucher untuk mengaktifkan harga spesial di halaman produk.</p>
                        <button type="button" disabled={claiming || !status?.claimable} onClick={() => void claim()} className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-6 text-sm font-bold text-white transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60">
                            <FiGift /> {claiming ? "Mengaktifkan voucher..." : "Klaim Voucher"}
                        </button>
                    </>
                )}

                {error && (
                    <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {error} <button type="button" onClick={() => void refresh()} className="ml-1 font-semibold underline">Coba lagi</button>
                    </div>
                )}
            </section>
        </main>
    );
}

function ProductPriceCard({
    product,
}: {
    product: {
        name: string;
        image: string | null;
        variant: string;
        regularPrice: number;
        promoPrice: number;
    };
}) {
    return (
        <div className="mx-auto mt-6 flex max-w-md items-center gap-4 rounded-2xl border border-rose-100 bg-rose-50/70 p-3 text-left">
            {product.image ? (
                <Image src={product.image} alt={product.name} width={72} height={72} className="h-18 w-18 rounded-xl object-cover" />
            ) : (
                <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-xl bg-white text-rose-500"><FiGift size={25} /></div>
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-gray-900">{product.name}</p>
                <p className="text-xs text-gray-500">Varian: {product.variant}</p>
                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                    <strong className="text-lg font-black text-rose-700">Rp {product.promoPrice.toLocaleString("id-ID")}</strong>
                    <span className="text-xs text-gray-400 line-through">Rp {product.regularPrice.toLocaleString("id-ID")}</span>
                </div>
            </div>
        </div>
    );
}
