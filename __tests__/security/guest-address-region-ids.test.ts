/**
 * ==========================================
 * GUEST ADDRESS — REGION ID RESOLUTION (REGRESSION)
 * ==========================================
 *
 * Reproduces the production failure:
 *
 *   POST /api/orders  →  400
 *   {"success":false,"message":"Kelurahan/desa yang dipilih tidak ditemukan."}
 *
 * CAUSE: the address form is fed by the SHIPPING PROVIDER's region feed,
 * whose ids do not exist in the local province/regency/district/village
 * tables. The payload below carries such ids alongside perfectly valid
 * address text, and previously hard-failed inside resolveGuestAddress().
 *
 * The same input must now resolve; an id is only ever ADOPTED when it
 * resolves to the place the buyer actually selected AND its parent chain
 * agrees — a foreign-space id must never re-point the destination.
 *
 * Real MariaDB (`toko`). No Mengantar / RajaOngkir call is made.
 */

jest.mock("@/lib/mengantar/shipping", () => ({
    ...jest.requireActual("@/lib/mengantar/shipping"),
    resolveMengantarDestinationAreaId: jest.fn(async () => null),
}));

import { readFileSync } from "fs";
import { resolve } from "path";

import { prisma } from "@/lib/prisma";
import { resolveGuestAddress } from "@/lib/guest-address";

jest.setTimeout(60000);

