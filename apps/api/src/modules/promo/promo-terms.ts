import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { promoFundingGauge } from '../../plugins/observability';

/**
 * [M-32] A promo's terms are a law, not a form.
 *
 * Stop-ship register M-32: create capped a percentage at 100, but update had
 * no percentage max and no merged date check, and wrote whatever it was sent;
 * a zero max-discount read as "no cap"; and at checkout the discount's
 * capacity included the tip, so a code larger than goods + fee ate the
 * rider's tip while the tip earning was still minted in full — money with no
 * funder. Now:
 *
 *   - the WHOLE record is validated on every write — an update is validated
 *     as the merged row, never as the patch alone — and the database carries
 *     the same bounds as CHECK constraints (promo_codes_*_check);
 *   - every create and every change of terms writes an immutable PromoTerms
 *     version; the promo row only moves a pointer; rollback pins a prior
 *     version by writing a NEW one that names what it restored;
 *   - a redemption snapshots the version, the funder and the discount per
 *     component (goods, delivery fee, tip = 0) on the order — the redeemed
 *     terms cannot change under an order, and every discounted dollar names
 *     who funds it;
 *   - the scan reports what the law would have caught, fenced at the date it
 *     took effect.
 */
export const PROMO_FUNDING_ENFORCED_AT = new Date('2026-09-02T04:00:00.000Z');
export const PROMO_MONEY_MAX = 10_000_000;
export const PROMO_MAX_USES_MAX = 1_000_000;
export const PROMO_MAX_USES_PER_USER_MAX = 100;

export interface PromoTermsInput {
  discountType: string;
  discountValue: number;
  minOrderAmount?: number | null;
  maxDiscount?: number | null;
  validFrom: Date;
  validUntil: Date;
  maxUses?: number | null;
  maxUsesPerUser: number;
}

const isDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const money = (v: number | null | undefined) => v == null || (Number.isFinite(v) && v >= 0 && v <= PROMO_MONEY_MAX);

/** Every way the terms break the invariant — the same law the database
 *  CHECKs carry. Empty means valid. */
export function promoTermsProblems(t: PromoTermsInput): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(t.discountValue) || t.discountValue < 0) problems.push('discountValue must be zero or more');
  else if (t.discountValue > PROMO_MONEY_MAX) problems.push(`discountValue cannot exceed ${PROMO_MONEY_MAX}`);
  if (t.discountType === 'PERCENTAGE' && t.discountValue > 100) problems.push('a percentage discount cannot exceed 100');
  if (!money(t.maxDiscount)) problems.push(`maxDiscount must be between 0 and ${PROMO_MONEY_MAX} (0 is an explicit cap of zero)`);
  if (!money(t.minOrderAmount)) problems.push(`minOrderAmount must be between 0 and ${PROMO_MONEY_MAX}`);
  if (!isDate(t.validFrom)) problems.push('validFrom must be a date');
  if (!isDate(t.validUntil)) problems.push('validUntil must be a date');
  if (isDate(t.validFrom) && isDate(t.validUntil) && t.validFrom.getTime() >= t.validUntil.getTime()) problems.push('validUntil must be after validFrom');
  if (t.maxUses != null && (!Number.isInteger(t.maxUses) || t.maxUses < 1 || t.maxUses > PROMO_MAX_USES_MAX)) problems.push(`maxUses must be a whole number from 1 to ${PROMO_MAX_USES_MAX}`);
  if (!Number.isInteger(t.maxUsesPerUser) || t.maxUsesPerUser < 1 || t.maxUsesPerUser > PROMO_MAX_USES_PER_USER_MAX) problems.push(`maxUsesPerUser must be a whole number from 1 to ${PROMO_MAX_USES_PER_USER_MAX}`);
  return problems;
}

export function assertPromoTerms(t: PromoTermsInput): void {
  const problems = promoTermsProblems(t);
  if (problems.length > 0) {
    throw new AppError(400, 'INVALID_PROMO_TERMS', `These terms are not valid: ${problems.join('; ')}`, { problems });
  }
}

export interface PromoTermsPatch {
  description?: string;
  isActive?: boolean;
  discountValue?: number;
  minOrderAmount?: number | null;
  maxDiscount?: number | null;
  validFrom?: Date;
  validUntil?: Date;
  maxUses?: number | null;
  maxUsesPerUser?: number;
}
const TERM_FIELDS = ['discountValue', 'minOrderAmount', 'maxDiscount', 'validFrom', 'validUntil', 'maxUses', 'maxUsesPerUser'] as const;

