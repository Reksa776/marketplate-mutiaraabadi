"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

/*
 * =========================================================
 * TYPES
 * =========================================================
 */

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

type ProductData = {
    id: number;
    name: string;
    slug: string;
    image: string | null;
};

type VariantData = {
    id: number;
    name: string;
    image: string | null;
    price: number;
    originalPrice?: number;
    effectivePrice?: number;
    discount?: number;
    hasDiscount?: boolean;
    priceSource?: string;
    flashSaleName?: string | null;
    flashSaleEndAt?: string | null;
    weight: number;
    stock: number;
};

type BuyNowData = {
    product: ProductData;

    variant: VariantData;

    quantity: number;

    subtotal: number;

    totalWeight: number;

    addresses: Address[];

    store: {
        id: number;

        storeName: string;

        rajaOngkirDestinationId: number | null;
    };
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

type PaymentMethod =
    | "COD"
    | "BANK_TRANSFER"
    | "E_WALLET"
    | "QRIS";

/*
 * Payment channels offered in the UI. Only channels published for the
 * iPaymu direct payment API are listed; the server keeps its own
 * allowlist and validates whatever is sent.
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

type Props = {
    productId: string;
    variantId: string;
    quantity: string;
};

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

/*
 * =========================================================
 * RETRY HELPER
 * =========================================================
 *
 * Dipakai hanya untuk request yang aman diulang:
 *
 * GET region
 * GET buy-now
 * GET destination
 * POST shipping calculation
 *
 * JANGAN pakai helper ini untuk:
 *
 * POST create order
 * POST create order
 * POST save address
 *
 * supaya tidak berpotensi membuat data/transaksi dobel.
 */

async function withRetry<T>(
    fn: () => Promise<T>,
    options?: {
        retries?: number;
        delayMs?: number;
        onRetry?: (
            attempt: number,
            totalRetries: number
        ) => void;
    }
): Promise<T> {
    const retries = options?.retries ?? 4;
    const delayMs = options?.delayMs ?? 1000;

    let lastError: unknown;

    for (
        let attempt = 1;
        attempt <= retries;
        attempt++
    ) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt >= retries) {
                break;
            }

            options?.onRetry?.(
                attempt,
                retries
            );

            await new Promise((resolve) =>
                setTimeout(
                    resolve,
                    delayMs * attempt
                )
            );
        }
    }

    throw lastError;
}

/*
 * =========================================================
 * SAFE JSON RESPONSE
 * =========================================================
 */

async function parseApiResponse(
    response: Response
) {
    const contentType =
        response.headers.get(
            "content-type"
        ) || "";

    if (
        contentType.includes(
            "application/json"
        )
    ) {
        return response.json();
    }

    const text =
        await response.text();

    throw new Error(
        text ||
        `Server mengembalikan response tidak valid (${response.status}).`
    );
}
/*
 * =====================================================
 * PENJELASAN LAYANAN KURIR
 * =====================================================
 *
 * Key format: "KODE_KURIR-KODE_SERVICE" (uppercase).
 * Kalau gak ketemu di sini, fallback ke `description`
 * bawaan dari RajaOngkir.
 */

