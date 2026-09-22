"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiSave } from "react-icons/fi";
import toast from "react-hot-toast";

import {
    MAX_TIKTOK_PIXEL_CODE_LENGTH,
    analyzeTikTokPixelCode,
    findTikTokPixelIdMismatch,
} from "@/lib/analytics/tiktok-pixel-code";
import { normalizeTikTokPixelId } from "@/lib/analytics/tiktok";

type Region = {
    id: number;
    name: string;
    zip_code?: string | null;
    postal_code?: string | null;
    postalCode?: string | null;
};

type StoreForm = {
    storeName: string;
    phone: string;
    email: string;
    logo: string;
    address: string;

    tiktokPixelEnabled: boolean;
    tiktokPixelId: string;
    tiktokPixelName: string;
    tiktokPixelCode: string;

    provinceId: number | null;
    province: string;

    cityId: number | null;
    city: string;

    districtId: number | null;
    district: string;

    subdistrictId: number | null;
    subdistrict: string;

    postalCode: string;

    // WAJIB ADA
    rajaOngkirDestinationId: number | null;

    latitude: string;
    longitude: string;
};

const initialForm: StoreForm = {
    storeName: "",
    phone: "",
    email: "",
    logo: "",
    address: "",

    tiktokPixelEnabled: false,
    tiktokPixelId: "",
    tiktokPixelName: "",
    tiktokPixelCode: "",

    provinceId: null,
    province: "",

    cityId: null,
    city: "",

    districtId: null,
    district: "",

    subdistrictId: null,
    subdistrict: "",

    postalCode: "",

    rajaOngkirDestinationId: null,

    latitude: "",
    longitude: "",
};

