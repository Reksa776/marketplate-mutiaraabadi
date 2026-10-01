import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/* ==========================================
 * PATCH /api/addresses/[id]
 * ==========================================
 *
 * Edit an address. Only the owner can edit.
 * Supports toggling isDefault.
 *
 * If isDefault is set to true, all other
 * addresses for this user are unset.
 * If the currently-default address is being
 * changed to non-default, and no other address
 * is default, the first remaining address
 * becomes default (safe fallback).
 */

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                { success: false, message: "Silakan login terlebih dahulu." },
                { status: 401 }
            );
        }

        const userId = session.user.id;
        const { id } = await params;

        /* ==========================================
         * FIND ADDRESS + OWNERSHIP CHECK
         * ========================================== */

        const existing = await prisma.userAddress.findUnique({
            where: { id },
        });

        if (!existing) {
            return NextResponse.json(
                { success: false, message: "Alamat tidak ditemukan." },
                { status: 404 }
            );
        }

        if (existing.userId !== userId) {
            return NextResponse.json(
                { success: false, message: "Akses ditolak." },
                { status: 403 }
            );
        }

        /* ==========================================
         * PARSE BODY
         * ========================================== */

        const body = await request.json();

        const updateData: Record<string, any> = {};

        if (body.label !== undefined) {
            updateData.label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
        }

        if (body.recipientName !== undefined) {
            if (typeof body.recipientName !== "string" || !body.recipientName.trim()) {
                return NextResponse.json(
                    { success: false, message: "Nama penerima wajib diisi." },
                    { status: 400 }
                );
            }
            updateData.recipientName = body.recipientName.trim();
        }

        if (body.phone !== undefined) {
            if (typeof body.phone !== "string" || !body.phone.trim()) {
                return NextResponse.json(
                    { success: false, message: "Nomor HP wajib diisi." },
                    { status: 400 }
                );
            }
            updateData.phone = body.phone.trim();
        }

        if (body.address !== undefined) {
            if (typeof body.address !== "string" || !body.address.trim()) {
                return NextResponse.json(
                    { success: false, message: "Alamat lengkap wajib diisi." },
                    { status: 400 }
                );
            }
            updateData.address = body.address.trim();
        }

        if (body.province !== undefined) {
            updateData.province = typeof body.province === "string" && body.province.trim() ? body.province.trim() : null;
        }

        if (body.city !== undefined) {
            updateData.city = typeof body.city === "string" && body.city.trim() ? body.city.trim() : null;
        }

        if (body.district !== undefined) {
            updateData.district = typeof body.district === "string" && body.district.trim() ? body.district.trim() : null;
        }

        if (body.subdistrict !== undefined) {
            updateData.subdistrict = typeof body.subdistrict === "string" && body.subdistrict.trim() ? body.subdistrict.trim() : null;
        }

        if (body.postalCode !== undefined) {
            updateData.postalCode = typeof body.postalCode === "string" && body.postalCode.trim() ? body.postalCode.trim() : null;
        }

        if (body.rajaOngkirDestinationId !== undefined) {
            const destId = Number(body.rajaOngkirDestinationId);
            updateData.rajaOngkirDestinationId = Number.isInteger(destId) && destId > 0 ? destId : null;
        }

        /*
         * Invalidate the cached Mengantar destination area id whenever
         * any area-defining field changes. The area is re-resolved
         * server-side from /address/search on the next estimate, so a
         * stale id can never leak into a shipment quote.
         */
        if (
            body.province !== undefined ||
            body.city !== undefined ||
            body.district !== undefined ||
            body.subdistrict !== undefined ||
            body.postalCode !== undefined
        ) {
            updateData.mengantarDestinationAreaId = null;
        }

        if (body.latitude !== undefined) {
            const lat = Number(body.latitude);
            updateData.latitude = Number.isFinite(lat) ? lat : null;
        }

        if (body.longitude !== undefined) {
            const lng = Number(body.longitude);
            updateData.longitude = Number.isFinite(lng) ? lng : null;
        }

        /* ==========================================
         * HANDLE isDefault
         * ==========================================
         *
         * If isDefault is explicitly set to true:
         *   1. Unset all other addresses for this user
         *   2. Set this address as default
         *
         * If isDefault is explicitly set to false:
         *   1. If this was the default, find next best default
         *   2. Set this address as non-default
         */

        if (body.isDefault === true && !existing.isDefault) {
            /* Make this the default — unset all others first */
            await prisma.userAddress.updateMany({
                where: { userId, isDefault: true },
                data: { isDefault: false },
            });
            updateData.isDefault = true;
        } else if (body.isDefault === false && existing.isDefault) {
            /* Removing default status — find next best */
            const nextDefault = await prisma.userAddress.findFirst({
                where: { userId, id: { not: id } },
                orderBy: [{ createdAt: "asc" }],
                select: { id: true },
            });

            if (nextDefault) {
                /* Promote next address to default */
                await prisma.userAddress.update({
                    where: { id: nextDefault.id },
                    data: { isDefault: true },
                });
            }
            updateData.isDefault = false;
        }

        /* ==========================================
         * VALIDATE REGION IDs IF PROVIDED
         * ==========================================
         *
         * F8: Same chain rules as POST /api/addresses.
         * A child region may only be stored when no parent is
         * set OR the parent matches. A valid child also implies
         * its parent, so the stored chain is never contradictory.
         */

        // Candidate value for each level: body if provided (parsed to
        // a positive integer else null), otherwise the existing row value.
        const candidateProvinceId =
            body.provinceId !== undefined
                ? (() => {
                      const n = Number(body.provinceId);
                      return Number.isInteger(n) && n > 0 ? n : null;
                  })()
                : existing.provinceId;

        const candidateRegencyId =
            body.cityId !== undefined
                ? (() => {
                      const n = Number(body.cityId);
                      return Number.isInteger(n) && n > 0 ? n : null;
                  })()
                : existing.regencyId;

        const candidateDistrictId =
            body.districtId !== undefined
                ? (() => {
                      const n = Number(body.districtId);
                      return Number.isInteger(n) && n > 0 ? n : null;
                  })()
                : existing.districtId;

        const candidateVillageId =
            body.villageId !== undefined
                ? (() => {
                      const n = Number(body.villageId);
                      return Number.isInteger(n) && n > 0 ? n : null;
                  })()
                : existing.villageId;

        let validProvinceId: number | null = null;
        let validRegencyId: number | null = null;
        let validDistrictId: number | null = null;
        let validVillageId: number | null = null;

        if (candidateProvinceId) {
            const prov = await prisma.province.findUnique({
                where: { id: candidateProvinceId },
                select: { id: true },
            });
            if (prov) validProvinceId = prov.id;
        }

        if (candidateRegencyId) {
            const regencyData = await prisma.regency.findUnique({
                where: { id: candidateRegencyId },
                select: { id: true, provinceId: true },
            });
            if (regencyData) {
                if (!validProvinceId || regencyData.provinceId === validProvinceId) {
                    validRegencyId = regencyData.id;
                    if (!validProvinceId) validProvinceId = regencyData.provinceId;
                }
            }
        }

        if (candidateDistrictId) {
            const districtData = await prisma.district.findUnique({
                where: { id: candidateDistrictId },
                select: { id: true, regencyId: true },
            });
            if (districtData) {
                if (!validRegencyId || districtData.regencyId === validRegencyId) {
                    validDistrictId = districtData.id;
                    if (!validRegencyId) {
                        validRegencyId = districtData.regencyId;
                        if (!validProvinceId) {
                            const reg = await prisma.regency.findUnique({
                                where: { id: validRegencyId },
                                select: { provinceId: true },
                            });
                            if (reg) validProvinceId = reg.provinceId;
                        }
                    }
                }
            }
        }

        if (candidateVillageId) {
            const villageData = await prisma.village.findUnique({
                where: { id: candidateVillageId },
                select: { id: true, districtId: true },
            });
            if (villageData) {
                if (!validDistrictId || villageData.districtId === validDistrictId) {
                    validVillageId = villageData.id;
                    if (!validDistrictId) validDistrictId = villageData.districtId;
                }
            }
        }

        // Write only levels the client explicitly provided…
        if (body.provinceId !== undefined) updateData.provinceId = validProvinceId;
        if (body.cityId !== undefined) updateData.regencyId = validRegencyId;
        if (body.districtId !== undefined) updateData.districtId = validDistrictId;
        if (body.villageId !== undefined) updateData.villageId = validVillageId;

        // …and cascade any parent implied by an accepted child where the
        // client did not override it, so the stored chain stays consistent.
        if (
            body.provinceId === undefined &&
            existing.provinceId === null &&
            validProvinceId !== null
        ) {
            updateData.provinceId = validProvinceId;
        }
        if (
            body.cityId === undefined &&
            existing.regencyId === null &&
            validRegencyId !== null
        ) {
            updateData.regencyId = validRegencyId;
        }
        if (
            body.districtId === undefined &&
            existing.districtId === null &&
            validDistrictId !== null
        ) {
            updateData.districtId = validDistrictId;
        }

        /* ==========================================
         * EXECUTE UPDATE
         * ========================================== */

        const updated = await prisma.userAddress.update({
            where: { id },
            data: updateData,
        });

        return NextResponse.json({
            success: true,
            message: "Alamat berhasil diperbarui.",
            data: updated,
        });
    } catch (error) {
        console.error("PATCH ADDRESS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Gagal memperbarui alamat." },
            { status: 500 }
        );
    }
}