const SUFFIX = `gar-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

/*
 * Synthetic region rows in an unused id range, so the "id verifies",
 * "id disagrees with the label" and "id sits under another parent"
 * branches can all be exercised for real without touching seeded data.
 */
const PROVINCE_ID = 9_700_001;
const REGENCY_ID = 9_700_002;
const OTHER_REGENCY_ID = 9_700_012;
const DISTRICT_ID = 9_700_003;
const OTHER_DISTRICT_ID = 9_700_013;
const VILLAGE_ID = 9_700_004;
const OTHER_VILLAGE_ID = 9_700_014;

const PROVINCE_NAME = `PROV-${SUFFIX}`;
const CITY_NAME = `KOTA-${SUFFIX}`;
const OTHER_CITY_NAME = `KOTA-LAIN-${SUFFIX}`;
const DISTRICT_NAME = `KEC-${SUFFIX}`;
const OTHER_DISTRICT_NAME = `KEC-LAIN-${SUFFIX}`;
const VILLAGE_NAME = `KEL-${SUFFIX}`;
const OTHER_VILLAGE_NAME = `KEL-LAIN-${SUFFIX}`;

beforeAll(async () => {
    await prisma.province.create({
        data: { id: PROVINCE_ID, name: PROVINCE_NAME },
    });

    await prisma.regency.createMany({
        data: [
            {
                id: REGENCY_ID,
                provinceId: PROVINCE_ID,
                name: CITY_NAME,
            },
            {
                id: OTHER_REGENCY_ID,
                provinceId: PROVINCE_ID,
                name: OTHER_CITY_NAME,
            },
        ],
    });

    await prisma.district.createMany({
        data: [
            {
                id: DISTRICT_ID,
                regencyId: REGENCY_ID,
                name: DISTRICT_NAME,
            },
            {
                id: OTHER_DISTRICT_ID,
                regencyId: REGENCY_ID,
                name: OTHER_DISTRICT_NAME,
            },
        ],
    });

    await prisma.village.createMany({
        data: [
            {
                id: VILLAGE_ID,
                districtId: DISTRICT_ID,
                name: VILLAGE_NAME,
                postalCode: "12160",
            },
            {
                /*
                 * Same regency, DIFFERENT kecamatan: used to prove a
                 * kelurahan that belongs elsewhere is never adopted.
                 */
                id: OTHER_VILLAGE_ID,
                districtId: OTHER_DISTRICT_ID,
                name: OTHER_VILLAGE_NAME,
                postalCode: "99999",
            },
        ],
    });
});

afterAll(async () => {
    await prisma.village.deleteMany({
        where: { id: { in: [VILLAGE_ID, OTHER_VILLAGE_ID] } },
    });

    await prisma.district.deleteMany({
        where: {
            id: { in: [DISTRICT_ID, OTHER_DISTRICT_ID] },
        },
    });

    await prisma.regency.deleteMany({
        where: { id: { in: [REGENCY_ID, OTHER_REGENCY_ID] } },
    });

    await prisma.province.deleteMany({
        where: { id: PROVINCE_ID },
    });

    await prisma.$disconnect();
});

/** The exact shape the address form submits (ids optional). */
function formPayload(
    overrides: Record<string, unknown> = {}
) {
    return {
        recipientName: "Siti Rahayu",
        phone: "081234567890",
        email: `siti-${SUFFIX}@example.com`,
        address: "Jl. Melati No. 5, RT 02 RW 03",
        province: "DKI JAKARTA",
        city: "JAKARTA SELATAN",
        district: "KEBAYORAN BARU",
        subdistrict: "MELAWA",
        postalCode: "12160",
        ...overrides,
    };
}

describe("resolveGuestAddress — provider-space region ids", () => {
    test("REGRESSION: the failing form payload now resolves instead of throwing", async () => {
        /*
         * These ids are in the SHIPPING PROVIDER's space. None of them
         * exist in the local region tables — exactly what the browser
         * sends after a real province → city → kecamatan → kelurahan
         * selection, and exactly what used to raise
         * "Kelurahan/desa yang dipilih tidak ditemukan."
         */
        const result = await resolveGuestAddress(
            formPayload({
                provinceId: 6,
                regencyId: 153,
                districtId: 1699,
                villageId: 56872,
            }) as never
        );

        expect(result.recipientName).toBe("Siti Rahayu");
        expect(result.phone).toBe("6281234567890");
        expect(result.email).toBe(
            `siti-${SUFFIX}@example.com`
        );
        expect(result.address).toBe(
            "Jl. Melati No. 5, RT 02 RW 03"
        );

        // The submitted text is kept — an unverifiable id must never
        // blank out or invent part of the destination.
        expect(result.province).toBe("DKI JAKARTA");
        expect(result.city).toBe("JAKARTA SELATAN");
        expect(result.district).toBe("KEBAYORAN BARU");
        expect(result.subdistrict).toBe("MELAWA");
        expect(result.postalCode).toBe("12160");
    });

    test("an id that resolves to a DIFFERENT region never re-points the destination", async () => {
        /*
         * Province id 6 DOES exist locally — as an unrelated province.
         * Adopting it would silently move the buyer. The label must win.
         */
        const result = await resolveGuestAddress(
            formPayload({
                provinceId: 6,
                province: "DKI JAKARTA",
            }) as never
        );

        expect(result.province).toBe("DKI JAKARTA");
    });

    test("an unknown village id alone is discarded, not fatal", async () => {
        const result = await resolveGuestAddress(
            formPayload({ villageId: 999_999_999 }) as never
        );

        expect(result.subdistrict).toBe("MELAWA");
        expect(result.district).toBe("KEBAYORAN BARU");
        expect(result.city).toBe("JAKARTA SELATAN");
    });

    test("verified local ids win: the stored hierarchy is canonical", async () => {
        const result = await resolveGuestAddress(
            formPayload({
                /*
                 * Labels agree with the stored rows (casing/punctuation
                 * aside), so the ids are adopted and the DB spelling is
                 * what ends up on the order.
                 */
                province: PROVINCE_NAME.toLowerCase(),
                city: CITY_NAME.toLowerCase(),
                district: DISTRICT_NAME.toLowerCase(),
                subdistrict: VILLAGE_NAME.toLowerCase(),
                provinceId: PROVINCE_ID,
                regencyId: REGENCY_ID,
                districtId: DISTRICT_ID,
                villageId: VILLAGE_ID,
            }) as never
        );

        expect(result.province).toBe(PROVINCE_NAME);
        expect(result.city).toBe(CITY_NAME);
        expect(result.district).toBe(DISTRICT_NAME);
        expect(result.subdistrict).toBe(VILLAGE_NAME);
        expect(result.postalCode).toBe("12160");
    });

    test("a kelurahan from ANOTHER kecamatan is never adopted (parent-child check)", async () => {
        /*
         * OTHER_VILLAGE_ID exists and its label agrees, but it sits under
         * a different kecamatan than the one selected, so it must be
         * discarded rather than adopted.
         */
        const result = await resolveGuestAddress(
            formPayload({
                province: PROVINCE_NAME.toLowerCase(),
                city: CITY_NAME.toLowerCase(),
                district: DISTRICT_NAME.toLowerCase(),
                subdistrict: OTHER_VILLAGE_NAME,
                provinceId: PROVINCE_ID,
                regencyId: REGENCY_ID,
                districtId: DISTRICT_ID,
                villageId: OTHER_VILLAGE_ID,
            }) as never
        );

        // The selected (canonical) kecamatan keeps the chain…
        expect(result.province).toBe(PROVINCE_NAME);
        expect(result.city).toBe(CITY_NAME);
        expect(result.district).toBe(DISTRICT_NAME);

        // …the row's own postal code is NOT adopted (proof its data was
        // dropped), and only the buyer's label text remains.
        expect(result.postalCode).toBe("12160");
        expect(result.postalCode).not.toBe("99999");
        expect(result.subdistrict).toBe(OTHER_VILLAGE_NAME);
    });

    test("a kecamatan under ANOTHER kota is never adopted (parent-child check)", async () => {
        const result = await resolveGuestAddress(
            formPayload({
                province: PROVINCE_NAME.toLowerCase(),
                city: OTHER_CITY_NAME.toLowerCase(),
                district: DISTRICT_NAME.toLowerCase(),
                subdistrict: "KELURAHAN APA SAJA",
                provinceId: PROVINCE_ID,
                // This kota really exists, but DISTRICT_ID belongs to the
                // other one — the kecamatan id must be dropped.
                regencyId: OTHER_REGENCY_ID,
                districtId: DISTRICT_ID,
            }) as never
        );

        // The kecamatan id was dropped, so only the submitted label is
        // left — and the kota that DID verify is the canonical one.
        expect(result.district).toBe(
            DISTRICT_NAME.toLowerCase()
        );
        expect(result.city).toBe(OTHER_CITY_NAME);
        expect(result.province).toBe(PROVINCE_NAME);
    });
});

describe("one canonical address for estimates and for orders", () => {
    function readFile(relativePath: string): string {
        return readFileSync(
            resolve(process.cwd(), relativePath),
            "utf-8"
        );
    }

    test("the shipping estimate and order creation both canonicalize via resolveGuestAddress", () => {
        // The estimate route and checkout MUST agree on the destination,
        // so both go through the same server-side resolver.
        expect(
            readFile("app/api/mengantar/estimate/route.ts")
        ).toContain("resolveGuestAddress");
        expect(readFile("lib/checkout.ts")).toContain(
            "resolveGuestAddress"
        );
    });
});