type PromoRow = {
  discountType: string;
  discountValue: Prisma.Decimal | number;
  minOrderAmount: Prisma.Decimal | number | null;
  maxDiscount: Prisma.Decimal | number | null;
  validFrom: Date;
  validUntil: Date;
  maxUses: number | null;
  maxUsesPerUser: number;
};
const num = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

/** The WHOLE record as it would stand after the patch. Validation reads this,
 *  never the patch alone — a new end date is judged against the stored start. */
export function mergedPromoTerms(existing: PromoRow, patch: PromoTermsPatch): PromoTermsInput {
  return {
    discountType: existing.discountType,
    discountValue: patch.discountValue !== undefined ? patch.discountValue : Number(existing.discountValue),
    minOrderAmount: patch.minOrderAmount !== undefined ? patch.minOrderAmount : num(existing.minOrderAmount),
    maxDiscount: patch.maxDiscount !== undefined ? patch.maxDiscount : num(existing.maxDiscount),
    validFrom: patch.validFrom ?? existing.validFrom,
    validUntil: patch.validUntil ?? existing.validUntil,
    maxUses: patch.maxUses !== undefined ? patch.maxUses : existing.maxUses,
    maxUsesPerUser: patch.maxUsesPerUser ?? existing.maxUsesPerUser,
  };
}

/** Write the immutable terms row for the promo's CURRENT version. Call after
 *  the row was written, inside the same transaction. */
export async function recordPromoTermsVersion(
  tx: Prisma.TransactionClient,
  promoCodeId: string,
  opts: { createdBy?: string | null; restoredFrom?: number | null } = {},
) {
  const promo = await tx.promoCode.findUniqueOrThrow({ where: { id: promoCodeId } });
  return tx.promoTerms.create({
    data: {
      promoCodeId,
      version: promo.termsVersion,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      minOrderAmount: promo.minOrderAmount,
      maxDiscount: promo.maxDiscount,
      applicableTo: promo.applicableTo,
      validFrom: promo.validFrom,
      validUntil: promo.validUntil,
      maxUses: promo.maxUses,
      maxUsesPerUser: promo.maxUsesPerUser,
      funder: promo.funder,
      restoredFrom: opts.restoredFrom ?? null,
      createdBy: opts.createdBy ?? null,
    },
  });
}

/** Update under the law: lock the row, validate the MERGED record, apply the
 *  patch, and — when any term changed — bump the version and write its
 *  immutable row. One transaction; a refused patch changes nothing. */
export async function updatePromoTerms(prisma: PrismaClient, promoCodeId: string, patch: PromoTermsPatch, actor: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "promo_codes" WHERE id = ${promoCodeId} FOR UPDATE`;
    const existing = await tx.promoCode.findUnique({ where: { id: promoCodeId } });
    if (!existing) throw new NotFoundError('PromoCode', promoCodeId);
    assertPromoTerms(mergedPromoTerms(existing, patch));
    const termsChanged = TERM_FIELDS.some((f) => patch[f] !== undefined);
    const promo = await tx.promoCode.update({
      where: { id: promoCodeId },
      data: {
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        ...(patch.discountValue !== undefined && { discountValue: patch.discountValue }),
        ...(patch.minOrderAmount !== undefined && { minOrderAmount: patch.minOrderAmount }),
        ...(patch.maxDiscount !== undefined && { maxDiscount: patch.maxDiscount }),
        ...(patch.validFrom !== undefined && { validFrom: patch.validFrom }),
        ...(patch.validUntil !== undefined && { validUntil: patch.validUntil }),
        ...(patch.maxUses !== undefined && { maxUses: patch.maxUses }),
        ...(patch.maxUsesPerUser !== undefined && { maxUsesPerUser: patch.maxUsesPerUser }),
        ...(termsChanged && { termsVersion: { increment: 1 } }),
      },
    });
    if (termsChanged) await recordPromoTermsVersion(tx, promoCodeId, { createdBy: actor });
    return promo;
  });
}

/** Rollback pins a prior version: the row takes that version's terms and a
 *  NEW version is written naming what it restored. History is never edited. */
export async function rollbackPromoTerms(prisma: PrismaClient, promoCodeId: string, toVersion: number | undefined, actor: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "promo_codes" WHERE id = ${promoCodeId} FOR UPDATE`;
    const existing = await tx.promoCode.findUnique({ where: { id: promoCodeId } });
    if (!existing) throw new NotFoundError('PromoCode', promoCodeId);
    const target = toVersion ?? existing.termsVersion - 1;
    if (target < 1 || target >= existing.termsVersion) {
      throw new AppError(400, 'NO_SUCH_VERSION', `Version ${target} is not a prior version of this promo (the live version is ${existing.termsVersion})`);
    }
    const terms = await tx.promoTerms.findUnique({ where: { promoCodeId_version: { promoCodeId, version: target } } });
    if (!terms) throw new AppError(404, 'NO_SUCH_VERSION', `Version ${target} was never recorded for this promo`);
    assertPromoTerms({
      discountType: terms.discountType, discountValue: Number(terms.discountValue), minOrderAmount: num(terms.minOrderAmount), maxDiscount: num(terms.maxDiscount),
      validFrom: terms.validFrom, validUntil: terms.validUntil, maxUses: terms.maxUses, maxUsesPerUser: terms.maxUsesPerUser,
    });
    const promo = await tx.promoCode.update({
      where: { id: promoCodeId },
      data: {
        discountType: terms.discountType, discountValue: terms.discountValue, minOrderAmount: terms.minOrderAmount, maxDiscount: terms.maxDiscount,
        applicableTo: terms.applicableTo, validFrom: terms.validFrom, validUntil: terms.validUntil, maxUses: terms.maxUses, maxUsesPerUser: terms.maxUsesPerUser,
        termsVersion: { increment: 1 },
      },
    });
    const recorded = await recordPromoTermsVersion(tx, promoCodeId, { createdBy: actor, restoredFrom: target });
    return { promo, restoredFrom: target, version: recorded.version };
  });
}

