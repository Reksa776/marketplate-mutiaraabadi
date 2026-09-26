"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { trackTikTokEvent } from "@/lib/analytics/tiktok";
import { whenTikTokReadyForEvents } from "@/lib/analytics/tiktok-identity";
import { buildTikTokCartProperties } from "@/lib/analytics/tiktok-catalog";
import VoucherPickerModal from "@/components/VoucherPickerModal";
import type { VoucherPickerSelection } from "@/components/VoucherPickerModal";
import {
    IPAYMU_MIN_AMOUNT,
    IPAYMU_MIN_AMOUNT_FULL_MESSAGE,
    IPAYMU_MIN_AMOUNT_UI_NOTE,
    isIpaymuAmountAllowed,
} from "@/lib/payment/ipaymu-min-amount";

type Address = {
    id: string;
    label: string | null;
    recipientName: string;
    phone: string;
    address: string;

    province: string | null;
    city: string | null;
    district: string | null;
    subdistrict: string | null;

    postalCode: string | null;

    provinceId: number | null;
    regencyId: number | null;
    districtId: number | null;
    villageId: number | null;

    rajaOngkirDestinationId: number | null;

    latitude: string | null;
    longitude: string | null;

    isDefault: boolean;
};

type CheckoutItem = {
    id: number;
    productId: number;
    variantId: number;

    productName: string;
    variantName: string;

    image: string | null;

    price: number;
    quantity: number;

    availableStock: number;
    stockStatus: "OK" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "VARIANT_NOT_FOUND";

    /*
     * Berat satu variant.
     */
    weight: number;

    /*
     * Berat variant x quantity.
     */
    totalWeight: number;

    subtotal: number;
};

type CheckoutData = {
    items: CheckoutItem[];
    subtotal: number;
    totalWeight: number;
    invalidCount: number;
    addresses: Address[];

    store: {
        id: number;
        storeName: string;
        rajaOngkirDestinationId: number | null;
    };
};

type AddressForm = {
    label: string;

    recipientName: string;
    phone: string;
    address: string;

    province: string;
    provinceId: string;

    city: string;
    cityId: string;

    district: string;
    districtId: string;

    subdistrict: string;
    subdistrictId: string;

    postalCode: string;

    rajaOngkirDestinationId: number | null;

    latitude: string;
    longitude: string;

    isDefault: boolean;
};

type Region = {
    id: number;
    name: string;
    zip_code?: string;
};

type ShippingOption = {
    description: string | undefined;
    courier?: string;
    code?: string;

    service?: string;
    service_name?: string;

    etd?: string;
    estimation?: string;

    cost?: number;
    price?: number;
    shipping_cost?: number;
};

/*
 * =====================================================
 * PENJELASAN LAYANAN KURIR
 * =====================================================
 */

const SERVICE_EXPLANATIONS: Record<string, string> = {
    "JNE-OKE": "Layanan ekonomis JNE, harga paling murah tapi estimasi lebih lama.",
    "JNE-REG": "Layanan reguler JNE, estimasi standar dengan harga wajar.",
    "JNE-YES": "Yakin Esok Sampai — JNE menjamin paket sampai keesokan hari (khusus kota-kota tertentu).",
    "JNE-SPS": "Super Speed — pengiriman di hari yang sama, khusus rute tertentu.",

    "JNT-EZ": "Layanan ekonomis J&T, harga lebih murah dengan estimasi lebih lama.",
    "JNT-REG": "Layanan reguler J&T, estimasi standar.",

    "SICEPAT-REG": "Layanan reguler SiCepat, estimasi standar.",
    "SICEPAT-BEST": "Besok Sampai Tujuan — SiCepat menjamin paket sampai keesokan hari.",
    "SICEPAT-GOKIL": "Ongkos Kirim Irit — layanan paling murah SiCepat, estimasi lebih lama.",
    "SICEPAT-SDS": "Same Day Service — sampai di hari yang sama (khusus kota tertentu).",
};

function getServiceExplanation(
    courier: string,
    service: string,
    apiDescription?: string
) {
    const key = `${courier}-${service}`.toUpperCase();

    return (
        SERVICE_EXPLANATIONS[key] ||
        apiDescription ||
        "Layanan pengiriman standar dari kurir ini."
    );
}

const emptyAddressForm: AddressForm = {
    label: "",

    recipientName: "",
    phone: "",
    address: "",

    province: "",
    provinceId: "",

    city: "",
    cityId: "",

    district: "",
    districtId: "",

    subdistrict: "",
    subdistrictId: "",

    postalCode: "",

    rajaOngkirDestinationId: null,

    latitude: "",
    longitude: "",

    isDefault: false,
};