/* ==========================================
 * DELETE /api/addresses/[id]
 * ==========================================
 *
 * Delete an address. Only the owner can delete.
 *
 * If the deleted address was the default:
 *   - Promote the next oldest address to default.
 *   - If no addresses remain, no default needed.
 */

export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();

        if (!session?.user?.id) {
            return NextResponse.json(
                { success: false, message: "Silakan login terlebih dahulu." },
                { status: 401 }
            );
        }

        const userId = session.user.id;
        const { id } = await params;

        /* ==========================================
         * FIND ADDRESS + OWNERSHIP CHECK
         * ========================================== */

        const existing = await prisma.userAddress.findUnique({
            where: { id },
        });

        if (!existing) {
            return NextResponse.json(
                { success: false, message: "Alamat tidak ditemukan." },
                { status: 404 }
            );
        }

        if (existing.userId !== userId) {
            return NextResponse.json(
                { success: false, message: "Akses ditolak." },
                { status: 403 }
            );
        }

        /* ==========================================
         * DELETE
         * ========================================== */

        await prisma.userAddress.delete({
            where: { id },
        });

        /* ==========================================
         * DEFAULT FALLBACK
         * ==========================================
         *
         * If the deleted address was default,
         * promote the next oldest address.
         */

        if (existing.isDefault) {
            const nextDefault = await prisma.userAddress.findFirst({
                where: { userId },
                orderBy: [{ createdAt: "asc" }],
                select: { id: true },
            });

            if (nextDefault) {
                await prisma.userAddress.update({
                    where: { id: nextDefault.id },
                    data: { isDefault: true },
                });
            }
        }

        return NextResponse.json({
            success: true,
            message: "Alamat berhasil dihapus.",
        });
    } catch (error) {
        console.error("DELETE ADDRESS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Gagal menghapus alamat." },
            { status: 500 }
        );
    }
}
