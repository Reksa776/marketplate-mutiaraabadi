"use client";

import {
    useEffect,
    useRef,
    useState,
    type FormEvent,
} from "react";
import Link from "next/link";
import { FiArrowLeft, FiSave } from "react-icons/fi";
import toast from "react-hot-toast";

import {
    MAX_TIKTOK_PIXEL_CODE_LENGTH,
    analyzeTikTokPixelCode,
    findTikTokPixelIdMismatch,
} from "@/lib/analytics/tiktok-pixel-code";
import { normalizeTikTokPixelId } from "@/lib/analytics/tiktok";
import {
    MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH,
    normalizeTikTokPixelAccessToken,
} from "@/lib/analytics/tiktok-access-token";

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
    /**
     * Active website favicon URL (public path).
     *
     * Read-only for the settings PUT: it is uploaded/removed
     * through /api/admin/settings/favicon so a normal save can
     * never wipe it. Kept in the form only for preview.
     */
    faviconUrl: string;
    address: string;

    tiktokPixelEnabled: boolean;
    tiktokPixelId: string;
    tiktokPixelName: string;
    tiktokPixelCode: string;

    /**
     * Server-side Events API credential.
     *
     * NEVER pre-filled from the server: the input always starts
     * empty and is only used to SET/REPLACE the token. The stored
     * value is represented by the configured flag + last-4 hint.
     */
    tiktokPixelAccessToken: string;
    tiktokPixelAccessTokenConfigured: boolean;
    tiktokPixelAccessTokenLast4: string;
    clearTiktokPixelAccessToken: boolean;

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

    /*
     * Mengantar shipping / pickup configuration. The two
     * `configured` flags are server-derived, read-only status.
     */
    mengantarApiConfigured: boolean;
    mengantarPickupConfigured: boolean;
    mengantarOriginAreaId: string;
    mengantarPickupAddressId: string;
    mengantarPickupTimeId: string;
    mengantarPickupMode: "dropoff" | "scheduled";

    latitude: string;
    longitude: string;
};

type MengantarArea = {
    id: string;
    province: string | null;
    city: string | null;
    district: string | null;
    subdistrict: string | null;
    postalCode: string | null;
};

type MengantarPickupAddress = {
    _id: string;
    name: string | null;
    address: string | null;
    pic: string | null;
    picPhone: string | null;
    areaId: string | null;
};

type MengantarPickupTime = {
    _id: string;
    date: string | null;
    time: string | null;
};

const initialForm: StoreForm = {
    storeName: "",
    phone: "",
    email: "",
    logo: "",
    faviconUrl: "",
    address: "",

    tiktokPixelEnabled: false,
    tiktokPixelId: "",
    tiktokPixelName: "",
    tiktokPixelCode: "",

    tiktokPixelAccessToken: "",
    tiktokPixelAccessTokenConfigured: false,
    tiktokPixelAccessTokenLast4: "",
    clearTiktokPixelAccessToken: false,

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

    mengantarApiConfigured: false,
    mengantarPickupConfigured: false,
    mengantarOriginAreaId: "",
    mengantarPickupAddressId: "",
    mengantarPickupTimeId: "",
    mengantarPickupMode: "dropoff",

    latitude: "",
    longitude: "",
};

/**
 * ============================
 * FAVICON UPLOAD (CLIENT GATE)
 * ============================
 *
 * Mirrors the server rules so an obviously bad file is
 * rejected before the network round trip. The SERVER remains
 * the authoritative validator (magic bytes, size, MIME) —
 * nothing here is trusted.
 */
const FAVICON_MAX_BYTES = 1024 * 1024;
const FAVICON_ACCEPT =
    "image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico";
const FAVICON_ALLOWED_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

