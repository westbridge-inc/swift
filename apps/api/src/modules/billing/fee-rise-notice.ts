import type { Prisma } from '@prisma/client';
import { formatMoney } from '../../utils/currency-amount';
import { formatGuyanaTime } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// [F2 · GUARDRAILS §7 standing rule 2 · Mover and Business Agreements F2]
// A HELD weekly-fee rise, told 14 days ahead, applied only from the weekly fee
// it was told for.
//
// The Agreements say: "Swift may change the weekly fee. We will tell you in
// the app at least 14 days before the change. The new fee applies from your
// first weekly fee due after that date. If you do not accept it, stop your
// plan before then; you will not pay the new fee." Two paths find that a
// partner's card rate is now HIGHER than the weekly fee they pay, and neither
// raises it at once (COORD 17 Oct 23:41Z):
//   - a finance fee-hold resolution (mover-fee-authority resolveMoverFeeHold,
//     #1844): it keeps the old rate and its MOVER_FEE_RESOLVED audit records
//     futureRate.heldRise;
//   - a taxi activation of a mover who has already paid a week (subscription
//     .service moverRow, #1855): it keeps the old rate.
// Each now also records the rise HERE, in the same transaction, under the
// payer's lock. This module is the one reader of those rises:
//
//   1. HELD: the rise is recorded, never written onto the subscription. It
//      applies to nothing yet.
//   2. TOLD: the hourly billing run tells the payer in the app (inbox +
//      push): the old fee, the new fee, and the first weekly fee it applies
//      to, which is the first fee date at least FEE_RISE_NOTICE_DAYS (14)
//      after the notice reached their inbox. The told date is the one the
//      inbox row says (a retried send finds the first row by its dedupe key,
//      so the date never moves after the partner read it). A rise whose
//      notice could not be delivered stays HELD and applies to nothing; it is
//      retried every run, and its date counts from the delivery.
//   3. APPLIED: the subscription's rate moves to the new fee only once the
//      next weekly fee to be charged is due on or after the told date, i.e.
//      every week that started before it is settled at the old price. That
//      is checked in the transaction where a paid week moves the next fee
//      date (billing.service applySuccessfulChargeInTx) and by the hourly
//      run, so the coming week is quoted (and paid) at the new fee from that
//      moment, never sooner. A week already paid keeps its price: if a whole
//      week at the old price is held in the fee credit when the rise would
//      apply, that week keeps the old price and the rise moves one week
//      later, once.
//   4. DROPPED: a rise that no longer matches the subscription (its rate moved
//      under it, a negotiated or waived fee, the plan ended) is dropped, with
//      an audit row; a partner who was told is told it will not happen.
//
// The record lives in a platform_config row keyed by subscription
// (`billing.fee_rise:<id>`), as the fee pause keeps its per-subscription
// records (mmg-pause.ts). It is runtime state, not seeded configuration
// (desiredPlatformConfig() never names it). The ':' keeps it out of the admin
// config editor's key alphabet, so no console write can forge or clear one.
// Every transition writes an append-only audit row.
// ---------------------------------------------------------------------------

export const FEE_RISE_NOTICE_DAYS = 14;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export const FEE_RISE_PREFIX = 'billing.fee_rise:';
export const feeRiseKey = (subscriptionId: string) => `${FEE_RISE_PREFIX}${subscriptionId}`;
/** The notification kind the apps already route (alert-class.ts, notification-router.ts). */
export const FEE_RISE_NOTICE_KIND = 'billing_rate_change';

/** [R27] WEEKLY_RETIER: the weekly re-tier (billing.service runWeeklyRetier) found a higher card rate.
 *  [ENTERPRISE E2] CHAIN_DEAL: the owner's chain deal ends or is raised (chain-deal.ts): the branch's NEGOTIATED
 *  rate moves (customRate customFrom -> customTo, null = back to its own tier fee), never sooner than notBefore. */
export type FeeRiseSource = 'MOVER_FEE_RESOLVED' | 'TAXI_ACTIVATION' | 'WEEKLY_RETIER' | 'CHAIN_DEAL';