export interface PromoFundingScan {
  invalidTerms: number;
  discountWithoutFunder: { total: number; sinceEnforced: number };
  tipFundingGap: { total: number; sinceEnforced: number };
}

/** The operations clause: what the law would have caught. Active promos with
 *  invalid terms; discounted orders with no redemption snapshot (no named
 *  funder); orders whose tip was discounted. Each order count is also fenced
 *  at the enforcement date — legacy rows are reported, never rewritten. */
export async function scanPromoFunding(prisma: PrismaClient): Promise<PromoFundingScan> {
  const [invalid] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM "promo_codes"
    WHERE "isActive" = true AND (
      ("discountType" = 'PERCENTAGE' AND "discountValue" > 100) OR "discountValue" < 0
      OR "validFrom" >= "validUntil"
      OR ("maxDiscount" IS NOT NULL AND "maxDiscount" < 0) OR ("minOrderAmount" IS NOT NULL AND "minOrderAmount" < 0)
      OR ("maxUses" IS NOT NULL AND "maxUses" < 1) OR "maxUsesPerUser" < 1)`;
  const [unfunded] = await prisma.$queryRaw<Array<{ total: bigint; since_enforced: bigint }>>`
    SELECT count(*)::bigint AS total, count(*) FILTER (WHERE o."createdAt" >= ${PROMO_FUNDING_ENFORCED_AT})::bigint AS since_enforced
    FROM "orders" o
    WHERE o."discount" > 0 AND NOT EXISTS (SELECT 1 FROM "promo_redemptions" r WHERE r."orderId" = o."id")`;
  const [tipGap] = await prisma.$queryRaw<Array<{ total: bigint; since_enforced: bigint }>>`
    SELECT count(*)::bigint AS total, count(*) FILTER (WHERE o."createdAt" >= ${PROMO_FUNDING_ENFORCED_AT})::bigint AS since_enforced
    FROM "orders" o
    WHERE o."discount" > o."subtotalCustomer" + o."deliveryFee"`;
  const scan: PromoFundingScan = {
    invalidTerms: Number(invalid?.n ?? 0),
    discountWithoutFunder: { total: Number(unfunded?.total ?? 0), sinceEnforced: Number(unfunded?.since_enforced ?? 0) },
    tipFundingGap: { total: Number(tipGap?.total ?? 0), sinceEnforced: Number(tipGap?.since_enforced ?? 0) },
  };
  promoFundingGauge.labels('invalid_terms').set(scan.invalidTerms);
  promoFundingGauge.labels('discount_without_funder').set(scan.discountWithoutFunder.total);
  promoFundingGauge.labels('discount_without_funder_since_enforced').set(scan.discountWithoutFunder.sinceEnforced);
  promoFundingGauge.labels('tip_funding_gap').set(scan.tipFundingGap.total);
  promoFundingGauge.labels('tip_funding_gap_since_enforced').set(scan.tipFundingGap.sinceEnforced);
  return scan;
}
