import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { DEFAULT_DELIVERY_RATES, mergeDeliveryRates, type DeliveryRates } from '../../utils/markup';
import { DEFAULT_COURIER_RATES, mergeCourierRates, type CourierRates } from '../courier/courier.service';
import { pricingConfigCounter, pricingConfigGauge } from '../../plugins/observability';

/**
 * [M-35] Every price config is schema-valid, finite, non-negative, versioned,
 * and in declared units.
 *
 * Stop-ship register M-35: the fare service spread raw JSON over its defaults
 * and the shared helpers checked `typeof === 'number'` — NaN, Infinity, a
 * negative rate or a multiplier of 0 all passed, and a quote could be
 * negative, free, NaN, or unlike what was stored. Now one strict schema per
 * kind (unknown keys refused; money as whole-GYD integers, multipliers finite
 * within bounds, the Economy multiplier exactly 1), applied at WRITE (the
 * admin route refuses) and at READ (an invalid live column fails closed to
 * the newest recorded version, never to a guess); every valid payload is an
 * immutable version; rollback points at one. The old tolerant merge is
 * computed alongside as the shadow and every disagreement is counted.
 */
export const PRICING_SCHEMA_VERSION = 1;
export type PricingKind = 'TAXI_RATES' | 'TAXI_CLASS_RATES' | 'DELIVERY_RATES' | 'COURIER_RATES';
export const PRICING_KINDS: readonly PricingKind[] = ['TAXI_RATES', 'TAXI_CLASS_RATES', 'DELIVERY_RATES', 'COURIER_RATES'];
export const PRICING_MONEY_MAX = 100_000_000;

export interface TaxiRates { base: number; perKm: number; perMin: number; minimum: number }
export type ClassRates = { ECONOMY: number; COMFORT: number; XL: number; GROUP: number };

/** The declared defaults — themselves valid full payloads. */
export const DEFAULT_TAXI_RATES: TaxiRates = { base: 1000, perKm: 300, perMin: 25, minimum: 1500 };
export const DEFAULT_CLASS_RATES: ClassRates = { ECONOMY: 1.0, COMFORT: 1.35, XL: 1.8, GROUP: 2.5 };

/** Whole local-currency units (GYD today) — never fractional, never negative. */
const money = z.number().int().min(0).max(PRICING_MONEY_MAX);
const multiplier = z.number().finite().min(0.5).max(10);
const km = z.number().finite().min(0).max(10_000);

const SCHEMAS: Record<PricingKind, z.ZodTypeAny> = {
  TAXI_RATES: z.object({ base: money, perKm: money, perMin: money, minimum: money }).strict(),
  TAXI_CLASS_RATES: z.object({ ECONOMY: z.literal(1), COMFORT: multiplier, XL: multiplier, GROUP: multiplier }).strict(),
  DELIVERY_RATES: z.object({ baseFee: money, perKmRate: money, includedKm: km, surgeMultiplier: multiplier }).strict(),
  COURIER_RATES: z.object({
    baseFee: money,
    perKmRate: money,
    sizeSurcharge: z.object({ SMALL: money, MEDIUM: money, LARGE: money, EXTRA_LARGE: money }).strict(),
    speedMultiplier: z.object({ STANDARD: z.literal(1), EXPRESS: multiplier, RUSH: multiplier }).strict(),
  }).strict(),
};

/** The units each kind's payload is declared in. */
export const PRICING_UNITS: Record<PricingKind, string> = {
  TAXI_RATES: 'GYD_WHOLE',
  TAXI_CLASS_RATES: 'MULTIPLIER',
  DELIVERY_RATES: 'GYD_WHOLE+KM+MULTIPLIER',
  COURIER_RATES: 'GYD_WHOLE+MULTIPLIER',
};

const DEFAULTS: Record<PricingKind, object> = {
  TAXI_RATES: DEFAULT_TAXI_RATES,
  TAXI_CLASS_RATES: DEFAULT_CLASS_RATES,
  DELIVERY_RATES: DEFAULT_DELIVERY_RATES,
  COURIER_RATES: DEFAULT_COURIER_RATES,
};