export interface HeldFeeRise {
  /** The weekly rate the partner pays now, when the rise was held (major units). */
  from: number;
  /** The higher rate the rise moves to once told and due. */
  to: number;
  currencyCode: string;
  source: FeeRiseSource;
  /** When the rise was held (ISO). */
  heldAt: string;
  /** When the notice reached the payer's inbox (ISO); null = not told, so it applies to nothing. */
  noticeAt: string | null;
  /** The first weekly fee the new rate applies to, as told (ISO); set with noticeAt. */
  appliesFrom: string | null;
  /** The inbox row that told it. */
  inboxId: string | null;
  /** A week held paid at the old price already moved it once. */
  deferredOnce?: boolean;
  /** [ENTERPRISE E2] CHAIN_DEAL only: the chain deal the branch is on now (its customRate) ... */
  customFrom?: number;
  /** ... and what its customRate becomes (null: the deal ends, the branch pays its own tier fee). */
  customTo?: number | null;
  /** ... and the deal's end date: no weekly fee due before it is charged the new fee (ISO). */
  notBefore?: string;
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const SOURCES: readonly FeeRiseSource[] = ['MOVER_FEE_RESOLVED', 'TAXI_ACTIVATION', 'WEEKLY_RETIER', 'CHAIN_DEAL'];

/**
 * A stored held rise, or null for anything that is not one. A record that
 * could only ever charge more, or sooner, than this file allows (not a rise,
 * a told date sooner than 14 days after the notice) is not one either: it
 * applies to nothing until a person looks.
 */
export function readHeldFeeRise(value: unknown): HeldFeeRise | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const from = typeof v['from'] === 'number' ? v['from'] : NaN;
  const to = typeof v['to'] === 'number' ? v['to'] : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from) return null;
  if (typeof v['currencyCode'] !== 'string' || !SOURCES.includes(v['source'] as FeeRiseSource) || !isIso(v['heldAt'])) return null;
  const noticeAt = v['noticeAt'] == null ? null : isIso(v['noticeAt']) ? v['noticeAt'] : undefined;
  const appliesFrom = v['appliesFrom'] == null ? null : isIso(v['appliesFrom']) ? v['appliesFrom'] : undefined;
  if (noticeAt === undefined || appliesFrom === undefined || (noticeAt === null) !== (appliesFrom === null)) return null;
  if (noticeAt && appliesFrom && Date.parse(appliesFrom) < Date.parse(noticeAt) + FEE_RISE_NOTICE_DAYS * DAY_MS) return null;
  // [ENTERPRISE E2] A chain-deal rise names the deal it moves from and to, and its end date: a told date before
  // that end date, or a "change" that would not raise the deal, is not one.
  let chain: Pick<HeldFeeRise, 'customFrom' | 'customTo' | 'notBefore'> = {};
  if (v['source'] === 'CHAIN_DEAL') {
    const customFrom = typeof v['customFrom'] === 'number' ? v['customFrom'] : NaN;
    const customTo = v['customTo'] === null ? null : typeof v['customTo'] === 'number' ? v['customTo'] : NaN;
    if (!Number.isFinite(customFrom) || customFrom <= 0 || (customTo !== null && !(Number.isFinite(customTo) && customTo > customFrom))) return null;
    if (!isIso(v['notBefore'])) return null;
    if (appliesFrom && Date.parse(appliesFrom) < Date.parse(v['notBefore'])) return null;
    chain = { customFrom, customTo, notBefore: v['notBefore'] };
  } else if ('customFrom' in v || 'customTo' in v || 'notBefore' in v) {
    return null;
  }
  return {
    from, to, currencyCode: v['currencyCode'], source: v['source'] as FeeRiseSource, heldAt: v['heldAt'], noticeAt, appliesFrom,
    inboxId: typeof v['inboxId'] === 'string' ? v['inboxId'] : null,
    ...(v['deferredOnce'] === true ? { deferredOnce: true } : {}),
    ...chain,
  };
}

/** The first weekly fee date on or after `earliest`: the next fee date, or a whole number of weeks after it. */
export function firstFeeOnOrAfter(nextBillingDate: Date, earliest: Date): Date {
  const next = nextBillingDate.getTime();
  if (next >= earliest.getTime()) return new Date(next);
  return new Date(next + Math.ceil((earliest.getTime() - next) / WEEK_MS) * WEEK_MS);
}

/** An hour on top of the 14 days: the notice is dated when it is sent, and the
 *  inbox row lands a moment later (or on a database clock a little ahead). */