export default function CheckoutPage() {
    const creatingPaymentRef = useRef(false);
    const [appliedVoucherCode, setAppliedVoucherCode] = useState("");
    const [voucherDiscount, setVoucherDiscount] = useState(0);

    // Spin Wheel reward state
    type PendingSpinReward = {
        spinId: number;
        rewardId: number;
        rewardName: string;
        rewardType: string;
        rewardValue: number;
        maxDiscount: number | null;
        createdAt: string;
    };
    const [pendingSpinRewards, setPendingSpinRewards] = useState<PendingSpinReward[]>([]);
    const [selectedSpinReward, setSelectedSpinReward] = useState<number | null>(null);

    // Voucher Picker Modal state
    const [showVoucherPicker, setShowVoucherPicker] = useState(false);
    const [voucherPickerSelection, setVoucherPickerSelection] = useState<VoucherPickerSelection>({
        voucherCode: null,
        spinWheelSpinId: null,
        voucherDiscount: 0,
        spinWheelDiscount: 0,
    });

    // Manual voucher code state
    const [manualVoucherCode, setManualVoucherCode] = useState("");
    const [manualVoucherLoading, setManualVoucherLoading] = useState(false);
    const [manualVoucherError, setManualVoucherError] = useState<string | null>(null);
    const [showManualVoucherInput, setShowManualVoucherInput] = useState(false);

    function handleVoucherPickerSelect(selection: VoucherPickerSelection) {
        setAppliedVoucherCode(selection.voucherCode || "");
        setVoucherDiscount(selection.voucherDiscount);
        setSelectedSpinReward(selection.spinWheelSpinId);
        setVoucherPickerSelection(selection);
        // Clear manual input state when picker selection changes
        setManualVoucherCode("");
        setManualVoucherError(null);
    }

    async function validateManualVoucher() {
        const code = manualVoucherCode.trim();
        if (!code) {
            setManualVoucherError("Masukkan kode voucher.");
            return;
        }

        if (!data) return;

        try {
            setManualVoucherLoading(true);
            setManualVoucherError(null);

            const response = await fetch("/api/voucher/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code,
                    subtotal: data.subtotal,
                }),
                cache: "no-store",
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                setManualVoucherError(
                    result.message || "Kode voucher tidak dapat digunakan."
                );
                return;
            }

            // Apply the validated voucher
            setAppliedVoucherCode(result.data.code);
            setVoucherDiscount(result.data.discount);

            // Clear spin wheel (mutual exclusion)
            setSelectedSpinReward(null);

            // Update voucher picker selection to reflect the manual code
            setVoucherPickerSelection({
                voucherCode: result.data.code,
                spinWheelSpinId: null,
                voucherDiscount: result.data.discount,
                spinWheelDiscount: 0,
            });

            setManualVoucherCode("");
            setManualVoucherError(null);
            setShowManualVoucherInput(false);

            toast.success(`Voucher ${result.data.code} berhasil diterapkan!`);
        } catch {
            setManualVoucherError("Gagal memvalidasi voucher. Coba lagi.");
        } finally {
            setManualVoucherLoading(false);
        }
    }

    function removeManualVoucher() {
        setAppliedVoucherCode("");
        setVoucherDiscount(0);
        setManualVoucherCode("");
        setManualVoucherError(null);
        setVoucherPickerSelection({
            voucherCode: null,
            spinWheelSpinId: null,
            voucherDiscount: 0,
            spinWheelDiscount: 0,
        });
    }
    const snapProcessingRef = useRef(false);
    const router = useRouter();
    const [paymentMethod, setPaymentMethod] = useState<
        "COD" | "BANK_TRANSFER" | "E_WALLET" | "QRIS"
    >("COD");

    /*
     * Provider channel chosen by the customer (bank / e-wallet).
     *
     * This is only a CHOICE: the server validates it against the iPaymu
     * channel allowlist before creating any order, and the amount /
     * reference / buyer data stay server-authoritative.
     */
    const [paymentChannel, setPaymentChannel] =
        useState<string | null>(null);
    const [loading, setLoading] =
        useState(true);

    const [data, setData] =
        useState<CheckoutData | null>(null);

    const [selectedAddress, setSelectedAddress] =
        useState("");

    const [showAddressForm, setShowAddressForm] =
        useState(false);

    const [savingAddress, setSavingAddress] =
        useState(false);

    const [shippingOptions, setShippingOptions] =
        useState<ShippingOption[]>([]);

    const [selectedShipping, setSelectedShipping] =
        useState<ShippingOption | null>(null);

    const [loadingShipping, setLoadingShipping] =
        useState(false);

    const [shippingDiscount, setShippingDiscount] = useState(0);
    const [shippingDiscountName, setShippingDiscountName] = useState<string | null>(null);

    /*
     * REGION
     */

    const [provinces, setProvinces] =
        useState<Region[]>([]);

    const [cities, setCities] =
        useState<Region[]>([]);

    const [districts, setDistricts] =
        useState<Region[]>([]);

    const [subdistricts, setSubdistricts] =
        useState<Region[]>([]);

    const [loadingProvinces, setLoadingProvinces] =
        useState(false);

    const [loadingCities, setLoadingCities] =
        useState(false);

    const [loadingDistricts, setLoadingDistricts] =
        useState(false);

    const [loadingSubdistricts, setLoadingSubdistricts] =
        useState(false);

    const [loadingDestination, setLoadingDestination] =
        useState(false);

    const [addressForm, setAddressForm] =
        useState<AddressForm>(
            emptyAddressForm
        );


    /*
     * ==========================================
     * TIKTOK PIXEL - INITIATE CHECKOUT
     * ==========================================
     *
     * Fire when checkout data is loaded
     * (items available).
     */
    useEffect(() => {
        if (!data || data.items.length === 0) {
            return;
        }

        /*
         * Standard TikTok parameters: every cart line is its own
         * catalog entry (multi-product contents[]), and `value`
         * is the server-computed subtotal.
         */
        return whenTikTokReadyForEvents(() => {
            trackTikTokEvent(
                "InitiateCheckout",
                buildTikTokCartProperties(
                    data.items.map((item) => ({
                        productId: item.productId,
                        variantId: item.variantId,
                        productName: item.productName,
                        quantity: item.quantity,
                        price: item.price,
                    })),
                    { value: data.subtotal }
                )
            );
        });
    }, [data]);

    /*
     * ==========================================
     * LOAD REGIONS
     * ==========================================
     */

    async function loadRegions(
        type:
            | "province"
            | "city"
            | "district"
            | "subdistrict",
        id?: string
    ): Promise<Region[]> {
        const params = new URLSearchParams();

        params.set("type", type);

        if (id) {
            params.set("id", id);
        }

        const response = await fetch(
            `/api/rajaongkir/regions?${params.toString()}`,
            {
                cache: "no-store",
            }
        );

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(
                result.message ||
                "Gagal mengambil data wilayah."
            );
        }

        return Array.isArray(result.data)
            ? result.data
            : [];
    }

    /*
     * ==========================================
     * LOAD DESTINATION RAJAONGKIR
     * ==========================================
     */

    async function loadRajaOngkirDestination() {
        if (
            !addressForm.provinceId ||
            !addressForm.cityId ||
            !addressForm.districtId ||
            !addressForm.subdistrictId
        ) {
            return;
        }

        if (
            !addressForm.province ||
            !addressForm.city ||
            !addressForm.district ||
            !addressForm.subdistrict
        ) {
            return;
        }

        try {
            setLoadingDestination(true);

            /*
             * ==========================================
             * BUILD PARAMS
             * ==========================================
             */

            const params =
                new URLSearchParams();

            params.set(
                "provinceId",
                addressForm.provinceId
            );

            params.set(
                "cityId",
                addressForm.cityId
            );

            params.set(
                "districtId",
                addressForm.districtId
            );

            params.set(
                "subdistrictId",
                addressForm.subdistrictId
            );

            /*
             * Nama wilayah diperlukan oleh
             * RajaOngkir untuk parameter search.
             */

            params.set(
                "province",
                addressForm.province
            );

            params.set(
                "city",
                addressForm.city
            );

            params.set(
                "district",
                addressForm.district
            );

            params.set(
                "subdistrict",
                addressForm.subdistrict
            );

            if (
                addressForm.postalCode
            ) {
                params.set(
                    "postalCode",
                    addressForm.postalCode
                );
            }

            /*
             * ==========================================
             * REQUEST
             * ==========================================
             */

            console.log(
                "LOAD RAJAONGKIR DESTINATION:",
                {
                    province:
                        addressForm.province,

                    city:
                        addressForm.city,

                    district:
                        addressForm.district,

                    subdistrict:
                        addressForm.subdistrict,

                    postalCode:
                        addressForm.postalCode,
                }
            );

            const response =
                await fetch(
                    `/api/rajaongkir/destination?${params.toString()}`,
                    {
                        method: "GET",
                        cache: "no-store",
                    }
                );

            const result =
                await response.json();

            console.log(
                "DESTINATION RESULT:",
                result
            );

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ||
                    "Destination RajaOngkir tidak ditemukan."
                );
            }

            const destinationId =
                Number(
                    result.data
                        ?.rajaOngkirDestinationId
                );

            if (
                !Number.isInteger(
                    destinationId
                ) ||
                destinationId <= 0
            ) {
                throw new Error(
                    "Destination RajaOngkir yang diterima tidak valid."
                );
            }

            /*
             * ==========================================
             * SAVE DESTINATION ID
             * ==========================================
             */

            setAddressForm(
                (prev) => ({
                    ...prev,

                    rajaOngkirDestinationId:
                        destinationId,
                })
            );

            console.log(
                "RAJAONGKIR DESTINATION ID:",
                destinationId
            );
        } catch (error) {
            console.error(
                "LOAD DESTINATION ERROR:",
                error
            );

            setAddressForm(
                (prev) => ({
                    ...prev,

                    rajaOngkirDestinationId:
                        null,
                })
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mencari destination RajaOngkir."
            );
        } finally {
            setLoadingDestination(false);
        }
    }

    /*
     * ==========================================
     * LOAD PROVINCES
     * ==========================================
     */

    async function loadProvinces() {
        try {
            setLoadingProvinces(true);

            const result =
                await loadRegions(
                    "province"
                );

            setProvinces(result);
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil provinsi."
            );
        } finally {
            setLoadingProvinces(false);
        }
    }

    /*
     * ==========================================
     * PROVINCE
     * ==========================================
     */

    async function handleProvinceChange(
        provinceId: string
    ) {
        const province =
            provinces.find(
                (item) =>
                    String(item.id) ===
                    provinceId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                provinceId,

                province:
                    province?.name ?? "",

                cityId: "",
                city: "",

                districtId: "",
                district: "",

                subdistrictId: "",
                subdistrict: "",

                postalCode: "",

                rajaOngkirDestinationId:
                    null,
            })
        );

        setCities([]);
        setDistricts([]);
        setSubdistricts([]);

        if (!provinceId) {
            return;
        }

        try {
            setLoadingCities(true);

            const result =
                await loadRegions(
                    "city",
                    provinceId
                );

            setCities(result);
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kota."
            );
        } finally {
            setLoadingCities(false);
        }
    }

    /*
     * ==========================================
     * CITY
     * ==========================================
     */

    async function handleCityChange(
        cityId: string
    ) {
        const city =
            cities.find(
                (item) =>
                    String(item.id) ===
                    cityId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                cityId,

                city:
                    city?.name ?? "",

                districtId: "",
                district: "",

                subdistrictId: "",
                subdistrict: "",

                postalCode: "",

                rajaOngkirDestinationId:
                    null,
            })
        );

        setDistricts([]);
        setSubdistricts([]);

        if (!cityId) {
            return;
        }

        try {
            setLoadingDistricts(true);

            const result =
                await loadRegions(
                    "district",
                    cityId
                );

            setDistricts(result);
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kecamatan."
            );
        } finally {
            setLoadingDistricts(false);
        }
    }

    /*
     * ==========================================
     * DISTRICT
     * ==========================================
     */

    async function handleDistrictChange(
        districtId: string
    ) {
        const district =
            districts.find(
                (item) =>
                    String(item.id) ===
                    districtId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                districtId,

                district:
                    district?.name ?? "",

                subdistrictId: "",
                subdistrict: "",

                postalCode: "",

                rajaOngkirDestinationId:
                    null,
            })
        );

        setSubdistricts([]);

        if (!districtId) {
            return;
        }

        try {
            setLoadingSubdistricts(
                true
            );

            const result =
                await loadRegions(
                    "subdistrict",
                    districtId
                );

            setSubdistricts(result);
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil kelurahan."
            );
        } finally {
            setLoadingSubdistricts(
                false
            );
        }
    }

    /*
     * ==========================================
     * SUBDISTRICT
     * ==========================================
     */

    async function handleSubdistrictChange(
        subdistrictId: string
    ) {
        const subdistrict =
            subdistricts.find(
                (item) =>
                    String(item.id) ===
                    subdistrictId
            );

        if (!subdistrict) {
            return;
        }

        /*
         * Simpan data wilayah dahulu.
         */

        setAddressForm(
            (prev) => ({
                ...prev,

                subdistrictId,

                subdistrict:
                    subdistrict.name,

                postalCode:
                    subdistrict.zip_code ??
                    "",

                /*
                 * Jangan langsung menggunakan
                 * subdistrict.id sebagai
                 * RajaOngkirDestinationId.
                 */

                rajaOngkirDestinationId:
                    null,
            })
        );
    }

    /*
     * ==========================================
     * CARI DESTINATION SETELAH KELURAHAN
     * ==========================================
     */

    useEffect(() => {
        if (
            !addressForm.provinceId ||
            !addressForm.cityId ||
            !addressForm.districtId ||
            !addressForm.subdistrictId ||
            !addressForm.province ||
            !addressForm.city ||
            !addressForm.district ||
            !addressForm.subdistrict
        ) {
            return;
        }

        loadRajaOngkirDestination();
    }, [
        addressForm.provinceId,
        addressForm.cityId,
        addressForm.districtId,
        addressForm.subdistrictId,
    ]);

    /*
     * ==========================================
     * INITIAL LOAD
     * ==========================================
     */

    useEffect(() => {
        loadCheckout();
        loadProvinces();

        // Load pending spin wheel rewards from localStorage
        try {
            const stored = localStorage.getItem("spinWheelPendingRewards");
            if (stored) {
                const rewards: PendingSpinReward[] = JSON.parse(stored);
                // Filter only non-expired rewards (30 days)
                const now = Date.now();
                const valid = rewards.filter(
                    (r) => now - new Date(r.createdAt).getTime() < 30 * 24 * 60 * 60 * 1000
                );
                setPendingSpinRewards(valid);
            }
        } catch {
            // ignore parse errors
        }
    }, []);

    /*
     * ==========================================
     * LOAD CHECKOUT
     * ==========================================
     */    async function loadCheckout() {
        try {
            setLoading(true);

            // Read selectedCartItemIds from localStorage
            let selectedParam = "";
            try {
                const stored = localStorage.getItem(
                    "selectedCartItemIds"
                );
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (
                        Array.isArray(parsed) &&
                        parsed.length > 0
                    ) {
                        selectedParam =
                            `?selectedCartItemIds=${encodeURIComponent(stored)}`;
                    }
                }
            } catch {
                // ignore
            }

            const response =
                await fetch(
                    `/api/checkout${selectedParam}`,
                    {
                        cache: "no-store",
                    }
                );

            const result =
                await response.json();

            if (!response.ok) {
                router.push("/cart")
                throw new Error(
                    result.message || "Gagal mengambil checkout."
                );
            }

            setData(result.data);

            const defaultAddress =
                result.data.addresses.find(
                    (item: Address) =>
                        item.isDefault
                );

            if (defaultAddress) {
                setSelectedAddress(
                    defaultAddress.id
                );
            } else if (
                result.data.addresses.length >
                0
            ) {
                setSelectedAddress(
                    result.data
                        .addresses[0].id
                );
            }
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil checkout."
            );
        } finally {
            setLoading(false);
        }
    }

    /*
     * ==========================================
     * UPDATE FORM
     * ==========================================
     */

    function updateAddressForm(
        field: keyof AddressForm,
        value:
            | string
            | boolean
            | number
            | null
    ) {
        setAddressForm(
            (prev) => ({
                ...prev,
                [field]: value,
            })
        );
    }

    /*
     * ==========================================
     * SAVE ADDRESS
     * ==========================================
     */

    async function saveAddress() {
        if (!addressForm.recipientName.trim()) {
            toast.error("Nama penerima wajib diisi.");
            return;
        }

        if (!addressForm.phone.trim()) {
            toast.error("Nomor HP wajib diisi.");
            return;
        }

        if (!addressForm.address.trim()) {
            toast.error("Alamat lengkap wajib diisi.");
            return;
        }

        if (!addressForm.provinceId) {
            toast.error("Pilih provinsi.");
            return;
        }

        if (!addressForm.cityId) {
            toast.error("Pilih kota/kabupaten.");
            return;
        }

        if (!addressForm.districtId) {
            toast.error("Pilih kecamatan.");
            return;
        }

        if (!addressForm.subdistrictId) {
            toast.error("Pilih kelurahan/desa.");
            return;
        }

        if (loadingDestination) {
            toast.error(
                "Sedang mencari Destination RajaOngkir. Tunggu sebentar."
            );
            return;
        }

        if (
            !addressForm.rajaOngkirDestinationId ||
            addressForm.rajaOngkirDestinationId <= 0
        ) {
            toast.error(
                "Destination RajaOngkir belum ditemukan."
            );
            return;
        }

        if (!addressForm.postalCode.trim()) {
            toast.error("Kode pos belum tersedia.");
            return;
        }

        try {
            setSavingAddress(true);

            const response = await fetch(
                "/api/addresses",
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json",
                    },

                    body: JSON.stringify({
                        label:
                            addressForm.label.trim() ||
                            null,

                        recipientName:
                            addressForm.recipientName.trim(),

                        phone:
                            addressForm.phone.trim(),

                        address:
                            addressForm.address.trim(),

                        province:
                            addressForm.province,

                        city:
                            addressForm.city,

                        district:
                            addressForm.district,

                        subdistrict:
                            addressForm.subdistrict,

                        postalCode:
                            addressForm.postalCode,

                        /*
                         * Database IDs
                         */

                        provinceId:
                            Number(
                                addressForm.provinceId
                            ),

                        regencyId:
                            Number(
                                addressForm.cityId
                            ),

                        districtId:
                            Number(
                                addressForm.districtId
                            ),

                        villageId:
                            Number(
                                addressForm.subdistrictId
                            ),

                        /*
                         * RajaOngkir destination
                         */

                        rajaOngkirDestinationId:
                            Number(
                                addressForm.rajaOngkirDestinationId
                            ),

                        latitude:
                            addressForm.latitude
                                ? Number(
                                    addressForm.latitude
                                )
                                : null,

                        longitude:
                            addressForm.longitude
                                ? Number(
                                    addressForm.longitude
                                )
                                : null,

                        isDefault:
                            addressForm.isDefault,
                    }),
                }
            );

            const result =
                await response.json();

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ||
                    "Gagal menyimpan alamat."
                );
            }

            toast.success(
                "Alamat berhasil disimpan."
            );

            setShowAddressForm(false);

            setAddressForm({
                ...emptyAddressForm,
            });

            await loadCheckout();

            const savedAddress =
                result.data ??
                result.address;

            if (savedAddress?.id) {
                setSelectedAddress(
                    savedAddress.id
                );
            }
        } catch (error) {
            console.error(
                "SAVE ADDRESS ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal menyimpan alamat."
            );
        } finally {
            setSavingAddress(false);
        }
    }

    /*
     * ==========================================
     * SHIPPING COST
     * ==========================================
     */

    async function loadShippingCost() {
        if (!selectedAddress) {
            setShippingOptions([]);
            setSelectedShipping(null);
            return;
        }

        if (!data) {
            return;
        }

        const address = data.addresses.find(
            (item) =>
                item.id === selectedAddress
        );

        if (!address) {
            toast.error(
                "Alamat tidak ditemukan."
            );
            return;
        }

        const origin =
            Number(
                data.store
                    ?.rajaOngkirDestinationId
            );

        if (
            !Number.isInteger(origin) ||
            origin <= 0
        ) {
            toast.error(
                "Destination toko belum dikonfigurasi."
            );
            return;
        }

        const destination =
            Number(
                address.rajaOngkirDestinationId
            );

        if (
            !Number.isInteger(destination) ||
            destination <= 0
        ) {
            toast.error(
                "Destination alamat belum tersedia."
            );
            return;
        }

        /*
         * Berat dalam gram.
         *
         * Minimal 1 gram supaya request valid.
         */

        const weight = Math.max(
            Math.ceil(
                Number(
                    data.totalWeight || 0
                )
            ),
            1
        );

        try {
            setLoadingShipping(true);

            setShippingOptions([]);

            setSelectedShipping(null);

            const response = await fetch(
                "/api/shipping/cost",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body: JSON.stringify({
                        origin,

                        destination,

                        weight,

                        courier:
                            "jne:jnt:sicepat",

                        price:
                            "lowest",
                    }),

                    cache: "no-store",
                }
            );

            const result =
                await response.json();

            if (
                !response.ok ||
                !result.success
            ) {
                throw new Error(
                    result.message ||
                    "Gagal mengambil ongkir."
                );
            }

            const options =
                Array.isArray(
                    result.data
                )
                    ? result.data
                    : [];

            setShippingOptions(
                options
            );

            if (
                options.length === 0
            ) {
                toast.error(
                    "Tidak ada layanan pengiriman."
                );
            }
        } catch (error) {
            console.error(
                "SHIPPING COST ERROR:",
                error
            );

            setShippingOptions([]);

            setSelectedShipping(null);

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil ongkir."
            );
        } finally {
            setLoadingShipping(false);
        }
    }

    /*
     * ==========================================
     * AUTO SHIPPING
     * ==========================================
     */

    useEffect(() => {
        if (!selectedAddress) {
            setShippingOptions([]);
            setSelectedShipping(null);
            return;
        }

        if (!data) {
            return;
        }

        if (
            !data.totalWeight ||
            data.totalWeight <= 0
        ) {
            return;
        }

        loadShippingCost();
    }, [
        selectedAddress,
        data,
    ]);

    /*
     * ==========================================
     * SHIPPING DISCOUNT PREVIEW
     * ==========================================
     *
     * Fetch shipping discount preview when shipping is selected.
     */
    useEffect(() => {
        if (!selectedShipping || !data) {
            setShippingDiscount(0);
            setShippingDiscountName(null);
            return;
        }

        const shippingCost = Number(
            selectedShipping.cost ??
            selectedShipping.price ??
            selectedShipping.shipping_cost ??
            0
        );

        if (!Number.isFinite(shippingCost) || shippingCost <= 0) {
            setShippingDiscount(0);
            setShippingDiscountName(null);
            return;
        }

        async function fetchShippingDiscount() {
            try {
                const response = await fetch("/api/shipping/discount-preview", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        shippingCost,
                        subtotal: data!.subtotal,
                        code: appliedVoucherCode || null,
                    }),
                    cache: "no-store",
                });
                const result = await response.json();
                if (result.success && result.data?.hasDiscount) {
                    setShippingDiscount(result.data.discountAmount || 0);
                    setShippingDiscountName(result.data.name || null);
                } else {
                    setShippingDiscount(0);
                    setShippingDiscountName(null);
                }
            } catch {
                setShippingDiscount(0);
                setShippingDiscountName(null);
            }
        }

        fetchShippingDiscount();
    }, [selectedShipping, data, appliedVoucherCode]);

    /*
 /*
 * ==========================================
 * CREATE ORDER / CREATE PAYMENT
 * ==========================================
 */

    const [creatingOrder, setCreatingOrder] =
        useState(false);

    /*
     * ==========================================
     * PAYMENT CHANNELS
     * ==========================================
     *
     * Only channels published for the iPaymu direct payment API are
     * offered here (Virtual Account + e-wallet lists from the provider
     * documentation).
     */

    const BANK_CHANNELS = [
        { value: "bca", label: "BCA" },
        { value: "bni", label: "BNI" },
        { value: "bri", label: "BRI" },
        { value: "mandiri", label: "Mandiri" },
        { value: "bsi", label: "BSI" },
        { value: "permata", label: "Permata" },
        { value: "cimb", label: "CIMB Niaga" },
        { value: "danamon", label: "Danamon" },
    ];

    const EWALLET_CHANNELS = [
        { value: "dana", label: "DANA" },
        { value: "shopeepay", label: "ShopeePay" },
    ];

    function getSelectedCartItemIds(): number[] {
        try {
            const stored = localStorage.getItem(
                "selectedCartItemIds"
            );
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    return parsed
                        .map(Number)
                        .filter(
                            (n: number) =>
                                Number.isInteger(n) &&
                                n > 0
                        );
                }
            }
        } catch {
            // ignore
        }
        return [];
    }

    async function createOrder() {
        if (creatingOrder) {
            return;
        }

        if (snapProcessingRef.current) {
            return;
        }

        // Pre-check: reject if no items selected
        const selectedIds = getSelectedCartItemIds();
        if (selectedIds.length === 0) {
            toast.error(
                "Pilih minimal satu produk untuk checkout."
            );
            return;
        }

        if (!selectedAddress) {
            toast.error(
                "Pilih alamat pengiriman."
            );
            return;
        }

        if (!selectedShipping) {
            toast.error(
                "Pilih pengiriman."
            );
            return;
        }

        if (!paymentMethod) {
            toast.error(
                "Pilih metode pembayaran."
            );
            return;
        }

        /*
         * IPAYMU MIN-AMOUNT RULE
         *
         * Client-side mirror of the backend rule: below Rp10.000 only
         * QRIS is accepted by iPaymu. The server enforces this anyway —
         * this guard only gives instant feedback when the total dropped
         * below the threshold after a method was already selected.
         */
        if (
            paymentMethod !== "COD" &&
            !isIpaymuAmountAllowed(grandTotal, paymentMethod)
        ) {
            toast.error(IPAYMU_MIN_AMOUNT_FULL_MESSAGE);
            return;
        }

        /*
         * ==========================================
         * TIKTOK PIXEL - ADD PAYMENT INFO
         * ==========================================
         *
         * Fire when user submits order.
         */
        whenTikTokReadyForEvents(() => {
            trackTikTokEvent(
                "AddPaymentInfo",
                buildTikTokCartProperties(
                    data?.items.map((item) => ({
                        productId: item.productId,
                        variantId: item.variantId,
                        productName: item.productName,
                        quantity: item.quantity,
                        price: item.price,
                    })) ?? [],
                    {
                        value: grandTotal,
                        extra: {
                            payment_method: paymentMethod,
                        },
                    }
                )
            );
        });

        try {
            setCreatingOrder(true);

            /*
             * ==========================================
             * COD
             * ==========================================
             *
             * COD memang langsung membuat Order.
             */

            if (paymentMethod === "COD") {
                const response =
                    await fetch(
                        "/api/orders",
                        {
                            method: "POST",

                            headers: {
                                "Content-Type":
                                    "application/json",
                            },

                            body: JSON.stringify({
                                addressId:
                                    selectedAddress,

                                shipping:
                                    selectedShipping,

                                paymentMethod:
                                    "COD",
                                voucherCode: appliedVoucherCode || null,
                                spinWheelSpinId: selectedSpinReward,
                                selectedCartItemIds: getSelectedCartItemIds(),
                            }),
                        }
                    );

                const result =
                    await response.json();

                console.log(
                    "CREATE COD ORDER RESPONSE:",
                    result
                );

                if (
                    !response.ok ||
                    !result.success
                ) {
                    throw new Error(
                        result.message ||
                        "Gagal membuat pesanan COD."
                    );
                }

                const order =
                    result.data;

                if (!order?.id) {
                    throw new Error(
                        "Order COD berhasil dibuat tetapi ID order tidak ditemukan."
                    );
                }

                /*
                 * COD sudah benar-benar
                 * menjadi pesanan.
                 */

                // Clear used spin wheel reward from localStorage
                localStorage.removeItem("spinWheelPendingRewards");

                window.location.href =
                    `/checkout/success?order=${order.id}`;

                return;
            }

            /*
             * ==========================================
             * IPAYMU DIRECT PAYMENT
             * ==========================================
             *
             * BANK_TRANSFER
             * E_WALLET
             * QRIS
             *
             * Creates the order + the iPaymu direct payment, then sends
             * the customer to OUR OWN payment page where the QR / VA /
             * e-wallet instruction is displayed.
             */            const paymentResponse =
                await fetch(
                    "/api/payment/ipaymu",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            addressId:
                                selectedAddress,

                            shipping:
                                selectedShipping,
                            paymentMethod:
                                paymentMethod,
                            paymentChannel:
                                paymentMethod === "BANK_TRANSFER" ||
                                paymentMethod === "E_WALLET"
                                    ? paymentChannel
                                    : null,
                            voucherCode: appliedVoucherCode || null,
                            spinWheelSpinId: selectedSpinReward,
                            selectedCartItemIds: getSelectedCartItemIds(),
                        }),
                    }
                );

            const paymentResult =
                await paymentResponse.json();

            console.log(
                "IPAYMU RESPONSE:",
                paymentResult
            );

            if (
                !paymentResponse.ok ||
                !paymentResult.success
            ) {
                throw new Error(
                    paymentResult.message ||
                    "Gagal membuat pembayaran."
                );
            }

            const paymentData =
                paymentResult.data;

            if (!paymentData?.paymentUrl) {
                throw new Error(
                    "URL pembayaran tidak ditemukan."
                );
            }

            /*
             * ==========================================
             * HALAMAN PEMBAYARAN TOKO SENDIRI
             * ==========================================
             *
             * `paymentUrl` adalah halaman pembayaran milik toko
             * (/checkout/payment/{orderId}), bukan halaman iPaymu:
             * instruksi pembayaran (QRIS / VA / e-wallet) ditampilkan
             * di dalam toko dan customer tidak keluar dari website.
             */

            // Clear used spin wheel reward from localStorage
            localStorage.removeItem("spinWheelPendingRewards");

            window.location.href =
                paymentData.paymentUrl;
        } catch (error) {
            console.error(
                "CREATE PAYMENT ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal membuat pesanan."
            );
        } finally {
            setCreatingOrder(false);
        }
    }

    /*
     * ==========================================
     * LOADING
     * ==========================================
     */

    if (loading) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-6xl">
                    <div className="rounded-3xl border bg-white p-8">
                        Memuat checkout...
                    </div>
                </div>
            </main>
        );
    }

    if (!data) {
        return null;
    }

    const address =
        data.addresses.find(
            (item) =>
                item.id ===
                selectedAddress
        );

    const shippingCost =
        selectedShipping
            ? Number(
                selectedShipping.cost ??
                selectedShipping.price ??
                selectedShipping.shipping_cost ??
                0
            )
            : 0;

    const finalShippingCost = Math.max(0, shippingCost - shippingDiscount);

    // Compute spin wheel discount client-side for display
    const spinWheelDisplayDiscount = (() => {
        if (!selectedSpinReward) return 0;
        const selected = pendingSpinRewards.find((r) => r.spinId === selectedSpinReward);
        if (!selected) return 0;
        const subtotal = data.subtotal;
        switch (selected.rewardType) {
            case "PERCENTAGE": {
                let d = (subtotal * selected.rewardValue) / 100;
                if (selected.maxDiscount !== null && d > selected.maxDiscount) d = selected.maxDiscount;
                if (d > subtotal) d = subtotal;
                return Math.round(d);
            }
            case "FIXED": {
                let d = selected.rewardValue;
                if (d > subtotal) d = subtotal;
                return Math.round(d);
            }
            default:
                return 0;
        }
    })();

    const grandTotal = Math.max(
        0,
        data.subtotal -
        voucherDiscount -
        spinWheelDisplayDiscount +
        finalShippingCost
    );

    const iPaymuMinBlocked = grandTotal < IPAYMU_MIN_AMOUNT;

    /*
     * ==========================================
     * UI
     * ==========================================
     */

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-6xl">

                {/* HEADER */}

                <div className="mb-8">
                    <Link
                        href="/cart"
                        className="text-sm text-gray-500 hover:text-gray-900"
                    >
                        ← Kembali ke Keranjang
                    </Link>

                    <h1 className="mt-3 text-3xl font-bold text-gray-900">
                        Checkout
                    </h1>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1fr_380px]">

                    <div className="space-y-6">
                        {/* ================================= */}
                        {/* PRODUCTS */}
                        {/* ================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">

                            <h2 className="text-lg font-bold">
                                Produk
                            </h2>

                            {data.invalidCount > 0 && (
                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                    <p className="text-sm font-medium text-amber-800">
                                        ⚠️ {data.invalidCount} produk memiliki stok tidak mencukupi.
                                    </p>
                                    <p className="mt-1 text-xs text-amber-600">
                                        Kembali ke keranjang untuk memperbaiki sebelum checkout.
                                    </p>
                                    <a
                                        href="/cart"
                                        className="mt-2 inline-block text-xs font-medium text-amber-700 underline hover:text-amber-900"
                                    >
                                        Buka Keranjang →
                                    </a>
                                </div>
                            )}

                            <div className="mt-5 divide-y">

                                {data.items.map(
                                    (item) => (
                                        <div
                                            key={
                                                item.id
                                            }
                                            className="flex gap-4 py-4 first:pt-0 last:pb-0"
                                        >

                                            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-gray-100">

                                                {item.image && (
                                                    <img
                                                        src={
                                                            item.image
                                                        }
                                                        alt={
                                                            item.productName
                                                        }
                                                        className="h-full w-full object-cover"
                                                    />
                                                )}

                                            </div>

                                            <div className="min-w-0 flex-1">

                                                <h3 className="font-semibold">
                                                    {
                                                        item.productName
                                                    }
                                                </h3>

                                                <p className="mt-1 text-sm text-gray-500">
                                                    {
                                                        item.variantName
                                                    }
                                                </p>

                                                {item.stockStatus === "OUT_OF_STOCK" && (
                                                    <p className="mt-1 text-xs font-medium text-red-500">
                                                        ❌ Stok habis
                                                    </p>
                                                )}

                                                {item.stockStatus === "INSUFFICIENT_STOCK" && (
                                                    <p className="mt-1 text-xs font-medium text-amber-500">
                                                        ⚠️ Stok hanya tersedia {item.availableStock}
                                                    </p>
                                                )}

                                                <p className="mt-2 text-sm">
                                                    {
                                                        item.quantity
                                                    }{" "}
                                                    × Rp{" "}
                                                    {item.price.toLocaleString(
                                                        "id-ID"
                                                    )}
                                                </p>

                                                <p className="mt-1 text-xs text-gray-400">
                                                    Berat:{" "}
                                                    {item.weight.toLocaleString(
                                                        "id-ID"
                                                    )}{" "}
                                                    gram
                                                </p>

                                            </div>

                                            <div className="font-semibold">
                                                Rp{" "}
                                                {item.subtotal.toLocaleString(
                                                    "id-ID"
                                                )}
                                            </div>

                                        </div>
                                    )
                                )}

                            </div>

                        </section>

                        {/* ================================= */}
                        {/* ADDRESS */}
                        {/* ================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">

                                <div>
                                    <h2 className="text-lg font-bold">
                                        Alamat Pengiriman
                                    </h2>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Pilih atau tambahkan alamat pengiriman.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowAddressForm(
                                            (prev) =>
                                                !prev
                                        )
                                    }
                                    className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700"
                                >
                                    {showAddressForm
                                        ? "Tutup Form"
                                        : "+ Tambah Alamat"}
                                </button>

                            </div>

                            {/* FORM */}

                            {showAddressForm && (
                                <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5">

                                    <h3 className="font-semibold text-gray-900">
                                        Alamat Baru
                                    </h3>

                                    <div className="mt-5 grid gap-4 sm:grid-cols-2">

                                        {/* LABEL */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Label Alamat
                                            </label>

                                            <input
                                                type="text"
                                                value={
                                                    addressForm.label
                                                }
                                                onChange={(e) =>
                                                    updateAddressForm(
                                                        "label",
                                                        e.target.value
                                                    )
                                                }
                                                placeholder="Rumah"
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* NAMA */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Nama Penerima *
                                            </label>

                                            <input
                                                type="text"
                                                value={
                                                    addressForm.recipientName
                                                }
                                                onChange={(e) =>
                                                    updateAddressForm(
                                                        "recipientName",
                                                        e.target.value
                                                    )
                                                }
                                                placeholder="Nama penerima"
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* PHONE */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                No. WhatsApp *
                                            </label>

                                            <input
                                                type="tel"
                                                value={
                                                    addressForm.phone
                                                }
                                                onChange={(e) =>
                                                    updateAddressForm(
                                                        "phone",
                                                        e.target.value
                                                    )
                                                }
                                                placeholder="08xxxxxxxxxx"
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* ADDRESS */}

                                        <div className="sm:col-span-2">
                                            <label className="text-sm font-medium text-gray-700">
                                                Alamat Lengkap *
                                            </label>

                                            <textarea
                                                value={
                                                    addressForm.address
                                                }
                                                onChange={(e) =>
                                                    updateAddressForm(
                                                        "address",
                                                        e.target.value
                                                    )
                                                }
                                                rows={3}
                                                placeholder="Nama jalan, nomor rumah, RT/RW, patokan, dll."
                                                className="mt-1.5 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* PROVINCE */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Provinsi *
                                            </label>

                                            <select
                                                value={
                                                    addressForm.provinceId
                                                }
                                                onChange={(e) =>
                                                    handleProvinceChange(
                                                        e.target.value
                                                    )
                                                }
                                                disabled={
                                                    loadingProvinces
                                                }
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500 disabled:bg-gray-100"
                                            >
                                                <option value="">
                                                    {loadingProvinces
                                                        ? "Memuat provinsi..."
                                                        : "Pilih Provinsi"}
                                                </option>

                                                {provinces.map(
                                                    (province) => (
                                                        <option
                                                            key={
                                                                province.id
                                                            }
                                                            value={
                                                                province.id
                                                            }
                                                        >
                                                            {
                                                                province.name
                                                            }
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        </div>

                                        {/* CITY */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Kota / Kabupaten *
                                            </label>

                                            <select
                                                value={
                                                    addressForm.cityId
                                                }
                                                onChange={(e) =>
                                                    handleCityChange(
                                                        e.target.value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.provinceId ||
                                                    loadingCities
                                                }
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500 disabled:bg-gray-100"
                                            >
                                                <option value="">
                                                    {loadingCities
                                                        ? "Memuat kota..."
                                                        : "Pilih Kota / Kabupaten"}
                                                </option>

                                                {cities.map(
                                                    (city) => (
                                                        <option
                                                            key={
                                                                city.id
                                                            }
                                                            value={
                                                                city.id
                                                            }
                                                        >
                                                            {
                                                                city.name
                                                            }
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        </div>

                                        {/* DISTRICT */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Kecamatan *
                                            </label>

                                            <select
                                                value={
                                                    addressForm.districtId
                                                }
                                                onChange={(e) =>
                                                    handleDistrictChange(
                                                        e.target.value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.cityId ||
                                                    loadingDistricts
                                                }
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500 disabled:bg-gray-100"
                                            >
                                                <option value="">
                                                    {loadingDistricts
                                                        ? "Memuat kecamatan..."
                                                        : "Pilih Kecamatan"}
                                                </option>

                                                {districts.map(
                                                    (district) => (
                                                        <option
                                                            key={
                                                                district.id
                                                            }
                                                            value={
                                                                district.id
                                                            }
                                                        >
                                                            {
                                                                district.name
                                                            }
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        </div>

                                        {/* SUBDISTRICT */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Kelurahan / Desa *
                                            </label>

                                            <select
                                                value={
                                                    addressForm.subdistrictId
                                                }
                                                onChange={(e) =>
                                                    handleSubdistrictChange(
                                                        e.target.value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.districtId ||
                                                    loadingSubdistricts
                                                }
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm outline-none focus:border-rose-500 disabled:bg-gray-100"
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

                                        {/* POSTAL */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                Kode Pos
                                            </label>

                                            <input
                                                type="text"
                                                value={
                                                    addressForm.postalCode
                                                }
                                                readOnly
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-gray-100 px-3 text-sm outline-none"
                                            />
                                        </div>

                                        {/* DESTINATION */}

                                        <div>
                                            <label className="text-sm font-medium text-gray-700">
                                                RajaOngkir Destination ID
                                            </label>

                                            <input
                                                type="text"
                                                value={
                                                    addressForm.rajaOngkirDestinationId ??
                                                    ""
                                                }
                                                readOnly
                                                placeholder={
                                                    loadingDestination
                                                        ? "Mencari destination..."
                                                        : "Otomatis"
                                                }
                                                className="mt-1.5 h-11 w-full rounded-xl border border-gray-300 bg-gray-100 px-3 text-sm outline-none"
                                            />

                                            {loadingDestination && (
                                                <p className="mt-1 text-xs text-gray-500">
                                                    Mencari destination RajaOngkir...
                                                </p>
                                            )}

                                            {!loadingDestination &&
                                                addressForm.subdistrictId &&
                                                !addressForm.rajaOngkirDestinationId && (
                                                    <p className="mt-1 text-xs text-red-500">
                                                        Destination tidak ditemukan.
                                                    </p>
                                                )}

                                            {!loadingDestination &&
                                                addressForm.rajaOngkirDestinationId && (
                                                    <p className="mt-1 text-xs text-green-600">
                                                        Destination berhasil ditemukan.
                                                    </p>
                                                )}
                                        </div>

                                        {/* DEFAULT */}

                                        <label className="flex items-center gap-2 text-sm text-gray-700 sm:col-span-2">
                                            <input
                                                type="checkbox"
                                                checked={
                                                    addressForm.isDefault
                                                }
                                                onChange={(e) =>
                                                    updateAddressForm(
                                                        "isDefault",
                                                        e.target.checked
                                                    )
                                                }
                                                className="h-4 w-4 rounded"
                                            />

                                            Jadikan alamat utama
                                        </label>

                                    </div>

                                    {/* ACTION */}

                                    <div className="mt-5 flex justify-end gap-3">

                                        <button
                                            type="button"
                                            onClick={() =>
                                                setShowAddressForm(
                                                    false
                                                )
                                            }
                                            className="rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-100"
                                        >
                                            Batal
                                        </button>

                                        <button
                                            type="button"
                                            onClick={
                                                saveAddress
                                            }
                                            disabled={
                                                savingAddress ||
                                                loadingDestination ||
                                                !addressForm.rajaOngkirDestinationId
                                            }
                                            className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                        >
                                            {savingAddress
                                                ? "Menyimpan..."
                                                : loadingDestination
                                                    ? "Mencari Destination..."
                                                    : "Simpan Alamat"}
                                        </button>

                                    </div>

                                </div>
                            )}

                            {/* ADDRESS LIST */}

                            {data.addresses.length ===
                                0 ? (
                                <div className="mt-5 rounded-2xl border border-dashed border-gray-300 p-6 text-center">

                                    <p className="font-medium">
                                        Belum ada alamat
                                    </p>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Tambahkan alamat pengiriman terlebih dahulu.
                                    </p>

                                </div>
                            ) : (
                                <div className="mt-5 space-y-3">

                                    {data.addresses.map(
                                        (item) => (
                                            <button
                                                key={
                                                    item.id
                                                }
                                                type="button"
                                                onClick={() =>
                                                    setSelectedAddress(
                                                        item.id
                                                    )
                                                }
                                                className={`w-full rounded-2xl border p-4 text-left transition ${selectedAddress ===
                                                    item.id
                                                    ? "border-rose-500 bg-rose-50"
                                                    : "border-gray-200 hover:border-gray-300"
                                                    }`}
                                            >

                                                <div className="flex items-start justify-between gap-4">

                                                    <div>

                                                        <div className="flex flex-wrap items-center gap-2 font-semibold">

                                                            {
                                                                item.recipientName
                                                            }

                                                            {item.label && (
                                                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600">
                                                                    {
                                                                        item.label
                                                                    }
                                                                </span>
                                                            )}

                                                        </div>

                                                        <div className="mt-1 text-sm text-gray-500">
                                                            {
                                                                item.phone
                                                            }
                                                        </div>

                                                        <div className="mt-3 text-sm leading-6 text-gray-700">

                                                            {
                                                                item.address
                                                            }

                                                            <br />

                                                            {
                                                                item.subdistrict
                                                            }
                                                            ,{" "}
                                                            {
                                                                item.district
                                                            }
                                                            ,{" "}
                                                            {
                                                                item.city
                                                            }
                                                            ,{" "}
                                                            {
                                                                item.province
                                                            }

                                                            {item.postalCode &&
                                                                ` ${item.postalCode}`}

                                                        </div>

                                                        <div className="mt-2 text-xs text-gray-400">
                                                            Destination:{" "}
                                                            {item.rajaOngkirDestinationId ??
                                                                "Belum tersedia"}
                                                        </div>

                                                    </div>

                                                    <div className="flex shrink-0 flex-col items-end gap-2">

                                                        {item.isDefault && (
                                                            <span className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white">
                                                                Utama
                                                            </span>
                                                        )}

                                                        {selectedAddress ===
                                                            item.id && (
                                                                <span className="text-xs font-semibold text-rose-600">
                                                                    ✓ Dipilih
                                                                </span>
                                                            )}

                                                    </div>

                                                </div>

                                            </button>
                                        )
                                    )}

                                </div>
                            )}


                        </section>
                        {/* ================================= */}
                        {/* SHIPPING */}
                        {/* ================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">

                            <div className="flex items-center justify-between">


                                <div>
                                    <h2 className="text-lg font-bold">
                                        Pilih Pengiriman
                                    </h2>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Pilih kurir dan layanan pengiriman.
                                    </p>
                                </div>

                                {loadingShipping && (
                                    <span className="text-sm text-gray-500">
                                        Menghitung...
                                    </span>
                                )}

                            </div>

                            {!selectedAddress && (
                                <div className="mt-5 rounded-2xl bg-gray-50 p-5 text-sm text-gray-500">
                                    Pilih alamat terlebih dahulu untuk melihat pilihan pengiriman.
                                </div>
                            )}

                            {selectedAddress &&
                                !loadingShipping &&
                                shippingOptions.length ===
                                0 && (
                                    <div className="mt-5 rounded-2xl bg-gray-50 p-5 text-sm text-gray-500">
                                        Tidak ada layanan pengiriman yang tersedia.
                                    </div>
                                )}

                            {shippingOptions.length >
                                0 && (
                                    <div className="mt-5 space-y-3">

                                        {shippingOptions.map(
                                            (
                                                option,
                                                index
                                            ) => {

                                                const cost =
                                                    Number(
                                                        option.cost ??
                                                        option.price ??
                                                        option.shipping_cost ??
                                                        0
                                                    );

                                                const courier =
                                                    option.courier ??
                                                    option.code ??
                                                    "";

                                                const service =
                                                    option.service ??
                                                    option.service_name ??
                                                    "";

                                                const etd =
                                                    option.etd ??
                                                    option.estimation ??
                                                    "";

                                                const key =
                                                    `${courier}-${service}-${index}`;

                                                const selected =
                                                    selectedShipping ===
                                                    option;

                                                return (
                                                    <button
                                                        key={
                                                            key
                                                        }
                                                        type="button"
                                                        onClick={() =>
                                                            setSelectedShipping(
                                                                option
                                                            )
                                                        }
                                                        className={`w-full rounded-2xl border p-4 text-left transition ${selected
                                                            ? "border-rose-500 bg-rose-50"
                                                            : "border-gray-200 hover:border-gray-300"
                                                            }`}
                                                    >

                                                        <div className="flex items-center justify-between gap-4">

                                                            <div>

                                                                <div className="font-bold uppercase">
                                                                    {
                                                                        courier
                                                                    }
                                                                </div>

                                                                <div className="mt-1 text-sm font-medium">
                                                                    {
                                                                        service
                                                                    }
                                                                </div>

                                                                {etd && (
                                                                    <div className="mt-1 text-xs text-gray-500">
                                                                        Estimasi{" "}
                                                                        {
                                                                            etd
                                                                        }{" "}
                                                                        hari
                                                                    </div>
                                                                )}
                                                                <div className="mt-1 text-xs text-gray-400">
                                                                    {getServiceExplanation(
                                                                        courier,
                                                                        service,
                                                                        option.description
                                                                    )}
                                                                </div>
                                                            </div>

                                                            <div className="font-bold">
                                                                Rp{" "}
                                                                {cost.toLocaleString(
                                                                    "id-ID"
                                                                )}
                                                            </div>

                                                        </div>

                                                    </button>
                                                );
                                            }
                                        )}

                                    </div>
                                )}

                        </section>
                        <div className="space-y-3">
                            <h3 className="text-lg font-semibold">
                                Metode Pembayaran
                            </h3>

                            {/* COD */}
                            <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-4">
                                <input
                                    type="radio"
                                    name="paymentMethod"
                                    value="COD"
                                    checked={paymentMethod === "COD"}
                                    onChange={() => {
                                        setPaymentMethod("COD");
                                        setPaymentChannel(null);
                                    }}
                                />

                                <div>
                                    <div className="font-medium">
                                        COD
                                    </div>

                                    <div className="text-sm text-gray-500">
                                        Bayar ketika pesanan diterima
                                    </div>
                                </div>
                            </label>

                            {/* BANK TRANSFER */}
                            <div className={`rounded-lg border p-4 ${iPaymuMinBlocked ? "opacity-60" : ""}`}>
                                <label className={`flex items-center gap-3 ${iPaymuMinBlocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                    <input
                                        type="radio"
                                        name="paymentMethod"
                                        value="BANK_TRANSFER"
                                        disabled={iPaymuMinBlocked}
                                        checked={
                                            paymentMethod === "BANK_TRANSFER"
                                        }
                                        onChange={() => {
                                            setPaymentMethod("BANK_TRANSFER");
                                            setPaymentChannel("bca");
                                        }}
                                    />

                                    <div>
                                        <div className="font-medium">
                                            Bank Transfer (Virtual Account)
                                        </div>

                                        <div className="text-sm text-gray-500">
                                            Nomor VA tampil di halaman
                                            pembayaran toko
                                        </div>
                                    </div>
                                </label>

                                {iPaymuMinBlocked && (
                                    <div className="mt-2 text-xs font-medium text-amber-600">
                                        {IPAYMU_MIN_AMOUNT_UI_NOTE}
                                    </div>
                                )}

                                {paymentMethod === "BANK_TRANSFER" && (
                                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {BANK_CHANNELS.map((bank) => (
                                            <button
                                                key={bank.value}
                                                type="button"
                                                onClick={() =>
                                                    setPaymentChannel(
                                                        bank.value
                                                    )
                                                }
                                                className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                                                    paymentChannel ===
                                                    bank.value
                                                        ? "border-rose-500 bg-rose-50 text-rose-700"
                                                        : "border-gray-200 text-gray-700 hover:border-gray-300"
                                                }`}
                                            >
                                                {bank.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* E-WALLET */}
                            <div className={`rounded-lg border p-4 ${iPaymuMinBlocked ? "opacity-60" : ""}`}>
                                <label className={`flex items-center gap-3 ${iPaymuMinBlocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                    <input
                                        type="radio"
                                        name="paymentMethod"
                                        value="E_WALLET"
                                        disabled={iPaymuMinBlocked}
                                        checked={
                                            paymentMethod === "E_WALLET"
                                        }
                                        onChange={() => {
                                            setPaymentMethod("E_WALLET");
                                            setPaymentChannel("dana");
                                        }}
                                    />

                                    <div>
                                        <div className="font-medium">
                                            E-Wallet
                                        </div>

                                        <div className="text-sm text-gray-500">
                                            DANA / ShopeePay
                                        </div>
                                    </div>
                                </label>

                                {iPaymuMinBlocked && (
                                    <div className="mt-2 text-xs font-medium text-amber-600">
                                        {IPAYMU_MIN_AMOUNT_UI_NOTE}
                                    </div>
                                )}

                                {paymentMethod === "E_WALLET" && (
                                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {EWALLET_CHANNELS.map((wallet) => (
                                            <button
                                                key={wallet.value}
                                                type="button"
                                                onClick={() =>
                                                    setPaymentChannel(
                                                        wallet.value
                                                    )
                                                }
                                                className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                                                    paymentChannel ===
                                                    wallet.value
                                                        ? "border-rose-500 bg-rose-50 text-rose-700"
                                                        : "border-gray-200 text-gray-700 hover:border-gray-300"
                                                }`}
                                            >
                                                {wallet.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* QRIS */}
                            <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-4">
                                <input
                                    type="radio"
                                    name="paymentMethod"
                                    value="QRIS"
                                    checked={
                                        paymentMethod === "QRIS"
                                    }
                                    onChange={() => {
                                        setPaymentMethod("QRIS");
                                        setPaymentChannel(null);
                                    }}
                                />

                                <div>
                                    <div className="font-medium">
                                        QRIS
                                    </div>

                                    <div className="text-sm text-gray-500">
                                        Scan QR di halaman pembayaran toko
                                    </div>
                                </div>
                            </label>
                        </div>





                    </div>

                    {/* ================================= */}
                    {/* SUMMARY */}
                    {/* ================================= */}

                    <aside className="h-fit rounded-3xl border border-gray-200 bg-white p-6 lg:sticky lg:top-6">

                        <h2 className="text-lg font-bold text-gray-900">
                            Ringkasan Pesanan
                        </h2>

                        <div className="mt-5 space-y-4 text-sm">

                            <div className="flex items-center justify-between">

                                <span className="text-gray-500">
                                    Subtotal
                                </span>

                                <span className="font-medium text-gray-900">
                                    Rp{" "}
                                    {data.subtotal.toLocaleString(
                                        "id-ID"
                                    )}
                                </span>

                            </div>

                            <div className="flex items-center justify-between">

                                <span className="text-gray-500">
                                    Berat
                                </span>

                                <span className="font-medium text-gray-900">
                                    {Number(
                                        data.totalWeight ||
                                        0
                                    ).toLocaleString(
                                        "id-ID"
                                    )}{" "}
                                    gram
                                </span>

                            </div>

                            <div className="flex items-start justify-between gap-4">

                                <span className="text-gray-500">
                                    Pengiriman
                                </span>

                                {selectedShipping ? (
                                    <div className="text-right">

                                        <div className="font-medium uppercase text-gray-900">
                                            {
                                                selectedShipping.courier ??
                                                selectedShipping.code ??
                                                ""
                                            }
                                        </div>

                                        <div className="text-xs text-gray-500">
                                            {
                                                selectedShipping.service ??
                                                selectedShipping.service_name ??
                                                ""
                                            }
                                        </div>

                                    </div>
                                ) : (
                                    <span className="text-gray-400">
                                        Belum dipilih
                                    </span>
                                )}

                            </div>

                            <div className="flex items-center justify-between">

                                <span className="text-gray-500">
                                    Ongkir
                                </span>

                                <span
                                    className={
                                        selectedShipping
                                            ? "font-medium text-gray-900"
                                            : "text-gray-400"
                                    }
                                >
                                    {selectedShipping
                                        ? `Rp ${shippingCost.toLocaleString(
                                            "id-ID"
                                        )}`
                                        : "Pilih pengiriman"}
                                </span>

                            </div>

                            {shippingDiscount > 0 && (
                                <div className="flex items-center justify-between text-emerald-600">
                                    <span className="text-sm">
                                        Diskon Ongkir{shippingDiscountName ? ` (${shippingDiscountName})` : ""}
                                    </span>
                                    <span className="font-semibold">
                                        - Rp {shippingDiscount.toLocaleString("id-ID")}
                                    </span>
                                </div>
                            )}
                            {/* Voucher Section */}
                            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-semibold">
                                        Voucher
                                    </span>
                                    {!appliedVoucherCode && !selectedSpinReward && (
                                        <button
                                            type="button"
                                            onClick={() => setShowVoucherPicker(true)}
                                            className="text-sm font-semibold text-rose-600 hover:text-rose-700"
                                        >
                                            Pilih Voucher {'>'}
                                        </button>
                                    )}
                                    {(appliedVoucherCode || selectedSpinReward) && (
                                        <button
                                            type="button"
                                            onClick={() => setShowVoucherPicker(true)}
                                            className="text-sm font-semibold text-rose-600 hover:text-rose-700"
                                        >
                                            Ubah {'>'}
                                        </button>
                                    )}
                                </div>

                                {appliedVoucherCode ? (
                                    <div className="mt-2">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm">🎟️</span>
                                                <span className="text-sm font-medium text-gray-900">
                                                    {appliedVoucherCode}
                                                </span>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={removeManualVoucher}
                                                className="text-xs text-red-500 hover:text-red-700"
                                            >
                                                Hapus
                                            </button>
                                        </div>
                                        <div className="mt-1 text-xs font-semibold text-emerald-600">
                                            Hemat {voucherDiscount > 0 ? `-Rp ${voucherDiscount.toLocaleString("id-ID")}` : ""}
                                        </div>
                                    </div>
                                ) : selectedSpinReward ? (
                                    <div className="mt-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm">🎡</span>
                                            <span className="text-sm font-medium text-gray-900">
                                                Reward Spin Wheel
                                            </span>
                                        </div>
                                        <div className="mt-1 text-xs font-semibold text-amber-600">
                                            Hemat {spinWheelDisplayDiscount > 0 ? `-Rp ${spinWheelDisplayDiscount.toLocaleString("id-ID")}` : ""}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mt-2">
                                        <div className="text-xs text-gray-500">
                                            Belum ada voucher yang digunakan
                                        </div>
                                    </div>
                                )}

                                {/* Manual Voucher Code Input */}
                                {!appliedVoucherCode && !selectedSpinReward && (
                                    <div className="mt-3 border-t border-gray-200 pt-3">
                                        {!showManualVoucherInput ? (
                                            <button
                                                type="button"
                                                onClick={() => setShowManualVoucherInput(true)}
                                                className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                                            >
                                                ✏️ Masukkan kode voucher
                                            </button>
                                        ) : (
                                            <div>
                                                <div className="flex gap-2">
                                                    <input
                                                        type="text"
                                                        value={manualVoucherCode}
                                                        onChange={(e) => {
                                                            setManualVoucherCode(e.target.value.toUpperCase());
                                                            setManualVoucherError(null);
                                                        }}
                                                        placeholder="Contoh: PROMOHEMAT20"
                                                        disabled={manualVoucherLoading}
                                                        className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-rose-500 disabled:bg-gray-100"
                                                        onKeyDown={(e) => {
                                                            if (e.key === "Enter") {
                                                                e.preventDefault();
                                                                validateManualVoucher();
                                                            }
                                                        }}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={validateManualVoucher}
                                                        disabled={manualVoucherLoading || !manualVoucherCode.trim()}
                                                        className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                                    >
                                                        {manualVoucherLoading ? "Memproses..." : "Gunakan"}
                                                    </button>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setShowManualVoucherInput(false);
                                                        setManualVoucherCode("");
                                                        setManualVoucherError(null);
                                                    }}
                                                    className="mt-1 text-xs text-gray-500 hover:text-gray-700"
                                                >
                                                    Batal
                                                </button>
                                                {manualVoucherError && (
                                                    <p className="mt-2 text-xs font-medium text-red-500">
                                                        {manualVoucherError}
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {voucherDiscount > 0 && (
                                <div className="flex items-center justify-between text-emerald-600">
                                    <span>Diskon Voucher</span>
                                    <span className="font-semibold">
                                        - Rp {voucherDiscount.toLocaleString("id-ID")}
                                    </span>
                                </div>
                            )}

                            {spinWheelDisplayDiscount > 0 && (
                                <div className="flex items-center justify-between text-amber-600">
                                    <span>Diskon Spin Wheel</span>
                                    <span className="font-semibold">
                                        - Rp {spinWheelDisplayDiscount.toLocaleString("id-ID")}
                                    </span>
                                </div>
                            )}

                            <div className="border-t border-gray-200 pt-4">

                                <div className="flex items-center justify-between">

                                    <span className="text-base font-bold text-gray-900">
                                        Total
                                    </span>

                                    <span className="text-xl font-bold text-rose-600">
                                        Rp{" "}
                                        {grandTotal.toLocaleString(
                                            "id-ID"
                                        )}
                                    </span>

                                </div>

                            </div>

                        </div>

                        {data && data.invalidCount > 0 && (
                            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                <p className="text-sm font-medium text-amber-800">
                                    ⚠️ {data.invalidCount} produk tidak dipilih karena stok tidak mencukupi.
                                </p>
                            </div>
                        )}

                        {data && data.items.length === 0 && (
                            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                <p className="text-sm font-medium text-amber-800">
                                    Pilih minimal satu produk untuk checkout.
                                </p>
                                <a
                                    href="/cart"
                                    className="mt-2 inline-block text-xs font-medium text-amber-700 underline hover:text-amber-900"
                                >
                                    Buka Keranjang →
                                </a>
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={createOrder}
                            disabled={
                                creatingOrder ||
                                !address ||
                                !selectedShipping ||
                                (data ? data.items.length === 0 : true)
                            }
                            className="mt-6 w-full rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            {creatingOrder
                                ? "Memproses..."
                                : !address
                                    ? "Pilih Alamat"
                                    : !selectedShipping
                                        ? "Pilih Pengiriman"
                                        : (data && data.items.length === 0)
                                            ? "Pilih Produk"
                                            : "Buat Pesanan"}
                        </button>

                    </aside>

                </div>
            </div>

            {/* Voucher Picker Modal */}
            <VoucherPickerModal
                open={showVoucherPicker}
                onClose={() => setShowVoucherPicker(false)}
                onSelect={handleVoucherPickerSelect}
                subtotal={data.subtotal}
                currentSelection={voucherPickerSelection}
            />

        </main>
    );
}