const SERVICE_EXPLANATIONS: Record<string, string> = {
    // JNE
    "JNE-OKE": "Layanan ekonomis JNE, harga paling murah tapi estimasi lebih lama.",
    "JNE-REG": "Layanan reguler JNE, estimasi standar dengan harga wajar.",
    "JNE-YES": "Yakin Esok Sampai — JNE menjamin paket sampai keesokan hari (khusus kota-kota tertentu).",
    "JNE-SPS": "Super Speed — pengiriman di hari yang sama, khusus rute tertentu.",

    // J&T
    "JNT-EZ": "Layanan ekonomis J&T, harga lebih murah dengan estimasi lebih lama.",
    "JNT-REG": "Layanan reguler J&T, estimasi standar.",

    // SiCepat
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

/*
 * =========================================================
 * COMPONENT
 * =========================================================
 */

export default function BuyNowPage({
    productId,
    variantId,
    quantity,
}: Props) {
    const router = useRouter();

    /*
     * =====================================================
     * BASIC DATA
     * =====================================================
     */

    const numericProductId =
        Number(productId);

    const numericVariantId =
        Number(variantId);

    const numericQuantity =
        Number(quantity);

    /*
     * =====================================================
     * VOUCHER
     * =====================================================
     */

    const [appliedVoucherCode, setAppliedVoucherCode] =
        useState("");

    const [voucherDiscount, setVoucherDiscount] =
        useState(0);

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

    /*
     * =====================================================
     * BUY NOW DATA
     * =====================================================
     */

    const [loading, setLoading] =
        useState(true);

    const [loadError, setLoadError] =
        useState<string | null>(null);

    const [loadRetrying, setLoadRetrying] =
        useState(false);

    const [data, setData] =
        useState<BuyNowData | null>(null);

    /*
     * =====================================================
     * ADDRESS
     * =====================================================
     */

    const [selectedAddress, setSelectedAddress] =
        useState("");

    const [showAddressForm, setShowAddressForm] =
        useState(false);

    const [savingAddress, setSavingAddress] =
        useState(false);

    const [addressForm, setAddressForm] =
        useState<AddressForm>({
            ...emptyAddressForm,
        });

    /*
     * =====================================================
     * REGION
     * =====================================================
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

    const [provincesRetrying, setProvincesRetrying] =
        useState(false);

    const [loadingCities, setLoadingCities] =
        useState(false);

    const [citiesRetrying, setCitiesRetrying] =
        useState(false);

    const [loadingDistricts, setLoadingDistricts] =
        useState(false);

    const [districtsRetrying, setDistrictsRetrying] =
        useState(false);

    const [loadingSubdistricts, setLoadingSubdistricts] =
        useState(false);

    const [subdistrictsRetrying, setSubdistrictsRetrying] =
        useState(false);

    const [loadingDestination, setLoadingDestination] =
        useState(false);

    const [destinationRetrying, setDestinationRetrying] =
        useState(false);

    /*
     * =====================================================
     * SHIPPING
     * =====================================================
     */

    const [shippingOptions, setShippingOptions] =
        useState<ShippingOption[]>([]);

    const [selectedShipping, setSelectedShipping] =
        useState<ShippingOption | null>(null);

    const [loadingShipping, setLoadingShipping] =
        useState(false);

    const [shippingRetrying, setShippingRetrying] =
        useState(false);

    const [shippingDiscount, setShippingDiscount] = useState(0);
    const [shippingDiscountName, setShippingDiscountName] = useState<string | null>(null);

    /*
     * =====================================================
     * PAYMENT
     * =====================================================
     */

    const [paymentMethod, setPaymentMethod] =
        useState<PaymentMethod>("COD");

    /*
     * Provider channel chosen by the customer (bank / e-wallet).
     * Server-validated against the iPaymu channel allowlist before any
     * order or payment is created.
     */
    const [paymentChannel, setPaymentChannel] =
        useState<string | null>(null);

    const [creatingOrder, setCreatingOrder] =
        useState(false);

    /*
     * =====================================================
     * iPaymu redirect flow — no client-side
     * payment library needed.
     * =====================================================
     */

    /*
     * =====================================================
     * DESTINATION EFFECT
     * =====================================================
     */

    useEffect(() => {
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

        loadRajaOngkirDestination();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        addressForm.provinceId,
        addressForm.cityId,
        addressForm.districtId,
        addressForm.subdistrictId,
    ]);

    /*
     * =====================================================
     * REGION LOAD
     * =====================================================
     */

    async function loadRegions(
        type:
            | "province"
            | "city"
            | "district"
            | "subdistrict",
        id?: string
    ): Promise<Region[]> {
        const params =
            new URLSearchParams();

        params.set(
            "type",
            type
        );

        if (id) {
            params.set(
                "id",
                id
            );
        }

        const response =
            await fetch(
                `/api/rajaongkir/regions?${params.toString()}`,
                {
                    method: "GET",
                    cache: "no-store",
                }
            );

        const result =
            await parseApiResponse(
                response
            );

        if (
            !response.ok ||
            !result?.success
        ) {
            throw new Error(
                result?.message ||
                "Gagal mengambil data wilayah."
            );
        }

        return Array.isArray(
            result.data
        )
            ? result.data
            : [];
    }

    /*
     * =====================================================
     * LOAD PROVINCES
     * =====================================================
     */

    async function loadProvinces() {
        try {
            setLoadingProvinces(true);
            setProvincesRetrying(false);

            const result =
                await withRetry(
                    () =>
                        loadRegions(
                            "province"
                        ),
                    {
                        onRetry: () =>
                            setProvincesRetrying(
                                true
                            ),
                    }
                );

            setProvinces(result);
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
        } finally {
            setLoadingProvinces(false);
            setProvincesRetrying(false);
        }
    }

    /*
     * =====================================================
     * PROVINCE CHANGE
     * =====================================================
     */

    async function handleProvinceChange(
        provinceId: string
    ) {
        const province =
            provinces.find(
                (item) =>
                    String(
                        item.id
                    ) === provinceId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                provinceId,

                province:
                    province?.name ||
                    "",

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
            setCitiesRetrying(false);

            const result =
                await withRetry(
                    () =>
                        loadRegions(
                            "city",
                            provinceId
                        ),
                    {
                        onRetry: () =>
                            setCitiesRetrying(
                                true
                            ),
                    }
                );

            setCities(result);
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
            setCitiesRetrying(false);
        }
    }

    /*
     * =====================================================
     * CITY CHANGE
     * =====================================================
     */

    async function handleCityChange(
        cityId: string
    ) {
        const city =
            cities.find(
                (item) =>
                    String(
                        item.id
                    ) === cityId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                cityId,

                city:
                    city?.name ||
                    "",

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
            setDistrictsRetrying(false);

            const result =
                await withRetry(
                    () =>
                        loadRegions(
                            "district",
                            cityId
                        ),
                    {
                        onRetry: () =>
                            setDistrictsRetrying(
                                true
                            ),
                    }
                );

            setDistricts(result);
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
            setDistrictsRetrying(false);
        }
    }

    /*
     * =====================================================
     * DISTRICT CHANGE
     * =====================================================
     */

    async function handleDistrictChange(
        districtId: string
    ) {
        const district =
            districts.find(
                (item) =>
                    String(
                        item.id
                    ) === districtId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                districtId,

                district:
                    district?.name ||
                    "",

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

            setSubdistrictsRetrying(
                false
            );

            const result =
                await withRetry(
                    () =>
                        loadRegions(
                            "subdistrict",
                            districtId
                        ),
                    {
                        onRetry: () =>
                            setSubdistrictsRetrying(
                                true
                            ),
                    }
                );

            setSubdistricts(result);
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
            setLoadingSubdistricts(
                false
            );

            setSubdistrictsRetrying(
                false
            );
        }
    }

    /*
     * =====================================================
     * SUBDISTRICT CHANGE
     * =====================================================
     */

    function handleSubdistrictChange(
        subdistrictId: string
    ) {
        const subdistrict =
            subdistricts.find(
                (item) =>
                    String(
                        item.id
                    ) ===
                    subdistrictId
            );

        setAddressForm(
            (prev) => ({
                ...prev,

                subdistrictId,

                subdistrict:
                    subdistrict?.name ||
                    "",

                postalCode:
                    subdistrict?.zip_code ||
                    "",

                rajaOngkirDestinationId:
                    null,
            })
        );
    }

    /*
     * =====================================================
     * RAJA ONGKIR DESTINATION
     * =====================================================
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
            setLoadingDestination(
                true
            );

            setDestinationRetrying(
                false
            );

            const destinationId =
                await withRetry(
                    async () => {
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

                        const response =
                            await fetch(
                                `/api/rajaongkir/destination?${params.toString()}`,
                                {
                                    method: "GET",
                                    cache: "no-store",
                                }
                            );

                        const result =
                            await parseApiResponse(
                                response
                            );

                        if (
                            !response.ok ||
                            !result?.success
                        ) {
                            throw new Error(
                                result?.message ||
                                "Destination RajaOngkir tidak ditemukan."
                            );
                        }

                        const id =
                            Number(
                                result
                                    ?.data
                                    ?.rajaOngkirDestinationId
                            );

                        if (
                            !Number.isInteger(
                                id
                            ) ||
                            id <= 0
                        ) {
                            throw new Error(
                                "Destination RajaOngkir tidak valid."
                            );
                        }

                        return id;
                    },
                    {
                        onRetry: () =>
                            setDestinationRetrying(
                                true
                            ),
                    }
                );

            setAddressForm(
                (prev) => ({
                    ...prev,

                    rajaOngkirDestinationId:
                        destinationId,
                })
            );
        } catch (error) {
            console.error(
                "DESTINATION ERROR:",
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
            setLoadingDestination(
                false
            );

            setDestinationRetrying(
                false
            );
        }
    }

    /*
     * =====================================================
     * LOAD BUY NOW
     * =====================================================
     */

    async function loadBuyNow() {
        if (
            !Number.isInteger(
                numericProductId
            ) ||
            numericProductId <= 0
        ) {
            setLoadError(
                "Product ID tidak valid."
            );

            setLoading(false);

            return;
        }

        if (
            !Number.isInteger(
                numericVariantId
            ) ||
            numericVariantId <= 0
        ) {
            setLoadError(
                "Variant ID tidak valid."
            );

            setLoading(false);

            return;
        }

        if (
            !Number.isInteger(
                numericQuantity
            ) ||
            numericQuantity <= 0
        ) {
            setLoadError(
                "Quantity tidak valid."
            );

            setLoading(false);

            return;
        }

        try {
            setLoading(true);
            setLoadError(null);
            setLoadRetrying(false);

            const checkoutData =
                await withRetry(
                    async () => {
                        const params =
                            new URLSearchParams();

                        params.set(
                            "productId",
                            String(
                                numericProductId
                            )
                        );

                        params.set(
                            "variantId",
                            String(
                                numericVariantId
                            )
                        );

                        params.set(
                            "quantity",
                            String(
                                numericQuantity
                            )
                        );

                        const response =
                            await fetch(
                                `/api/buy-now?${params.toString()}`,
                                {
                                    method: "GET",
                                    cache: "no-store",
                                }
                            );

                        const result =
                            await parseApiResponse(
                                response
                            );

                        if (
                            !response.ok ||
                            !result?.success
                        ) {
                            throw new Error(
                                result?.message ||
                                `Gagal mengambil data Buy Now (${response.status}).`
                            );
                        }

                        return result.data as BuyNowData;
                    },
                    {
                        onRetry: () =>
                            setLoadRetrying(
                                true
                            ),
                    }
                );

            setData(
                checkoutData
            );

            /*
             * Reset shipping ketika reload.
             */

            setShippingOptions(
                []
            );

            setSelectedShipping(
                null
            );

            /*
             * Pilih default address.
             */

            const defaultAddress =
                checkoutData.addresses.find(
                    (
                        item
                    ) =>
                        item.isDefault
                );

            if (
                defaultAddress
            ) {
                setSelectedAddress(
                    defaultAddress.id
                );
            } else if (
                checkoutData
                    .addresses
                    .length > 0
            ) {
                setSelectedAddress(
                    checkoutData
                        .addresses[0]
                        .id
                );
            } else {
                setSelectedAddress(
                    ""
                );
            }
        } catch (error) {
            console.error(
                "LOAD BUY NOW ERROR:",
                error
            );

            const message =
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil data Buy Now.";

            setLoadError(
                message
            );

            toast.error(
                message
            );
        } finally {
            setLoading(false);
            setLoadRetrying(false);
        }
    }

    /*
     * =====================================================
     * INITIAL LOAD
     * =====================================================
     */

    useEffect(() => {
        loadBuyNow();
        loadProvinces();

        // Load pending spin wheel rewards from localStorage
        try {
            const stored = localStorage.getItem("spinWheelPendingRewards");
            if (stored) {
                const rewards: PendingSpinReward[] = JSON.parse(stored);
                const now = Date.now();
                const valid = rewards.filter(
                    (r) => now - new Date(r.createdAt).getTime() < 30 * 24 * 60 * 60 * 1000
                );
                setPendingSpinRewards(valid);
            }
        } catch {
            // ignore parse errors
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        productId,
        variantId,
        quantity,
    ]);

    /*
     * =====================================================
     * TIKTOK PIXEL - INITIATE CHECKOUT
     * =====================================================
     *
     * Fire when buy-now data is loaded
     * (product + variant available).
     */
    useEffect(() => {
        if (!data) {
            return;
        }

        /*
         * Standard TikTok parameters with the catalog identity of
         * the single buy-now product; `value` is the server-computed
         * subtotal.
         */
        return whenTikTokReadyForEvents(() => {
            trackTikTokEvent(
                "InitiateCheckout",
                buildTikTokCartProperties(
                    [
                        {
                            productId: data.product.id,
                            variantId: data.variant.id,
                            productName: data.product.name,
                            quantity: data.quantity,
                            /* Effective (charged) unit price. */
                            price:
                                data.variant
                                    .effectivePrice ??
                                data.variant.price,
                        },
                    ],
                    { value: data.subtotal }
                )
            );
        });
    }, [data]);

    /*
     * =====================================================
     * SAVE ADDRESS
     * =====================================================
     */

    async function saveAddress() {
        if (
            !addressForm.recipientName.trim()
        ) {
            toast.error(
                "Nama penerima wajib diisi."
            );

            return;
        }

        if (
            !addressForm.phone.trim()
        ) {
            toast.error(
                "Nomor HP wajib diisi."
            );

            return;
        }

        if (
            !addressForm.address.trim()
        ) {
            toast.error(
                "Alamat lengkap wajib diisi."
            );

            return;
        }

        if (
            !addressForm.provinceId
        ) {
            toast.error(
                "Pilih provinsi."
            );

            return;
        }

        if (
            !addressForm.cityId
        ) {
            toast.error(
                "Pilih kota/kabupaten."
            );

            return;
        }

        if (
            !addressForm.districtId
        ) {
            toast.error(
                "Pilih kecamatan."
            );

            return;
        }

        if (
            !addressForm.subdistrictId
        ) {
            toast.error(
                "Pilih kelurahan/desa."
            );

            return;
        }

        if (
            !addressForm.postalCode.trim()
        ) {
            toast.error(
                "Kode pos belum tersedia."
            );

            return;
        }

        if (
            loadingDestination
        ) {
            toast.error(
                "Sedang mencari Destination RajaOngkir. Tunggu sebentar."
            );

            return;
        }

        if (
            !addressForm.rajaOngkirDestinationId ||
            addressForm
                .rajaOngkirDestinationId <=
            0
        ) {
            toast.error(
                "Destination RajaOngkir belum ditemukan."
            );

            return;
        }

        try {
            setSavingAddress(
                true
            );

            /*
             * PENTING:
             *
             * Tidak pakai withRetry di sini.
             *
             * Karena POST address kalau retry
             * bisa membuat duplicate address.
             */

            const response =
                await fetch(
                    "/api/addresses",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            label:
                                addressForm.label.trim() ||
                                null,

                            recipientName:
                                addressForm
                                    .recipientName
                                    .trim(),

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

                            rajaOngkirDestinationId:
                                Number(
                                    addressForm
                                        .rajaOngkirDestinationId
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
                await parseApiResponse(
                    response
                );

            if (
                !response.ok ||
                !result?.success
            ) {
                throw new Error(
                    result?.message ||
                    "Gagal menyimpan alamat."
                );
            }

            const savedAddress =
                result?.data ??
                result?.address ??
                null;

            toast.success(
                "Alamat berhasil disimpan."
            );

            setShowAddressForm(
                false
            );

            setAddressForm({
                ...emptyAddressForm,
            });

            /*
             * Reload addresses.
             */

            await loadBuyNow();

            /*
             * Pilih address baru kalau API
             * mengembalikan ID.
             */

            if (
                savedAddress?.id
            ) {
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
            setSavingAddress(
                false
            );
        }
    }

    /*
     * =====================================================
     * LOAD SHIPPING
     * =====================================================
     */

    async function loadShippingCost() {
        if (!data) {
            return;
        }

        if (
            !selectedAddress
        ) {
            setShippingOptions(
                []
            );

            setSelectedShipping(
                null
            );

            return;
        }

        const address =
            data.addresses.find(
                (
                    item
                ) =>
                    item.id ===
                    selectedAddress
            );

        if (!address) {
            setShippingOptions(
                []
            );

            setSelectedShipping(
                null
            );

            return;
        }

        const origin =
            Number(
                data.store
                    .rajaOngkirDestinationId
            );

        const destination =
            Number(
                address.rajaOngkirDestinationId
            );

        if (
            !Number.isInteger(
                origin
            ) ||
            origin <= 0
        ) {
            toast.error(
                "Destination toko belum dikonfigurasi."
            );

            return;
        }

        if (
            !Number.isInteger(
                destination
            ) ||
            destination <= 0
        ) {
            toast.error(
                "Destination alamat belum tersedia."
            );

            return;
        }

        const weight =
            Math.max(
                Math.ceil(
                    Number(
                        data.totalWeight
                    )
                ),
                1
            );

        try {
            setLoadingShipping(
                true
            );

            setShippingRetrying(
                false
            );

            setShippingOptions(
                []
            );

            setSelectedShipping(
                null
            );

            const options =
                await withRetry(
                    async () => {
                        const response =
                            await fetch(
                                "/api/buy-now/shipping",
                                {
                                    method: "POST",

                                    headers: {
                                        "Content-Type":
                                            "application/json",
                                    },

                                    body:
                                        JSON.stringify(
                                            {
                                                origin,

                                                destination,

                                                weight,

                                                courier:
                                                    "jne:jnt:sicepat",

                                                price:
                                                    "lowest",
                                            }
                                        ),

                                    cache: "no-store",
                                }
                            );

                        const result =
                            await parseApiResponse(
                                response
                            );

                        if (
                            !response.ok ||
                            !result?.success
                        ) {
                            throw new Error(
                                result?.message ||
                                "Gagal mengambil ongkir."
                            );
                        }

                        return Array.isArray(
                            result.data
                        )
                            ? result.data
                            : [];
                    },
                    {
                        onRetry: () =>
                            setShippingRetrying(
                                true
                            ),
                    }
                );

            setShippingOptions(
                options
            );

            if (
                options.length ===
                0
            ) {
                toast.error(
                    "Tidak ada layanan pengiriman."
                );
            }
        } catch (error) {
            console.error(
                "SHIPPING ERROR:",
                error
            );

            setShippingOptions(
                []
            );

            setSelectedShipping(
                null
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mengambil ongkir."
            );
        } finally {
            setLoadingShipping(
                false
            );

            setShippingRetrying(
                false
            );
        }
    }

    /*
     * =====================================================
     * SHIPPING AUTO LOAD
     * =====================================================
     */

    useEffect(() => {
        if (!data) {
            return;
        }

        loadShippingCost();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        data,
        selectedAddress,
    ]);

    /*
     * =====================================================
     * SHIPPING DISCOUNT PREVIEW
     * =====================================================
     *
     * Fetch shipping discount when shipping is selected.
     */
    useEffect(() => {
        if (!selectedShipping || !data) {
            setShippingDiscount(0);
            setShippingDiscountName(null);
            return;
        }

        const sc = Number(
            selectedShipping.cost ??
            selectedShipping.price ??
            selectedShipping.shipping_cost ??
            0
        );

        if (!Number.isFinite(sc) || sc <= 0) {
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
                        shippingCost: sc,
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
     * =====================================================
     * SHIPPING COST
     * =====================================================
     */

    const shippingCost =
        useMemo(() => {
            if (
                !selectedShipping
            ) {
                return 0;
            }

            return Number(
                selectedShipping.cost ??
                selectedShipping.price ??
                selectedShipping.shipping_cost ??
                0
            );
        }, [
            selectedShipping,
        ]);

    /*
     * =====================================================
     * GRAND TOTAL
     * =====================================================
     */

    const finalShippingCost =
        useMemo(() => {
            return Math.max(0, shippingCost - shippingDiscount);
        }, [shippingCost, shippingDiscount]);    // Compute spin wheel discount client-side for display
    const spinWheelDisplayDiscount = useMemo(() => {
        if (!selectedSpinReward || !data) return 0;
        const selected = pendingSpinRewards.find((r) => r.spinId === selectedSpinReward);
        if (!selected) return 0;
        const subtotal = Number(data.subtotal);
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
    }, [selectedSpinReward, pendingSpinRewards, data]);

    const grandTotal =
        useMemo(() => {
            if (!data) {
                return 0;
            }

            return Math.max(
                0,

                Number(
                    data.subtotal
                ) -

                Number(
                    voucherDiscount
                ) -

                Number(
                    spinWheelDisplayDiscount
                ) +

                Number(
                    finalShippingCost
                )
            );
        }, [
            data,


            voucherDiscount,
            spinWheelDisplayDiscount,
            finalShippingCost,
        ]);

    const iPaymuMinBlocked = grandTotal < IPAYMU_MIN_AMOUNT;

    /*
     * =====================================================
     * APPLY VOUCHER
     * =====================================================
     *
     * Catatan:
     *
     * Karena schema API voucher yang lu kasih belum
     * menentukan endpoint validasi voucher, function ini
     * tidak menebak-nebak endpoint.
     *
     * Voucher final tetap sebaiknya dihitung ulang
     * oleh backend saat create order.
     */

    /*
     * =====================================================
     * CREATE COD ORDER
     * =====================================================
     */

    async function createCodOrder() {
        if (!data) {
            return;
        }

        if (
            !selectedAddress
        ) {
            toast.error(
                "Pilih alamat pengiriman."
            );

            return;
        }

        if (
            !selectedShipping
        ) {
            toast.error(
                "Pilih pengiriman."
            );

            return;
        }

        /*
         * Jangan retry POST order.
         */

        try {
            setCreatingOrder(
                true
            );

            const response =
                await fetch(
                    "/api/buy-now",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body:
                            JSON.stringify({
                                productId:
                                    numericProductId,

                                variantId:
                                    numericVariantId,

                                quantity:
                                    numericQuantity,

                                addressId:
                                    selectedAddress,

                                shipping:
                                    selectedShipping,

                                paymentMethod:
                                    "COD",

                                voucherCode:
                                    appliedVoucherCode ||
                                    null,
                                spinWheelSpinId: selectedSpinReward,
                            }),
                    }
                );

            const result =
                await parseApiResponse(
                    response
                );

            if (
                !response.ok ||
                !result?.success
            ) {
                throw new Error(
                    result?.message ||
                    "Gagal membuat pesanan."
                );
            }

            const order =
                result?.data;

            if (
                !order?.id
            ) {
                throw new Error(
                    "Order berhasil dibuat tetapi ID order tidak ditemukan."
                );
            }

            toast.success(
                "Pesanan berhasil dibuat."
            );

            // Clear used spin wheel reward from localStorage
            localStorage.removeItem("spinWheelPendingRewards");

            window.location.href =
                `/checkout/success?order=${encodeURIComponent(
                    String(
                        order.id
                    )
                )}`;
        } catch (error) {
            console.error(
                "COD ORDER ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal membuat pesanan."
            );
        } finally {
            setCreatingOrder(
                false
            );
        }
    }

    /*
     * =====================================================
     * CREATE IPAYMU PAYMENT
     * =====================================================
     */

    async function createIpaymuPayment() {
        if (!data) {
            return;
        }

        if (
            !selectedAddress
        ) {
            toast.error(
                "Pilih alamat pengiriman."
            );

            return;
        }

        if (
            !selectedShipping
        ) {
            toast.error(
                "Pilih pengiriman."
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

        try {
            setCreatingOrder(
                true
            );

            /*
             * Jangan retry request ini.
             *
             * Endpoint backend seharusnya idempotent
             * menggunakan paymentReference/orderNumber.
             */

            const paymentResponse =
                await fetch(
                    "/api/buy-now/ipaymu",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body:
                            JSON.stringify({
                                productId:
                                    numericProductId,

                                variantId:
                                    numericVariantId,

                                quantity:
                                    numericQuantity,

                                addressId:
                                    selectedAddress,                                    shipping:
                                        selectedShipping,

                                    paymentMethod:
                                        paymentMethod,

                                    /*
                                     * Customer channel choice only — the
                                     * server validates it against the
                                     * iPaymu allowlist before creating any
                                     * order or payment.
                                     */
                                    paymentChannel:
                                        paymentMethod ===
                                            "BANK_TRANSFER" ||
                                        paymentMethod === "E_WALLET"
                                            ? paymentChannel
                                            : null,

                                    voucherCode:
                                        appliedVoucherCode ||
                                        null,
                                    spinWheelSpinId: selectedSpinReward,
                                }),
                    }
                );

            const paymentResult =
                await parseApiResponse(
                    paymentResponse
                );

            if (
                !paymentResponse.ok ||
                !paymentResult?.success
            ) {
                throw new Error(
                    paymentResult?.message ||
                    "Gagal membuat pembayaran."
                );
            }

            const paymentData =
                paymentResult?.data;

            if (
                !paymentData?.paymentUrl
            ) {
                console.error(
                    "IPAYMU PAYMENT URL TIDAK ADA:",
                    paymentData
                );

                throw new Error(
                    "URL pembayaran tidak ditemukan."
                );
            }

            /*
             * ==========================================
             * REDIRECT KE HALAMAN PEMBAYARAN
             * ==========================================
             *
             * Customer diarahkan ke halaman
             * pembayaran iPaymu untuk menyelesaikan
             * transaksi.
             */

            // Clear used spin wheel reward from localStorage
            localStorage.removeItem("spinWheelPendingRewards");

            window.location.href =
                paymentData.paymentUrl;
        } catch (error) {
            console.error(
                "IPAYMU PAYMENT ERROR:",
                error
            );

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal membuat pembayaran."
            );
        } finally {
            setCreatingOrder(
                false
            );
        }
    }

    /*
     * =====================================================
     * CREATE ORDER DISPATCHER
     * =====================================================
     */

    async function createOrder() {
        if (!data) {
            return;
        }

        if (
            !Number.isInteger(
                numericProductId
            ) ||
            numericProductId <= 0
        ) {
            toast.error(
                "Product ID tidak valid."
            );

            return;
        }

        if (
            !Number.isInteger(
                numericVariantId
            ) ||
            numericVariantId <= 0
        ) {
            toast.error(
                "Variant ID tidak valid."
            );

            return;
        }

        if (
            !Number.isInteger(
                numericQuantity
            ) ||
            numericQuantity <= 0
        ) {
            toast.error(
                "Quantity tidak valid."
            );

            return;
        }

        if (
            !selectedAddress
        ) {
            toast.error(
                "Pilih alamat pengiriman."
            );

            return;
        }

        if (
            !selectedShipping
        ) {
            toast.error(
                "Pilih pengiriman."
            );

            return;
        }

        if (
            creatingOrder
        ) {
            return;
        }

        /*
         * =====================================================
         * TIKTOK PIXEL - ADD PAYMENT INFO
         * =====================================================
         *
         * Fire when user submits buy-now order.
         */
        whenTikTokReadyForEvents(() => {
            trackTikTokEvent(
                "AddPaymentInfo",
                buildTikTokCartProperties(
                    [
                        {
                            productId: data.product.id,
                            variantId: data.variant.id,
                            productName: data.product.name,
                            quantity: data.quantity,
                            /* Effective (charged) unit price. */
                            price:
                                data.variant
                                    .effectivePrice ??
                                data.variant.price,
                        },
                    ],
                    {
                        value: grandTotal,
                        extra: {
                            payment_method: paymentMethod,
                        },
                    }
                )
            );
        });

        if (
            paymentMethod ===
            "COD"
        ) {
            await createCodOrder();

            return;
        }

        await createIpaymuPayment();
    }

    /*
     * =====================================================
     * SELECTED ADDRESS
     * =====================================================
     */

    const address =
        data?.addresses.find(
            (
                item
            ) =>
                item.id ===
                selectedAddress
        ) || null;

    /*
     * =====================================================
     * PAYMENT BUTTON STATE
     * =====================================================
     */

    const paymentButtonDisabled =
        creatingOrder ||
        !address ||
        !selectedShipping;

    /*
     * =====================================================
     * LOADING
     * =====================================================
     */

    if (loading) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-6xl">
                    <div className="rounded-3xl border bg-white p-8 text-center">
                        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-rose-600 border-t-transparent" />

                        <p className="mt-4 font-medium">
                            Memuat Buy Now...
                        </p>

                        {loadRetrying && (
                            <p className="mt-1 text-sm text-gray-500">
                                Koneksi lambat,
                                mencoba lagi...
                            </p>
                        )}
                    </div>
                </div>
            </main>
        );
    }

    /*
     * =====================================================
     * LOAD ERROR
     * =====================================================
     */

    if (!data) {
        return (
            <main className="min-h-screen bg-gray-50 px-4 py-8">
                <div className="mx-auto max-w-6xl">
                    <div className="rounded-3xl border bg-white p-8 text-center">
                        <p className="font-medium">
                            {loadError ||
                                "Data produk tidak ditemukan."}
                        </p>

                        <button
                            type="button"
                            onClick={() =>
                                loadBuyNow()
                            }
                            className="mt-4 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700"
                        >
                            Coba Lagi
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    /*
     * =====================================================
     * UI
     * =====================================================
     */

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-6xl">

                {/* =================================================
                    HEADER
                ================================================= */}

                <div className="mb-8">
                    <Link
                        href={`/products/${data.product.slug}`}
                        className="text-sm text-gray-500 hover:text-gray-900"
                    >
                        ← Kembali ke Produk
                    </Link>

                    <h1 className="mt-3 text-3xl font-bold text-gray-900">
                        Beli Sekarang
                    </h1>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1fr_380px]">

                    <div className="space-y-6">

                        {/* =================================================
                            PRODUCT
                        ================================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">
                            <h2 className="text-lg font-bold">
                                Produk
                            </h2>

                            <div className="mt-5 flex gap-4">
                                <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-gray-100">
                                    {(
                                        data.variant
                                            .image ||
                                        data.product
                                            .image
                                    ) && (
                                            <img
                                                src={
                                                    data.variant
                                                        .image ||
                                                    data.product
                                                        .image ||
                                                    ""
                                                }
                                                alt={
                                                    data.product
                                                        .name
                                                }
                                                className="h-full w-full object-cover"
                                            />
                                        )}
                                </div>

                                <div className="min-w-0 flex-1">
                                    <h3 className="font-bold text-gray-900">
                                        {
                                            data.product
                                                .name
                                        }
                                    </h3>

                                    <p className="mt-1 text-sm text-gray-500">
                                        {
                                            data.variant
                                                .name
                                        }
                                    </p>

                                    <div className="mt-2">
                                        <p className="text-sm">
                                            {data.quantity} × Rp{" "}
                                            {Number(
                                                data.variant
                                                    .effectivePrice ??
                                                data.variant
                                                    .price
                                            ).toLocaleString(
                                                "id-ID"
                                            )}
                                        </p>
                                        {(data.variant.hasDiscount ?? false) && (
                                            <p className="mt-0.5 text-xs text-gray-400 line-through">
                                                Rp {Number(
                                                    data.variant
                                                        .originalPrice ??
                                                    data.variant
                                                        .price
                                                ).toLocaleString("id-ID")}
                                            </p>
                                        )}
                                        {(data.variant.priceSource === "FLASH_SALE") && data.variant.flashSaleName && (
                                            <p className="mt-0.5 text-xs font-medium text-rose-500">
                                                🔥 {data.variant.flashSaleName}
                                            </p>
                                        )}
                                    </div>

                                    <p className="mt-1 text-xs text-gray-400">
                                        Berat{" "}
                                        {Number(
                                            data.totalWeight
                                        ).toLocaleString(
                                            "id-ID"
                                        )}{" "}
                                        gram
                                    </p>
                                </div>

                                <div className="font-bold">
                                    Rp{" "}
                                    {Number(
                                        data.subtotal
                                    ).toLocaleString(
                                        "id-ID"
                                    )}
                                </div>
                            </div>
                        </section>

                        {/* =================================================
                            ADDRESS
                        ================================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h2 className="text-lg font-bold">
                                        Alamat Pengiriman
                                    </h2>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Pilih alamat tujuan.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => {
                                        setAddressForm({
                                            ...emptyAddressForm,
                                        });

                                        setShowAddressForm(
                                            true
                                        );
                                    }}
                                    className="text-sm font-semibold text-rose-600 hover:text-rose-700"
                                >
                                    + Tambah Alamat
                                </button>
                            </div>

                            {data.addresses.length ===
                                0 ? (
                                <div className="mt-5 rounded-2xl border border-dashed border-gray-300 p-6 text-center">
                                    <p className="font-medium">
                                        Belum ada alamat
                                    </p>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Tambahkan alamat
                                        terlebih dahulu.
                                    </p>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAddressForm({
                                                ...emptyAddressForm,
                                            });

                                            setShowAddressForm(
                                                true
                                            );
                                        }}
                                        className="mt-4 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white"
                                    >
                                        + Tambah Alamat
                                    </button>
                                </div>
                            ) : (
                                <div className="mt-5 space-y-3">
                                    {data.addresses.map(
                                        (
                                            item
                                        ) => (
                                            <button
                                                key={
                                                    item.id
                                                }
                                                type="button"
                                                onClick={() => {
                                                    setSelectedAddress(
                                                        item.id
                                                    );

                                                    setSelectedShipping(
                                                        null
                                                    );

                                                    setShippingOptions(
                                                        []
                                                    );
                                                }}
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
                                                    </div>

                                                    {item.isDefault && (
                                                        <span className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white">
                                                            Utama
                                                        </span>
                                                    )}
                                                </div>
                                            </button>
                                        )
                                    )}
                                </div>
                            )}

                            {/* =================================================
                                ADDRESS FORM
                            ================================================= */}

                            {showAddressForm && (
                                <div className="mt-5 rounded-2xl border border-gray-200 bg-gray-50 p-5">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <h3 className="font-bold text-gray-900">
                                                Tambah Alamat Baru
                                            </h3>

                                            <p className="mt-1 text-sm text-gray-500">
                                                Isi alamat
                                                lengkap untuk
                                                pengiriman.
                                            </p>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() =>
                                                setShowAddressForm(
                                                    false
                                                )
                                            }
                                            className="text-sm text-gray-500 hover:text-gray-900"
                                        >
                                            Batal
                                        </button>
                                    </div>

                                    <div className="mt-5 grid gap-4">

                                        {/* LABEL */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Label Alamat
                                            </label>

                                            <input
                                                value={
                                                    addressForm.label
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            label:
                                                                e
                                                                    .target
                                                                    .value,
                                                        })
                                                    )
                                                }
                                                placeholder="Rumah / Kantor"
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* NAME */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Nama Penerima
                                            </label>

                                            <input
                                                value={
                                                    addressForm.recipientName
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            recipientName:
                                                                e
                                                                    .target
                                                                    .value,
                                                        })
                                                    )
                                                }
                                                placeholder="Nama penerima"
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* PHONE */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Nomor HP
                                            </label>

                                            <input
                                                value={
                                                    addressForm.phone
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            phone:
                                                                e
                                                                    .target
                                                                    .value,
                                                        })
                                                    )
                                                }
                                                placeholder="08xxxxxxxxxx"
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* ADDRESS */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Alamat Lengkap
                                            </label>

                                            <textarea
                                                value={
                                                    addressForm.address
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            address:
                                                                e
                                                                    .target
                                                                    .value,
                                                        })
                                                    )
                                                }
                                                rows={
                                                    3
                                                }
                                                placeholder="Nama jalan, nomor rumah, RT/RW, dll."
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* PROVINCE */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Provinsi
                                            </label>

                                            <select
                                                value={
                                                    addressForm.provinceId
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    handleProvinceChange(
                                                        e
                                                            .target
                                                            .value
                                                    )
                                                }
                                                disabled={
                                                    loadingProvinces
                                                }
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            >
                                                <option value="">
                                                    {loadingProvinces
                                                        ? provincesRetrying
                                                            ? "Mencoba lagi..."
                                                            : "Memuat provinsi..."
                                                        : "Pilih provinsi"}
                                                </option>

                                                {provinces.map(
                                                    (
                                                        item
                                                    ) => (
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

                                            {!loadingProvinces &&
                                                provinces.length ===
                                                0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            loadProvinces()
                                                        }
                                                        className="mt-1 text-xs font-semibold text-rose-600 hover:text-rose-700"
                                                    >
                                                        Gagal memuat
                                                        provinsi,
                                                        coba lagi
                                                    </button>
                                                )}
                                        </div>

                                        {/* CITY */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Kota /
                                                Kabupaten
                                            </label>

                                            <select
                                                value={
                                                    addressForm.cityId
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    handleCityChange(
                                                        e
                                                            .target
                                                            .value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.provinceId ||
                                                    loadingCities
                                                }
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            >
                                                <option value="">
                                                    {loadingCities
                                                        ? citiesRetrying
                                                            ? "Mencoba lagi..."
                                                            : "Memuat kota..."
                                                        : "Pilih kota/kabupaten"}
                                                </option>

                                                {cities.map(
                                                    (
                                                        item
                                                    ) => (
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

                                        {/* DISTRICT */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Kecamatan
                                            </label>

                                            <select
                                                value={
                                                    addressForm.districtId
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    handleDistrictChange(
                                                        e
                                                            .target
                                                            .value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.cityId ||
                                                    loadingDistricts
                                                }
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            >
                                                <option value="">
                                                    {loadingDistricts
                                                        ? districtsRetrying
                                                            ? "Mencoba lagi..."
                                                            : "Memuat kecamatan..."
                                                        : "Pilih kecamatan"}
                                                </option>

                                                {districts.map(
                                                    (
                                                        item
                                                    ) => (
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

                                        {/* SUBDISTRICT */}

                                        <div>
                                            <label className="text-sm font-medium">
                                                Kelurahan /
                                                Desa
                                            </label>

                                            <select
                                                value={
                                                    addressForm.subdistrictId
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    handleSubdistrictChange(
                                                        e
                                                            .target
                                                            .value
                                                    )
                                                }
                                                disabled={
                                                    !addressForm.districtId ||
                                                    loadingSubdistricts
                                                }
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            >
                                                <option value="">
                                                    {loadingSubdistricts
                                                        ? subdistrictsRetrying
                                                            ? "Mencoba lagi..."
                                                            : "Memuat kelurahan..."
                                                        : "Pilih kelurahan/desa"}
                                                </option>

                                                {subdistricts.map(
                                                    (
                                                        item
                                                    ) => (
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
                                            <label className="text-sm font-medium">
                                                Kode Pos
                                            </label>

                                            <input
                                                value={
                                                    addressForm.postalCode
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            postalCode:
                                                                e
                                                                    .target
                                                                    .value,
                                                        })
                                                    )
                                                }
                                                placeholder="Kode pos"
                                                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-rose-500"
                                            />
                                        </div>

                                        {/* DESTINATION */}

                                        <div className="rounded-xl bg-white p-4">
                                            <div className="text-xs text-gray-500">
                                                RajaOngkir
                                                Destination
                                            </div>

                                            <div className="mt-1 font-semibold">
                                                {loadingDestination
                                                    ? destinationRetrying
                                                        ? "Mencoba lagi..."
                                                        : "Mencari destination..."
                                                    : addressForm.rajaOngkirDestinationId
                                                        ? `ID ${addressForm.rajaOngkirDestinationId}`
                                                        : "Belum ditemukan"}
                                            </div>
                                        </div>

                                        {/* DEFAULT */}

                                        <label className="flex items-center gap-3">
                                            <input
                                                type="checkbox"
                                                checked={
                                                    addressForm.isDefault
                                                }
                                                onChange={(
                                                    e
                                                ) =>
                                                    setAddressForm(
                                                        (
                                                            prev
                                                        ) => ({
                                                            ...prev,
                                                            isDefault:
                                                                e
                                                                    .target
                                                                    .checked,
                                                        })
                                                    )
                                                }
                                            />

                                            <span className="text-sm">
                                                Jadikan
                                                alamat utama
                                            </span>
                                        </label>

                                        {/* SAVE */}

                                        <button
                                            type="button"
                                            onClick={
                                                saveAddress
                                            }
                                            disabled={
                                                savingAddress ||
                                                loadingDestination
                                            }
                                            className="w-full rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                        >
                                            {savingAddress
                                                ? "Menyimpan..."
                                                : loadingDestination
                                                    ? "Mencari lokasi..."
                                                    : "Simpan Alamat"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </section>

                        {/* =================================================
                            SHIPPING
                        ================================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold">
                                        Pilih Pengiriman
                                    </h2>

                                    <p className="mt-1 text-sm text-gray-500">
                                        Pilih kurir dan
                                        layanan.
                                    </p>
                                </div>

                                {loadingShipping && (
                                    <span className="text-sm text-gray-500">
                                        {shippingRetrying
                                            ? "Mencoba lagi..."
                                            : "Menghitung..."}
                                    </span>
                                )}
                            </div>

                            {!selectedAddress && (
                                <div className="mt-5 rounded-2xl bg-gray-50 p-5 text-sm text-gray-500">
                                    Pilih alamat
                                    pengiriman terlebih
                                    dahulu.
                                </div>
                            )}

                            {selectedAddress &&
                                !loadingShipping &&
                                shippingOptions.length ===
                                0 && (
                                    <div className="mt-5 rounded-2xl bg-gray-50 p-5 text-sm text-gray-500">
                                        <p>
                                            Tidak ada
                                            layanan
                                            pengiriman.
                                        </p>

                                        <button
                                            type="button"
                                            onClick={() =>
                                                loadShippingCost()
                                            }
                                            className="mt-2 text-xs font-semibold text-rose-600 hover:text-rose-700"
                                        >
                                            Coba lagi
                                        </button>
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

                                                const selected =
                                                    selectedShipping ===
                                                    option;

                                                return (
                                                    <button
                                                        key={`${courier}-${service}-${index}`}
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

                        {/* =================================================
                            PAYMENT
                        ================================================= */}

                        <section className="rounded-3xl border border-gray-200 bg-white p-6">
                            <h2 className="text-lg font-bold">
                                Metode Pembayaran
                            </h2>

                            <div className="mt-5 space-y-3">

                                {/* COD */}

                                <label
                                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-4 ${paymentMethod ===
                                        "COD"
                                        ? "border-rose-500 bg-rose-50"
                                        : "border-gray-200"
                                        }`}
                                >
                                    <input
                                        type="radio"
                                        name="payment"
                                        checked={
                                            paymentMethod ===
                                            "COD"
                                        }
                                        onChange={() => {
                                            setPaymentMethod(
                                                "COD"
                                            );
                                            setPaymentChannel(null);
                                        }}
                                    />

                                    <div>
                                        <div className="font-semibold">
                                            COD
                                        </div>

                                        <div className="text-sm text-gray-500">
                                            Bayar saat
                                            barang
                                            diterima.
                                        </div>
                                    </div>
                                </label>

                                {/* BANK TRANSFER */}

                                <div
                                    className={`rounded-2xl border p-4 ${iPaymuMinBlocked ? "opacity-60" : ""} ${paymentMethod ===
                                        "BANK_TRANSFER"
                                        ? "border-rose-500 bg-rose-50"
                                        : "border-gray-200"
                                        }`}
                                >
                                    <label className={`flex items-center gap-3 ${iPaymuMinBlocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                        <input
                                            type="radio"
                                            name="payment"
                                            disabled={iPaymuMinBlocked}
                                            checked={
                                                paymentMethod ===
                                                "BANK_TRANSFER"
                                            }
                                            onChange={() => {
                                                setPaymentMethod(
                                                    "BANK_TRANSFER"
                                                );
                                                setPaymentChannel("bca");
                                            }}
                                        />

                                        <div>
                                            <div className="font-semibold">
                                                Bank Transfer (Virtual
                                                Account)
                                            </div>

                                            <div className="text-sm text-gray-500">
                                                Nomor VA tampil di halaman
                                                pembayaran toko.
                                            </div>
                                        </div>
                                    </label>

                                    {iPaymuMinBlocked && (
                                        <div className="mt-2 text-xs font-medium text-amber-600">
                                            {IPAYMU_MIN_AMOUNT_UI_NOTE}
                                        </div>
                                    )}

                                    {paymentMethod ===
                                        "BANK_TRANSFER" && (
                                        <div className="mt-4 grid grid-cols-2 gap-2">
                                            {BANK_CHANNELS.map(
                                                (bank) => (
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
                                                                ? "border-rose-500 bg-white text-rose-700"
                                                                : "border-gray-200 bg-white text-gray-700"
                                                        }`}
                                                    >
                                                        {bank.label}
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* E-WALLET */}

                                <div
                                    className={`rounded-2xl border p-4 ${iPaymuMinBlocked ? "opacity-60" : ""} ${paymentMethod ===
                                        "E_WALLET"
                                        ? "border-rose-500 bg-rose-50"
                                        : "border-gray-200"
                                        }`}
                                >
                                    <label className={`flex items-center gap-3 ${iPaymuMinBlocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                        <input
                                            type="radio"
                                            name="payment"
                                            disabled={iPaymuMinBlocked}
                                            checked={
                                                paymentMethod ===
                                                "E_WALLET"
                                            }
                                            onChange={() => {
                                                setPaymentMethod(
                                                    "E_WALLET"
                                                );
                                                setPaymentChannel("dana");
                                            }}
                                        />

                                        <div>
                                            <div className="font-semibold">
                                                E-Wallet
                                            </div>

                                            <div className="text-sm text-gray-500">
                                                DANA / ShopeePay.
                                            </div>
                                        </div>
                                    </label>

                                    {iPaymuMinBlocked && (
                                        <div className="mt-2 text-xs font-medium text-amber-600">
                                            {IPAYMU_MIN_AMOUNT_UI_NOTE}
                                        </div>
                                    )}

                                    {paymentMethod ===
                                        "E_WALLET" && (
                                        <div className="mt-4 grid grid-cols-2 gap-2">
                                            {EWALLET_CHANNELS.map(
                                                (wallet) => (
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
                                                                ? "border-rose-500 bg-white text-rose-700"
                                                                : "border-gray-200 bg-white text-gray-700"
                                                        }`}
                                                    >
                                                        {wallet.label}
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* QRIS */}

                                <label
                                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-4 ${paymentMethod ===
                                        "QRIS"
                                        ? "border-rose-500 bg-rose-50"
                                        : "border-gray-200"
                                        }`}
                                >
                                    <input
                                        type="radio"
                                        name="payment"
                                        checked={
                                            paymentMethod ===
                                            "QRIS"
                                        }
                                        onChange={() => {
                                            setPaymentMethod(
                                                "QRIS"
                                            );
                                            setPaymentChannel(null);
                                        }}
                                    />

                                    <div>
                                        <div className="font-semibold">
                                            QRIS
                                        </div>

                                        <div className="text-sm text-gray-500">
                                            Bayar
                                            menggunakan
                                            QRIS melalui
                                            iPaymu.
                                        </div>
                                    </div>
                                </label>
                            </div>


                        </section>
                    </div>

                    {/* =====================================================
                        SUMMARY
                    ===================================================== */}

                    <aside className="h-fit rounded-3xl border border-gray-200 bg-white p-6 lg:sticky lg:top-6">
                        <h2 className="text-lg font-bold">
                            Ringkasan
                        </h2>

                        <div className="mt-5 space-y-4 text-sm">

                            {/* PRODUCT */}

                            <div className="flex justify-between gap-4">
                                <span className="text-gray-500">
                                    Produk
                                </span>

                                <span className="font-medium">
                                    Rp{" "}
                                    {Number(
                                        data.subtotal
                                    ).toLocaleString(
                                        "id-ID"
                                    )}
                                </span>
                            </div>

                            {/* WEIGHT */}

                            <div className="flex justify-between gap-4">
                                <span className="text-gray-500">
                                    Berat
                                </span>

                                <span className="font-medium">
                                    {Number(
                                        data.totalWeight
                                    ).toLocaleString(
                                        "id-ID"
                                    )}{" "}
                                    gram
                                </span>
                            </div>

                            {/* SHIPPING */}

                            <div className="flex justify-between gap-4">
                                <span className="text-gray-500">
                                    Ongkir
                                </span>

                                <span className="font-medium">
                                    {selectedShipping
                                        ? `Rp ${shippingCost.toLocaleString(
                                            "id-ID"
                                        )}`
                                        : "Belum dipilih"}
                                </span>
                            </div>

                            {/* SHIPPING DISCOUNT */}

                            {shippingDiscount > 0 && (
                                <div className="flex justify-between gap-4 text-green-600">
                                    <span>
                                        Diskon Ongkir{shippingDiscountName ? ` (${shippingDiscountName})` : ""}
                                    </span>
                                    <span className="font-medium">
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
                                <div className="flex justify-between gap-4 text-emerald-600">
                                    <span>Diskon Voucher</span>
                                    <span className="font-semibold">
                                        - Rp {voucherDiscount.toLocaleString("id-ID")}
                                    </span>
                                </div>
                            )}

                            {spinWheelDisplayDiscount > 0 && (
                                <div className="flex justify-between gap-4 text-amber-600">
                                    <span>Diskon Spin Wheel</span>
                                    <span className="font-semibold">
                                        - Rp {spinWheelDisplayDiscount.toLocaleString("id-ID")}
                                    </span>
                                </div>
                            )}

                            <div className="border-t pt-4">
                                <div className="flex justify-between gap-4">
                                    <span className="font-bold">
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

                        {/* =================================================
                            CHECKOUT BUTTON
                        ================================================= */}

                        <button
                            type="button"
                            onClick={
                                createOrder
                            }
                            disabled={
                                paymentButtonDisabled
                            }
                            className="mt-6 w-full rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            {creatingOrder
                                ? "Memproses..."
                                : !address
                                    ? "Pilih Alamat"
                                    : !selectedShipping
                                        ? "Pilih Pengiriman"
                                        : paymentMethod ===
                                            "COD"
                                            ? "Buat Pesanan"
                                            : "Bayar Sekarang"}
                        </button>

                        {/* =================================================
                            SECURITY NOTE
                        ================================================= */}

                        <p className="mt-4 text-center text-xs leading-5 text-gray-400">
                            Total pembayaran akan
                            divalidasi kembali di
                            server sebelum pesanan
                            dibuat.
                        </p>
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