export const FEE_RISE_NOTICE_MARGIN_MS = 3_600_000;

/** The first weekly fee a rise told at `noticeAt` may apply to: never sooner than 14 days after it, and
 *  [ENTERPRISE E2] never before `notBefore` (a chain deal's end date). */
export function riseAppliesFrom(nextBillingDate: Date, noticeAt: Date, notBefore?: Date | null): Date {
  const notice = noticeAt.getTime() + FEE_RISE_NOTICE_DAYS * DAY_MS + FEE_RISE_NOTICE_MARGIN_MS;
  return firstFeeOnOrAfter(nextBillingDate, new Date(Math.max(notice, notBefore ? notBefore.getTime() : notice)));
}

/** "Thursday 5 November", the day in Guyana. */
export function feeRiseDay(at: Date): string {
  return formatGuyanaTime(at, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The dedupe key of the one notice a held rise sends: a retry finds the first inbox row. */
export const feeRiseDedupeKey = (subscriptionId: string, rise: Pick<HeldFeeRise, 'heldAt' | 'from' | 'to'>) =>
  `fee-rise:${subscriptionId}:${rise.heldAt}:${rise.from}->${rise.to}`;

/** [ENTERPRISE E2 · REVIEW-F #2227 S3-1] The words of a chain-deal rise. The owner gets one notice per branch (each
 *  branch has its own fee and its own "say no"), so each notice names its branch first: what happens to the deal,
 *  the branch's old fee, its new fee, the first weekly fee it applies to, and how to say no for THAT branch. */
export function chainDealRiseCopy(p: { branch: string; from: number; to: number; currencyCode: string; date: Date | null; dealTo: number | null }): { title: string; body: string } {
  const money = (n: number) => formatMoney(n, p.currencyCode, { whole: true });
  const deal = p.dealTo === null ? 'your Swift chain deal is ending.' : `your Swift chain deal is changing to ${money(p.dealTo)} a week.`;
  const when = p.date ? `From ${p.branch}'s weekly fee due ${feeRiseDay(p.date)}` : `From ${p.branch}'s first weekly fee due at least ${FEE_RISE_NOTICE_DAYS} days from today`;
  return {
    title: `${p.branch}: your weekly fee is changing`,
    body: `${p.branch}: ${deal} ${when}, its Swift weekly fee will be ${money(p.to)} (it is ${money(p.from)} now). `
      + 'Until then nothing changes, and any week already paid keeps the price paid. '
      + `If you do not want the new fee for ${p.branch}, tap Stop weekly billing on ${p.branch}'s weekly-fee screen in Swift before then and you will not pay it.`,
  };
}

/** [ENTERPRISE E2 · REVIEW-F #2227 S3-1] A chain-deal change that will not happen, for one named branch. */
export function chainDealCancelledCopy(p: { branch: string; from: number; to: number; currencyCode: string; date: Date | null }): { title: string; body: string } {
  const money = (n: number) => formatMoney(n, p.currencyCode, { whole: true });
  return {
    title: `${p.branch}: your weekly fee is not changing`,
    body: `${p.branch}: the change to ${money(p.to)} we told you about${p.date ? ` for its weekly fee due ${feeRiseDay(p.date)}` : ''} will not happen: its Swift weekly fee stays ${money(p.from)}.`,
  };
}

/**
 * [ENTERPRISE E2] Record a chain-deal change that RAISES one branch's weekly fee as held, never written: the deal it
 * is on (`customFrom`, its customRate now) moves to `customTo` (null: the deal ends) from the branch's first weekly
 * fee on or after `notBefore` and 14 days after the branch is told (the hourly billing run tells and applies it,
 * exactly as any held rise). `from` and `to` are what the branch is CHARGED now and then (the lower of a deal and its
 * own tier fee). The same change again is left as it is; a different one replaces it. Called under the owner's
 * billing locks (chain-deal.ts).
 */
export async function holdChainDealRiseInTx(
  tx: Prisma.TransactionClient,
  p: { subscriptionId: string; from: number; to: number; customFrom: number; customTo: number | null; notBefore: Date; currencyCode: string; sourceRef?: string | null; now: Date },
): Promise<'held' | 'unchanged' | 'not-a-rise'> {
  if (!(p.from > 0) || !(p.to > p.from) || !(p.customFrom > 0) || (p.customTo !== null && !(p.customTo > p.customFrom))) return 'not-a-rise';
  const sub = await tx.subscription.findUnique({ where: { id: p.subscriptionId }, select: { customRate: true, feeWaived: true } });
  if (!sub || sub.feeWaived || sub.customRate === null || Number(sub.customRate) !== p.customFrom) return 'not-a-rise';
  const key = feeRiseKey(p.subscriptionId);
  const row = await tx.platformConfig.findUnique({ where: { key } });
  const held = row ? readHeldFeeRise(row.value) : null;
  if (held && held.source === 'CHAIN_DEAL' && held.from === p.from && held.to === p.to && held.customFrom === p.customFrom
    && held.customTo === p.customTo && held.notBefore === p.notBefore.toISOString()) return 'unchanged';
  const value: HeldFeeRise = {
    from: p.from, to: p.to, currencyCode: p.currencyCode, source: 'CHAIN_DEAL', heldAt: p.now.toISOString(),
    noticeAt: null, appliesFrom: null, inboxId: null, customFrom: p.customFrom, customTo: p.customTo, notBefore: p.notBefore.toISOString(),
  };
  const json = value as unknown as Prisma.InputJsonValue;
  await tx.platformConfig.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
  await tx.auditLog.create({ data: {
    action: 'BILLING_FEE_RISE_HELD', entity: 'Subscription', entityId: p.subscriptionId,
    changes: {
      from: p.from, to: p.to, currencyCode: p.currencyCode, source: 'CHAIN_DEAL', sourceRef: p.sourceRef ?? null,
      customFrom: p.customFrom, customTo: p.customTo, notBefore: p.notBefore.toISOString(), noticeDays: FEE_RISE_NOTICE_DAYS,
      replaces: held ? { source: held.source, from: held.from, to: held.to, noticeAt: held.noticeAt, appliesFrom: held.appliesFrom } : null,
    },
  } });
  return 'held';
}

/**
 * Record a HIGHER weekly fee as held, never written: the hourly billing run
 * tells the payer and moves it in once its told date comes. Called in the
 * caller's transaction, under the payer's lock, by a path that kept the old
 * rate because the new one is higher. The same rise again is left as it is
 * (told or not); a different one replaces it (and is told again, its date
 * counted from the new notice). A negotiated or waived fee is not driven by
 * the rate, so nothing is held for it.
 */
export async function holdFeeRiseInTx(
  tx: Prisma.TransactionClient,
  p: { subscriptionId: string; from: number; to: number; currencyCode: string; source: FeeRiseSource; sourceRef?: string | null; now: Date },
): Promise<'held' | 'unchanged' | 'not-a-rise'> {
  if (!(p.from > 0) || !(p.to > p.from)) return 'not-a-rise';
  const sub = await tx.subscription.findUnique({ where: { id: p.subscriptionId }, select: { customRate: true, feeWaived: true, weeklyRate: true } });
  if (!sub || sub.customRate !== null || sub.feeWaived || Number(sub.weeklyRate) !== p.from) return 'not-a-rise';
  const key = feeRiseKey(p.subscriptionId);
  const row = await tx.platformConfig.findUnique({ where: { key } });
  const held = row ? readHeldFeeRise(row.value) : null;
  if (held && held.from === p.from && held.to === p.to) return 'unchanged';
  const value: HeldFeeRise = {
    from: p.from, to: p.to, currencyCode: p.currencyCode, source: p.source, heldAt: p.now.toISOString(),
    noticeAt: null, appliesFrom: null, inboxId: null,
  };
  const json = value as unknown as Prisma.InputJsonValue;
  await tx.platformConfig.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
  await tx.auditLog.create({ data: {
    action: 'BILLING_FEE_RISE_HELD', entity: 'Subscription', entityId: p.subscriptionId,
    changes: {
      from: p.from, to: p.to, currencyCode: p.currencyCode, source: p.source, sourceRef: p.sourceRef ?? null,
      noticeDays: FEE_RISE_NOTICE_DAYS,
      replaces: held ? { from: held.from, to: held.to, noticeAt: held.noticeAt, appliesFrom: held.appliesFrom } : null,
    },
  } });
  return 'held';
}