export default function AdminSettingsForm() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [provinces, setProvinces] = useState<Region[]>([]);
    const [cities, setCities] = useState<Region[]>([]);
    const [districts, setDistricts] = useState<Region[]>([]);
    const [subdistricts, setSubdistricts] = useState<Region[]>([]);

    const [loadingCities, setLoadingCities] = useState(false);
    const [loadingDistricts, setLoadingDistricts] = useState(false);
    const [loadingSubdistricts, setLoadingSubdistricts] =
        useState(false);

    const [form, setForm] = useState<StoreForm>(initialForm);

    function updateField<K extends keyof StoreForm>(
        field: K,
        value: StoreForm[K]
    ) {
        setForm((prev) => ({
            ...prev,
            [field]: value,
        }));
    }

    /**
     * ============================
     * LOAD WILAYAH
     * ============================
     */

    async function loadRegions(
        type: string,
        id?: number
    ): Promise<Region[]> {
        const query = id
            ? `?type=${type}&id=${id}`
            : `?type=${type}`;

        const response = await fetch(
            `/api/admin/settings/regions${query}`,
            {
                cache: "no-store",
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.message ||
                "Gagal mengambil data wilayah."
            );
        }

        return Array.isArray(data.data)
            ? data.data
            : [];
    }

    async function loadProvinces() {
        try {
            const data = await loadRegions(
                "provinces"
            );

            setProvinces(data);
        } catch (error) {
            console.error(
                "LOAD PROVINCES ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil provinsi."
            );
        }
    }

    async function loadCities(
        provinceId: number
    ) {
        try {
            setLoadingCities(true);

            const data = await loadRegions(
                "cities",
                provinceId
            );

            setCities(data);
        } catch (error) {
            console.error(
                "LOAD CITIES ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kota."
            );
        } finally {
            setLoadingCities(false);
        }
    }

    async function loadDistricts(
        cityId: number
    ) {
        try {
            setLoadingDistricts(true);

            const data = await loadRegions(
                "districts",
                cityId
            );

            setDistricts(data);
        } catch (error) {
            console.error(
                "LOAD DISTRICTS ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kecamatan."
            );
        } finally {
            setLoadingDistricts(false);
        }
    }

    async function loadSubdistricts(
        districtId: number
    ) {
        try {
            setLoadingSubdistricts(true);

            const data = await loadRegions(
                "subdistricts",
                districtId
            );

            setSubdistricts(data);
        } catch (error) {
            console.error(
                "LOAD SUBDISTRICTS ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kelurahan."
            );
        } finally {
            setLoadingSubdistricts(false);
        }
    }

    async function loadDestinationId(
        subdistrict: string,
        postalCode: string
    ) {
        try {
            if (
                !subdistrict &&
                !postalCode
            ) {
                return null;
            }

            const params =
                new URLSearchParams();

            if (subdistrict) {
                params.set(
                    "subdistrict",
                    subdistrict
                );
            }

            if (postalCode) {
                params.set(
                    "postalCode",
                    postalCode
                );
            }

            const response =
                await fetch(
                    `/api/admin/settings/destination?${params.toString()}`,
                    {
                        cache: "no-store",
                    }
                );

            const data =
                await response.json();

            console.log(
                "DESTINATION RESULT:",
                data
            );

            if (!response.ok) {
                throw new Error(
                    data.message ||
                    "Gagal mendapatkan destination ID."
                );
            }

            const destinationId =
                data?.data?.id ??
                data?.data?.destinationId;

            if (!destinationId) {
                throw new Error(
                    "Destination ID tidak ditemukan."
                );
            }

            setForm((prev) => ({
                ...prev,

                rajaOngkirDestinationId:
                    Number(destinationId),
            }));

            return Number(
                destinationId
            );
        } catch (error) {
            console.error(
                "LOAD DESTINATION ID ERROR:",
                error
            );

            setForm((prev) => ({
                ...prev,

                rajaOngkirDestinationId:
                    null,
            }));

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mendapatkan destination ID."
            );

            return null;
        }
    }

    /**
     * ============================
     * LOAD STORE SETTING
     * ============================
     */

    async function loadSettings() {
        try {
            const response = await fetch(
                "/api/admin/settings",
                {
                    cache: "no-store",
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                    "Gagal mengambil pengaturan."
                );
            }

            if (!data.data) {
                return;
            }

            const nextForm: StoreForm = {
                storeName:
                    data.data.storeName ?? "",

                phone:
                    data.data.phone ?? "",

                email:
                    data.data.email ?? "",

                logo:
                    data.data.logo ?? "",

                address:
                    data.data.address ?? "",

                tiktokPixelEnabled:
                    data.data
                        .tiktokPixelEnabled ===
                    true,

                tiktokPixelId:
                    data.data.tiktokPixelId ?? "",

                tiktokPixelName:
                    data.data.tiktokPixelName ?? "",

                /*
                 * Kode ditampilkan apa adanya —
                 * tidak ada formatting otomatis.
                 */
                tiktokPixelCode:
                    data.data.tiktokPixelCode ?? "",

                provinceId:
                    data.data.provinceId ?? null,

                province:
                    data.data.province ?? "",

                cityId:
                    data.data.cityId ?? null,

                city:
                    data.data.city ?? "",

                districtId:
                    data.data.districtId ?? null,

                district:
                    data.data.district ?? "",

                subdistrictId:
                    data.data.subdistrictId ?? null,

                subdistrict:
                    data.data.subdistrict ?? "",

                postalCode:
                    data.data.postalCode ?? "",

                rajaOngkirDestinationId:
                    data.data
                        .rajaOngkirDestinationId ??
                    null,

                latitude:
                    data.data.latitude != null
                        ? String(
                            data.data.latitude
                        )
                        : "",

                longitude:
                    data.data.longitude != null
                        ? String(
                            data.data.longitude
                        )
                        : "",
            };

            setForm(nextForm);

            /**
             * Load child wilayah
             * berdasarkan data yang
             * sudah tersimpan.
             */

            if (nextForm.provinceId) {
                await loadCities(
                    nextForm.provinceId
                );
            }

            if (nextForm.cityId) {
                await loadDistricts(
                    nextForm.cityId
                );
            }

            if (nextForm.districtId) {
                await loadSubdistricts(
                    nextForm.districtId
                );
            }
        } catch (error) {
            console.error(
                "LOAD SETTINGS ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil pengaturan."
            );
        }
    }

    /**
     * ============================
     * INITIAL LOAD
     * ============================
     */

    useEffect(() => {
        async function init() {
            setLoading(true);

            await Promise.all([
                loadProvinces(),
                loadSettings(),
            ]);

            setLoading(false);
        }

        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * ============================
     * PROVINCE CHANGE
     * ============================
     */

    async function handleProvinceChange(
        value: string
    ) {
        const provinceId = Number(value);

        if (!provinceId) {
            setForm((prev) => ({
                ...prev,

                provinceId: null,
                province: "",

                cityId: null,
                city: "",

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setCities([]);
            setDistricts([]);
            setSubdistricts([]);

            return;
        }

        const province = provinces.find(
            (item) =>
                item.id === provinceId
        );

        setForm((prev) => ({
            ...prev,

            provinceId,

            province:
                province?.name ?? "",

            cityId: null,
            city: "",

            districtId: null,
            district: "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setCities([]);
        setDistricts([]);
        setSubdistricts([]);

        await loadCities(provinceId);
    }

    /**
     * ============================
     * CITY CHANGE
     * ============================
     */

    async function handleCityChange(
        value: string
    ) {
        const cityId = Number(value);

        if (!cityId) {
            setForm((prev) => ({
                ...prev,

                cityId: null,
                city: "",

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setDistricts([]);
            setSubdistricts([]);

            return;
        }

        const city = cities.find(
            (item) =>
                item.id === cityId
        );

        setForm((prev) => ({
            ...prev,

            cityId,

            city:
                city?.name ?? "",

            districtId: null,
            district: "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setDistricts([]);
        setSubdistricts([]);

        await loadDistricts(cityId);
    }

    /**
     * ============================
     * DISTRICT CHANGE
     * ============================
     */

    async function handleDistrictChange(
        value: string
    ) {
        const districtId = Number(value);

        if (!districtId) {
            setForm((prev) => ({
                ...prev,

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setSubdistricts([]);

            return;
        }

        const district =
            districts.find(
                (item) =>
                    item.id === districtId
            );

        setForm((prev) => ({
            ...prev,

            districtId,

            district:
                district?.name ?? "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setSubdistricts([]);

        await loadSubdistricts(
            districtId
        );
    }

    /**
     * ============================
     * SUBDISTRICT CHANGE
     * ============================
     */

    async function handleSubdistrictChange(
        value: string
    ) {
        const subdistrictId =
            Number(value);

        if (!subdistrictId) {
            setForm((prev) => ({
                ...prev,

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",

                rajaOngkirDestinationId:
                    null,
            }));

            return;
        }

        const subdistrict =
            subdistricts.find(
                (item) =>
                    item.id ===
                    subdistrictId
            );

        const postalCode =
            subdistrict?.zip_code ??
            subdistrict?.postal_code ??
            subdistrict?.postalCode ??
            "";

        const subdistrictName =
            subdistrict?.name ?? "";

        // Update UI terlebih dahulu
        setForm((prev) => ({
            ...prev,

            subdistrictId,

            subdistrict:
                subdistrictName,

            postalCode,

            rajaOngkirDestinationId:
                null,
        }));

        // Ambil RajaOngkir Destination ID
        if (subdistrictName) {
            await loadDestinationId(
                subdistrictName,
                postalCode
            );
        }
    }

    /**
     * ============================
     * SUBMIT
     * ============================
     */

    async function handleSubmit(
        event: FormEvent
    ) {
        event.preventDefault();

        if (!form.storeName.trim()) {
            toast.error(
                "Nama toko wajib diisi."
            );
            return;
        }

        if (!form.address.trim()) {
            toast.error(
                "Alamat toko wajib diisi."
            );
            return;
        }

        if (!form.provinceId) {
            toast.error(
                "Pilih provinsi."
            );
            return;
        }

        if (!form.cityId) {
            toast.error(
                "Pilih kota/kabupaten."
            );
            return;
        }

        if (!form.districtId) {
            toast.error(
                "Pilih kecamatan."
            );
            return;
        }

        if (!form.subdistrictId) {
            toast.error(
                "Pilih kelurahan/desa."
            );
            return;
        }

        /*
         * Validasi ringan di client; server tetap
         * memvalidasi ulang Pixel ID dan Pixel Code.
         */
        if (form.tiktokPixelId.trim()) {
            if (
                !normalizeTikTokPixelId(
                    form.tiktokPixelId
                )
            ) {
                toast.error(
                    "TikTok Pixel ID tidak valid."
                );
                return;
            }
        }

        if (
            form.tiktokPixelEnabled &&
            !form.tiktokPixelCode.trim()
        ) {
            toast.error(
                "Isi Kode Pixel TikTok sebelum mengaktifkan TikTok Pixel."
            );
            return;
        }

        if (
            form.tiktokPixelEnabled &&
            analyzeTikTokPixelCode(
                form.tiktokPixelCode
            ).isEmpty
        ) {
            toast.error(
                "Kode Pixel TikTok tidak berisi JavaScript inline."
            );
            return;
        }

        try {
            setSaving(true);

            const response =
                await fetch(
                    "/api/admin/settings",
                    {
                        method: "PUT",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify(
                            form
                        ),
                    }
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                    "Gagal menyimpan pengaturan."
                );
            }

            toast.success(
                "Pengaturan toko berhasil disimpan."
            );

            /**
             * Reload data supaya
             * state benar-benar sama
             * dengan database.
             */

            await loadSettings();
        } catch (error) {
            console.error(
                "SAVE SETTINGS ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal menyimpan pengaturan."
            );
        } finally {
            setSaving(false);
        }
    }

    /**
     * ============================
     * LOADING
     * ============================
     */

    if (loading) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
                <div className="mx-auto max-w-5xl">
                    <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm">
                        <div className="animate-pulse">
                            Memuat pengaturan toko...
                        </div>
                    </div>
                </div>
            </main>
        );
    }

    /*
     * Analisa kode untuk warning di UI.
     * Hanya membaca metadata — kode tidak diubah.
     */
    const pixelCodeAnalysis =
        analyzeTikTokPixelCode(
            form.tiktokPixelCode
        );

    const pixelIdMismatch =
        findTikTokPixelIdMismatch(
            form.tiktokPixelId,
            form.tiktokPixelCode
        );

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-5xl">

                {/* HEADER */}

                <div className="mb-6">
                    <Link
                        href="/admin"
                        className="inline-flex items-center gap-2 text-sm font-medium text-gray-500 transition hover:text-gray-900"
                    >
                        <FiArrowLeft size={16} />

                        Kembali ke Dashboard
                    </Link>
                </div>

                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">
                        Pengaturan Toko
                    </h1>

                    <p className="mt-2 text-sm text-gray-500">
                        Atur identitas dan lokasi
                        toko.
                    </p>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="space-y-6"
                >

                    {/* =====================
                        INFORMASI TOKO
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-gray-900">
                            Informasi Toko
                        </h2>

                        <div className="mt-5 grid gap-5 md:grid-cols-2">

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Nama Toko
                                </label>

                                <input
                                    type="text"
                                    value={
                                        form.storeName
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "storeName",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="Nama toko"
                                />
                            </div>

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Nomor Telepon
                                </label>

                                <input
                                    type="text"
                                    value={
                                        form.phone
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "phone",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="08xxxxxxxxxx"
                                />
                            </div>

                            <div className="md:col-span-2">
                                <label className="text-sm font-medium text-gray-700">
                                    Email
                                </label>

                                <input
                                    type="email"
                                    value={
                                        form.email
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "email",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="email@toko.com"
                                />
                            </div>
                        </div>
                    </section>

                    {/* =====================
                        TIKTOK PIXEL
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-gray-900">
                            TikTok Pixel
                        </h2>

                        <p className="mt-1 text-sm text-gray-500">
                            Digunakan untuk mengukur aktivitas
                            website dan event TikTok Pixel.
                        </p>

                        <label className="mt-5 flex items-start gap-3 rounded-xl border border-gray-200 p-4">
                            <input
                                type="checkbox"
                                checked={
                                    form.tiktokPixelEnabled
                                }
                                onChange={(e) =>
                                    updateField(
                                        "tiktokPixelEnabled",
                                        e.target.checked
                                    )
                                }
                                className="mt-0.5 h-4 w-4 accent-rose-600"
                            />

                            <span>
                                <span className="block text-sm font-medium text-gray-700">
                                    Aktifkan TikTok Pixel
                                </span>

                                <span className="mt-1 block text-xs text-gray-500">
                                    Pixel hanya dimuat di
                                    halaman toko (bukan
                                    dashboard admin).
                                </span>
                            </span>
                        </label>

                        {/* PIXEL ID + NAME */}

                        <div className="mt-5 grid gap-5 md:grid-cols-2">
                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    TikTok Pixel ID
                                </label>

                                <input
                                    type="text"
                                    value={
                                        form.tiktokPixelId
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "tiktokPixelId",
                                            e.target.value
                                                .trim()
                                                .toUpperCase()
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm outline-none transition focus:border-rose-500"
                                    placeholder="Contoh: C1A2B3C4D5E6F7G8H9J0"
                                    autoComplete="off"
                                    spellCheck={false}
                                />

                                <p className="mt-2 text-xs text-gray-500">
                                    Contoh Pixel ID:{" "}
                                    <span className="font-mono">
                                        C1A2B3C4D5E6F7G8H9J0
                                    </span>
                                </p>
                            </div>

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    TikTok Pixel Name
                                </label>

                                <input
                                    type="text"
                                    value={
                                        form.tiktokPixelName
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "tiktokPixelName",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="Contoh: Web Tiktok"
                                    autoComplete="off"
                                />

                                <p className="mt-2 text-xs text-gray-500">
                                    Label pixel sesuai nama di TikTok
                                    Events Manager.
                                </p>
                            </div>
                        </div>

                        {/* PIXEL CODE */}

                        <div className="mt-5">
                            <label className="text-sm font-medium text-gray-700">
                                Kode Pixel TikTok
                            </label>

                            <textarea
                                value={
                                    form.tiktokPixelCode
                                }
                                onChange={(e) =>
                                    updateField(
                                        "tiktokPixelCode",
                                        e.target.value
                                    )
                                }
                                rows={12}
                                spellCheck={false}
                                className="mt-2 w-full resize-y rounded-xl border border-gray-300 px-4 py-3 font-mono text-xs leading-relaxed outline-none transition focus:border-rose-500"
                                placeholder={'<script>\n!function (w, d, t) { ... }(window, document, \'ttq\');\n</script>'}
                            />

                            <p className="mt-2 text-xs font-medium text-amber-700">
                                Kode ini akan dijalankan pada
                                website storefront. Masukkan
                                hanya kode tracking yang
                                dipercaya.
                            </p>

                            <p className="mt-1 text-xs text-gray-500">
                                Tempel kode apa adanya dari
                                TikTok Events Manager. Tag{" "}
                                <span className="font-mono">
                                    {"<script>"}
                                </span>{" "}
                                dan{" "}
                                <span className="font-mono">
                                    {"</script>"}
                                </span>{" "}
                                diambil otomatis, isi kode tidak
                                diubah. Maksimal{" "}
                                {MAX_TIKTOK_PIXEL_CODE_LENGTH}{" "}
                                karakter.
                            </p>
                        </div>

                        {/* WARNINGS */}

                        {pixelIdMismatch && (
                            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                                Pixel ID berbeda dengan ID yang
                                ditemukan di Pixel Code:{" "}
                                <span className="font-mono">
                                    {pixelIdMismatch}
                                </span>
                                {" "}
                                vs{" "}
                                <span className="font-mono">
                                    {form.tiktokPixelId ||
                                        "-"}
                                </span>
                                . Kode tidak diubah otomatis —
                                periksa dan sesuaikan sendiri.
                            </p>
                        )}

                        {form.tiktokPixelCode.trim() &&
                            pixelCodeAnalysis.isEmpty && (
                                <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                                    Kode tidak berisi JavaScript
                                    inline. Tempel kode lengkap dari
                                    TikTok Events Manager.
                                </p>
                            )}

                        {form.tiktokPixelCode.trim() &&
                            !pixelCodeAnalysis.isEmpty && (
                                <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
                                    <p className="font-medium text-gray-700">
                                        Terdeteksi pada kode:
                                    </p>

                                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                                        <li>
                                            ttq.load:{" "}
                                            {pixelCodeAnalysis.hasLoadCall
                                                ? "ya"
                                                : "tidak"}
                                            {pixelCodeAnalysis
                                                .pixelIds
                                                .length > 0 &&
                                                ` (${pixelCodeAnalysis.pixelIds.join(
                                                    ", "
                                                )})`}
                                        </li>

                                        <li>
                                            ttq.page:{" "}
                                            {pixelCodeAnalysis.hasPageCall
                                                ? "ya"
                                                : "tidak"}
                                        </li>
                                    </ul>

                                    {!pixelCodeAnalysis.hasPageCall && (
                                        <p className="mt-1 text-amber-700">
                                            Kode tidak memanggil{" "}
                                            ttq.page() — PageView
                                            tidak akan terkirim.
                                        </p>
                                    )}

                                    {pixelCodeAnalysis.hasIdentifyCall && (
                                        <p className="mt-1 text-amber-700">
                                            Kode memanggil{" "}
                                            ttq.identify() (Advanced
                                            Matching). Pastikan data
                                            yang dikirim sudah sesuai
                                            kebijakan privasi.
                                        </p>
                                    )}
                                </div>
                            )}
                    </section>

                    {/* =====================
                        ALAMAT TOKO
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-gray-900">
                            Alamat Toko
                        </h2>

                        <p className="mt-1 text-sm text-gray-500">
                            Pilih wilayah dari data
                            RajaOngkir.
                        </p>

                        <div className="mt-5 space-y-5">

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Alamat Lengkap
                                </label>

                                <textarea
                                    value={
                                        form.address
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "address",
                                            e.target.value
                                        )
                                    }
                                    rows={4}
                                    className="mt-2 w-full resize-none rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="Nama jalan, nomor rumah, RT/RW, patokan..."
                                />
                            </div>

                            <div className="grid gap-5 md:grid-cols-2">

                                {/* PROVINSI */}

                                <div>
                                    <label className="text-sm font-medium text-gray-700">
                                        Provinsi
                                    </label>

                                    <select
                                        value={
                                            form.provinceId ??
                                            ""
                                        }
                                        onChange={(e) =>
                                            handleProvinceChange(
                                                e.target.value
                                            )
                                        }
                                        className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500"
                                    >
                                        <option value="">
                                            Pilih Provinsi
                                        </option>

                                        {provinces.map(
                                            (item) => (
                                                <option
                                                    key={
                                                        item.id
                                                    }
                                                    value={
                                                        item.id
                                                    }
                                                >
                                                    {
                                                        item.name
                                                    }
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>

                                {/* KOTA */}

                                <div>
                                    <label className="text-sm font-medium text-gray-700">
                                        Kota /
                                        Kabupaten
                                    </label>

                                    <select
                                        value={
                                            form.cityId ??
                                            ""
                                        }
                                        disabled={
                                            !form.provinceId ||
                                            loadingCities
                                        }
                                        onChange={(e) =>
                                            handleCityChange(
                                                e.target.value
                                            )
                                        }
                                        className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500 disabled:bg-gray-100"
                                    >
                                        <option value="">
                                            {loadingCities
                                                ? "Memuat kota..."
                                                : "Pilih Kota / Kabupaten"}
                                        </option>

                                        {cities.map(
                                            (item) => (
                                                <option
                                                    key={
                                                        item.id
                                                    }
                                                    value={
                                                        item.id
                                                    }
                                                >
                                                    {
                                                        item.name
                                                    }
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>

                                {/* KECAMATAN */}

                                <div>
                                    <label className="text-sm font-medium text-gray-700">
                                        Kecamatan
                                    </label>

                                    <select
                                        value={
                                            form.districtId ??
                                            ""
                                        }
                                        disabled={
                                            !form.cityId ||
                                            loadingDistricts
                                        }
                                        onChange={(e) =>
                                            handleDistrictChange(
                                                e.target.value
                                            )
                                        }
                                        className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500 disabled:bg-gray-100"
                                    >
                                        <option value="">
                                            {loadingDistricts
                                                ? "Memuat kecamatan..."
                                                : "Pilih Kecamatan"}
                                        </option>

                                        {districts.map(
                                            (item) => (
                                                <option
                                                    key={
                                                        item.id
                                                    }
                                                    value={
                                                        item.id
                                                    }
                                                >
                                                    {
                                                        item.name
                                                    }
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>

                                {/* KELURAHAN */}

                                <div>
                                    <label className="text-sm font-medium text-gray-700">
                                        Kelurahan /
                                        Desa
                                    </label>

                                    <select
                                        value={
                                            form.subdistrictId ??
                                            ""
                                        }
                                        disabled={
                                            !form.districtId ||
                                            loadingSubdistricts
                                        }
                                        onChange={(e) =>
                                            handleSubdistrictChange(
                                                e.target.value
                                            )
                                        }
                                        className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500 disabled:bg-gray-100"
                                    >
                                        <option value="">
                                            {loadingSubdistricts
                                                ? "Memuat kelurahan..."
                                                : "Pilih Kelurahan / Desa"}
                                        </option>

                                        {subdistricts.map(
                                            (item) => (
                                                <option
                                                    key={
                                                        item.id
                                                    }
                                                    value={
                                                        item.id
                                                    }
                                                >
                                                    {
                                                        item.name
                                                    }
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>
                            </div>

                            {/* KODE POS */}

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Kode Pos
                                </label>

                                <input
                                    type="text"
                                    value={
                                        form.postalCode
                                    }
                                    readOnly
                                    className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-gray-700 outline-none"
                                />

                                <p className="mt-1 text-xs text-gray-500">
                                    Kode pos diisi otomatis
                                    berdasarkan kelurahan/desa
                                    yang dipilih.
                                </p>
                            </div>
                            <div className="mt-4">
                                <label className="mb-2 block text-sm font-medium text-gray-700">
                                    RajaOngkir Destination ID
                                </label>

                                <input
                                    type="text"
                                    value={form.rajaOngkirDestinationId ?? "-"}
                                    readOnly
                                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 outline-none"
                                    placeholder="Akan terisi otomatis"
                                />

                                <p className="mt-1 text-xs text-gray-500">
                                    Destination ID dibuat otomatis berdasarkan
                                    kelurahan yang dipilih.
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* =====================
                        KOORDINAT
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-gray-900">
                            Koordinat Toko
                        </h2>

                        <p className="mt-1 text-sm text-gray-500">
                            Untuk sementara koordinat
                            dapat diisi manual. Nanti
                            kita sambungkan ke GPS dan
                            map.
                        </p>

                        <div className="mt-5 grid gap-5 md:grid-cols-2">

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Latitude
                                </label>

                                <input
                                    type="text"
                                    value={form.latitude}
                                    onChange={(e) =>
                                        updateField(
                                            "latitude",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-rose-500"
                                    placeholder="-6.2000000"
                                />
                            </div>

                            <div>
                                <label className="text-sm font-medium text-gray-700">
                                    Longitude
                                </label>

                                <input
                                    type="text"
                                    value={form.longitude}
                                    onChange={(e) =>
                                        updateField(
                                            "longitude",
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-rose-500"
                                    placeholder="106.8166667"
                                />
                            </div>
                        </div>
                    </section>

                    {/* =====================
                        SAVE
                    ====================== */}

                    <div className="flex justify-end">
                        <button
                            type="submit"
                            disabled={saving}
                            className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <FiSave size={17} />

                            {saving
                                ? "Menyimpan..."
                                : "Simpan Pengaturan"}
                        </button>
                    </div>
                </form>
            </div>
        </main>
    );
}