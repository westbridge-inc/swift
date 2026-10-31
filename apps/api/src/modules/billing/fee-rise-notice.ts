import type { Prisma, VehicleType } from '@prisma/client';
import { VEHICLE_CLASSES } from '../../config/vehicle-classes';
import { formatMoney } from '../../utils/currency-amount';
import { endOfGuyanaDay, formatGuyanaTime, guyanaDayKey } from '../../utils/guyana-day';

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

/** [RETIER PR-B · owner 30 Oct 2026] WHY a weekly re-tier rise: the catalogue a store reached (the listings counted,
 *  the step and the item count that step starts at), or the vehicle a mover drives on Swift. Told in the notice, with
 *  how to bring the fee back down. */
export type RetierBasis =
  | { kind: 'CATALOGUE'; items: number; tier: string; stepFrom: number }
  | { kind: 'VEHICLE'; vehicleType: string; tier: string };

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
  /** [RETIER PR-B] WEEKLY_RETIER only: why the card gives the higher fee (told in the notice). */
  basis?: RetierBasis;
}

/** A stored basis, or undefined for anything that is not one. */
function readRetierBasis(value: unknown): RetierBasis | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v['tier'] !== 'string') return undefined;
  if (v['kind'] === 'CATALOGUE' && Number.isInteger(v['items']) && (v['items'] as number) >= 0 && Number.isInteger(v['stepFrom']) && (v['stepFrom'] as number) > 0) {
    return { kind: 'CATALOGUE', items: v['items'] as number, tier: v['tier'], stepFrom: v['stepFrom'] as number };
  }
  if (v['kind'] === 'VEHICLE' && typeof v['vehicleType'] === 'string') return { kind: 'VEHICLE', vehicleType: v['vehicleType'], tier: v['tier'] };
  return undefined;
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
  // [RETIER PR-B] A re-tier rise may carry its basis (the words of its notice); any other rise carries none, and a
  // basis that cannot be read is not one.
  let basis: Pick<HeldFeeRise, 'basis'> = {};
  if (v['basis'] !== undefined && v['basis'] !== null) {
    const read = v['source'] === 'WEEKLY_RETIER' ? readRetierBasis(v['basis']) : undefined;
    if (!read) return null;
    basis = { basis: read };
  }
  return {
    from, to, currencyCode: v['currencyCode'], source: v['source'] as FeeRiseSource, heldAt: v['heldAt'], noticeAt, appliesFrom,
    inboxId: typeof v['inboxId'] === 'string' ? v['inboxId'] : null,
    ...(v['deferredOnce'] === true ? { deferredOnce: true } : {}),
    ...chain,
    ...basis,
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

/** [RETIER PR-B · REVIEW-F/M #2259 S3-1] A store's weekly re-tier rise (CATALOGUE) told for the weekly fee due
 *  `appliesFrom`: the last day the store may bring its count back under the step is the day (in Guyana) a week before
 *  it, as its notice says. The count keeps items taken off sale, changed or removed in the last 7 days, so a cut made
 *  later would still count when the rise moves in. */
export function retierLastCutDay(appliesFrom: Date): Date {
  return new Date(appliesFrom.getTime() - 7 * DAY_MS);
}

/** ... and the rise moves in no sooner than the first moment after that day ends (Guyana): the paid-week and hourly
 *  passes count the store then, so a store under the step by the end of that day, and still under, is never moved. */
export function retierMovesInFrom(appliesFrom: Date): Date {
  return new Date(endOfGuyanaDay(guyanaDayKey(retierLastCutDay(appliesFrom))).getTime() + 1);
}

/** "Thursday 5 November", the day in Guyana. */
export function feeRiseDay(at: Date): string {
  return formatGuyanaTime(at, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The dedupe key of the one notice a held rise sends: a retry finds the first inbox row. */
export const feeRiseDedupeKey = (subscriptionId: string, rise: Pick<HeldFeeRise, 'heldAt' | 'from' | 'to'>) =>
  `fee-rise:${subscriptionId}:${rise.heldAt}:${rise.from}->${rise.to}`;

/** [R27] The words of a LOWER weekly fee: it applies from the next weekly fee; one already charged keeps its amount. */
export function feeDecreaseCopy(p: { from: number; to: number; currencyCode: string }): { title: string; body: string } {
  const money = (n: number) => formatMoney(n, p.currencyCode, { whole: true });
  return {
    title: 'Your weekly fee is going down',
    body: `From your next weekly fee, your Swift weekly fee will be ${money(p.to)} (it is ${money(p.from)} now). A weekly fee already charged keeps its amount.`,
  };
}

/** A tier in the partner's words. */
const TIER_WORDS: Record<string, string> = {
  small: 'business', large: 'large catalogue', department: 'department store', service: 'service business',
  courier: 'delivery and courier', courierHeavy: 'heavy delivery', taxi: 'taxi',
};

/** [RETIER PR-B · REVIEW-F/M #2259 S3-1] How a store's items are counted, in the partner's words: the same phrase as
 *  partner/store-fee.ts CATALOGUE_COUNT_WORDS (a test pins them equal; this file stays free of the partner module). */
const CATALOGUE_COUNT_PHRASE = 'taken off sale, changed or removed in the last 7 days';

/**
 * [RETIER PR-B · owner 30 Oct 2026 · F2] The words of a weekly re-tier rise: WHY (the catalogue or vehicle that
 * reached a higher step), the new fee and from which weekly fee, that nothing changes until then, how to bring it
 * back down, and how to say no. True with the re-tier's own rules [REVIEW-F/M #2259 S3-1]: Swift counts a store's
 * items each week (every listing for sale, and every one taken off sale, changed or removed in the last 7 days); a
 * store whose count is under the step by the end of the told last day (retierLastCutDay) and stays under is never
 * moved (the rise moves in no sooner: retierMovesInFrom) and is told so. A mover's lower vehicle moves the fee only
 * once seen on two weekly counts a week apart (billing.service retierInTx). [REVIEW-G #2259 S4-2] A store's notice
 * names the store (an owner may have several), in the words of a chain branch's notice.
 */
export function retierRiseCopy(p: { from: number; to: number; currencyCode: string; date: Date | null; basis: RetierBasis; store?: string | null }): { title: string; body: string } {
  const money = (n: number) => formatMoney(n, p.currencyCode, { whole: true });
  const tier = TIER_WORDS[p.basis.tier] ?? p.basis.tier;
  const store = p.store?.trim() || null;
  const its = store ? 'its' : 'your';
  const why = p.basis.kind === 'CATALOGUE'
    ? `${store ?? 'Your store'} now has ${p.basis.items.toLocaleString('en-US')} items for sale, which is the ${tier} rate.`
    : `Your vehicle on Swift is now a ${VEHICLE_CLASSES[p.basis.vehicleType as VehicleType]?.label ?? p.basis.vehicleType}, which is the ${tier} rate.`;
  const when = p.date ? `From ${its} weekly fee due ${feeRiseDay(p.date)}` : `From ${its} first weekly fee due at least ${FEE_RISE_NOTICE_DAYS} days from today`;
  const cut = p.date ? `by the end of ${feeRiseDay(retierLastCutDay(p.date))}` : 'a full week before the new fee starts';
  const down = p.basis.kind === 'CATALOGUE'
    ? `Swift counts the items in ${store ?? 'your store'} every week: items for sale, and items ${CATALOGUE_COUNT_PHRASE}. `
      + `If that count is under ${p.basis.stepFrom.toLocaleString('en-US')} ${cut} and stays under, this change will not happen, and we will tell you.`
    : 'Your fee follows the vehicle you drive on Swift: if you change back to a smaller vehicle, your fee goes back down after Swift has seen the smaller vehicle on two weekly counts, a week apart, and we will tell you.';
  const no = store
    ? `If you do not want the new fee for ${store}, tap Stop weekly billing on ${store}'s weekly-fee screen in Swift before then and you will not pay it.`
    : 'If you do not want the new fee, tap Stop weekly billing in Swift before then and you will not pay it.';
  return {
    title: store ? `${store}: your weekly fee is changing` : 'Your weekly fee is changing',
    body: `${why} ${when}, ${its} Swift weekly fee will be ${money(p.to)} (it is ${money(p.from)} now). `
      + (store ? 'Until then nothing changes, and any week already paid keeps the price paid. ' : 'Until then nothing changes, and any week you have already paid keeps the price you paid. ')
      + `${down} ${no}`,
  };
}

/** The words of each notice: the old fee, the new fee and the date, plainly, as the Agreements promise. */
export function feeRiseCopy(kind: 'RISE' | 'CANCELLED', p: { from: number; to: number; currencyCode: string; date: Date | null }): { title: string; body: string } {
  const money = (n: number) => formatMoney(n, p.currencyCode, { whole: true });
  if (kind === 'RISE') {
    return {
      title: 'Your weekly fee is changing',
      // [REVIEW-F #1884 S4-1/S4-2] Name the phone's own control, and a dateless notice (never sent:
      // the run always dates it) still promises only what F2 does.
      body: `From your ${p.date ? `weekly fee due ${feeRiseDay(p.date)}` : `first weekly fee due at least ${FEE_RISE_NOTICE_DAYS} days from today`}, your Swift weekly fee will be ${money(p.to)} (it is ${money(p.from)} now). `
        + 'Until then nothing changes, and any week you have already paid keeps the price you paid. '
        + 'If you do not want the new fee, tap Stop weekly billing in Swift before then and you will not pay it.',
    };
  }
  return {
    title: 'Your weekly fee is not changing',
    body: `The change to ${money(p.to)} we told you about${p.date ? ` for your weekly fee due ${feeRiseDay(p.date)}` : ''} will not happen: your Swift weekly fee stays ${money(p.from)}.`,
  };
}

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
  // [REVIEW-G #2227 N2] A rise of another source held for this branch is never replaced here (it would lose its notice).
  if (held && held.source !== 'CHAIN_DEAL') return 'not-a-rise';
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
  p: { subscriptionId: string; from: number; to: number; currencyCode: string; source: FeeRiseSource; sourceRef?: string | null; now: Date; basis?: RetierBasis },
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
    // [RETIER PR-B] Only a re-tier rise carries its basis (the reader refuses one on any other source).
    ...(p.source === 'WEEKLY_RETIER' && p.basis ? { basis: p.basis } : {}),
  };
  const json = value as unknown as Prisma.InputJsonValue;
  await tx.platformConfig.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
  await tx.auditLog.create({ data: {
    action: 'BILLING_FEE_RISE_HELD', entity: 'Subscription', entityId: p.subscriptionId,
    changes: {
      from: p.from, to: p.to, currencyCode: p.currencyCode, source: p.source, sourceRef: p.sourceRef ?? null,
      noticeDays: FEE_RISE_NOTICE_DAYS, ...(value.basis ? { basis: value.basis } : {}),
      replaces: held ? { from: held.from, to: held.to, noticeAt: held.noticeAt, appliesFrom: held.appliesFrom } : null,
    },
  } });
  return 'held';
}