export function pricingDefaults(kind: PricingKind): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULTS[kind])) as Record<string, unknown>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A partial payload over the defaults, one level of nesting deep. */
function mergeOverDefaults(kind: PricingKind, raw: Record<string, unknown>): Record<string, unknown> {
  const out = pricingDefaults(kind);
  for (const [key, value] of Object.entries(raw)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return out;
}

export type PricingValidation =
  | { status: 'ABSENT'; payload: Record<string, unknown>; problems: [] }
  | { status: 'VALID'; payload: Record<string, unknown>; problems: [] }
  | { status: 'INVALID'; payload: null; problems: string[] };

/** The law: null means "the defaults"; a plain object is merged over the
 *  defaults and the WHOLE result must satisfy the strict schema; anything else
 *  — a scalar, an array, a bad key, a bad value — is INVALID with every
 *  problem named. */
export function validatePricingConfig(kind: PricingKind, raw: unknown): PricingValidation {
  if (raw === null || raw === undefined) return { status: 'ABSENT', payload: pricingDefaults(kind), problems: [] };
  if (!isPlainObject(raw)) return { status: 'INVALID', payload: null, problems: [`${kind} must be a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`] };
  const merged = mergeOverDefaults(kind, raw);
  const parsed = SCHEMAS[kind].safeParse(merged);
  if (!parsed.success) {
    return { status: 'INVALID', payload: null, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  return { status: 'VALID', payload: parsed.data as Record<string, unknown>, problems: [] };
}

export function pricingPayloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** The old tolerant merge, kept ONLY as the shadow. */
function legacyMerge(kind: PricingKind, raw: unknown): Record<string, unknown> {
  switch (kind) {
    case 'DELIVERY_RATES': return mergeDeliveryRates(raw) as unknown as Record<string, unknown>;
    case 'COURIER_RATES': return mergeCourierRates(raw) as unknown as Record<string, unknown>;
    case 'TAXI_RATES': return { ...DEFAULT_TAXI_RATES, ...((isPlainObject(raw) ? raw : {}) as Partial<TaxiRates>) };
    case 'TAXI_CLASS_RATES': return { ...DEFAULT_CLASS_RATES, ...((isPlainObject(raw) ? raw : {}) as Partial<ClassRates>) };
  }
}

const COLUMN: Record<PricingKind, 'taxiRates' | 'taxiClassRates' | 'deliveryRates' | 'courierRates'> = {
  TAXI_RATES: 'taxiRates', TAXI_CLASS_RATES: 'taxiClassRates', DELIVERY_RATES: 'deliveryRates', COURIER_RATES: 'courierRates',
};

async function latestVersion(db: Prisma.TransactionClient | PrismaClient, countryCode: string, kind: PricingKind) {
  return db.pricingConfigVersion.findFirst({ where: { countryCode, kind }, orderBy: { version: 'desc' } });
}

async function appendVersion(
  db: Prisma.TransactionClient | PrismaClient,
  countryCode: string,
  kind: PricingKind,
  payload: Record<string, unknown>,
  opts: { createdBy?: string | null; restoredFrom?: number | null } = {},
) {
  const latest = await latestVersion(db, countryCode, kind);
  return db.pricingConfigVersion.create({
    data: {
      countryCode, kind, version: (latest?.version ?? 0) + 1, schemaVersion: PRICING_SCHEMA_VERSION, units: PRICING_UNITS[kind],
      payload: payload as Prisma.InputJsonValue, payloadHash: pricingPayloadHash(payload), restoredFrom: opts.restoredFrom ?? null, createdBy: opts.createdBy ?? null,
    },
  });
}

export type PricingSource = 'config' | 'last_known_good' | 'defaults';
export interface PricingRead<T> {
  payload: T;
  source: PricingSource;
  version: number | null;
  problems: string[];
}

const warned = new Set<string>();

/** Read one kind for one country, fail-closed: a valid column is the answer
 *  (and is recorded as a version the first time it is seen); an invalid
 *  column is refused and the newest recorded version answers instead; with no
 *  version the declared defaults do. Never throws — pricing must never crash
 *  a quote — and the source is always named. */
export async function readPricingConfig<T extends object>(prisma: PrismaClient, countryCode: string, kind: PricingKind): Promise<PricingRead<T>> {
  const column = COLUMN[kind];
  const row = await prisma.countryConfig.findUnique({ where: { code: countryCode }, select: { [column]: true } }).catch(() => null);
  const raw = row ? (row as Record<string, unknown>)[column] : null;
  const verdict = validatePricingConfig(kind, raw);
  // The shadow: the tolerant merge the readers used until now.
  const shadow = legacyMerge(kind, raw);
  if (verdict.status === 'VALID') {
    pricingConfigGauge.labels(kind, countryCode, 'invalid').set(0);
    if (JSON.stringify(shadow) !== JSON.stringify(verdict.payload)) pricingConfigCounter.labels('shadow_diff', kind).inc();
    let version: number | null = null;
    try {
      const latest = await latestVersion(prisma, countryCode, kind);
      if (!latest || latest.payloadHash !== pricingPayloadHash(verdict.payload)) {
        const recorded = await appendVersion(prisma, countryCode, kind, verdict.payload, { createdBy: 'reader' });
        version = recorded.version;
      } else {
        version = latest.version;
      }
    } catch {
      version = null; // the ledger being unreachable never blocks a valid quote
    }
    return { payload: verdict.payload as unknown as T, source: 'config', version, problems: [] };
  }
  if (verdict.status === 'ABSENT') {
    pricingConfigGauge.labels(kind, countryCode, 'invalid').set(0);
    return { payload: verdict.payload as unknown as T, source: 'defaults', version: null, problems: [] };
  }
  // INVALID: fail closed to the last known good, else the defaults. Reported.
  pricingConfigGauge.labels(kind, countryCode, 'invalid').set(1);
  pricingConfigCounter.labels('refused', kind).inc();
  if (JSON.stringify(shadow) !== JSON.stringify(pricingDefaults(kind))) pricingConfigCounter.labels('shadow_diff', kind).inc();
  const key = `${countryCode}:${kind}`;
  if (!warned.has(key)) {
    warned.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[M-35] ${countryCode} ${kind} is INVALID — ${verdict.problems.join('; ')} — pricing from the last known good version`);
  }
  const latest = await latestVersion(prisma, countryCode, kind).catch(() => null);
  if (latest) return { payload: latest.payload as unknown as T, source: 'last_known_good', version: latest.version, problems: verdict.problems };
  return { payload: pricingDefaults(kind) as unknown as T, source: 'defaults', version: null, problems: verdict.problems };
}

export const readTaxiRates = (prisma: PrismaClient, countryCode: string) => readPricingConfig<TaxiRates>(prisma, countryCode, 'TAXI_RATES');
export const readClassRates = (prisma: PrismaClient, countryCode: string) => readPricingConfig<ClassRates>(prisma, countryCode, 'TAXI_CLASS_RATES');
export const readDeliveryRates = (prisma: PrismaClient, countryCode: string) => readPricingConfig<DeliveryRates>(prisma, countryCode, 'DELIVERY_RATES');
export const readCourierRates = (prisma: PrismaClient, countryCode: string) => readPricingConfig<CourierRates>(prisma, countryCode, 'COURIER_RATES');

/** Write under the law: the partial is merged over the defaults, the WHOLE
 *  payload validated, the column set to the merged payload and a version
 *  appended — one transaction; a refused write changes nothing. */
export async function writePricingConfig(prisma: PrismaClient, countryCode: string, kind: PricingKind, raw: unknown, actor: string | null) {
  const verdict = validatePricingConfig(kind, raw);
  if (verdict.status !== 'VALID') {
    throw new AppError(400, 'INVALID_PRICING_CONFIG', `${kind} for ${countryCode} is not valid: ${verdict.problems.join('; ') || 'a payload is required'}`, { problems: verdict.problems });
  }
  return prisma.$transaction(async (tx) => {
    const exists = await tx.countryConfig.findUnique({ where: { code: countryCode }, select: { code: true } });
    if (!exists) throw new AppError(404, 'NOT_FOUND', `CountryConfig ${countryCode} not found`);
    await tx.countryConfig.update({ where: { code: countryCode }, data: { [COLUMN[kind]]: verdict.payload as Prisma.InputJsonValue } });
    const recorded = await appendVersion(tx, countryCode, kind, verdict.payload, { createdBy: actor });
    return { payload: verdict.payload, version: recorded.version };
  });
}

/** Rollback points the column at a recorded version and records a NEW version naming what it restored. */
export async function rollbackPricingConfig(prisma: PrismaClient, countryCode: string, kind: PricingKind, toVersion: number | undefined, actor: string | null) {
  return prisma.$transaction(async (tx) => {
    const latest = await latestVersion(tx, countryCode, kind);
    if (!latest) throw new AppError(404, 'NO_SUCH_VERSION', `${kind} for ${countryCode} has no recorded version to roll back to`);
    const target = toVersion ?? latest.version - 1;
    if (target < 1 || target >= latest.version) throw new AppError(400, 'NO_SUCH_VERSION', `Version ${target} is not a prior version (the newest is ${latest.version})`);
    const row = await tx.pricingConfigVersion.findUnique({ where: { countryCode_kind_version: { countryCode, kind, version: target } } });
    if (!row) throw new AppError(404, 'NO_SUCH_VERSION', `Version ${target} was never recorded`);
    const verdict = validatePricingConfig(kind, row.payload);
    if (verdict.status !== 'VALID') throw new AppError(409, 'INVALID_PRICING_CONFIG', `Version ${target} no longer satisfies the schema: ${verdict.problems.join('; ')}`);
    await tx.countryConfig.update({ where: { code: countryCode }, data: { [COLUMN[kind]]: verdict.payload as Prisma.InputJsonValue } });
    const recorded = await appendVersion(tx, countryCode, kind, verdict.payload, { createdBy: actor, restoredFrom: target });
    return { payload: verdict.payload, version: recorded.version, restoredFrom: target };
  });
}

export interface PricingScan {
  checked: number;
  invalid: Array<{ countryCode: string; kind: PricingKind; problems: string[] }>;
}

/** [M-35 · operations] Validate every country's every kind; quarantine is
 *  the reader's fail-closed path — this names what it is refusing. */
export async function scanPricingConfigs(prisma: PrismaClient): Promise<PricingScan> {
  const rows = await prisma.countryConfig.findMany({ select: { code: true, taxiRates: true, taxiClassRates: true, deliveryRates: true, courierRates: true } });
  const invalid: PricingScan['invalid'] = [];
  let checked = 0;
  for (const row of rows) {
    for (const kind of PRICING_KINDS) {
      checked += 1;
      const verdict = validatePricingConfig(kind, (row as Record<string, unknown>)[COLUMN[kind]]);
      pricingConfigGauge.labels(kind, row.code, 'invalid').set(verdict.status === 'INVALID' ? 1 : 0);
      if (verdict.status === 'INVALID') invalid.push({ countryCode: row.code, kind, problems: verdict.problems });
    }
  }
  return { checked, invalid };
}

/** [M-35] A quote is never negative, never NaN, never infinite — refused
 *  (503) rather than shown; a sane but extreme fare is counted as an outlier. */
export const PRICE_OUTLIER_CEILING = 1_000_000;
export function assertSaneFare(fare: number, context: string): number {
  if (!Number.isFinite(fare) || fare < 0) {
    pricingConfigCounter.labels('unsane_fare', context).inc();
    throw new AppError(503, 'PRICING_UNAVAILABLE', 'Pricing is temporarily unavailable — try again in a moment.', { context });
  }
  if (fare > PRICE_OUTLIER_CEILING) pricingConfigCounter.labels('outlier', context).inc();
  return fare;
}