export default function AdminSettingsForm() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [faviconUploading, setFaviconUploading] =
        useState(false);
    const [showAccessToken, setShowAccessToken] =
        useState(false);

    const faviconInputRef =
        useRef<HTMLInputElement>(null);

    const [provinces, setProvinces] = useState<Region[]>([]);
    const [cities, setCities] = useState<Region[]>([]);
    const [districts, setDistricts] = useState<Region[]>([]);
    const [subdistricts, setSubdistricts] = useState<Region[]>([]);

    const [loadingCities, setLoadingCities] = useState(false);
    const [loadingDistricts, setLoadingDistricts] = useState(false);
    const [loadingSubdistricts, setLoadingSubdistricts] =
        useState(false);

    const [form, setForm] = useState<StoreForm>(initialForm);

    /* Mengantar shipping configuration lookup state. */
    const [mengantarOriginQuery, setMengantarOriginQuery] =
        useState("");
    const [mengantarAreas, setMengantarAreas] = useState<
        MengantarArea[]
    >([]);
    const [mengantarPickupAddresses, setMengantarPickupAddresses] =
        useState<MengantarPickupAddress[]>([]);
    const [mengantarTimes, setMengantarTimes] = useState<
        MengantarPickupTime[]
    >([]);
    const [mengantarOriginLabel, setMengantarOriginLabel] =
        useState("");
    const [mengantarPickupLabel, setMengantarPickupLabel] =
        useState("");
    const [loadingMengantar, setLoadingMengantar] =
        useState(false);

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

                faviconUrl:
                    data.data.faviconUrl ?? "",

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

                /*
                 * Token TIDAK pernah di-prefill dari server.
                 * Yang kita simpan hanya status + last-4.
                 */
                tiktokPixelAccessToken: "",

                tiktokPixelAccessTokenConfigured:
                    data.data
                        .tiktokPixelAccessTokenConfigured ===
                    true,

                tiktokPixelAccessTokenLast4:
                    typeof data.data
                        .tiktokPixelAccessTokenLast4 ===
                    "string"
                        ? data.data
                              .tiktokPixelAccessTokenLast4
                        : "",

                clearTiktokPixelAccessToken: false,

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

                mengantarApiConfigured:
                    data.data
                        .mengantarApiConfigured === true,

                mengantarPickupConfigured:
                    data.data
                        .mengantarPickupConfigured === true,

                mengantarOriginAreaId:
                    data.data
                        .mengantarOriginAreaId ?? "",

                mengantarPickupAddressId:
                    data.data
                        .mengantarPickupAddressId ?? "",

                mengantarPickupTimeId:
                    data.data
                        .mengantarPickupTimeId ?? "",

                mengantarPickupMode:
                    data.data.mengantarPickupTimeId
                        ? "scheduled"
                        : "dropoff",

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

    /*
     * Hydrate the Mengantar pickup lists once settings have loaded
     * (only when the server actually holds an API key).
     */
    useEffect(() => {
        if (!form.mengantarApiConfigured) return;

        void loadMengantarPickupAddresses();

        if (form.mengantarPickupAddressId) {
            void loadMengantarTimes(
                form.mengantarPickupAddressId
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form.mengantarApiConfigured]);

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
     * FAVICON
     * ============================
     */

    async function handleFaviconUpload(
        event: React.ChangeEvent<HTMLInputElement>
    ) {
        const input = event.target;
        const file = input.files?.[0];

        if (!file) {
            return;
        }

        if (file.size === 0) {
            toast.error("File favicon kosong.");
            input.value = "";
            return;
        }

        if (file.size > FAVICON_MAX_BYTES) {
            toast.error(
                "Ukuran favicon maksimal 1MB."
            );
            input.value = "";
            return;
        }

        if (
            file.type &&
            !FAVICON_ALLOWED_TYPES.includes(file.type)
        ) {
            toast.error(
                "Format favicon harus PNG, JPG, WEBP, atau ICO."
            );
            input.value = "";
            return;
        }

        try {
            setFaviconUploading(true);

            const formData = new FormData();

            formData.append("file", file);

            const response = await fetch(
                "/api/admin/settings/favicon",
                {
                    method: "POST",
                    body: formData,
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal mengupload favicon."
                );
            }

            updateField(
                "faviconUrl",
                data.url ?? ""
            );

            toast.success(
                data.message ??
                    "Favicon berhasil diperbarui."
            );
        } catch (error) {
            console.error(
                "FAVICON UPLOAD ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengupload favicon."
            );
        } finally {
            setFaviconUploading(false);
            input.value = "";
        }
    }

    async function handleFaviconRemove() {
        try {
            setFaviconUploading(true);

            const response = await fetch(
                "/api/admin/settings/favicon",
                { method: "DELETE" }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                        "Gagal menghapus favicon."
                );
            }

            updateField("faviconUrl", "");

            toast.success(
                data.message ??
                    "Favicon dihapus, kembali ke ikon default."
            );
        } catch (error) {
            console.error(
                "FAVICON REMOVE ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal menghapus favicon."
            );
        } finally {
            setFaviconUploading(false);
        }
    }

    /**
     * ============================
     * MENGANTAR SHIPPING HELPERS
     * ============================
     *
     * IDs are resolved through the ADMIN-only, read-only route
     * /api/admin/settings/mengantar so they never have to be
     * copy-pasted. When the server has no API key the route returns
     * `configured:false` and the UI falls back to manual entry.
     */

    async function fetchMengantarResource(
        params: Record<string, string>
    ): Promise<{
        configured?: boolean;
        data?: unknown;
        message?: string;
    }> {
        const query = new URLSearchParams(
            params
        ).toString();

        const response = await fetch(
            `/api/admin/settings/mengantar?${query}`,
            { cache: "no-store" }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.message ||
                    "Gagal mengambil data Mengantar."
            );
        }

        return data;
    }

    async function searchMengantarOrigin() {
        const keyword = mengantarOriginQuery.trim();

        if (!keyword) {
            toast.error(
                "Isi kata kunci area (mis. nama kecamatan)."
            );
            return;
        }

        try {
            setLoadingMengantar(true);

            const data = await fetchMengantarResource({
                resource: "areas",
                keyword,
            });

            if (data.configured === false) {
                setMengantarAreas([]);

                toast.error(
                    data.message ||
                        "API key Mengantar belum diatur."
                );
                return;
            }

            setMengantarAreas(
                Array.isArray(data.data)
                    ? (data.data as MengantarArea[])
                    : []
            );
        } catch (error) {
            console.error(
                "SEARCH MENGANTAR AREA ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mencari area Mengantar."
            );
        } finally {
            setLoadingMengantar(false);
        }
    }

    function selectMengantarOrigin(area: MengantarArea) {
        setForm((prev) => ({
            ...prev,
            mengantarOriginAreaId: area.id,
        }));

        setMengantarOriginLabel(
            [
                area.subdistrict,
                area.district,
                area.city,
                area.province,
                area.postalCode,
            ]
                .filter(Boolean)
                .join(" / ")
        );

        setMengantarAreas([]);
    }

    async function loadMengantarPickupAddresses() {
        try {
            setLoadingMengantar(true);

            const data = await fetchMengantarResource({
                resource: "pickup-addresses",
            });

            if (data.configured === false) {
                toast.error(
                    data.message ||
                        "API key Mengantar belum diatur."
                );
                return;
            }

            const list = Array.isArray(data.data)
                ? (data.data as MengantarPickupAddress[])
                : [];

            setMengantarPickupAddresses(list);

            const selected = list.find(
                (addr) =>
                    addr._id ===
                    form.mengantarPickupAddressId
            );

            if (selected) {
                setMengantarPickupLabel(
                    selected.name ??
                        selected.address ??
                        ""
                );
            }
        } catch (error) {
            console.error(
                "LOAD MENGANTAR PICKUP ADDRESSES ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil pickup address Mengantar."
            );
        } finally {
            setLoadingMengantar(false);
        }
    }

    async function loadMengantarTimes(addressId: string) {
        if (!addressId) {
            setMengantarTimes([]);
            return;
        }

        try {
            setLoadingMengantar(true);

            const data = await fetchMengantarResource({
                resource: "pickup-times",
                addressId,
            });

            if (data.configured === false) return;

            setMengantarTimes(
                Array.isArray(data.data)
                    ? (data.data as MengantarPickupTime[])
                    : []
            );
        } catch (error) {
            console.error(
                "LOAD MENGANTAR TIMES ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil slot pickup Mengantar."
            );
        } finally {
            setLoadingMengantar(false);
        }
    }

    function handleMengantarPickupChange(value: string) {
        const selected = mengantarPickupAddresses.find(
            (addr) => addr._id === value
        );

        setForm((prev) => ({
            ...prev,
            mengantarPickupAddressId: value,
            mengantarPickupTimeId: "",
        }));

        setMengantarPickupLabel(
            selected
                ? selected.name ?? selected.address ?? ""
                : ""
        );

        setMengantarTimes([]);

        if (value) {
            void loadMengantarTimes(value);
        }
    }

    function handleMengantarModeChange(
        mode: "dropoff" | "scheduled"
    ) {
        setForm((prev) => ({
            ...prev,
            mengantarPickupMode: mode,
            ...(mode === "dropoff"
                ? { mengantarPickupTimeId: "" }
                : {}),
        }));

        if (
            mode === "scheduled" &&
            form.mengantarPickupAddressId
        ) {
            void loadMengantarTimes(
                form.mengantarPickupAddressId
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

        /*
         * Access Token: hanya divalidasi kalau diisi.
         * Kosong = pertahankan token lama.
         */
        if (
            form.tiktokPixelAccessToken.trim() &&
            form.tiktokPixelAccessToken.trim()
                .length >
                MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH
        ) {
            toast.error(
                `TikTok Pixel Access Token maksimal ${MAX_TIKTOK_PIXEL_ACCESS_TOKEN_LENGTH} karakter.`
            );
            return;
        }

        if (
            form.tiktokPixelAccessToken.trim() &&
            !normalizeTikTokPixelAccessToken(
                form.tiktokPixelAccessToken
            )
        ) {
            toast.error(
                "TikTok Pixel Access Token tidak valid."
            );
            return;
        }

        /*
         * Mengantar: a partial config is never valid. Empty is fine
         * (Mengantar disabled) — server validates the same rules.
         */
        const mengantarOriginId =
            form.mengantarOriginAreaId.trim();
        const mengantarPickupId =
            form.mengantarPickupAddressId.trim();

        if (
            mengantarOriginId ||
            mengantarPickupId ||
            form.mengantarPickupTimeId.trim()
        ) {
            if (!mengantarOriginId) {
                toast.error(
                    "Origin area Mengantar wajib diisi."
                );
                return;
            }

            if (!mengantarPickupId) {
                toast.error(
                    "Pickup address Mengantar wajib diisi."
                );
                return;
            }
        }

        if (
            form.mengantarPickupMode === "scheduled" &&
            mengantarOriginId &&
            !form.mengantarPickupTimeId.trim()
        ) {
            toast.error(
                "Pilih slot waktu pickup untuk Scheduled Pickup."
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
                        FAVICON WEBSITE
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <h2 className="text-lg font-bold text-gray-900">
                            Favicon Website
                        </h2>

                        <p className="mt-1 text-sm text-gray-500">
                            Ikon kecil yang tampil di tab
                            browser. Format PNG, JPG, WEBP,
                            atau ICO, maksimal 1MB. Hapus untuk
                            kembali ke ikon default.
                        </p>

                        <div className="mt-5 flex flex-wrap items-center gap-5">
                            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-gray-200 bg-gray-50">
                                {form.faviconUrl ? (
                                    <img
                                        src={form.faviconUrl}
                                        alt="Favicon saat ini"
                                        className="h-8 w-8 object-contain"
                                    />
                                ) : (
                                    <span className="text-xs text-gray-400">
                                        Default
                                    </span>
                                )}
                            </div>

                            <div className="space-y-2">
                                <p className="text-sm font-medium text-gray-700">
                                    {form.faviconUrl
                                        ? "Favicon kustom aktif"
                                        : "Belum ada favicon kustom"}
                                </p>

                                <p className="break-all text-xs text-gray-400">
                                    {form.faviconUrl ||
                                        "Ikon default aplikasi"}
                                </p>

                                <div className="flex gap-2">
                                    <input
                                        ref={faviconInputRef}
                                        type="file"
                                        accept={FAVICON_ACCEPT}
                                        onChange={
                                            handleFaviconUpload
                                        }
                                        className="hidden"
                                        id="store-favicon"
                                        disabled={
                                            faviconUploading
                                        }
                                    />

                                    <label
                                        htmlFor="store-favicon"
                                        className={`cursor-pointer rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800 ${
                                            faviconUploading
                                                ? "pointer-events-none opacity-60"
                                                : ""
                                        }`}
                                    >
                                        {faviconUploading
                                            ? "Memproses..."
                                            : form.faviconUrl
                                              ? "Ganti Favicon"
                                              : "Upload Favicon"}
                                    </label>

                                    {form.faviconUrl && (
                                        <button
                                            type="button"
                                            onClick={
                                                handleFaviconRemove
                                            }
                                            disabled={
                                                faviconUploading
                                            }
                                            className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:opacity-60"
                                        >
                                            Hapus
                                        </button>
                                    )}
                                </div>
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

                        {/* ACCESS TOKEN (SERVER-SIDE EVENTS API) */}

                        <div className="mt-5">
                            <label className="text-sm font-medium text-gray-700">
                                TikTok Pixel Access Token
                            </label>

                            <p className="mt-2 text-xs font-medium text-gray-600">
                                {form.tiktokPixelAccessTokenConfigured
                                    ? "Access Token tersimpan"
                                    : "Belum ada Access Token tersimpan"}

                                {form.tiktokPixelAccessTokenConfigured &&
                                    form.tiktokPixelAccessTokenLast4 && (
                                        <span className="ml-1 font-mono text-gray-400">
                                            ({"••••"}
                                            {
                                                form.tiktokPixelAccessTokenLast4
                                            }
                                            )
                                        </span>
                                    )}
                            </p>

                            <div className="mt-2 flex gap-2">
                                <input
                                    type={
                                        showAccessToken
                                            ? "text"
                                            : "password"
                                    }
                                    value={
                                        form.tiktokPixelAccessToken
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "tiktokPixelAccessToken",
                                            e.target.value
                                        )
                                    }
                                    disabled={
                                        form.clearTiktokPixelAccessToken
                                    }
                                    className="w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm outline-none transition focus:border-rose-500 disabled:bg-gray-100"
                                    placeholder={
                                        form.tiktokPixelAccessTokenConfigured
                                            ? "Kosongkan untuk mempertahankan token lama"
                                            : "Tempel Access Token dari TikTok Events Manager"
                                    }
                                    autoComplete="new-password"
                                    spellCheck={false}
                                />

                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowAccessToken(
                                            (value) =>
                                                !value
                                        )
                                    }
                                    className="shrink-0 rounded-xl border border-gray-300 px-4 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
                                >
                                    {showAccessToken
                                        ? "Sembunyikan"
                                        : "Lihat"}
                                </button>
                            </div>

                            <p className="mt-2 text-xs text-gray-500">
                                Dipakai hanya oleh server untuk
                                TikTok Events API. Nilainya tidak
                                pernah dikirim ke browser / client
                                bundle. Token yang tersimpan tidak
                                pernah ditampilkan kembali.
                            </p>

                            {form.tiktokPixelAccessTokenConfigured && (
                                <label className="mt-3 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-3">
                                    <input
                                        type="checkbox"
                                        checked={
                                            form.clearTiktokPixelAccessToken
                                        }
                                        onChange={(e) =>
                                            updateField(
                                                "clearTiktokPixelAccessToken",
                                                e.target.checked
                                            )
                                        }
                                        className="mt-0.5 h-4 w-4 accent-red-600"
                                    />

                                    <span className="text-xs text-red-700">
                                        Hapus Access Token yang
                                        tersimpan (TikTok Events API
                                        server-side akan berhenti
                                        mengirim event).
                                    </span>
                                </label>
                            )}
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
                        MENGANTAR SHIPPING
                    ====================== */}

                    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">
                                    Mengantar Shipping
                                </h2>

                                <p className="mt-1 text-sm text-gray-500">
                                    Konfigurasi pickup untuk
                                    ongkir & pengiriman
                                    Mengantar. RajaOngkir tetap
                                    dipakai untuk dropdown
                                    alamat customer.
                                </p>
                            </div>

                            <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                    form.mengantarPickupConfigured
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-gray-100 text-gray-600"
                                }`}
                            >
                                {form.mengantarPickupConfigured
                                    ? "Terkonfigurasi"
                                    : "Belum dikonfigurasi"}
                            </span>
                        </div>

                        {!form.mengantarApiConfigured && (
                            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                                API key Mengantar belum diatur di
                                server, jadi pencarian area &
                                pickup address otomatis tidak
                                tersedia. Isi ID secara manual
                                dari dashboard Mengantar.
                            </p>
                        )}

                        {/* ORIGIN AREA */}

                        <div className="mt-5">
                            <label className="text-sm font-medium text-gray-700">
                                Origin Area (Mengantar)
                            </label>

                            <p className="mt-1 text-xs text-gray-500">
                                Area asal pengiriman. Ini
                                BUKAN RajaOngkir destination
                                ID.
                            </p>

                            <div className="mt-2 flex flex-wrap gap-2">
                                <input
                                    type="text"
                                    value={
                                        mengantarOriginQuery
                                    }
                                    onChange={(e) =>
                                        setMengantarOriginQuery(
                                            e.target.value
                                        )
                                    }
                                    className="min-w-[220px] flex-1 rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-rose-500"
                                    placeholder="Cari area, mis. Nagarakembang"
                                    autoComplete="off"
                                    spellCheck={false}
                                />

                                <button
                                    type="button"
                                    onClick={
                                        searchMengantarOrigin
                                    }
                                    disabled={loadingMengantar}
                                    className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
                                >
                                    Cari
                                </button>
                            </div>

                            {mengantarAreas.length > 0 && (
                                <ul className="mt-2 max-h-60 overflow-auto rounded-xl border border-gray-200">
                                    {mengantarAreas.map(
                                        (area) => (
                                            <li
                                                key={
                                                    area.id
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        selectMengantarOrigin(
                                                            area
                                                        )
                                                    }
                                                    className="w-full px-4 py-2 text-left text-sm transition hover:bg-rose-50"
                                                >
                                                    <span className="block font-medium text-gray-800">
                                                        {[
                                                            area.subdistrict,
                                                            area.district,
                                                            area.city,
                                                            area.province,
                                                        ]
                                                            .filter(
                                                                Boolean
                                                            )
                                                            .join(
                                                                " / "
                                                            )}
                                                    </span>

                                                    <span className="block text-xs text-gray-500">
                                                        {area.postalCode ||
                                                            "-"}{" "}
                                                        •{" "}
                                                        {
                                                            area.id
                                                        }
                                                    </span>
                                                </button>
                                            </li>
                                        )
                                    )}
                                </ul>
                            )}

                            <input
                                type="text"
                                value={
                                    form.mengantarOriginAreaId
                                }
                                onChange={(e) =>
                                    updateField(
                                        "mengantarOriginAreaId",
                                        e.target.value.trim()
                                    )
                                }
                                className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm outline-none transition focus:border-rose-500"
                                placeholder="Origin area _id"
                                autoComplete="off"
                                spellCheck={false}
                            />

                            {mengantarOriginLabel && (
                                <p className="mt-1 text-xs text-gray-500">
                                    Terpilih:{" "}
                                    {mengantarOriginLabel}
                                </p>
                            )}
                        </div>

                        {/* PICKUP ADDRESS */}

                        <div className="mt-5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="text-sm font-medium text-gray-700">
                                    Pickup Address
                                    (Mengantar)
                                </label>

                                <button
                                    type="button"
                                    onClick={
                                        loadMengantarPickupAddresses
                                    }
                                    disabled={loadingMengantar}
                                    className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-60"
                                >
                                    {loadingMengantar
                                        ? "Memuat..."
                                        : "Muat daftar pickup address"}
                                </button>
                            </div>

                            <p className="mt-1 text-xs text-gray-500">
                                Bukan origin area ID. Ambil dari
                                daftar pickup address akun
                                Mengantar.
                            </p>

                            {mengantarPickupAddresses.length >
                            0 ? (
                                <select
                                    value={
                                        form.mengantarPickupAddressId
                                    }
                                    onChange={(e) =>
                                        handleMengantarPickupChange(
                                            e.target.value
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500"
                                >
                                    <option value="">
                                        Pilih pickup address
                                    </option>

                                    {mengantarPickupAddresses.map(
                                        (addr) => (
                                            <option
                                                key={
                                                    addr._id
                                                }
                                                value={
                                                    addr._id
                                                }
                                            >
                                                {addr.name ||
                                                    "Pickup address"}{" "}
                                                —{" "}
                                                {addr.address ||
                                                    addr._id}
                                            </option>
                                        )
                                    )}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={
                                        form.mengantarPickupAddressId
                                    }
                                    onChange={(e) =>
                                        handleMengantarPickupChange(
                                            e.target.value.trim()
                                        )
                                    }
                                    className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm outline-none transition focus:border-rose-500"
                                    placeholder="Pickup address _id"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            )}

                            {mengantarPickupLabel && (
                                <p className="mt-1 text-xs text-gray-500">
                                    Terpilih:{" "}
                                    {mengantarPickupLabel}
                                </p>
                            )}
                        </div>

                        {/* PICKUP MODE */}

                        <div className="mt-5">
                            <label className="text-sm font-medium text-gray-700">
                                Metode Pickup
                            </label>

                            <div className="mt-2 flex flex-wrap gap-2">
                                {(
                                    [
                                        "dropoff",
                                        "scheduled",
                                    ] as const
                                ).map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() =>
                                            handleMengantarModeChange(
                                                mode
                                            )
                                        }
                                        className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                                            form.mengantarPickupMode ===
                                            mode
                                                ? "border-rose-500 bg-rose-50 text-rose-700"
                                                : "border-gray-300 text-gray-700 hover:bg-gray-50"
                                        }`}
                                    >
                                        {mode ===
                                        "dropoff"
                                            ? "Drop-off"
                                            : "Scheduled Pickup"}
                                    </button>
                                ))}
                            </div>

                            {form.mengantarPickupMode ===
                            "scheduled" ? (
                                <select
                                    value={
                                        form.mengantarPickupTimeId
                                    }
                                    onChange={(e) =>
                                        updateField(
                                            "mengantarPickupTimeId",
                                            e.target.value
                                        )
                                    }
                                    disabled={
                                        !form.mengantarPickupAddressId ||
                                        loadingMengantar
                                    }
                                    className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 outline-none transition focus:border-rose-500 disabled:bg-gray-100"
                                >
                                    <option value="">
                                        Pilih slot waktu pickup
                                    </option>

                                    {mengantarTimes.map(
                                        (slot) => (
                                            <option
                                                key={
                                                    slot._id
                                                }
                                                value={
                                                    slot._id
                                                }
                                            >
                                                {[
                                                    slot.date,
                                                    slot.time,
                                                ]
                                                    .filter(
                                                        Boolean
                                                    )
                                                    .join(" ") ||
                                                    slot._id}
                                            </option>
                                        )
                                    )}
                                </select>
                            ) : (
                                <p className="mt-2 text-xs text-gray-500">
                                    Drop-off: paket diantar
                                    sendiri ke counter. Pickup
                                    time dikosongkan (NULL).
                                </p>
                            )}
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