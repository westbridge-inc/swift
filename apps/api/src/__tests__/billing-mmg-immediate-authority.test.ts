import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { billingMemoryTable, cloneBillingValue, matchesBillingRow } from './helpers/billing-memory-tables';
import { BILLING_CUTOVER_KEY, BILLING_CUTOVER_VERSION } from '../modules/billing/billing-cutover';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const ledger = vi.hoisted(() => ({ keys: [] as string[], postings: [] as any[] }));
vi.mock('../modules/billing/ledger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modules/billing/ledger')>(),
  postLedger: vi.fn(async (_tx: unknown, input: { idempotencyKey: string; entries: unknown[] }) => {
    ledger.keys.push(input.idempotencyKey);
    ledger.postings.push(input.entries);
  }),
}));
vi.mock('../modules/billing/receipts', () => ({ issueReceipt: vi.fn(async () => ({ id: 'receipt-1' })) }));

import { BillingService } from '../modules/billing/billing.service';
import { LiveMmgProvider, SandboxMmgProvider, type LiveMmgConfig } from '../providers/mmg/mmg-provider';
import { issueReceipt } from '../modules/billing/receipts';
import { deliverBillingNotice } from '../modules/billing/billing-notice-delivery';
import { NotificationService } from '../modules/notification/notification.service';
import { resolveConfirmationInTx } from '../modules/billing/dunning-clock';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const due = new Date('2026-09-20T12:00:00.000Z');

type Authority = 'CANCELLED' | 'PAUSED' | 'CHURNED' | 'DEACTIVATED' | 'BANNED_TOMBSTONE';
type ProviderEntry = 'initiate' | 'prior_lookup';
interface PaymentState {
  id: string;
  subscriptionId: string;
  amount: number;
  status: string;
  paymentMethod: string;
  externalRef: string | null;
  clientKey: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  expiresAt: Date;
  lastPolledAt: Date | null;
  pollBackoffSec: number;
  failureCode: string | null;
  failureRaw: unknown;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(entry: ProviderEntry = 'initiate', vendor = false) {
  const periodKey = due.toISOString().slice(0, 10);
  const reference = `sub:sub-1:${periodKey}:a0`;
  const state = {
    user: { id: 'user-1', status: 'ACTIVE', phone: '+5926000001', tenantId: 'swift-default', countryCode: 'GY', roles: ['MOVER'] },
    vendor: { id: 'vendor-1', status: 'ACTIVE', acceptingOrders: true, isVerified: true, suspensionSource: null as string | null },
    sub: {
      id: 'sub-1', riderId: vendor ? null : 'rider-1', driverId: null, vendorId: vendor ? 'vendor-1' : null,
      type: vendor ? 'RESTAURANT' : 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 2100, customRate: null,
      feeWaived: false, currencyCode: 'GYD', billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: '5926000001', paymentToken: null, autoRenew: true,
      autoSuspendEnabled: true, failedAttempts: 0, nextRetryAt: null,
      currentPeriodStart: new Date(due.getTime() - WEEK), currentPeriodEnd: due,
      nextBillingDate: due, lastPaymentDate: null, isInGracePeriod: false,
      gracePeriodEnd: null, suspendedAt: null, billingConfirmationPausedAt: null, billingEnforcementDueAt: null,
      createdAt: new Date(due.getTime() - WEEK), updatedAt: due,
      rider: vendor ? null : { userId: 'user-1' }, driver: null,
      vendor: vendor ? { id: 'vendor-1', owner: { userId: 'user-1' } } : null,
    },
    payment: entry === 'prior_lookup' ? {
      id: 'payment-1', subscriptionId: 'sub-1', amount: 2100, status: 'PENDING',
      paymentMethod: 'MOBILE_MONEY', externalRef: 'mmgtx-prior', clientKey: reference,
      periodStart: due, periodEnd: new Date(due.getTime() + WEEK), createdAt: due,
      expiresAt: new Date(Date.now() + 86_400_000), lastPolledAt: null, pollBackoffSec: 30,
      failureCode: null, failureRaw: null,
    } as PaymentState : null as PaymentState | null,
    wallet: 0,
    walletCurrency: 'GYD',
    walletExists: false,
    events: new Map<string, Record<string, any>>(),
    notifications: [] as string[],
    notificationPayloads: [] as any[],
    notificationKeys: new Map<string, string>(),
    rawOpenCount: 1,
    rawQueries: [] as string[],
    // [MMG checkout F2] The push rail claims the one provider identity inside
    // its settlement: a minimal provider_payments table (mint, lock, CAS).
    providerIdentities: new Map<string, { id: string; tenantId: string; status: string; amount: number; currencyCode: string; creditedPaymentId: string | null }>(),
    // Independent synthetic database clock for lease/race schedules. Existing
    // fixed-time tests align it with their drain time; hostile cases override it.
    noticeClock: null as null | (() => Date),
    tables: Object.fromEntries(['clock', 'transition', 'hold', 'feeNotice', 'handoff', 'authority', 'member', 'audit', 'notification', 'deviceToken']
      .map((name) => [name, []])) as Record<string, Record<string, any>[]>,
  };
  const barriers = {
    beforeCommit: undefined as (() => Promise<void>) | undefined,
    afterCommit: undefined as (() => Promise<void>) | undefined,
  };
  let inTransaction = false;
  let noticeSelectionTime = due;
  const noticeNow = () => state.noticeClock?.() ?? noticeSelectionTime;
  const accessWrites: boolean[] = [];
  // These provider-fixture identifiers are ASCII. SQL canonicalization and
  // historical Unicode alias retention are exercised against PostgreSQL.
  const providerKey = (value: unknown) => {
    if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) throw new Error('Non-ASCII provider identity needs the PostgreSQL harness');
    return value.trim().toUpperCase();
  };
  const memory = (name: string, defaults?: () => Record<string, any>) => billingMemoryTable(() => state.tables[name]!, name, defaults);
  const subscriptionRow = () => ({ ...state.sub, weeklyRate: new Prisma.Decimal(state.sub.weeklyRate),
    rider: state.sub.rider ? { ...state.sub.rider, user: { ...state.user } } : null,
    vendor: state.sub.vendor ? { ...state.sub.vendor, tenantId: state.user.tenantId,
      owner: { ...state.sub.vendor.owner, user: { ...state.user } } } : null,
  });
  const authority = memory('authority');
  const authorityRead = authority.findUnique;
  authority.findUnique = vi.fn(async (args: any) => {
    const row = await authorityRead(args);
    return row ? { ...row, members: cloneBillingValue(state.tables['member']!.filter((m) => m['userId'] === row['userId'])),
      decision: cloneBillingValue(state.tables['audit']!.find((a) => a['id'] === row['decisionId'])) } : null;
  });
  authority.findUniqueOrThrow = vi.fn(async (args: any) => {
    const row = await authority.findUnique(args); if (!row) throw new Error('authority missing'); return row;
  });

  // PostgreSQL stores an absent card instrument as NULL. Keep that column in
  // the fixture so the production legacy-card selector traverses these rows.
  const paymentRow = () => state.payment ? { instrumentId: null, ...state.payment } : null;
  const matchesStatus = (where: any) => {
    if (!state.payment) return false;
    if (where?.id?.not === state.payment.id) return false;
    if (!matchesBillingRow(paymentRow()!, where)) return false;
    if (where?.failureRaw?.path) {
      const value = where.failureRaw.path.reduce((raw: any, key: string) => raw?.[key], state.payment.failureRaw);
      if (value !== where.failureRaw.equals) return false;
    }
    if (where?.OR && !where.OR.some(matchesStatus)) return false;
    const wanted = where?.status;
    if (!wanted) return true;
    if (typeof wanted === 'string') return state.payment.status === wanted;
    if (wanted.in) return wanted.in.includes(state.payment.status);
    return true;
  };
  const payments = {
    create: vi.fn(async ({ data }: any) => {
      state.payment = {
        ...data, id: 'payment-1', externalRef: data.externalRef ?? null,
        createdAt: new Date(), lastPolledAt: null,
        pollBackoffSec: 30, failureCode: null, failureRaw: data.failureRaw ?? null,
      } as PaymentState;
      return { id: 'payment-1' };
    }),
    findMany: vi.fn(async ({ where }: any) => {
      return state.payment && matchesBillingRow(paymentRow()!, where) ? [cloneBillingValue(paymentRow()!)] : [];
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (!state.payment) return null;
      if (where.id && where.id !== state.payment.id) return null;
      if (where.clientKey && where.clientKey !== state.payment.clientKey) return null;
      return { ...state.payment };
    }),
    findFirst: vi.fn(async ({ where }: any) => matchesStatus(where) ? { ...state.payment } : null),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      if (!state.payment || !matchesBillingRow(state.payment, where)) throw new Error('payment missing');
      return cloneBillingValue(state.payment);
    }),
    count: vi.fn(async ({ where }: any) => matchesStatus(where) ? 1 : 0),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!state.payment || (where.id && where.id !== state.payment.id) || !matchesStatus(where)) return { count: 0 };
      if (where.subscriptionId && where.subscriptionId !== state.payment.subscriptionId) return { count: 0 };
      if (where.paymentMethod && where.paymentMethod !== state.payment.paymentMethod) return { count: 0 };
      if (where.externalRef === null && state.payment.externalRef !== null) return { count: 0 };
      if (typeof where.externalRef === 'string' && where.externalRef !== state.payment.externalRef) return { count: 0 };
      if (where.clientKey && where.clientKey !== state.payment.clientKey) return { count: 0 };
      Object.assign(state.payment, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      if (!state.payment || where.id !== state.payment.id) throw new Error('payment missing');
      Object.assign(state.payment, data);
      return { ...state.payment };
    }),
  };
  const billingEvent = {
    create: vi.fn(async ({ data }: any) => {
      if (state.events.has(data.idempotencyKey)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      const row = { ...data, id: `event-${state.events.size + 1}`, createdAt: new Date(),
        deliveredAt: null, noticeLeaseUntil: null, noticeLeaseToken: null, noticeSmsSentAt: null };
      state.events.set(data.idempotencyKey, row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => where.idempotencyKey
      ? state.events.get(where.idempotencyKey) ?? null
      : [...state.events.values()].find(event => event['id'] === where.id) ?? null),
    findFirst: vi.fn(async ({ where }: any) => [...state.events.entries()].find(([key, event]) =>
      matchesBillingRow({ ...event, idempotencyKey: key }, where))?.[1] ?? null),
    findMany: vi.fn(async ({ where = {} }: any = {}) => [...state.events.entries()]
      .map(([key, event]) => ({ ...event, idempotencyKey: key }))
      .filter((event) => matchesBillingRow(event, where))),
  };
  const tx: any = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join(' ');
      state.rawQueries.push(sql);
      if (sql.includes('UPDATE "billing_events"') && sql.includes('noticeLeaseToken')) {
        const databaseClock = sql.includes('clock_timestamp()');
        const clock = databaseClock ? noticeNow() : values[3];
        const event = [...state.events.values()].find(row => row['id'] === values[databaseClock ? 1 : 2]);
        if (!event || event['deliveredAt'] || (event['noticeLeaseUntil'] && event['noticeLeaseUntil'] > clock)) return [];
        event['noticeLeaseToken'] = values[0];
        event['noticeLeaseUntil'] = databaseClock ? new Date(+clock + 120_000) : values[1];
        return [{ id: event['id'], noticeSmsSentAt: event['noticeSmsSentAt'] }];
      }
      if (sql.includes('FROM "billing_events"') && sql.includes('noticeVersion')) {
        noticeSelectionTime = values[0];
        return [...state.events.values()].filter(row => !row['deliveredAt'] &&
          (!row['noticeLeaseUntil'] || row['noticeLeaseUntil'] <= values[0]) &&
          typeof row['note'] === 'string' && row['note'].startsWith('{"noticeVersion":1,'))
          .sort((a, b) => {
            const at = (a['noticeLeaseUntil'] ?? a['createdAt']).getTime();
            const bt = (b['noticeLeaseUntil'] ?? b['createdAt']).getTime();
            return at - bt || String(a['id']).localeCompare(String(b['id']));
          }).slice(0, 200);
      }
      if (sql.includes('pg_backend_pid()')) return [{ pid: 41 }];
      if (sql.includes('set_config(')) return [];
      if (sql.includes('FROM "billing_dunning_clocks"')) return cloneBillingValue(state.tables['clock']);
      if (sql.includes('JOIN "users" u')) return [{ tenantId: state.user.tenantId }];
      if (sql.includes('LEFT JOIN "riders"')) return [{ id: state.sub.id }];
      // [MMG checkout F2 · F7] The payer's tenant, and the provider identity row lock.
      if (sql.includes('SELECT mmg_txn_canon(')) return [{ key: providerKey(values[0]) }];
      if (sql.includes('FROM provider_payment_aliases')) return [];
      if (sql.includes('FROM mmg_agent_payments ap')) return state.payment?.status === 'CAPTURED'
        && state.payment.externalRef && providerKey(state.payment.externalRef) === providerKey(values[1])
        ? [{ claimant: `push:${state.payment.id}` }] : [];
      if (sql.includes('FROM provider_payments p')) {
        const identity = state.providerIdentities.get(providerKey(values[0]));
        return identity ? [{ ...identity, canonicalMatches: true }] : [];
      }
      if (sql.includes('FROM "provider_payments"')) {
        const identity = state.providerIdentities.get(values[1]);
        return identity ? [{ ...identity }] : [];
      }
      if (sql.includes('FROM "users"')) return [{ ...state.user }];
      if (sql.includes('FROM "subscriptions"')) return [{ status: state.sub.status, autoRenew: state.sub.autoRenew }];
      if (sql.includes('FROM "subscription_payments"')) {
        const payment = state.payment;
        return payment && ['FAILED', 'EXPIRED'].includes(payment.status)
          && (payment.failureRaw as any)?.subscriptionOutcome !== 'PRESERVED_NO_DUNNING'
          ? [{ ...payment, openCount: state.rawOpenCount }] : [];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join(' ');
      if (sql.includes('set_config(')) return 0;
      // [MMG checkout F2] Mint (ON CONFLICT DO NOTHING) and compare-and-set the provider identity.
      if (sql.includes('INSERT INTO "provider_payments"') || sql.includes('INSERT INTO provider_payments')) {
        const [tenantId, , raw, amount, currencyCode] = values;
        const key = providerKey(raw);
        if (!state.providerIdentities.has(key)) {
          state.providerIdentities.set(key, { id: `pp-${state.providerIdentities.size + 1}`, tenantId, status: 'OPEN', amount: Number(amount), currencyCode, creditedPaymentId: null });
        }
        return 1;
      }
      if (sql.includes('UPDATE "provider_payments"')) {
        const [creditedBy, , id, tenantId] = values;
        const identity = [...state.providerIdentities.values()].find((row) => row.id === id);
        if (!identity || identity.status !== 'OPEN' || identity.tenantId !== tenantId) return 0;
        Object.assign(identity, { status: 'CREDITED', creditedPaymentId: creditedBy });
        return 1;
      }
      if (!sql.includes('UPDATE "billing_events"')) throw new Error(`unexpected raw execute: ${sql}`);
      const smsStamp = sql.includes('SET "noticeSmsSentAt"');
      const finish = sql.includes('SET "deliveredAt"');
      const databaseClock = sql.includes('clock_timestamp()');
      const event = [...state.events.values()].find(row => row['id'] === values[databaseClock ? 0 : 1]);
      if (!event || event['noticeLeaseToken'] !== values[databaseClock ? 1 : 2]) return 0;
      // The hand-off UPDATE's own predicate: only an unexpired claim completes.
      if (finish && sql.includes('"noticeLeaseUntil" > clock_timestamp()') && !(event['noticeLeaseUntil'] > noticeNow())) return 0;
      if (sql.includes('SET "noticeLeaseUntil"')) {
        if (event['deliveredAt'] || event['noticeLeaseUntil'] <= noticeNow()) return 0;
        event['noticeLeaseUntil'] = new Date(+noticeNow() + 120_000);
        return 1;
      }
      const clock = databaseClock ? noticeNow() : values[0];
      if (smsStamp) event['noticeSmsSentAt'] = event['noticeSmsSentAt'] ?? clock;
      else if (finish) event['deliveredAt'] = clock;
      if (!smsStamp) {
        event['noticeLeaseToken'] = null;
        event['noticeLeaseUntil'] = finish ? null : databaseClock ? new Date(+clock + 60_000) : values[0];
      }
      return 1;
    }),
    subscriptionPayment: payments,
    // [MMG checkout I5] the approval-hold gate also reads checkouts in flight; none here.
    mmgCheckoutIntent: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    cardSession: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ ...state.user })), findUniqueOrThrow: vi.fn(async () => ({ ...state.user })), findMany: vi.fn(async () => []) },
    moverFeeAuthority: authority,
    moverFeeSubscription: memory('member'),
    auditLog: memory('audit'),
    billingDunningClock: memory('clock', () => ({ moverPayerUserId: null, epoch: 1, version: 0, elapsedMs: 0n, runningSince: null,
      pausedAt: null, resumedAt: null, authorityHoldReason: null, authorityRevision: null, retryAtMs: null, nudgeAtMs: null, churnAtMs: null })),
    paymentConfirmationHold: memory('hold', () => ({ paymentId: null, checkoutId: null, cardSessionId: null, status: 'ACTIVE',
      resolvedAt: null, resolvedBy: null, resolutionEvidence: null, resolutionHistory: [], reviewNotifiedAt: null })),
    billingObligationTransition: memory('transition'),
    billingFeeNotice: memory('feeNotice', () => ({ status: 'PENDING' })),
    billingNoticeHandoff: memory('handoff', () => ({ status: 'NOT_SENT', completedAt: null })),
    // [#1393] The inbox and device rows the real NotificationService reads
    // when it delivers a fee demand from the outbox (see `outbox` below).
    notification: memory('notification', () => ({ isRead: false, readAt: null })),
    deviceToken: memory('deviceToken', () => ({ isActive: true })),
    platformConfig: { findUnique: vi.fn(async ({ where }: any) => where.key === BILLING_CUTOVER_KEY ? { value: {
      version: BILLING_CUTOVER_VERSION, state: 'READY', completedAt: due.toISOString(), coverageDigest: 'synthetic-completed-backfill' } } : null) },
    billingEvent,
    subscription: {
      update: vi.fn(async ({ data }: any) => { Object.assign(state.sub, data); return { ...state.sub }; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.status && where.status !== state.sub.status) return { count: 0 };
        Object.assign(state.sub, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => subscriptionRow()),
      findUniqueOrThrow: vi.fn(async () => subscriptionRow()),
      findMany: vi.fn(async ({ where }: any = {}) => matchesBillingRow(subscriptionRow(), where) ? [subscriptionRow()] : []),
    },
    prepaidBalance: {
      findUnique: vi.fn(async () => state.walletExists || state.wallet > 0
        ? { balance: state.wallet, currencyCode: state.walletCurrency } : null),
      findUniqueOrThrow: vi.fn(async () => {
        if (!state.walletExists && state.wallet === 0) throw new Error('wallet missing');
        return { balance: state.wallet, currencyCode: state.walletCurrency };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.currencyCode && where.currencyCode !== state.walletCurrency) return { count: 0 };
        if (data.balance?.increment) {
          state.wallet += Number(data.balance.increment);
          return { count: 1 };
        }
        const minimum = Number(where?.balance?.gte ?? 0);
        const decrement = Number(data?.balance?.decrement ?? 0);
        if (where?.subscriptionId !== state.sub.id || state.wallet < minimum || decrement <= 0) return { count: 0 };
        state.wallet -= decrement;
        return { count: 1 };
      }),
      upsert: vi.fn(async ({ update, create }: any) => {
        if (state.walletExists || state.wallet > 0) state.wallet += Number(update.balance?.increment ?? 0);
        else {
          state.wallet = Number(create.balance);
          state.walletCurrency = create.currencyCode;
        }
        state.walletExists = true;
        return { balance: state.wallet, currencyCode: state.walletCurrency };
      }),
    },
    ledgerAccount: { upsert: vi.fn(), findMany: vi.fn(async () => []) },
    ledgerTransaction: { create: vi.fn() },
    ledgerEntry: { createMany: vi.fn() },
    vendor: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        accessWrites.push(inTransaction);
        if (where.status && state.vendor.status !== where.status) return { count: 0 };
        if (where.isVerified && !state.vendor.isVerified) return { count: 0 };
        if (where.OR && !where.OR.some((clause: any) => clause.suspensionSource === state.vendor.suspensionSource)) return { count: 0 };
        Object.assign(state.vendor, data);
        return { count: 1 };
      }),
    },
    rider: { updateMany: vi.fn(async () => ({ count: 1 })) },
    driver: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    ...tx,
    alertDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: (inner: any) => Promise<any>) => {
      const snapshot = cloneBillingValue(state);
      const ledgerLength = ledger.keys.length;
      inTransaction = true;
      let result: any;
      try {
        result = await fn(tx);
        await barriers.beforeCommit?.();
      } catch (error) {
        Object.assign(state, snapshot);
        ledger.keys.length = ledgerLength;
        ledger.postings.length = ledgerLength;
        throw error;
      } finally { inTransaction = false; }
      await barriers.afterCommit?.();
      return result;
    }),
    tenantBillingCurrency: { findUnique: vi.fn(async () => null) },
  };
  const notifications = {
    // Money-path cases record their direct notices here. Payer billing
    // notices are fee demands: cases about them deliver through the real
    // NotificationService and the fee-demand outbox (`outbox` below).
    drainFeeDemands: vi.fn(async () => ({ attempted: 0, delivered: 0 })),
    deliverFeeDemand: vi.fn(async () => ''),
    send: vi.fn(async (input: any) => {
      const key = input.dedupeKey ? `${input.userId}:${input.dedupeKey}` : null;
      if (key && state.notificationKeys.has(key)) return state.notificationKeys.get(key)!;
      state.notifications.push(input.data?.kind ?? input.type);
      state.notificationPayloads.push(input);
      const id = `notice-${state.notifications.length}`;
      if (key) state.notificationKeys.set(key, id);
      return id;
    }),
  };
  const billing = new BillingService(prisma as PrismaClient, notifications as any, {} as any);
  return { billing, state, periodKey, reference, barriers, accessWrites, prisma, notifications };
}

// Sweep race hooks affect only the initial candidate query. Resolver source
// reads must still traverse the actual fixture rows, as they do in PostgreSQL.
function selectSuspended(h: ReturnType<typeof harness>, select: () => Promise<any[]>) {
  const read = h.prisma.subscription.findMany;
  h.prisma.subscription.findMany = vi.fn(async (args: any) => args?.where?.status === 'SUSPENDED' ? select() : read(args));
}

/** [#1393] Payer billing notices (suspended nudge, churn) are weekly-fee
 * demands. A committed notice intent is handed to the fee-demand outbox and
 * the real NotificationService delivers it over these fixture tables: the
 * inbox row, then socket, push and SMS handoffs (each reserved UNKNOWN before
 * its provider call and re-checked under the payer's locks). Fake providers
 * record every effect. Earlier this file drove the retired per-event SMS
 * lease; each of those cases now proves the outbox property it maps to
 * (evidence: CLAUDE-legacy-notice-mapping.md). */
const DEMAND_KINDS = ['billing_suspended_nudge', 'billing_churned'];
function outbox<H extends ReturnType<typeof harness>>(h: H) {
  // The shared clock and its first nudge are anchored when first read, at the
  // database (wall) time: the fixture's world runs at the sweep's own instant.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(due);
  h.state.tables['deviceToken']!.push({ id: 'device-1', userId: h.state.user.id, token: 'ExponentPushToken[fixture-payer]', platform: 'ios', isActive: true });
  const sent: Array<{ channel: 'push' | 'sms'; kind?: unknown; to: string; body: string }> = [];
  const sendPush = vi.fn(async (tokens: string[], _title: string, body: string, data?: Record<string, unknown>) => {
    sent.push({ channel: 'push', kind: data?.['kind'], to: tokens.join(','), body });
    return { sent: tokens.length };
  });
  const sendSms = vi.fn(async (to: string, body: string) => { sent.push({ channel: 'sms', to, body }); return { ref: 'sms-ref' }; });
  const channels = { push: { sendPush }, sms: { sendSms }, email: { sendEmail: vi.fn(async () => undefined) } };
  const io = { to: () => ({ emit: () => true }) };
  const notices = (override: Record<string, unknown> = {}) =>
    new NotificationService(h.prisma as PrismaClient, io as never, { ...channels, ...override } as never);
  const worker = () => new BillingService(h.prisma as PrismaClient, notices(), {} as any);
  return Object.assign(h, {
    billing: worker(), worker, notices, sent, sendPush, sendSms,
    inbox: () => h.state.tables['notification']!,
    stages: () => h.state.tables['feeNotice']!,
    handoff: (channel: string) => h.state.tables['handoff']!.find((row) => row['channel'] === channel),
  });
}
type Outbox = ReturnType<typeof outbox>;
const demandInbox = (h: Outbox) => h.inbox().filter((row) => DEMAND_KINDS.includes(row['data']?.kind));
const demandEffects = (h: Outbox) => h.sent.filter((effect) => effect.body.includes('At the time'));
const stageOf = (h: Outbox, eventId: unknown) => h.stages().find((row) => row['stageKey'] === `event:${String(eventId)}`);
const smsSent = (h: Outbox) => h.sent.filter((effect) => effect.channel === 'sms');

/** PostgreSQL serializes these billing transactions on the payer's row locks.
 * The in-memory tables model that with one transaction at a time: a rival
 * started inside a transaction waits for it, exactly as it would on the lock. */
function serializeTransactions(h: ReturnType<typeof harness>) {
  const run = h.prisma.$transaction.getMockImplementation()!;
  let tail: Promise<unknown> = Promise.resolve();
  h.prisma.$transaction.mockImplementation((fn: any) => {
    const result = tail.then(() => run(fn));
    tail = result.catch(() => undefined);
    return result;
  });
}

/** A payment for this payer starts confirming in its own transaction: an MMG
 * request still pending at MMG, which every fee-demand handoff then sees. */
function startConfirming(h: ReturnType<typeof harness>) {
  return h.prisma.$transaction(async () => {
    h.state.payment = {
      id: 'payment-confirming', subscriptionId: 'sub-1', amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
      externalRef: 'mmgtx-confirming', clientKey: `sub:sub-1:${h.periodKey}:a1`, periodStart: due,
      periodEnd: new Date(due.getTime() + WEEK), createdAt: due, expiresAt: new Date(Date.now() + 86_400_000),
      lastPolledAt: null, pollBackoffSec: 30, failureCode: null, failureRaw: null,
    };
  });
}

/** A suspended payer's committed nudge, reached by the sweep (initial) or by
 * the notice drain over an intent committed earlier (retry). */
async function payerNoticeHarness(entry: 'initial' | 'retry', key: string) {
  const h = outbox(harness());
  Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(+due - 86_400_000) });
  selectSuspended(h, async () => [{ ...h.state.sub }]);
  if (entry === 'retry') {
    await h.prisma.billingEvent.create({ data: {
      subscriptionId: 'sub-1', type: 'REMINDER', idempotencyKey: `nudge:sub-1:${key}`,
      note: JSON.stringify({ noticeVersion: 1, target: 'payer', userId: 'user-1', title: 'Reminder', body: 'Unpaid', sms: 'Unpaid',
        data: { kind: 'billing_suspended_nudge', subscriptionId: 'sub-1' } }),
    } });
  }
  const notice = () => [...h.state.events.values()].find((row) => row['idempotencyKey']?.startsWith('nudge:'));
  return Object.assign(h, {
    notice,
    stage: () => stageOf(h, notice()?.['id']),
    start: () => entry === 'initial' ? h.billing.sweepSuspended(due) : h.billing.drainPendingNotices(due),
    retry: () => h.worker().drainPendingNotices(new Date(+due + 61_000)),
  });
}

describe('53FEC809 R3 approved mismatch quarantine', () => {
  function approval(h: ReturnType<typeof harness>, patch: Record<string, unknown> = {}) {
    return {
      transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000,
      currencyCode: 'GYD', reference: h.reference, createdAt: '2026-09-20T12:00:01.123Z',
      ...patch,
    };
  }

  async function observe(h: ReturnType<typeof harness>, evidence: ReturnType<typeof approval>, now = due) {
    return (h.billing as any).settleApprovedMmgPayment({ ...h.state.sub }, h.state.payment!.id, evidence, now);
  }

  function issuedHarness() {
    const h = harness('prior_lookup');
    h.state.events.set(`charge:${h.reference.slice(4)}`, {
      type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100,
    });
    return h;
  }

  it.each([
    ['amount', { amountMinor: 210001 }],
    ['currency', { currencyCode: ' usd ' }],
    ['merchant reference', { reference: ' sub:unrelated:2026-09-20:a0 ' }],
    ['provider reference', { transactionId: ' mmgtx-other ' }],
  ])('R3 retains exact positive %s mismatch facts with immutable issued expectations', async (_label, patch) => {
    const h = issuedHarness();
    const evidence = approval(h, patch as Record<string, unknown>);
    h.state.payment!.failureRaw = { providerEffect: 'AUTHORIZED', authorizedAt: '2026-09-20T12:00:00Z' };
    expect(await observe(h, evidence)).toBe('held');
    expect(h.state.payment).toMatchObject({
      status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH', externalRef: 'mmgtx-prior',
      failureRaw: {
        providerEffect: 'AUTHORIZED', providerOutcome: 'CAPTURED',
        recoveryDisposition: 'MANUAL_RECONCILIATION', settlementHold: 'MMG_APPROVAL_MISMATCH',
        providerObservation: evidence,
        expectedPayment: { transactionId: 'mmgtx-prior', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference },
      },
    });
    const evidenceEvents = [...h.state.events.values()].filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'));
    expect(evidenceEvents).toHaveLength(1);
    expect(JSON.parse(evidenceEvents[0]!['note'])).toMatchObject({ providerObservation: evidence });
    expect(h.state.wallet).toBe(0);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(ledger.keys).toEqual([]);
    expect(vi.mocked(issueReceipt)).not.toHaveBeenCalled();
  });

  it.each(['declined', 'reversed', 'expired'] as const)('R3 approved mismatch then %s never loses capture evidence or resumes dunning', async status => {
    const h = issuedHarness();
    const evidence = approval(h, { amountMinor: 210001 });
    h.state.sub.nextRetryAt = new Date(due.getTime() + DAY_FOR_R3) as any;
    await observe(h, evidence);
    const firstEvidence = cloneBillingValue(h.state.payment!.failureRaw);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({ ...evidence, status } as any);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + DAY_FOR_R3))).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH', failureRaw: firstEvidence });
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null });
    expect([...h.state.events.values()].filter(event => event['type'] === 'CHARGE_FAILED')).toEqual([]);
    expect(ledger.keys).toEqual([]);
  });

  it.each(['FAILED', 'EXPIRED'] as const)('R3 %s then approved mismatch reopens discoverable quarantine without erasing prior evidence', async status => {
    const h = issuedHarness();
    Object.assign(h.state.payment!, { status, failureRaw: { reason: 'earlier terminal observation' } });
    Object.assign(h.state.sub, { status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: new Date(due.getTime() + DAY_FOR_R3) });
    const evidence = approval(h, { currencyCode: 'TTD' });
    await observe(h, evidence);
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureRaw: {
      reason: 'earlier terminal observation', providerOutcome: 'CAPTURED', providerObservation: evidence,
    } });
    expect(h.state.sub).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1, nextRetryAt: null });
    const lookup = vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(evidence as any);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + DAY_FOR_R3))).toMatchObject({ stillPending: 1, settled: 0, failed: 0 });
    expect(lookup).toHaveBeenCalledWith({ transactionId: 'mmgtx-prior' });
    expect(await h.billing.reconcileTerminalWithoutOutcome(due)).toMatchObject({ repaired: 0 });
  });

  it('R3 duplicate polling and a restarted completion handler notify each tenant admin only on first observation', async () => {
    const h = issuedHarness();
    h.prisma.user.findMany.mockResolvedValue([{ id: 'synthetic-admin-a' }, { id: 'synthetic-admin-b' }]);
    const evidence = approval(h, { amountMinor: 1 });
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(evidence as any);
    for (let tick = 0; tick < 3; tick += 1) {
      await h.billing.pollPendingMmgCharges(new Date(due.getTime() + tick * DAY_FOR_R3));
    }
    const restarted = new BillingService(h.prisma, h.notifications as any, {} as any);
    await (restarted as any).settleApprovedMmgPayment({ ...h.state.sub }, h.state.payment!.id, evidence, due);
    const notices = h.state.notificationPayloads.filter(notice => notice.data?.kind === 'reconcile_mismatch');
    expect(notices.map(notice => notice.userId)).toEqual(['synthetic-admin-a', 'synthetic-admin-b']);
    expect(h.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ tenantId: 'swift-default' }, { roles: { has: 'SUPER_ADMIN' } }] }),
    }));
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
    expect(h.state.payment!.failureRaw).toMatchObject({ providerObservation: evidence });
  });

  it('R8 retries only the missing first-mismatch admin page after restart without a second hold or money effect', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(due);
    try {
    const h = issuedHarness();
    h.prisma.user.findMany.mockResolvedValue([{ id: 'synthetic-admin-a' }, { id: 'synthetic-admin-b' }]);
    const originalSend = h.notifications.send.getMockImplementation()!;
    let failSecondAdmin = true;
    h.notifications.send.mockImplementation(async (input: any) => {
      if (input.userId === 'synthetic-admin-b' && failSecondAdmin) {
        failSecondAdmin = false;
        return '';
      }
      return originalSend(input);
    });
    const evidence = approval(h, { amountMinor: 210001 });

    expect(await observe(h, evidence)).toBe('held');
    const pending = h.state.events.get('mismatch:payment-1');
    expect(pending).toMatchObject({ deliveredAt: null });
    expect(h.state.notificationPayloads.filter(notice => notice.data?.kind === 'reconcile_mismatch')
      .map(notice => notice.userId)).toEqual(['synthetic-admin-a']);

    const restarted = new BillingService(h.prisma, h.notifications as any, {} as any);
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 60_000)))
      .toEqual({ attempted: 1, delivered: 1 });
    await (restarted as any).settleApprovedMmgPayment({ ...h.state.sub }, h.state.payment!.id, evidence, due);
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 120_000)))
      .toEqual({ attempted: 0, delivered: 0 });

    const notices = h.state.notificationPayloads.filter(notice => notice.data?.kind === 'reconcile_mismatch');
    expect(notices.map(notice => notice.userId)).toEqual(['synthetic-admin-a', 'synthetic-admin-b']);
    expect(notices.every(notice => notice.dedupeKey === `billing-notice:${pending?.['id']}`)).toBe(true);
    expect(pending?.['deliveredAt']).toBeInstanceOf(Date);
    expect([...h.state.events.keys()].filter(key => key === 'mismatch:payment-1')).toHaveLength(1);
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([]);
    expect(vi.mocked(issueReceipt)).not.toHaveBeenCalled();
    expect(JSON.stringify(pending?.['note'])).not.toContain('mmgtx-prior');
    expect(JSON.stringify(pending?.['note'])).not.toContain('5926000001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3 later distinct or matching approvals append exact evidence but cannot silently release a quarantine', async () => {
    const h = issuedHarness();
    const first = approval(h, { amountMinor: 1 });
    const second = approval(h, { currencyCode: 'USD' });
    const matching = approval(h);
    for (const evidence of [first, second, matching, second, matching]) expect(await observe(h, evidence)).toBe('held');
    expect(h.state.payment!.failureRaw).toMatchObject({ providerObservation: first });
    const observations = [...h.state.events.values()]
      .filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'))
      .map(event => JSON.parse(event['note']).providerObservation);
    expect(observations).toEqual([first, second, matching]);
    expect(h.state.payment!.status).toBe('PENDING');
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([]);
    expect(vi.mocked(issueReceipt)).not.toHaveBeenCalled();
  });

  it.each(['approval-first', 'negative-first'] as const)('R3 out-of-order poll and approval completion converge with %s', async order => {
    const h = issuedHarness();
    const arrived = deferred();
    const release = deferred();
    const evidence = approval(h, { reference: 'sub:wrong:2026-09-20:a0' });
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      return order === 'approval-first' ? { ...evidence, status: 'declined' } as any : evidence as any;
    });
    const polling = h.billing.pollPendingMmgCharges(due);
    await arrived.promise;
    if (order === 'approval-first') await observe(h, evidence);
    else await (h.billing as any).terminalizeFailedPayment({ ...h.state.sub }, h.state.payment!,
      { status: 'FAILED', failureCode: 'DECLINED', from: ['PENDING', 'UNKNOWN'],
        mmgLookup: (h.billing as any).mmgLookupObservation(h.state.payment, { ...approval(h), status: 'declined' }) },
      'earlier bound decline', due, h.periodKey);
    release.resolve();
    await polling;
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH', failureRaw: { providerOutcome: 'CAPTURED', providerObservation: evidence } });
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.sub.failedAttempts).toBe(order === 'approval-first' ? 0 : 1);
    expect(ledger.keys).toEqual([]);
  });

  it.each(['MOBILE_MONEY', 'CARD', 'CASH'] as const)('R3 a new %s attempt cannot resend, spend or resume an old failure while MMG is held', async rail => {
    const h = issuedHarness();
    await observe(h, approval(h, { amountMinor: 1 }));
    Object.assign(h.state.sub, { billingMethod: rail, paymentToken: 'synthetic-card', failedAttempts: 1 });
    h.state.wallet = 5000;
    const initiate = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment');
    const chargeToken = vi.fn();
    (h.billing as any).payments = { chargeToken };
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(await (h.billing as any).applyFailedCharge({ ...h.state.sub }, 2100, 'stale failure', due, h.periodKey)).toBe('skipped');
    expect(h.state.sub.failedAttempts).toBe(1);
    expect(h.state.wallet).toBe(5000);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(initiate).not.toHaveBeenCalled();
    expect(chargeToken).not.toHaveBeenCalled();
  });

  it('R3 failed post-commit notification is first-observation only and retains the durable hold', async () => {
    const h = issuedHarness();
    h.prisma.user.findMany.mockResolvedValue([{ id: 'synthetic-admin-a' }]);
    h.notifications.send.mockRejectedValue(new Error('synthetic notification failure'));
    const evidence = approval(h, { amountMinor: 1 });
    expect(await observe(h, evidence)).toBe('held');
    expect(await observe(h, evidence)).toBe('held');
    expect(h.notifications.send).toHaveBeenCalledOnce();
    expect(h.state.payment!.failureRaw).toMatchObject({ providerOutcome: 'CAPTURED', providerObservation: evidence });
  });

  it.each([1, 40])('R3 suspended dunning skips a %s-day old subscription when an approval hold commits after selection', async days => {
    // [#1393] Payer notices go through the real fee-demand outbox (`outbox`).
    const h = outbox(issuedHarness());
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(due.getTime() - days * DAY_FOR_R3) });
    selectSuspended(h, async () => {
      const stale = { ...h.state.sub };
      await observe(h, approval(h, { amountMinor: 1 }));
      return [stale];
    });
    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect(demandInbox(h)).toEqual([]);
    expect(h.stages()).toEqual([]);
    expect(h.sendSms).not.toHaveBeenCalled();
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:') || key.startsWith('churned:'))).toEqual([]);
  });

  it.each([1, 40])('R4 a hold committed after the initial %s-day sweep read fences the nudge or churn write', async days => {
    // [#1393] Nothing is being confirmed when the sweep reads its candidate
    // (the same fixture nudges or churns without the hold: R4 normal sweep).
    // A payment then starts confirming, winning the payer lock first.
    const h = outbox(harness());
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(due.getTime() - days * DAY_FOR_R3) });
    let selected = false;
    let holdCommitted = false;
    let sweepAuthorityLock = false;
    selectSuspended(h, async () => {
      selected = true;
      return [{ ...h.state.sub }];
    });
    const commitHold = async () => {
      expect(selected).toBe(true);
      if (holdCommitted) return;
      holdCommitted = true;
      await startConfirming(h);
    };
    const originalLock = (h.billing as any).lockSubscriptionMoneyAuthority.bind(h.billing);
    vi.spyOn(h.billing as any, 'lockSubscriptionMoneyAuthority').mockImplementation(async (tx: any, sub: any) => {
      if (selected && !holdCommitted) {
        sweepAuthorityLock = true;
        // The competing money transaction wins the payer lock immediately
        // before the sweep can acquire it, after the sweep's candidate read.
        await commitHold();
      }
      return originalLock(tx, sub);
    });
    const originalUpdate = h.prisma.subscription.updateMany;
    h.prisma.subscription.updateMany = vi.fn(async (args: any) => {
      if (args.data.status === 'CHURNED') await commitHold();
      return originalUpdate(args);
    });
    const originalEvent = h.prisma.billingEvent.create;
    h.prisma.billingEvent.create = vi.fn(async (args: any) => {
      if (args.data.idempotencyKey.startsWith('nudge:')) await commitHold();
      return originalEvent(args);
    });

    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(holdCommitted).toBe(true);
    expect(sweepAuthorityLock).toBe(true);
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect(h.state.tables['hold']).toEqual([expect.objectContaining({ paymentId: 'payment-confirming', status: 'ACTIVE' })]);
    expect(demandInbox(h)).toEqual([]);
    expect(h.stages()).toEqual([]);
    expect(h.sendSms).not.toHaveBeenCalled();
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:') || key.startsWith('churned:'))).toEqual([]);
  });

  it.each([1, 40])('R4 a failed %s-day sweep transaction rolls back its decision before any notice', async days => {
    // [#1393] Nothing is being confirmed, so the refused commit is the
    // sweep's own decision; the same fixture then decides once it can commit.
    const h = outbox(harness());
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(due.getTime() - days * DAY_FOR_R3) });
    selectSuspended(h, async () => h.state.sub.status === 'SUSPENDED' ? [{ ...h.state.sub }] : []);
    h.barriers.beforeCommit = async () => { throw new Error('synthetic commit refusal'); };

    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:') || key.startsWith('churned:'))).toEqual([]);
    expect(demandInbox(h)).toEqual([]);
    expect(h.stages()).toEqual([]);
    expect(h.sendSms).not.toHaveBeenCalled();
    h.barriers.beforeCommit = undefined;
    expect(await h.billing.sweepSuspended(due)).toEqual(days === 40 ? { nudged: 0, churned: 1 } : { nudged: 1, churned: 0 });
    expect(h.sendSms).toHaveBeenCalledOnce();
  });

  it.each([1, 40])('R4 a normal %s-day sweep commits one event before its one notice', async days => {
    // [#1393 outbox] The sweep commits its event (the intent) first; the payer
    // notice is then handed to the fee-demand outbox, which delivers it once:
    // one inbox row, one push, one SMS. A repeated sweep adds nothing.
    const h = outbox(harness());
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(due.getTime() - days * DAY_FOR_R3) });
    selectSuspended(h, async () => [{ ...h.state.sub }]);
    const kind = days === 40 ? 'billing_churned' : 'billing_suspended_nudge';
    const eventPrefix = days === 40 ? 'churned:' : 'nudge:';
    const event = () => [...h.state.events.values()].find((row) => row['idempotencyKey']?.startsWith(eventPrefix));
    const handedOffAtEffect: boolean[] = [];
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      handedOffAtEffect.push(!!event()?.['deliveredAt'] && stageOf(h, event()?.['id'])?.['status'] === 'PENDING');
      h.sent.push({ channel: 'sms', to, body });
      return { ref: 'sms-ref' };
    });

    expect(await h.billing.sweepSuspended(due)).toEqual(days === 40 ? { nudged: 0, churned: 1 } : { nudged: 1, churned: 0 });
    expect(handedOffAtEffect).toEqual([true]);
    expect(stageOf(h, event()!['id'])).toMatchObject({ status: 'DELIVERED' });
    expect(demandInbox(h).map((row) => row['data'].kind)).toEqual([kind]);
    expect(h.sent.map((effect) => effect.channel)).toEqual(['push', 'sms']);
    expect(demandEffects(h)).toHaveLength(2);
    expect([...h.state.events.keys()].filter(key => key.startsWith(eventPrefix))).toHaveLength(1);

    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(await h.billing.drainPendingNotices(new Date(due.getTime() + 61_000))).toEqual({ attempted: 0, delivered: 0 });
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
    expect([...h.state.events.keys()].filter(key => key.startsWith(eventPrefix))).toHaveLength(1);
  });

  // [#1393 outbox] The cases below re-express the retired per-event SMS lease
  // cases (R4, R8, R9) against the fee-demand outbox that now delivers every
  // payer notice. Each keeps its name where the property is unchanged; where
  // the approved design changed the property (an SMS whose provider outcome is
  // unknown is never blindly re-sent; time no longer decides who may send)
  // the name says the new property. CLAUDE-legacy-notice-mapping.md maps each
  // case old to new.
  /** A suspended payer with no payment being confirmed (so nothing pauses its notices). */
  function suspendedOutbox(days = 1) {
    const h = outbox(harness());
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(due.getTime() - days * DAY_FOR_R3) });
    selectSuspended(h, async () => h.state.sub.status === 'SUSPENDED' ? [{ ...h.state.sub }] : []);
    return h;
  }
  const payerEvent = (h: Outbox, prefix = 'nudge:') => [...h.state.events.values()].find((row) => row['idempotencyKey']?.startsWith(prefix));
  const smsEffects = (h: Outbox) => h.sent.filter((effect) => effect.channel === 'sms');
  const pushEffects = (h: Outbox) => h.sent.filter((effect) => effect.channel === 'push');
  /** The next matching call of one fixture method fails once; every other call runs unchanged. */
  function failOnce(target: Record<string, any>, method: string, match: (args: any) => boolean = () => true, message = 'synthetic outage') {
    const original = target[method];
    let armed = true;
    target[method] = vi.fn(async (...args: any[]) => {
      if (armed && match(args[0])) { armed = false; throw new Error(message); }
      return original(...args);
    });
  }
  /** The owed week is paid: a weekly MMG request issued for it, then MMG approves it. */
  async function payOwedWeek(h: Outbox, at: Date) {
    h.state.payment = {
      id: 'payment-1', subscriptionId: 'sub-1', amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
      externalRef: 'mmgtx-prior', clientKey: h.reference, periodStart: due, periodEnd: new Date(due.getTime() + WEEK), createdAt: due,
      expiresAt: new Date(at.getTime() + 86_400_000), lastPolledAt: null, pollBackoffSec: 30, failureCode: null, failureRaw: null,
    };
    h.state.events.set(`charge:${h.reference.slice(4)}`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100 });
    return observe(h, approval(h), at);
  }
  const STALE_DEMAND = /still suspended|is unpaid|pay (?:in|your|to)|Approve the MMG/i;
  /** Fee-demand effects only: a payment's own receipt or reinstatement notice is not a demand. */
  const demandSent = (h: Outbox) => h.sent.filter((effect) => effect.channel === 'sms'
    ? effect.body.includes('At the time') || STALE_DEMAND.test(effect.body) : DEMAND_KINDS.includes(String(effect.kind)));
  /** The audited decision and money: status, schedule anchors, payment, wallet, ledger and events (not schedule projections). */
  const economicOf = (h: Outbox) => {
    const { status, autoRenew, failedAttempts, suspendedAt, currentPeriodStart, currentPeriodEnd, nextBillingDate } = h.state.sub as any;
    return JSON.stringify([{ status, autoRenew, failedAttempts, suspendedAt, currentPeriodStart, currentPeriodEnd, nextBillingDate },
      h.state.payment, h.state.wallet, ledger.keys, ledger.postings, [...h.state.events.keys()]]);
  };

  it('R4 a later same-day suspension can churn with its own atomic event', async () => {
    const h = suspendedOutbox(40);
    const first = h.state.sub.suspendedAt as unknown as Date;
    selectSuspended(h, async () => [{ ...h.state.sub }]);

    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 1 });
    Object.assign(h.state.sub, { status: 'SUSPENDED', suspendedAt: new Date(first.getTime() + 60 * 60 * 1000) });
    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 1 });
    const events = [...h.state.events.values()].filter((row) => row['idempotencyKey']?.startsWith('churned:'));
    expect(events).toHaveLength(2);
    // Each suspension episode has its own stage, delivered once each.
    expect(events.map((event) => stageOf(h, event['id'])?.['status'])).toEqual(['DELIVERED', 'DELIVERED']);
    expect(demandInbox(h).filter((row) => row['data'].kind === 'billing_churned')).toHaveLength(2);
    expect(smsEffects(h)).toHaveLength(2);
  });

  it.each([1, 40])('R8 a failed push on day %s still attempts the independent SMS', async days => {
    const h = suspendedOutbox(days);
    h.sendPush.mockRejectedValue(new Error('synthetic push failure'));

    await h.billing.sweepSuspended(due);

    expect(h.sendPush).toHaveBeenCalledOnce();
    expect(h.sendSms).toHaveBeenCalledOnce();
    // The push outcome is unknown and kept for reconciliation; the SMS landed.
    expect(h.handoff('push')).toMatchObject({ status: 'UNKNOWN' });
    expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
    expect([...h.state.events.keys()].filter(key => key.startsWith(days === 40 ? 'churned:' : 'nudge:'))).toHaveLength(1);
    // A restarted worker never re-sends either channel.
    await h.worker().drainPendingNotices(new Date(due.getTime() + 61_000));
    expect(h.sendPush).toHaveBeenCalledOnce();
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(demandInbox(h)).toHaveLength(1);
  });

  it('R8 an SMS outage after a committed inbox row is never blindly re-sent, and repeats no inbox or lifecycle event', async () => {
    const h = suspendedOutbox(1);
    h.sendSms.mockRejectedValueOnce(new Error('synthetic SMS outage'));

    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 1, churned: 0 });
    const event = payerEvent(h)!;
    expect(event['deliveredAt']).toBeTruthy(); // handed to the outbox
    expect(demandInbox(h)).toHaveLength(1);
    // The provider may have accepted it: the outcome is UNKNOWN, held for
    // reconciliation, never sent again (no duplicate fee demand).
    expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    await h.worker().drainPendingNotices(new Date(due.getTime() + 60_000));
    await h.worker().drainPendingNotices(new Date(due.getTime() + 120_000));
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
    expect(demandInbox(h)).toHaveLength(1);
    expect(pushEffects(h)).toHaveLength(1);
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:'))).toHaveLength(1);
  });

  it.each([1, 40])('R8 day %s retries the committed inbox after restart without repeating a checkpointed SMS or lifecycle event', async days => {
    // The first delivery cannot write the inbox row: nothing is sent, the
    // stage stays due. A restarted worker writes it and delivers each channel
    // once; a further restart repeats nothing.
    const h = suspendedOutbox(days);
    failOnce(h.prisma.notification, 'upsert', () => true, 'synthetic inbox outage');
    const expected = days === 40 ? { nudged: 0, churned: 1 } : { nudged: 1, churned: 0 };
    expect(await h.billing.sweepSuspended(due)).toEqual(expected);
    const event = payerEvent(h, days === 40 ? 'churned:' : 'nudge:')!;
    expect(event['deliveredAt']).toBeTruthy();
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    expect(h.sent).toEqual([]);
    const eventCount = h.state.events.size;

    const restarted = h.worker();
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 60_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'DELIVERED' });
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.sent.map((effect) => effect.channel)).toEqual(['push', 'sms']);
    expect(h.state.events.size).toBe(eventCount);
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 120_000))).toEqual({ attempted: 0, delivered: 0 });
    expect(await restarted.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(h.sent).toHaveLength(2);
  });

  it('R8 both failed channels remain due through a restarted worker and expired claim lease', async () => {
    // The hand-off to the outbox fails (a payer lookup outage): nothing is
    // recorded or sent and the intent stays due. A dead worker's unexpired
    // claim blocks a restart until it expires.
    const h = suspendedOutbox(1);
    failOnce(h.prisma.user, 'findUnique', (args) => !!args?.select?.roles, 'synthetic payer lookup outage');
    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 1, churned: 0 });
    const event = payerEvent(h)!;
    expect(event['deliveredAt']).toBeNull();
    expect(h.stages()).toEqual([]);
    expect(h.sent).toEqual([]);
    const eventCount = h.state.events.size;
    event['noticeLeaseToken'] = 'dead-worker';
    event['noticeLeaseUntil'] = new Date(due.getTime() + 120_000);

    const restarted = h.worker();
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 60_000))).toEqual({ attempted: 0, delivered: 0 });
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 121_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(smsEffects(h)).toHaveLength(1);
    expect(pushEffects(h)).toHaveLength(1);
    expect(payerEvent(h)!['deliveredAt']).toBeTruthy();
    expect(h.state.events.size).toBe(eventCount);
  });

  it('R8 publisher death after commit leaves the billing event for a restarted worker', async () => {
    const h = suspendedOutbox(1);
    h.barriers.afterCommit = async () => { throw new Error('synthetic publisher death'); };
    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    expect(payerEvent(h)!['deliveredAt']).toBeNull();
    expect(h.stages()).toEqual([]);
    expect(h.sent).toEqual([]);
    h.barriers.afterCommit = undefined;
    const restarted = h.worker();
    expect(await restarted.drainPendingNotices(new Date(due.getTime() + 60_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(payerEvent(h)!['deliveredAt']).toBeTruthy();
    expect(h.sent.map((effect) => effect.channel)).toEqual(['push', 'sms']);
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:'))).toHaveLength(1);
  });

  it('R8 competing restarted workers atomically claim one pending event', async () => {
    const h = suspendedOutbox(1);
    serializeTransactions(h);
    h.barriers.afterCommit = async () => { throw new Error('synthetic publisher death'); };
    expect(await h.billing.sweepSuspended(due)).toEqual({ nudged: 0, churned: 0 });
    h.barriers.afterCommit = undefined;

    const results = await Promise.all([
      h.worker().drainPendingNotices(new Date(due.getTime() + 60_000)),
      h.worker().drainPendingNotices(new Date(due.getTime() + 60_000)),
    ]);
    // One worker claimed the intent and handed it off; the stage's channels
    // went out once (a rival drain finds each reserved).
    expect(results.reduce((sum, row) => sum + row.attempted, 0)).toBeGreaterThanOrEqual(1);
    expect(h.stages()).toHaveLength(1);
    expect(smsEffects(h)).toHaveLength(1);
    expect(pushEffects(h)).toHaveLength(1);
    expect(demandInbox(h)).toHaveLength(1);
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:'))).toHaveLength(1);
  });

  it('R8 holds the active lease while another worker drains and permits only one send', async () => {
    const h = suspendedOutbox(1);
    serializeTransactions(h);
    h.barriers.afterCommit = async () => { throw new Error('synthetic publisher death'); };
    await h.billing.sweepSuspended(due);
    h.barriers.afterCommit = undefined;

    // Worker A claims the intent, then stalls inside its hand-off (the payer
    // re-check) while worker B drains.
    const entered = deferred();
    const release = deferred();
    const lookup = h.prisma.user.findUnique;
    let stalled = false;
    h.prisma.user.findUnique = vi.fn(async (args: any) => {
      if (!stalled && args?.select?.roles) { stalled = true; entered.resolve(); await release.promise; }
      return lookup(args);
    });
    const first = h.worker().drainPendingNotices(new Date(due.getTime() + 60_000));
    await entered.promise;
    expect(await h.worker().drainPendingNotices(new Date(due.getTime() + 60_000))).toEqual({ attempted: 0, delivered: 0 });
    release.resolve();
    expect(await first).toEqual({ attempted: 1, delivered: 1 });
    expect(smsEffects(h)).toHaveLength(1);
    expect(demandInbox(h)).toHaveLength(1);
  });

  it('R8 preserves the obligation after an SMS acknowledgement before its checkpoint, and never re-sends it', async () => {
    // The provider accepted the SMS but recording that outcome crashed: the
    // hand-off stays UNKNOWN (sent, unrecorded), the stage keeps it as
    // outstanding evidence, and no retry sends it a second time.
    const h = suspendedOutbox(1);
    failOnce(h.prisma.billingNoticeHandoff, 'update', (args) => args?.data?.status === 'DELIVERED' && h.handoff('sms')?.['id'] === args?.where?.id, 'synthetic checkpoint crash');
    await h.billing.sweepSuspended(due);
    const event = payerEvent(h)!;
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    await h.worker().drainPendingNotices(new Date(due.getTime() + 60_000));
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    expect(demandInbox(h)).toHaveLength(1);
    expect([...h.state.events.keys()].filter(key => key.startsWith('nudge:'))).toHaveLength(1);
  });

  it('R8 replays only the final acknowledgement after both channels checkpoint', async () => {
    const h = suspendedOutbox(1);
    failOnce(h.prisma.billingFeeNotice, 'updateMany', (args) => args?.data?.status === 'DELIVERED', 'synthetic final acknowledgement crash');
    await h.billing.sweepSuspended(due);
    const event = payerEvent(h)!;
    expect(h.handoff('push')).toMatchObject({ status: 'DELIVERED' });
    expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    expect(await h.worker().drainPendingNotices(new Date(due.getTime() + 60_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'DELIVERED' });
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.sendPush).toHaveBeenCalledOnce();
    expect(demandInbox(h)).toHaveLength(1);
  });

  it('R8 a bounded batch of poisoned oldest notices cannot starve the next eligible row', async () => {
    // 200 intents cannot be handed off (each names someone who is not the
    // payer); the 201st is healthy. Each refused hand-off cools down, so the
    // next bounded drain reaches the healthy one.
    const h = suspendedOutbox(1);
    const firstDrain = new Date(due.getTime() + 30_000);
    const initialEventCount = h.state.events.size;
    for (let i = 0; i < 201; i += 1) {
      const row = await h.prisma.billingEvent.create({ data: {
        subscriptionId: 'sub-1', type: 'REMINDER', currencyCode: 'GYD',
        idempotencyKey: `nudge:sub-1:${i}`,
        note: JSON.stringify({ noticeVersion: 1, target: 'payer', userId: i === 200 ? 'user-1' : 'not-the-payer',
          title: i === 200 ? 'healthy' : 'poison', body: 'Open the app to pay', sms: 'Unpaid',
          data: { kind: 'billing_suspended_nudge', subscriptionId: 'sub-1' } }),
      } });
      row.createdAt = new Date(due.getTime() + i);
    }
    expect(await h.billing.drainPendingNotices(firstDrain)).toEqual({ attempted: 200, delivered: 0 });
    expect(await h.billing.drainPendingNotices(new Date(firstDrain.getTime() + 1_000)))
      .toEqual({ attempted: 1, delivered: 1 });
    expect(h.state.events.get('nudge:sub-1:0')?.['deliveredAt']).toBeNull();
    expect(h.state.events.get('nudge:sub-1:0')?.['noticeLeaseUntil']).toEqual(new Date(firstDrain.getTime() + 60_000));
    expect(h.state.events.get('nudge:sub-1:200')?.['deliveredAt']).toBeTruthy();
    expect(h.state.events.size).toBe(initialEventCount + 201);
    expect(h.stages()).toHaveLength(1);
    expect(smsEffects(h)).toHaveLength(1);
  });

  it.each([1, 40])('R9 payment before day %s notice retry preserves historical evidence without a stale payment demand', async days => {
    const h = suspendedOutbox(days);
    failOnce(h.prisma.notification, 'upsert', () => true, 'synthetic inbox outage');
    await h.billing.sweepSuspended(due);
    const event = [...h.state.events.values()].find(row => row['note']?.startsWith('{"noticeVersion":1,'))!;
    const originalNote = event['note'];
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'PENDING' });
    expect(h.sent).toEqual([]);
    expect(await payOwedWeek(h, new Date(+due + 61_000))).toBe('advanced');
    expect(h.state.sub.status).toBe('ACTIVE');
    expect(h.state.payment!.status).toBe('CAPTURED');
    // Paying closed the obligation: its pending demand is obsolete, kept as history.
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'OBSOLETE' });
    const economic = JSON.stringify([h.state.sub, h.state.payment, h.state.wallet, ledger.keys, ledger.postings]);
    await h.worker().drainPendingNotices(new Date(+due + 62_000));
    expect(demandInbox(h)).toEqual([]);
    expect(h.sent.filter((effect) => STALE_DEMAND.test(effect.body) || effect.body.includes('At the time'))).toEqual([]);
    expect(event['note']).toBe(originalNote);
    expect(JSON.stringify([h.state.sub, h.state.payment, h.state.wallet, ledger.keys, ledger.postings])).toBe(economic);
  });

  it.each(['inbox', 'sms'] as const)('R9 payment between partial %s delivery and retry does not issue a current-state payment demand', async missing => {
    const h = suspendedOutbox(1);
    if (missing === 'inbox') failOnce(h.prisma.notification, 'upsert', () => true, 'synthetic inbox outage');
    else h.sendSms.mockRejectedValueOnce(new Error('synthetic SMS outage'));
    await h.billing.sweepSuspended(due);
    const event = [...h.state.events.values()].find(row => row['note']?.startsWith('{"noticeVersion":1,'))!;
    const before = demandSent(h).length;
    expect(await payOwedWeek(h, new Date(+due + 61_000))).toBe('advanced');
    await h.worker().drainPendingNotices(new Date(+due + 62_000));
    // No fee demand goes out after the payment; whatever went out before it
    // is the historical copy, never a current demand.
    expect(demandSent(h)).toHaveLength(before);
    expect(demandInbox(h)).toHaveLength(missing === 'inbox' ? 0 : 1);
    for (const row of demandInbox(h)) expect(row['body']).toContain('At the time');
    expect(demandSent(h).every((effect) => effect.body.includes('At the time') && !STALE_DEMAND.test(effect.body))).toBe(true);
    expect(stageOf(h, event['id'])).toMatchObject({ status: 'OBSOLETE' });
    expect(h.sendSms).toHaveBeenCalledTimes(missing === 'sms' ? 1 : 0);
  });

  it('R9 late batch acquisition cannot start expired or let a second worker duplicate the last SMS', async () => {
    const h = suspendedOutbox(1);
    let logical = +due;
    h.state.noticeClock = () => new Date(logical);
    const rows = [];
    for (let i = 0; i < 17; i += 1) {
      const row = await h.prisma.billingEvent.create({ data: {
        subscriptionId: 'sub-1', type: 'REMINDER', idempotencyKey: `nudge:sub-1:r9-${i}`,
        note: JSON.stringify({ noticeVersion: 1, target: 'payer', userId: 'user-1', title: 'Reminder', body: 'Unpaid', sms: 'Unpaid',
          data: { kind: 'billing_suspended_nudge', subscriptionId: 'sub-1' } }),
      } });
      row.createdAt = new Date(+due + i);
      rows.push(row);
    }
    const last = rows[16]!;
    // Each claim is taken on the database clock at its own acquisition.
    const claim = h.prisma.$queryRaw.getMockImplementation()!;
    let lastClaim: { leaseUntil: number; at: number } | undefined;
    h.prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const result = await claim(strings, ...values);
      if (strings.join(' ').includes('SET "noticeLeaseToken"') && values[1] === last.id && result.length === 1) {
        const event = [...h.state.events.values()].find((row) => row['id'] === last.id)!;
        lastClaim = { leaseUntil: +event['noticeLeaseUntil'], at: logical };
      }
      return result;
    });
    const smsB = vi.fn(async (to: string, body: string) => { h.sent.push({ channel: 'sms', to, body }); return { ref: 'sms-b' }; });
    const workerB = h.notices({ sms: { sendSms: smsB } });
    let sends = 0;
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      sends += 1;
      h.sent.push({ channel: 'sms', to, body });
      logical += 8_000;
      if (sends === 17) {
        // A second worker reaching the last intent while its SMS is in flight.
        expect(await deliverBillingNotice(h.prisma, workerB, last, new Date(logical))).toBe(false);
        const stage = stageOf(h, last.id)!;
        await workerB.deliverFeeDemand(stage['id']);
      }
      return { ref: 'sms-a' };
    });

    const result = await h.billing.drainPendingNotices(due);
    expect(lastClaim!.leaseUntil).toBe(lastClaim!.at + 120_000);
    expect(lastClaim!.at).toBe(+due + 16 * 8_000);
    expect(result).toEqual({ attempted: 17, delivered: 17 });
    expect(h.sendSms).toHaveBeenCalledTimes(17);
    expect(smsB).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'PAUSED', 'HELD'] as const)('R9 queued history remains truthful after %s without changing the audited decision', async status => {
    const h = suspendedOutbox(1);
    failOnce(h.prisma.notification, 'upsert', () => true, 'synthetic inbox outage');
    await h.billing.sweepSuspended(due);
    const event = [...h.state.events.values()].find(row => row['note']?.startsWith('{"noticeVersion":1,'))!;
    const note = event['note'];
    if (status === 'HELD') {
      // An MMG approval for this payer is held for a person.
      h.state.payment = {
        id: 'payment-1', subscriptionId: 'sub-1', amount: 2100, status: 'PENDING', paymentMethod: 'MOBILE_MONEY',
        externalRef: 'mmgtx-prior', clientKey: h.reference, periodStart: due, periodEnd: new Date(due.getTime() + WEEK), createdAt: due,
        expiresAt: new Date(+due + 86_400_000), lastPolledAt: null, pollBackoffSec: 30, failureCode: null, failureRaw: null,
      };
      h.state.events.set(`charge:${h.reference.slice(4)}`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100 });
      expect(await observe(h, approval(h, { amountMinor: 1 }), new Date(+due + 1_000))).toBe('held');
    } else Object.assign(h.state.sub, { status, autoRenew: false });
    const economic = economicOf(h);
    // (A held approval also queues its own admin page: the drain attempts it too.)
    expect(await h.worker().drainPendingNotices(new Date(+due + 62_000))).toMatchObject({ delivered: 0 });
    // Nothing is sent: a closed or cancelled plan's demand is obsolete; a held
    // payment pauses it (it waits for the person's decision).
    expect(h.sent).toEqual([]);
    expect(demandInbox(h)).toEqual([]);
    expect(stageOf(h, event['id'])).toMatchObject({ status: status === 'HELD' ? 'PENDING' : 'OBSOLETE' });
    expect(event['note']).toBe(note);
    expect(economicOf(h)).toBe(economic);
  });

  it.each([false, true])('R9 an expired inbox owner stops before SMS (replacement owner=%s)', async replacement => {
    // Owner A claimed the intent, then stalled past its claim before handing
    // it to the outbox. An expired claim hands off nothing; a replacement owner
    // (or a later retry) delivers it once.
    const h = suspendedOutbox(1);
    serializeTransactions(h);
    let logical = +due;
    h.state.noticeClock = () => new Date(logical);
    const row = await h.prisma.billingEvent.create({ data: {
      subscriptionId: 'sub-1', type: 'REMINDER', idempotencyKey: 'nudge:sub-1:slow',
      note: JSON.stringify({ noticeVersion: 1, target: 'payer', userId: 'user-1', title: 'Reminder', body: 'Unpaid', sms: 'Unpaid',
        data: { kind: 'billing_suspended_nudge', subscriptionId: 'sub-1' } }),
    } });
    const owner = { current: 'A' };
    h.sendSms.mockImplementation(async (to: string, body: string) => { h.sent.push({ channel: 'sms', to: `${owner.current}:${to}`, body }); return { ref: 'sms' }; });
    const transaction = h.prisma.$transaction.getMockImplementation()!;
    let stalled = false;
    h.prisma.$transaction.mockImplementation(async (fn: any) => {
      if (!stalled) {
        stalled = true;
        logical += 121_000;
        if (replacement) {
          owner.current = 'B';
          expect(await deliverBillingNotice(h.prisma, h.notices(), row, new Date(logical))).toBe(true);
          owner.current = 'A';
        }
      }
      return transaction(fn);
    });
    expect(await deliverBillingNotice(h.prisma, h.notices(), row, due)).toBe(false);
    expect(smsEffects(h).map((effect) => effect.to.split(':')[0])).toEqual(replacement ? ['B'] : []);
    expect(!!payerEvent(h)!['deliveredAt']).toBe(replacement);
    if (!replacement) {
      expect(h.stages()).toEqual([]);
      logical += 61_000;
      owner.current = 'B';
      expect(await deliverBillingNotice(h.prisma, h.notices(), row, new Date(logical))).toBe(true);
      expect(smsEffects(h)).toHaveLength(1);
    }
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.stages()).toHaveLength(1);
  });

  it('R9 claims and hands off on database time despite an old caller time', async () => {
    const h = suspendedOutbox(1);
    let logical = +due;
    h.state.noticeClock = () => new Date(logical);
    const row = await h.prisma.billingEvent.create({ data: {
      subscriptionId: 'sub-1', type: 'REMINDER', idempotencyKey: 'nudge:sub-1:renew',
      note: JSON.stringify({ noticeVersion: 1, target: 'payer', userId: 'user-1', title: 'Reminder', body: 'Unpaid', sms: 'Unpaid',
        data: { kind: 'billing_suspended_nudge', subscriptionId: 'sub-1' } }),
    } });
    const claimed: number[] = [];
    const claim = h.prisma.$queryRaw.getMockImplementation()!;
    h.prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const result = await claim(strings, ...values);
      if (strings.join(' ').includes('SET "noticeLeaseToken"') && result.length === 1) claimed.push(+payerEvent(h)!['noticeLeaseUntil']);
      return result;
    });
    const smsB = vi.fn(async () => ({ ref: 'sms-b' }));
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      h.sent.push({ channel: 'sms', to, body });
      logical += 119_000;
      // A rival during the in-flight SMS finds the intent already handed off.
      expect(await deliverBillingNotice(h.prisma, h.notices({ sms: { sendSms: smsB } }), row, new Date(logical))).toBe(false);
      return { ref: 'sms-a' };
    });
    expect(await deliverBillingNotice(h.prisma, h.notices(), row, new Date(+due - DAY_FOR_R3))).toBe(true);
    // The claim ran on the database clock, not the caller's day-old time.
    expect(claimed).toEqual([+due + 120_000]);
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(smsB).not.toHaveBeenCalled();
    expect(payerEvent(h)!['deliveredAt']).toEqual(new Date(+due));
  });

  it.each(['subscription', 'user'] as const)('R9 transient %s tenant resolution retains the tenant-admin obligation until recovery', async lookup => {
    const h = issuedHarness();
    h.prisma.user.findMany = vi.fn(async ({ where }: any) => where.OR
      ? [{ id: 'platform-admin' }, { id: 'tenant-admin' }] : [{ id: 'platform-admin' }]);
    const row = await h.prisma.billingEvent.create({ data: {
      subscriptionId: 'sub-1', type: 'RECONCILE_MISMATCH', idempotencyKey: 'mismatch:tenant-retry',
      note: JSON.stringify({ noticeVersion: 1, target: 'admins', title: 'Mismatch', body: 'Review billing evidence',
        data: { kind: 'reconcile_mismatch', subscriptionId: 'sub-1' } }),
    } });
    h.prisma[lookup].findUnique.mockRejectedValueOnce(new Error('synthetic tenant lookup outage'));
    await deliverBillingNotice(h.prisma, h.notifications as any, row, due).catch(() => false);
    expect(row.deliveredAt).toBeNull();
    expect(await h.billing.drainPendingNotices(new Date(+due + 61_000))).toEqual({ attempted: 1, delivered: 1 });
    expect(h.state.notificationPayloads.map(n => n.userId)).toEqual(['platform-admin', 'tenant-admin']);
  });


  it.each(['platform', 'missing-user', 'missing-subscription'] as const)('R9 strict tenant resolution distinguishes %s from a resolved tenant subject', async subject => {
    const h = issuedHarness();
    const row = await h.prisma.billingEvent.create({ data: {
      subscriptionId: 'sub-1', type: 'RECONCILE_MISMATCH', idempotencyKey: 'mismatch:subject',
      note: JSON.stringify({ noticeVersion: 1, target: 'admins', title: 'Mismatch', body: 'Review billing evidence',
        data: { kind: 'reconcile_mismatch', subscriptionId: 'sub-1' } }),
    } });
    if (subject === 'missing-subscription') h.prisma.subscription.findUnique.mockResolvedValueOnce(null);
    else h.prisma.user.findUnique.mockResolvedValueOnce(subject === 'platform' ? { tenantId: null } : null);
    h.prisma.user.findMany = vi.fn(async ({ where }: any) => {
      expect(where).toEqual({ status: 'ACTIVE', roles: { has: 'SUPER_ADMIN' } });
      return [{ id: 'platform-admin' }];
    });
    const result = await deliverBillingNotice(h.prisma, h.notifications as any, row, due).catch(() => false);
    expect(result).toBe(subject === 'platform');
    expect(!!row.deliveredAt).toBe(subject === 'platform');
    expect(h.state.notificationPayloads.map(n => n.userId)).toEqual(subject === 'platform' ? ['platform-admin'] : []);
  });

});

describe('R11 billing notice ownership through the real SMS recipient callback', () => {
  // [#1393 outbox] The per-event SMS recipient callback is retired. A payer
  // notice is handed to the fee-demand outbox under its claim; the outbox
  // re-checks the payer, the pause and the obligation under the payer's
  // locks, reserves each channel before its provider call and never re-sends
  // a reserved one. These cases keep R11's recipient schedules on that path:
  // 'subscription' is the payer authority read that opens the hand-off, and
  // 'phone' is the SMS recipient read just before the SMS reservation. (A
  // stall is placed outside any open transaction: the memory tables cannot
  // interleave a rival inside one, which PostgreSQL would serialize on the
  // payer lock.) CLAUDE-legacy-notice-mapping.md maps each case old to new.
  type Entry = 'initial' | 'retry';
  type Lookup = 'subscription' | 'phone';

  async function noticeHarness(entry: Entry) {
    const h = await payerNoticeHarness(entry, 'r11');
    let logical = +due;
    h.state.noticeClock = () => new Date(logical);
    const owner = { current: 'A' };
    const senders: string[] = [];
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      senders.push(owner.current);
      h.sent.push({ channel: 'sms', to, body });
      return { ref: `sms-${owner.current}` };
    });
    const claimed = () => !!h.notice()?.['noticeLeaseToken'] && !h.notice()?.['deliveredAt'];
    return Object.assign(h, {
      owner, senders, claimed,
      clock: () => logical,
      advance: (ms: number) => { logical += ms; },
      retry: () => h.worker().drainPendingNotices(new Date(logical)),
    });
  }
  type NoticeHarness = Awaited<ReturnType<typeof noticeHarness>>;

  /** Run `hook` once at the recipient lookup: before the hand-off transaction
   * opens (subscription) or at the SMS recipient read (phone). */
  function atRecipientLookup(h: NoticeHarness, lookup: Lookup, hook: () => Promise<void>) {
    let calls = 0;
    if (lookup === 'subscription') {
      const transaction = h.prisma.$transaction.getMockImplementation()!;
      h.prisma.$transaction.mockImplementation(async (fn: any) => {
        if (h.claimed()) { calls += 1; if (calls === 1) await hook(); }
        return transaction(fn);
      });
    } else {
      const read = h.prisma.user.findUnique;
      h.prisma.user.findUnique = vi.fn(async (args: any) => {
        if (args?.select?.phone === true && h.notice()?.['deliveredAt']) { calls += 1; if (calls === 1) await hook(); }
        return read(args);
      });
    }
    return () => calls;
  }

  const staleSchedules = (['initial', 'retry'] as const).flatMap(entry =>
    (['subscription', 'phone'] as const).flatMap(lookup => [false, true].map(replacement => ({ entry, lookup, replacement }))));
  it.each(staleSchedules)('R11 $entry: 121-second $lookup lookup suppresses stale SMS (replacement=$replacement)', async ({ entry, lookup, replacement }) => {
    const h = await noticeHarness(entry);
    const lookupCalls = atRecipientLookup(h, lookup, async () => {
      h.advance(121_000);
      if (replacement) {
        h.owner.current = 'B';
        expect(await h.retry()).toMatchObject({ delivered: 1 });
        h.owner.current = 'A';
      }
    });

    await h.start();

    expect(lookupCalls()).toBeGreaterThan(0);
    if (lookup === 'subscription') {
      // A's claim expired during the stall: A hands off nothing. The
      // replacement (or a retry after the cool-down) delivers it once.
      expect(h.senders).toEqual(replacement ? ['B'] : []);
      expect(!!h.notice()!['deliveredAt']).toBe(replacement);
      if (!replacement) {
        expect(h.stages()).toEqual([]);
        h.advance(61_000);
        h.owner.current = 'B';
        expect(await h.retry()).toEqual({ attempted: 1, delivered: 1 });
        expect(h.senders).toEqual(['B']);
      }
    } else {
      // Past the hand-off, the SMS belongs to whoever reserves it first under
      // the payer's lock: the replacement when one ran, else A after its
      // locked re-check. Never both.
      expect(h.senders).toEqual(replacement ? ['B'] : ['A']);
    }
    expect(smsSent(h)).toHaveLength(1);
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.state.events.size).toBe(1);
    expect(smsSent(h)[0]!.body).toContain('At the time');
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([]);
  });

  const callbackSchedules = (['initial', 'retry'] as const).flatMap(entry =>
    (['subscription', 'phone'] as const).map(lookup => ({ entry, lookup })));
  it.each(callbackSchedules)('R11 $entry: after a slow unexpired $lookup lookup the SMS is authorized at the actual provider boundary', async ({ entry, lookup }) => {
    const h = await noticeHarness(entry);
    const trace: string[] = [];
    atRecipientLookup(h, lookup, async () => { h.advance(119_000); trace.push('lookup-done'); });
    const notice = h.prisma.billingFeeNotice.findUnique;
    h.prisma.billingFeeNotice.findUnique = vi.fn(async (args: any) => { trace.push('authorize'); return notice(args); });
    let atSend: { reservation: unknown; stage: unknown; authorizedAfterLookup: boolean } | undefined;
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      atSend = {
        reservation: h.handoff('sms')?.['status'], stage: h.stage()?.['status'],
        authorizedAfterLookup: trace.lastIndexOf('authorize') > trace.indexOf('lookup-done') && trace.includes('lookup-done'),
      };
      h.sent.push({ channel: 'sms', to, body });
      return { ref: 'sms-a' };
    });

    await h.start();

    expect(h.sendSms).toHaveBeenCalledOnce();
    // The provider call was reserved first and authorized by a locked
    // re-check that ran after the slow lookup, on the then-current state.
    expect(atSend).toEqual({ reservation: 'UNKNOWN', stage: 'PENDING', authorizedAfterLookup: true });
    expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
    expect(h.stage()).toMatchObject({ status: 'DELIVERED' });
    expect(h.notice()!['deliveredAt']).toBeTruthy();
  });

  it.each(callbackSchedules)('R11 $entry: transient $lookup lookup failure retains the notice until recovery', async ({ entry, lookup }) => {
    const h = await noticeHarness(entry);
    // The lookup is down until recovery (every matching read fails meanwhile).
    let outage = true;
    const [target, method, matches] = lookup === 'subscription'
      ? [h.prisma.subscription, 'findUniqueOrThrow', (args: any) => !!args?.include?.rider && h.claimed()] as const
      : [h.prisma.user, 'findUnique', (args: any) => args?.select?.phone === true && !!h.notice()?.['deliveredAt']] as const;
    const read = (target as any)[method];
    (target as any)[method] = vi.fn(async (args: any) => {
      if (outage && matches(args)) throw new Error('synthetic recipient lookup outage');
      return read(args);
    });
    await h.start();
    expect(h.sendSms).not.toHaveBeenCalled();
    if (lookup === 'subscription') {
      // The hand-off rolled back: nothing recorded, the intent stays due.
      expect(h.notice()!['deliveredAt']).toBeNull();
      expect(h.stages()).toEqual([]);
    } else {
      // Handed off; the SMS was never reserved, so the stage stays due.
      expect(h.stage()).toMatchObject({ status: 'PENDING' });
      expect(h.handoff('sms')).toBeUndefined();
    }
    outage = false;
    h.advance(61_000);
    expect(await h.retry()).toEqual({ attempted: 1, delivered: 1 });
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.stage()).toMatchObject({ status: 'DELIVERED' });
  });

  it.each(['initial', 'retry'] as const)('R11 %s: payer mismatch cannot send or checkpoint the notice', async entry => {
    const h = await noticeHarness(entry);
    const original = h.prisma.subscription.findUnique.getMockImplementation()!;
    let mismatch = true;
    h.prisma.subscription.findUnique.mockImplementation(async (input: any) => {
      const sub = await original(input);
      return input?.select?.rider && h.claimed() && mismatch
        ? { ...sub, rider: { user: { id: 'other-payer', tenantId: 'swift-default' } } } : sub;
    });
    const phoneReads = vi.fn();
    const read = h.prisma.user.findUnique;
    h.prisma.user.findUnique = vi.fn(async (args: any) => { if (args?.select?.phone === true) phoneReads(); return read(args); });

    await h.start();
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(phoneReads).not.toHaveBeenCalled();
    expect(h.notice()!['deliveredAt']).toBeNull();
    expect(h.stages()).toEqual([]);
    expect(demandInbox(h)).toEqual([]);
    mismatch = false;
    h.advance(61_000);
    expect(await h.retry()).toEqual({ attempted: 1, delivered: 1 });
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.sendSms.mock.calls[0]![0]).toBe(h.state.user.phone);
    expect(demandInbox(h)).toHaveLength(1);
  });
});

describe('R13 final notice renewal result freshness at the real SMS boundary', () => {
  // [#1393 outbox] The final lease renewal before the SMS is retired. The
  // outbox reserves the SMS first (UNKNOWN, committed), then in a second
  // transaction holding the payer's locks re-checks the payer, the pause and
  // the obligation and starts the provider call. R13's schedules now act on
  // that final authorization: delayed, refused, failed, a failed channel, and
  // a provider call accepted with its outcome lost or still in flight. The
  // reservation, not elapsed time, decides who may send; an UNKNOWN outcome is
  // never re-sent. CLAUDE-legacy-notice-mapping.md maps each case old to new.
  type Entry = 'initial' | 'retry';

  async function freshnessHarness(entry: Entry) {
    const h = await payerNoticeHarness(entry, 'r13');
    let logical = +due;
    h.state.noticeClock = () => new Date(logical);
    const owner = { current: 'A' };
    const senders: string[] = [];
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      senders.push(owner.current);
      h.sent.push({ channel: 'sms', to, body });
      return { ref: `sms-${owner.current}` };
    });
    // The SMS's final authorization is the second hand-off transaction: its
    // locked re-check reads the notice once the SMS is already reserved.
    // Every such read reaches the hook, which decides when to act.
    let finalAuthorization: undefined | ((proceed: () => Promise<unknown>) => Promise<unknown>);
    let fired = 0;
    const read = h.prisma.billingFeeNotice.findUnique;
    h.prisma.billingFeeNotice.findUnique = vi.fn(async (args: any) => {
      if (finalAuthorization && h.handoff('sms')?.['status'] === 'UNKNOWN') {
        fired += 1;
        return finalAuthorization(() => read(args));
      }
      return read(args);
    });
    return Object.assign(h, {
      owner, senders,
      fired: () => fired,
      clock: () => logical,
      advance: (ms: number) => { logical += ms; },
      retry: () => h.worker().drainPendingNotices(new Date(logical)),
      onFinalAuthorization: (hook: NonNullable<typeof finalAuthorization>) => { finalAuthorization = hook; },
    });
  }

  const delays = (['initial', 'retry'] as const).flatMap(entry =>
    [119, 120, 121].flatMap(seconds => [false, true].map(replacement => ({ entry, seconds, replacement }))));
  it.each(delays)('R13 $entry: final authorization delayed $seconds seconds sends once, from the reservation holder (replacement=$replacement)', async ({ entry, seconds, replacement }) => {
    const h = await freshnessHarness(entry);
    let rival: { attempted: number; delivered: number } | undefined;
    let acted = false;
    h.onFinalAuthorization(async (proceed) => {
      if (acted) return proceed();
      acted = true;
      h.advance(seconds * 1000);
      if (replacement) {
        h.owner.current = 'B';
        rival = await h.retry();
        h.owner.current = 'A';
      }
      return proceed();
    });

    await h.start();

    expect(h.fired()).toBeGreaterThan(0);
    // Whatever the delay, A holds the SMS reservation: a rival finds it
    // reserved and sends nothing; A's locked re-check still permits it.
    expect(h.senders).toEqual(['A']);
    if (replacement) expect(rival).toMatchObject({ attempted: 1 });
    expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
    expect(h.stage()).toMatchObject({ status: 'DELIVERED' });
    expect(smsSent(h)[0]!.body).toContain('At the time');
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.state.events.size).toBe(1);
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([]);
  });

  const failedRenewals = (['initial', 'retry'] as const).flatMap(entry =>
    (['zero', 'throw'] as const).map(failure => ({ entry, failure })));
  it.each(failedRenewals)('R13 $entry: failed final authorization ($failure) sends nothing and recovers', async ({ entry, failure }) => {
    const h = await freshnessHarness(entry);
    // 'zero': a payment starts confirming just before the final re-check (the
    // re-check refuses); 'throw': the re-check itself fails until recovery.
    let outage = true;
    let confirming = false;
    h.onFinalAuthorization(async (proceed) => {
      if (failure === 'throw' && outage) throw new Error('synthetic final-authorization outage');
      if (failure === 'zero' && !confirming) { confirming = true; await startConfirming(h); }
      return proceed();
    });
    await h.start();
    expect(h.fired()).toBeGreaterThan(0);
    expect(h.sendSms).not.toHaveBeenCalled();
    // Refused before the provider call: provably unsent, so it may go later.
    expect(h.handoff('sms')).toMatchObject({ status: 'NOT_SENT' });
    expect(h.stage()).toMatchObject({ status: 'PENDING' });
    if (failure === 'zero') {
      // MMG answers the request not paid: the pause lifts.
      await h.prisma.$transaction((tx: any) => resolveConfirmationInTx(tx, 'sub-1', { paymentId: 'payment-confirming' }, 'PROVEN_UNPAID',
        { actor: 'synthetic-provider', reference: 'declined' }, new Date(h.clock())));
      h.state.payment = null;
    }
    outage = false;
    h.advance(61_000);
    expect(await h.retry()).toEqual({ attempted: 1, delivered: 1 });
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
    expect(demandInbox(h)).toHaveLength(1);
  });

  const failedChannels = (['initial', 'retry'] as const).flatMap(entry =>
    (['inbox', 'sms'] as const).map(failure => ({ entry, failure })));
  it.each(failedChannels)('R13 $entry: independent $failure recovery preserves the other channel checkpoint', async ({ entry, failure }) => {
    // 'inbox': the inbox's push fails after the inbox row commits; 'sms': the
    // SMS provider fails. Either outcome is UNKNOWN and kept; the other
    // channels' checkpoints stand, and a retry re-sends nothing.
    const h = await freshnessHarness(entry);
    if (failure === 'inbox') h.sendPush.mockRejectedValueOnce(new Error('synthetic push outage'));
    else h.sendSms.mockRejectedValueOnce(new Error('synthetic SMS outage'));
    await h.start();
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.sendPush).toHaveBeenCalledOnce();
    expect(h.handoff(failure === 'inbox' ? 'push' : 'sms')).toMatchObject({ status: 'UNKNOWN' });
    expect(h.handoff(failure === 'inbox' ? 'sms' : 'push')).toMatchObject({ status: 'DELIVERED' });
    expect(h.stage()).toMatchObject({ status: 'PENDING' });
    h.advance(61_000);
    await h.retry();
    expect(h.sendSms).toHaveBeenCalledOnce();
    expect(h.sendPush).toHaveBeenCalledOnce();
    expect(smsSent(h).every((effect) => effect.body.includes('At the time'))).toBe(true);
    expect(h.handoff(failure === 'inbox' ? 'sms' : 'push')).toMatchObject({ status: 'DELIVERED' });
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.state.events.size).toBe(1);
  });

  const ambiguities = (['initial', 'retry'] as const).flatMap(entry =>
    (['lost-ack', 'in-flight-expiry'] as const).map(ambiguity => ({ entry, ambiguity })));
  it.each(ambiguities)('R13 $entry: accepted provider $ambiguity remains explicit and stale checkpoints cannot overwrite the winner', async ({ entry, ambiguity }) => {
    const h = await freshnessHarness(entry);
    let rival: { attempted: number; delivered: number } | undefined;
    let replacementState: string | undefined;
    const effects: Array<{ owner: string; reservedAtSend: boolean }> = [];
    let once = false;
    h.sendSms.mockImplementation(async (to: string, body: string) => {
      effects.push({ owner: h.owner.current, reservedAtSend: h.handoff('sms')?.['status'] === 'UNKNOWN' });
      h.sent.push({ channel: 'sms', to, body });
      if (once) return { ref: 'sms-again' };
      once = true;
      // MMG's SMS provider accepted the message but its answer was lost.
      if (ambiguity === 'lost-ack') throw new Error('synthetic acceptance with lost provider acknowledgement');
      // The provider call is still in flight when a rival worker drains.
      h.advance(121_000);
      h.owner.current = 'B';
      rival = await h.retry();
      replacementState = JSON.stringify(h.handoff('sms'));
      h.owner.current = 'A';
      return { ref: 'sms-a' };
    });
    await h.start();
    if (ambiguity === 'lost-ack') {
      // Kept explicit for reconciliation, never re-sent by a later worker.
      expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
      expect(h.stage()).toMatchObject({ status: 'PENDING' });
      h.advance(61_000);
      h.owner.current = 'B';
      await h.retry();
      expect(h.handoff('sms')).toMatchObject({ status: 'UNKNOWN' });
    } else {
      // The rival found the SMS reserved and wrote nothing over it; the
      // sender's own completion is the only record.
      expect(rival).toMatchObject({ attempted: 1 });
      expect(JSON.parse(replacementState!)).toMatchObject({ status: 'UNKNOWN' });
      expect(h.handoff('sms')).toMatchObject({ status: 'DELIVERED' });
      expect(h.stage()).toMatchObject({ status: 'DELIVERED' });
    }
    expect(effects).toEqual([{ owner: 'A', reservedAtSend: true }]);
    expect(demandInbox(h)).toHaveLength(1);
    expect(h.state.events.size).toBe(1);
    expect(h.state.sub.status).toBe('SUSPENDED');
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([]);
  });
});

describe('R5 affirmative MMG evidence and fair card reconciliation', () => {
  it('push history query carries the payment deadline without authorizing an effect', async () => {
    const h = harness('prior_lookup');
    const createdAt = new Date(due.getTime() - 5 * 60_000);
    const expiresAt = new Date(due.getTime() + 10 * 60_000);
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, createdAt, expiresAt, lastPolledAt: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    const history = vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);
    expect(await h.billing.pollPendingMmgCharges(due)).toMatchObject({ settled: 0, banked: 0, adopted: 0, failed: 0, stillPending: 1 });
    expect(history).toHaveBeenCalledWith({ from: createdAt, to: expiresAt, limit: 100 });
    expect(h.state.payment).toMatchObject({ status: 'UNKNOWN', externalRef: null });
    expect(ledger.keys).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('approved initiate with %s provider id remains a durable hold', async (_label, transactionId) => {
    const h = harness();
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({
      status: 'approved', transactionId,
    } as any);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(h.state.payment).toMatchObject({
      status: 'PENDING', externalRef: null, failureCode: 'SETTLEMENT_MISMATCH',
      failureRaw: {
        providerEffect: 'AUTHORIZED', providerOutcome: 'CAPTURED',
        settlementHold: 'MMG_APPROVAL_MISMATCH',
        providerObservation: { status: 'approved' },
      },
    });
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due, nextRetryAt: null });
    expect(h.state.notifications).not.toContain('billing_failed');
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 2 * WEEK))).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment?.status).toBe('PENDING');
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(vi.mocked(SandboxMmgProvider.prototype.initiatePayment)).toHaveBeenCalledTimes(1);
  });

  it('approved no-id initiate retains its original fact through history recovery and a contrary lookup', async () => {
    const h = harness();
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'approved', transactionId: '' });
    const history = { transactionId: 'history-later', status: 'approved' as const,
      amountMinor: 1, currencyCode: 'USD', reference: h.reference };
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([history]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({ ...history, status: 'declined' });

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    const initialFact = cloneBillingValue((h.state.payment!.failureRaw as any).providerObservation);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 60_000))).toMatchObject({ adopted: 1, failed: 0 });
    expect(h.state.payment).toMatchObject({ status: 'PENDING', externalRef: 'history-later',
      failureCode: 'SETTLEMENT_MISMATCH', failureRaw: { providerObservation: initialFact } });
    expect([...h.state.events.values()].filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'))).toHaveLength(2);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + WEEK))).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null });
    expect(h.state.notifications).not.toContain('billing_failed');
  });

  it.each([
    ['amount', { amountMinor: 1 }],
    ['currency', { currencyCode: 'USD' }],
    ['missing id', { transactionId: '' }],
  ])('approved history %s is held before a contradictory declined lookup', async (_label, patch) => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    h.state.events.set(`charge:${h.reference.slice(4)}`, {
      type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100,
    });
    const evidence = {
      transactionId: 'history-approved', status: 'approved' as const,
      amountMinor: 210000, currencyCode: 'GYD', reference: h.reference, ...patch,
    };
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([evidence]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({ ...evidence, status: 'declined' });

    await h.billing.pollPendingMmgCharges(due);
    expect(h.state.payment).toMatchObject({
      failureRaw: {
        providerEffect: 'AUTHORIZED', providerOutcome: 'CAPTURED',
        providerObservation: evidence,
      },
    });
    expect(['PENDING', 'UNKNOWN']).toContain(h.state.payment?.status);
    expect([...h.state.events.values()].filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
    const firstObservation = cloneBillingValue(h.state.payment!.failureRaw);
    const later = await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 86_400_000));
    expect(later.failed).toBe(0);
    expect(h.state.payment?.failureRaw).toMatchObject(firstObservation as any);
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null });
    expect(h.state.notifications).not.toContain('billing_failed');
    expect([...h.state.events.values()].filter(event => event['type'] === 'CHARGE_FAILED')).toEqual([]);
  });

  it('duplicate no-id approved history keeps one hold and one evidence event beyond TTL', async () => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    h.state.events.set(`charge:${h.reference.slice(4)}`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100 });
    const evidence = { transactionId: '', status: 'approved' as const, amountMinor: 1, currencyCode: 'USD', reference: h.reference };
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([evidence]);
    for (const tick of [0, 1, 2]) {
      expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + tick * WEEK))).toMatchObject({ failed: 0 });
    }
    expect(h.state.payment).toMatchObject({ status: 'UNKNOWN', externalRef: null, failureRaw: {
      settlementHold: 'MMG_HISTORY_APPROVAL_UNVERIFIED', providerObservation: evidence,
    } });
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
    expect(h.state.sub.failedAttempts).toBe(0);
  });

  it('approved history arriving after another ID adoption still quarantines a later negative lookup', async () => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    h.state.events.set(`charge:${h.reference.slice(4)}`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100 });
    const arrived = deferred();
    const release = deferred();
    const evidence = { transactionId: 'history-approved', status: 'approved' as const,
      amountMinor: 1, currencyCode: 'USD', reference: h.reference };
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      return [evidence];
    });
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({ ...evidence, status: 'declined' });

    const polling = h.billing.pollPendingMmgCharges(due);
    await arrived.promise;
    Object.assign(h.state.payment!, { status: 'PENDING', externalRef: 'history-approved' });
    release.resolve();
    expect(await polling).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment?.failureRaw).toMatchObject({ providerOutcome: 'CAPTURED', providerObservation: evidence });
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + WEEK))).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment?.status).toBe('PENDING');
    expect(h.state.sub.failedAttempts).toBe(0);
  });

  it('history with a different merchant reference cannot be adopted or settle the intent', async () => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([{
      transactionId: 'unrelated-approved', status: 'approved', amountMinor: 210000,
      currencyCode: 'GYD', reference: 'sub:another-payer:2026-09-20:a0',
    }]);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + WEEK))).toMatchObject({ adopted: 0, failed: 0, stillPending: 1 });
    expect(h.state.payment).toMatchObject({ status: 'UNKNOWN', externalRef: null });
    expect(h.state.wallet).toBe(0);
  });

  it('a complete matching approved lookup resolves only its own provisional history hold', async () => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { status: 'UNKNOWN', externalRef: null, failureRaw: { providerEffect: 'AUTHORIZED' } });
    h.state.events.set(`charge:${h.reference.slice(4)}`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD', amount: 2100 });
    const evidence = { transactionId: 'history-matched', status: 'approved' as const,
      amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([evidence]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(evidence);

    expect(await h.billing.pollPendingMmgCharges(due)).toMatchObject({ adopted: 1, settled: 0 });
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: 'HISTORY_APPROVAL_UNVERIFIED',
      failureRaw: { settlementHold: 'MMG_HISTORY_APPROVAL_UNVERIFIED', providerObservation: evidence } });
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 3_600_000))).toMatchObject({ settled: 1, failed: 0 });
    expect(h.state.payment?.status).toBe('CAPTURED');
    expect((h.state.payment?.failureRaw as any).settlementHold).toBeUndefined();
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.sub.nextBillingDate).toEqual(new Date(due.getTime() + WEEK));
  });

  it('card row 201 is polled on the next run while older authorized absences stay UNKNOWN', async () => {
    const h = harness('prior_lookup');
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: `payment-${index}`, subscriptionId: h.state.sub.id, amount: 2100,
      paymentMethod: 'CARD', status: 'UNKNOWN', clientKey: `card-${index}`,
      externalRef: null, periodStart: due, periodEnd: new Date(due.getTime() + WEEK),
      createdAt: new Date(due.getTime() + index), expiresAt: new Date(due.getTime() + 3 * WEEK),
      lastPolledAt: null as Date | null, failureRaw: { providerEffect: 'AUTHORIZED' },
    }));
    const queries: any[] = [];
    h.prisma.subscriptionPayment.findMany.mockImplementation(async (query: any) => {
      queries.push(query);
      const order = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy];
      const byLastPoll = order.some((part: any) => part?.lastPolledAt);
      return rows.filter(row => row.status === 'UNKNOWN').sort((a, b) => {
        if (byLastPoll) {
          if (a.lastPolledAt === null && b.lastPolledAt !== null) return -1;
          if (a.lastPolledAt !== null && b.lastPolledAt === null) return 1;
          if (a.lastPolledAt && b.lastPolledAt) {
            const delta = a.lastPolledAt.getTime() - b.lastPolledAt.getTime();
            if (delta) return delta;
          }
        }
        return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
      }).slice(0, query.take).map(row => ({ ...row }));
    });
    h.prisma.subscriptionPayment.updateMany.mockImplementation(async ({ where, data }: any) => {
      const row = rows.find(candidate => candidate.id === where.id);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    h.prisma.subscriptionPayment.findFirst.mockImplementation(async () => rows.find(row => row.status === 'UNKNOWN') ?? null);
    h.prisma.subscriptionPayment.count.mockImplementation(async () => rows.filter(row => row.status === 'UNKNOWN').length);
    const lookups: string[] = [];
    (h.billing as any).payments = { lookupCharge: vi.fn(async ({ idempotencyKey }: any) => {
      lookups.push(idempotencyKey);
      return idempotencyKey === 'card-200'
        ? { status: 'succeeded', providerRef: 'captured-row-201' }
        : { status: 'not_found' };
    }) };
    vi.spyOn(h.billing as any, 'pinnedTrioFor').mockResolvedValue(undefined);
    vi.spyOn(h.billing as any, 'applySuccessfulCharge').mockImplementation(async () => {
      rows[200]!.status = 'CAPTURED';
      return true;
    });

    expect(await h.billing.reconcileUnknownCardCharges(due)).toMatchObject({ settled: 0, stillUnknown: 200 });
    expect(rows.slice(0, 200).every(row => row.status === 'UNKNOWN')).toBe(true);
    expect(rows[200]!.lastPolledAt).toBeNull();
    expect(await h.billing.reconcileUnknownCardCharges(new Date(due.getTime() + 60_000))).toMatchObject({ settled: 1 });
    expect(lookups).toContain('card-200');
    expect(rows[200]!.status).toBe('CAPTURED');
    expect(queries[0]?.take).toBe(200);
  });
});

describe('R6 approved initiation with a usable MMG identifier', () => {
  const approvedId = 'initiate-approved-id';

  function approvedInitiate(h: ReturnType<typeof harness>) {
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'approved', transactionId: approvedId });
    return { transactionId: approvedId, status: 'approved' as const,
      amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
  }

  it.each(['declined', 'reversed', 'expired', 'lookup error', 'local TTL'] as const)(
    'retains approved initiation before %s and never duns or reissues', async contrary => {
      const h = harness();
      const matching = approvedInitiate(h);
      const lookup = vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup');
      if (contrary === 'lookup error') lookup.mockRejectedValue(new Error('synthetic lookup outage'));
      else lookup.mockResolvedValue({ ...matching, status: contrary === 'local TTL' ? 'pending' : contrary });

      expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
      expect(h.state.payment).toMatchObject({ status: 'PENDING', externalRef: approvedId,
        failureRaw: { providerObservation: { status: 'approved', transactionId: approvedId } } });
      expect((h.state.payment?.failureRaw as any).settlementHold).toBeTruthy();
      expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
      expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due, nextRetryAt: null });
      expect(h.state.notifications).not.toContain('billing_mmg_pending');

      const poll = await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 2 * WEEK));
      expect(poll.failed).toBe(0);
      expect(h.state.payment?.status).toBe('PENDING');
      expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextBillingDate: due, nextRetryAt: null });
      expect(h.state.notifications).not.toContain('billing_failed');
      expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
      expect(vi.mocked(SandboxMmgProvider.prototype.initiatePayment)).toHaveBeenCalledTimes(1);
    },
  );

  it('settles only after a matching authoritative lookup and deduplicates the initiation observation', async () => {
    const h = harness();
    const matching = approvedInitiate(h);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(matching);

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    const first = cloneBillingValue(h.state.payment!.failureRaw);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(ledger.keys).toEqual([]);
    expect(await (h.billing as any).retainMmgHistoryApproval(
      { ...h.state.sub }, h.state.payment!.id,
      { status: 'approved', transactionId: approvedId }, due, 'initiate', h.reference,
    )).toBe('held');
    expect(h.state.payment?.failureRaw).toMatchObject(first as any);
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);

    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 3_600_000))).toMatchObject({ settled: 1, failed: 0 });
    expect(h.state.payment?.status).toBe('CAPTURED');
    expect((h.state.payment?.failureRaw as any).settlementHold).toBeUndefined();
    expect(h.state.sub.nextBillingDate).toEqual(new Date(due.getTime() + WEEK));
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.notifications).not.toContain('billing_failed');
  });

  it('commits the identifier and positive observation together or neither', async () => {
    const h = harness();
    approvedInitiate(h);
    let refuse = true;
    vi.mocked(SandboxMmgProvider.prototype.initiatePayment).mockImplementation(async () => {
      h.barriers.beforeCommit = async () => {
        if (refuse) { refuse = false; throw new Error('synthetic observation commit refusal'); }
      };
      return { status: 'approved', transactionId: approvedId };
    });

    await expect(h.billing.billSubscription({ ...h.state.sub } as any, due)).rejects.toThrow('synthetic observation commit refusal');
    expect(h.state.payment).toMatchObject({ status: 'UNKNOWN', externalRef: null });
    expect((h.state.payment?.failureRaw as any)?.providerObservation).toBeUndefined();
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(0);
    expect(h.state.sub.failedAttempts).toBe(0);

    expect(await (h.billing as any).retainMmgHistoryApproval(
      { ...h.state.sub }, h.state.payment!.id,
      { status: 'approved', transactionId: approvedId }, due, 'initiate', h.reference,
    )).toBe('adopted');
    expect(h.state.payment).toMatchObject({ status: 'PENDING', externalRef: approvedId,
      failureRaw: { providerObservation: { status: 'approved', transactionId: approvedId } } });
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
  });

  it.each(['CANCELLED', 'BANNED_TOMBSTONE'] as const)(
    'retains a late approved initiation after %s without restoring service', async authority => {
      const h = harness();
      const initiated = deferred<{ status: 'approved'; transactionId: string }>();
      vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockReturnValue(initiated.promise);
      const bill = h.billing.billSubscription({ ...h.state.sub } as any, due);
      await vi.waitFor(() => expect(vi.mocked(SandboxMmgProvider.prototype.initiatePayment)).toHaveBeenCalledOnce());
      applyAuthority(h.state, authority);
      initiated.resolve({ status: 'approved', transactionId: approvedId });

      expect(await bill).toBe('pending');
      expect(h.state.payment).toMatchObject({ status: 'PENDING', externalRef: approvedId,
        failureRaw: { providerObservation: { status: 'approved', transactionId: approvedId } } });
      expect(h.state.sub.status).toBe('CANCELLED');
      expect(h.state.sub.autoRenew).toBe(false);
      expect(h.state.sub.nextBillingDate).toEqual(due);
      expect(h.state.sub.failedAttempts).toBe(0);
      expect(h.state.notifications).not.toContain('billing_mmg_pending');
      expect(h.state.notifications).not.toContain('billing_failed');
    },
  );

  it('an overlapping negative observer cannot terminalize after the positive initiation commits', async () => {
    const h = harness();
    const matching = approvedInitiate(h);
    const initiated = deferred<{ status: 'approved'; transactionId: string }>();
    vi.mocked(SandboxMmgProvider.prototype.initiatePayment).mockReturnValue(initiated.promise);
    const lookupEntered = deferred();
    const releaseLookup = deferred();
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      lookupEntered.resolve();
      await releaseLookup.promise;
      return { ...matching, status: 'declined' };
    });
    const bill = h.billing.billSubscription({ ...h.state.sub } as any, due);
    await vi.waitFor(() => expect(vi.mocked(SandboxMmgProvider.prototype.initiatePayment)).toHaveBeenCalledOnce());
    expect(await (h.billing as any).adoptMmgHistoryId({ ...h.state.sub }, h.state.payment!.id,
      { ...matching, status: 'pending' })).toBe(true);
    const polling = h.billing.pollPendingMmgCharges(new Date(due.getTime() + WEEK));
    await lookupEntered.promise;
    initiated.resolve({ status: 'approved', transactionId: approvedId });
    expect(await bill).toBe('pending');
    releaseLookup.resolve();

    expect(await polling).toMatchObject({ failed: 0 });
    const secondAttempt = h.billing.billSubscription({ ...h.state.sub } as any, due);
    expect(await secondAttempt).toBe('pending');
    expect(h.state.payment?.status).toBe('PENDING');
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.notifications).not.toContain('billing_failed');
    expect(vi.mocked(SandboxMmgProvider.prototype.initiatePayment)).toHaveBeenCalledTimes(1);
  });
});

describe('R7 approved initiation against an independently captured MMG ID', () => {
  const historyId = 'history-approved-id';
  const distinctId = 'initiate-other-approved-id';

  function historyApproval(h: ReturnType<typeof harness>) {
    return { transactionId: historyId, status: 'approved' as const,
      amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
  }

  it.each([
    ['A-before-distinct-B', 'after-capture', distinctId, true],
    ['distinct-B-before-A', 'before-capture', distinctId, true],
    ['A-before-same-A', 'after-capture', historyId, false],
    ['same-A-before-A', 'before-capture', historyId, false],
  ] as const)('%s retains the right evidence and one financial disposition', async (_label, order, initiateId, distinct) => {
    const h = harness();
    h.prisma.user.findMany.mockResolvedValue([{ id: 'synthetic-admin' }]);
    const entered = deferred();
    const initiated = deferred<{ status: 'approved'; transactionId: string }>();
    const initiate = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
      entered.resolve();
      return initiated.promise;
    });
    const history = historyApproval(h);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([history]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(history);

    const bill = h.billing.billSubscription({ ...h.state.sub } as any, due);
    await entered.promise;
    expect(await h.billing.pollPendingMmgCharges(due)).toMatchObject({ adopted: 1, settled: 0 });
    if (order === 'after-capture') {
      expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 3_600_000))).toMatchObject({ settled: 1 });
    }
    const capturedAt = order === 'after-capture' ? (h.state.payment as any).paidAt : null;
    const issuedMoney = { amount: h.state.payment!.amount, periodStart: h.state.payment!.periodStart,
      periodEnd: h.state.payment!.periodEnd };
    initiated.resolve({ status: 'approved', transactionId: initiateId });
    expect(await bill).toBe('pending');
    if (order === 'before-capture') {
      expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 3_600_000))).toMatchObject({
        settled: distinct ? 0 : 1, failed: 0,
      });
    }

    const evidenceEvents = [...h.state.events.values()]
      .filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'));
    const observedIds = evidenceEvents.map(event => JSON.parse(event['note']).providerObservation.transactionId);
    expect(observedIds).toContain(historyId);
    if (distinct) expect(observedIds).toContain(distinctId);
    else expect(new Set(observedIds)).toEqual(new Set([historyId]));
    expect(h.state.payment).toMatchObject({
      status: order === 'after-capture' || !distinct ? 'CAPTURED' : 'PENDING',
      externalRef: historyId,
      failureCode: distinct ? 'SETTLEMENT_MISMATCH' : null,
    });
    if (distinct) {
      expect(h.state.payment?.failureRaw).toMatchObject({
        settlementHold: 'MMG_APPROVAL_MISMATCH', recoveryDisposition: 'MANUAL_RECONCILIATION',
      });
      expect(h.state.events.has('mismatch:payment-1')).toBe(true);
    } else {
      expect((h.state.payment?.failureRaw as any)?.settlementHold).toBeUndefined();
    }
    if (capturedAt) expect((h.state.payment as any).paidAt).toEqual(capturedAt);
    expect(h.state.payment).toMatchObject(issuedMoney);
    expect(h.state.sub).toMatchObject({
      failedAttempts: 0, nextRetryAt: null,
      nextBillingDate: distinct && order === 'before-capture' ? due : new Date(due.getTime() + WEEK),
    });
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual(distinct && order === 'before-capture' ? [] : [`ledger:success:sub-1:${h.periodKey}`]);
    expect(h.state.notifications.filter(kind => kind === 'billing_success')).toHaveLength(distinct && order === 'before-capture' ? 0 : 1);
    expect(h.state.notificationPayloads.filter(notice => notice.data?.kind === 'reconcile_mismatch')).toHaveLength(distinct ? 1 : 0);
    expect(h.state.notifications).not.toContain('billing_failed');
    expect([...h.state.events.keys()].filter(key => key.startsWith('bank:'))).toEqual([]);
    expect([...h.state.events.keys()].filter(key => key.startsWith('success:'))).toHaveLength(distinct && order === 'before-capture' ? 0 : 1);

    const eventCount = evidenceEvents.length;
    expect(await (h.billing as any).retainMmgHistoryApproval(
      { ...h.state.sub }, h.state.payment!.id,
      { status: 'approved', transactionId: initiateId }, due, 'initiate', h.reference,
    )).toBe(distinct ? 'held' : 'lost');
    expect([...h.state.events.keys()].filter(key => key.startsWith('mmg-approval-evidence:'))).toHaveLength(eventCount);
    expect(h.state.notificationPayloads.filter(notice => notice.data?.kind === 'reconcile_mismatch')).toHaveLength(distinct ? 1 : 0);
    if (distinct) {
      expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
      expect(initiate).toHaveBeenCalledTimes(1);
    }
  });

  it('rolls back a captured-row contradiction and accepts its exact retry once', async () => {
    const h = harness();
    const entered = deferred();
    const initiated = deferred<{ status: 'approved'; transactionId: string }>();
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
      entered.resolve();
      return initiated.promise;
    });
    const history = historyApproval(h);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([history]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue(history);
    const bill = h.billing.billSubscription({ ...h.state.sub } as any, due);
    await entered.promise;
    await h.billing.pollPendingMmgCharges(due);
    expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 3_600_000))).toMatchObject({ settled: 1 });
    const paidAt = (h.state.payment as any).paidAt;
    let refuse = true;
    h.barriers.beforeCommit = async () => {
      if (refuse) { refuse = false; throw new Error('synthetic captured mismatch commit refusal'); }
    };
    initiated.resolve({ status: 'approved', transactionId: distinctId });
    await expect(bill).rejects.toThrow('synthetic captured mismatch commit refusal');
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', externalRef: historyId, failureCode: null });
    expect((h.state.payment as any).paidAt).toEqual(paidAt);
    expect([...h.state.events.values()].filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'))).toHaveLength(1);
    expect(h.state.events.has('mismatch:payment-1')).toBe(false);
    expect(ledger.keys).toEqual([`ledger:success:sub-1:${h.periodKey}`]);

    expect(await (h.billing as any).retainMmgHistoryApproval(
      { ...h.state.sub }, h.state.payment!.id,
      { status: 'approved', transactionId: distinctId }, due, 'initiate', h.reference,
    )).toBe('held');
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', externalRef: historyId,
      failureCode: 'SETTLEMENT_MISMATCH', failureRaw: { settlementHold: 'MMG_APPROVAL_MISMATCH' } });
    expect([...h.state.events.values()].filter(event => event['idempotencyKey']?.startsWith('mmg-approval-evidence:'))).toHaveLength(2);
    expect(h.state.events.has('mismatch:payment-1')).toBe(true);
    expect(ledger.keys).toEqual([`ledger:success:sub-1:${h.periodKey}`]);
  });
});

const DAY_FOR_R3 = 86_400_000;

describe('EDFDCAB3 R2 dispatch, currency and oracle regressions', () => {
  it.each(['ACTIVE', 'CANCELLED'] as const)('R2 expiry cannot discard a card capture returned after dispatch under %s authority', async status => {
    const h = harness();
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    let duringExpiry: unknown;
    const chargeToken = vi.fn(async () => {
      if (status === 'CANCELLED') applyAuthority(h.state, 'CANCELLED');
      const result = await h.billing.reconcileUnknownCardCharges(new Date(due.getTime() + 2 * 86_400_000));
      duringExpiry = { ...result, paymentStatus: h.state.payment!.status };
      return { status: 'succeeded', providerRef: 'synthetic-r2-capture' };
    });
    (h.billing as any).payments = { chargeToken, lookupCharge: vi.fn(async () => ({ status: 'not_found' })) };

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('succeeded');
    expect(duringExpiry).toMatchObject({ expired: 0, stillUnknown: 1, paymentStatus: 'UNKNOWN' });
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', externalRef: 'synthetic-r2-capture' });
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.wallet).toBe(status === 'CANCELLED' ? 2100 : 0);
    expect(h.state.sub.nextBillingDate).toEqual(status === 'CANCELLED' ? due : new Date(due.getTime() + WEEK));
    expect(await h.billing.reconcileUnknownCardCharges()).toMatchObject({ settled: 0 });
    expect(ledger.keys).toHaveLength(1);
    expect(chargeToken).toHaveBeenCalledOnce();
  });

  it('R2 a crash after authorized card dispatch stays pollable past TTL and settles once after restart', async () => {
    const h = harness();
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    const lookupCharge = vi.fn(async (): Promise<{ status: string; providerRef?: string }> => ({ status: 'not_found' }));
    (h.billing as any).payments = { lookupCharge, chargeToken: vi.fn(async () => { throw new Error('synthetic process loss'); }) };
    await expect(h.billing.billSubscription({ ...h.state.sub } as any, due)).rejects.toThrow('synthetic process loss');
    const later = new Date(due.getTime() + 2 * 86_400_000);
    expect(await h.billing.reconcileUnknownCardCharges(later)).toMatchObject({ expired: 0, stillUnknown: 1 });
    expect(h.state.payment?.status).toBe('UNKNOWN');
    lookupCharge.mockResolvedValue({ status: 'succeeded', providerRef: 'synthetic-recovered' });
    expect(await h.billing.reconcileUnknownCardCharges(later)).toMatchObject({ settled: 1 });
    expect(await h.billing.reconcileUnknownCardCharges(later)).toMatchObject({ settled: 0 });
    expect(ledger.keys).toHaveLength(1);
  });

  it.each(['CARD', 'MOBILE_MONEY'] as const)('R2 ambiguous %s response preserves dispatch evidence through empty lookup after TTL', async rail => {
    const h = harness();
    if (rail === 'CARD') {
      Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
      (h.billing as any).payments = {
        chargeToken: vi.fn(async () => ({ status: 'unknown', providerRef: '', reason: 'synthetic timeout' })),
        lookupCharge: vi.fn(async () => ({ status: 'not_found' })),
      };
    } else {
      vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'error', transactionId: '', reason: 'synthetic timeout' });
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);
    }
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(h.state.payment?.failureRaw).toMatchObject({ providerEffect: 'AUTHORIZED', reason: 'synthetic timeout' });
    const later = new Date(due.getTime() + 2 * 86_400_000);
    if (rail === 'CARD') expect(await h.billing.reconcileUnknownCardCharges(later)).toMatchObject({ expired: 0, stillUnknown: 1 });
    else expect(await h.billing.pollPendingMmgCharges(later)).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment?.status).toBe('UNKNOWN');
    expect(h.state.sub.failedAttempts).toBe(0);
  });

  it('R2 MMG dispatch survives expiry before its provider id returns and remains pollable while the provider says pending', async () => {
    const h = harness();
    const later = new Date(due.getTime() + 3 * 86_400_000);
    let duringExpiry: unknown;
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);
    const lookup = vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({ transactionId: 'synthetic-r2-mmg', status: 'pending', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference });
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
      duringExpiry = await h.billing.pollPendingMmgCharges(later);
      return { status: 'approved', transactionId: 'synthetic-r2-mmg' };
    });
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(duringExpiry).toMatchObject({ failed: 0, stillPending: 1 });
    h.state.payment!.expiresAt = due;
    expect(await h.billing.pollPendingMmgCharges(new Date(later.getTime() + 86_400_000))).toMatchObject({ failed: 0, stillPending: 1 });
    expect(h.state.payment).toMatchObject({ status: 'PENDING', externalRef: 'synthetic-r2-mmg' });
    lookup.mockResolvedValue({ transactionId: 'synthetic-r2-mmg', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference });
    expect(await h.billing.pollPendingMmgCharges(new Date(later.getTime() + 2 * 86_400_000))).toMatchObject({ settled: 1 });
    expect(await h.billing.pollPendingMmgCharges(new Date(later.getTime() + 3 * 86_400_000))).toMatchObject({ settled: 0 });
    expect(ledger.keys).toHaveLength(1);
    expect(h.state.sub.failedAttempts).toBe(0);
  });

  it.each(['CARD', 'MOBILE_MONEY'] as const)('R2 expiry winning before %s dispatch prevents the provider call', async rail => {
    const h = harness();
    const card = vi.fn();
    const mmg = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment');
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);
    if (rail === 'CARD') Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    (h.billing as any).payments = { chargeToken: card, lookupCharge: vi.fn(async () => ({ status: 'not_found' })) };
    (h.billing as any).observer = { beforeProviderEffectAuthorization: async () => {
      const later = new Date(due.getTime() + 2 * 86_400_000);
      if (rail === 'CARD') await h.billing.reconcileUnknownCardCharges(later);
      else await h.billing.pollPendingMmgCharges(later);
    } };
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('skipped');
    expect(h.state.payment?.status).toBe('EXPIRED');
    expect(card).not.toHaveBeenCalled();
    expect(mmg).not.toHaveBeenCalled();
  });

  it.each(['CARD', 'MOBILE_MONEY'] as const)('R2 legacy %s intent without dispatch metadata remains ambiguous after TTL', async rail => {
    const h = harness('prior_lookup');
    Object.assign(h.state.payment!, { paymentMethod: rail, status: 'UNKNOWN', externalRef: null, failureRaw: null });
    const later = new Date(h.state.payment!.expiresAt.getTime() + 1);
    if (rail === 'CARD') {
      (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'not_found' })) };
      expect(await h.billing.reconcileUnknownCardCharges(later)).toMatchObject({ expired: 0, stillUnknown: 1 });
    } else {
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockResolvedValue([]);
      expect(await h.billing.pollPendingMmgCharges(later)).toMatchObject({ failed: 0, stillPending: 1 });
    }
    expect(h.state.payment?.status).toBe('UNKNOWN');
    expect(h.state.sub.failedAttempts).toBe(0);
  });

  it.each(['CARD', 'MOBILE_MONEY'] as const)('R2 holds a captured GYD %s payment against an existing TTD wallet without losing capture evidence', async rail => {
    const h = harness('prior_lookup');
    h.state.wallet = 100;
    h.state.walletCurrency = 'TTD';
    h.state.sub.currencyCode = 'TTD';
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD' });
    h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS', paymentRef: 'prepaid' });
    if (rail === 'CARD') Object.assign(h.state.payment!, { paymentMethod: 'CARD', status: 'UNKNOWN', externalRef: null, clientKey: `card:sub-1:${h.periodKey}:a0` });
    const settle = () => rail === 'CARD'
      ? (h.billing as any).applySuccessfulCharge({ ...h.state.sub }, 2100, 'synthetic-held-card', due, h.periodKey, h.state.payment!.id)
      : (h.billing as any).settleApprovedMmgPayment({ ...h.state.sub }, h.state.payment!.id,
        { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference }, due);
    expect(await settle()).toBe(rail === 'CARD' ? false : 'held');
    expect(await settle()).toBe(rail === 'CARD' ? false : 'held');
    expect(h.state.payment).toMatchObject({
      status: rail === 'CARD' ? 'UNKNOWN' : 'PENDING', failureCode: 'WALLET_CURRENCY_MISMATCH',
      externalRef: rail === 'CARD' ? 'synthetic-held-card' : 'mmgtx-prior',
      failureRaw: { providerOutcome: 'CAPTURED', currencyCode: 'GYD', recoveryDisposition: 'MANUAL_RECONCILIATION' },
    });
    expect(h.state.wallet).toBe(100);
    expect(h.state.walletCurrency).toBe('TTD');
    expect(h.state.events.get('bank:payment-1')).toBeUndefined();
    expect(h.state.events.get('wallet-currency:payment-1')).toMatchObject({ currencyCode: 'GYD', amount: 2100 });
    expect(ledger.keys).toEqual([]);
    expect(issueReceipt).not.toHaveBeenCalled();
    // Model the conflicting TTD liability being separately resolved, leaving
    // an empty GYD wallet. No exchange or relabelling of the TTD 100 is implied.
    h.state.wallet = 0;
    h.state.walletCurrency = 'GYD';
    expect(await settle()).toBe(rail === 'CARD' ? true : 'banked');
    expect(await settle()).toBe(rail === 'CARD' ? false : 'lost');
    expect(h.state.wallet).toBe(2100);
    expect(h.state.payment?.status).toBe('CAPTURED');
    expect(ledger.keys).toEqual(['ledger:bank:payment-1']);
    expect(issueReceipt).toHaveBeenCalledOnce();
  });

  it.each([0, 100])('R2 a direct GYD topup refuses a TTD wallet with balance %s atomically', async balance => {
    const h = harness();
    Object.assign(h.state, { wallet: balance, walletCurrency: 'TTD', walletExists: true });
    await expect(h.prisma.$transaction((tx: any) => h.billing.recordTopUpInTransaction(tx, {
      subscriptionId: 'sub-1', amount: 2100, recordedBy: 'synthetic-admin', eventKey: 'synthetic-currency-credit',
    }))).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH' });
    expect(h.state.wallet).toBe(balance);
    expect(h.state.walletCurrency).toBe('TTD');
    expect(h.state.events.size).toBe(0);
    expect(issueReceipt).not.toHaveBeenCalled();
    expect(ledger.keys).toEqual([]);
  });

  it.each(['selection', 'debit'] as const)('R2 GYD wallet cannot fund a TTD week at %s', async boundary => {
    const h = harness();
    h.state.wallet = 5000;
    Object.assign(h.state.sub, { currencyCode: 'TTD', billingMethod: 'CASH' });
    if (boundary === 'selection') {
      await expect((h.billing as any).attemptCharge({ ...h.state.sub }, 2100, due)).rejects.toMatchObject({ code: 'WALLET_CURRENCY_MISMATCH' });
    } else {
      await expect((h.billing as any).applySuccessfulCharge({ ...h.state.sub }, 2100, 'prepaid', due, h.periodKey, undefined, undefined, 2100)).rejects.toThrow(/prepaid balance/);
    }
    expect(h.state.wallet).toBe(5000);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(ledger.keys).toEqual([]);
  });

  it('R2 same-currency topups remain atomic and duplicate credit rolls its balance write back', async () => {
    const h = harness();
    h.state.wallet = 100;
    const credit = () => h.prisma.$transaction((tx: any) => h.billing.recordTopUpInTransaction(tx, {
      subscriptionId: 'sub-1', amount: 2100, recordedBy: 'synthetic-admin', eventKey: 'synthetic-same-currency',
    }));
    expect(await credit()).toMatchObject({ balance: 2200, currencyCode: 'GYD' });
    await expect(credit()).rejects.toMatchObject({ code: 'P2002' });
    expect(h.state.wallet).toBe(2200);
    expect(ledger.keys).toEqual(['ledger:synthetic-same-currency']);
    expect(issueReceipt).toHaveBeenCalledOnce();
  });

  it.each([false, true])('R2 actual PostgreSQL lock-order fixture setup leaves the observer unarmed (mutation %s)', async removePrepaidLock => {
    const source = readFileSync(`${__dirname}/billing-intent-machine.test.ts`, 'utf8');
    const testStart = source.indexOf("'proves PostgreSQL lock ordering against an arrived poller");
    const bodyStart = source.indexOf('const due =', testStart);
    const raceStart = source.indexOf('const late = concurrent.pollPendingMmgCharges(', bodyStart);
    expect(testStart >= 0 && bodyStart > testStart && raceStart > bodyStart).toBe(true);
    const prefix = source.slice(bodyStart, raceStart);
    // Execute the real fixture setup, stopping before its PostgreSQL race.
    // Resolved barriers let us inspect an erroneously armed observer without
    // treating a timeout as proof. The real race remains a separate DB gate.
    const h = harness('initiate', true);
    h.prisma.subscriptionPayment.findFirstOrThrow = async () => h.state.payment;
    h.prisma.prepaidBalance.create = async ({ data }: any) => { h.state.wallet = data.balance; };
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'pending', transactionId: 'synthetic-fixture' });
    const code = ts.transpile(`async function setup(removePrepaidLocks) { ${prefix}\nreturn { lateHolding, prepaidDebitedWhileLateHeld, latePid }; }`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
    const setup = new Function('BillingService', 'NotificationService', 'app', 'billing', 'getPaymentProvider', 'makeVendorMmgSub', 'subWithRelations', 'sandboxSetTxStatus', 'deferred', 'expect', 'vi', 'HOUR', `${code}; return setup;`)(
      BillingService, class { send = vi.fn(); }, { prisma: h.prisma, io: {} }, h.billing,
      () => ({}), async () => ({ sub: h.state.sub }), async () => ({ ...h.state.sub }), () => {},
      () => ({ promise: Promise.resolve(), resolve: () => {} }), expect, vi, 3_600_000,
    );
    expect(await setup(removePrepaidLock)).toEqual({ lateHolding: false, prepaidDebitedWhileLateHeld: false, latePid: 0 });
    expect(h.state.payment?.status).toBe('PENDING');
  });
});

describe('independent six-finding repair regressions', () => {
  function cardHarness() {
    const h = harness('prior_lookup');
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    Object.assign(h.state.payment!, { paymentMethod: 'CARD', status: 'UNKNOWN', clientKey: `card:sub-1:${h.periodKey}:a0`, externalRef: null, createdAt: due, expiresAt: new Date(due.getTime() + 60_000) });
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { type: 'CHARGE_ATTEMPT', currencyCode: 'GYD' });
    return h;
  }

  it.each(['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const)('F1 card captured after %s banks exactly once without access or success notice', async authority => {
    const h = cardHarness();
    applyAuthority(h.state, authority);
    const stopped = h.state.sub.status;
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'succeeded', providerRef: 'synthetic-captured' })) };
    expect(await h.billing.reconcileUnknownCardCharges(due)).toMatchObject({ settled: 1, stillUnknown: 0 });
    expect(await h.billing.reconcileUnknownCardCharges(due)).toMatchObject({ settled: 0, stillUnknown: 0 });
    expect(h.state.payment?.status).toBe('CAPTURED');
    expect(h.state.wallet).toBe(2100);
    expect(h.state.sub.status).toBe(stopped);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(ledger.postings).toEqual([[{ account: 'CLEARING_CARD', debit: 2100 }, { account: 'WALLET_LIABILITY', subledgerId: 'sub-1', credit: 2100 }]]);
    expect(h.state.notifications).not.toContain('billing_success');
    expect(h.accessWrites).toEqual([]);
  });

  it.each(['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const)('F2 card declined after %s preserves lifecycle and no dunning', async authority => {
    const h = cardHarness();
    applyAuthority(h.state, authority);
    const status = h.state.sub.status;
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'failed', reason: 'synthetic-decline' })) };
    await h.billing.reconcileUnknownCardCharges(due);
    expect(h.state.payment?.status).toBe('FAILED');
    expect(h.state.sub.status).toBe(status === 'ACTIVE' ? 'CANCELLED' : status);
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.notifications).toEqual([]);
  });

  it.each(['ACTIVE', 'CANCELLED', 'PAUSED', 'DEACTIVATED'] as const)('F3 not_found card under %s is reconciled but never automatically reissued', async authority => {
    const h = cardHarness();
    if (authority !== 'ACTIVE') applyAuthority(h.state, authority);
    const charge = vi.fn(async () => ({ status: 'succeeded', providerRef: 'synthetic-new-capture' }));
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'not_found' })), chargeToken: charge };
    expect(await h.billing.reconcileUnknownCardCharges(due)).toMatchObject({ settled: 0, stillUnknown: 1 });
    expect(charge).not.toHaveBeenCalled();
    expect(h.state.payment?.status).toBe('UNKNOWN');
    expect(h.state.sub.nextBillingDate).toEqual(due);
  });

  it('F1 a second rail covering the card period banks captured money using the original amount/currency', async () => {
    const h = cardHarness();
    h.state.sub.weeklyRate = 9000;
    h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS', paymentRef: 'prepaid' });
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'succeeded', providerRef: 'synthetic-captured' })) };
    expect(await h.billing.reconcileUnknownCardCharges(due)).toMatchObject({ settled: 1 });
    expect(h.state.wallet).toBe(2100);
    expect(h.state.events.get('bank:payment-1')).toMatchObject({ amount: 2100, currencyCode: 'GYD' });
    expect(h.state.sub.nextBillingDate).toEqual(due);
  });

  it('F5 banned non-tombstone MMG payer receives no prompt or new retry after pending response', async () => {
    const h = harness();
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
      h.state.user.status = 'BANNED';
      return { status: 'pending', transactionId: 'synthetic-pending' };
    });
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(h.state.payment?.status).toBe('PENDING');
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.notifications).toEqual([]);
  });

  it('F6 CARD ambiguous response retains timeout evidence under the actual rail predicate', async () => {
    const h = harness();
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    (h.billing as any).payments = { chargeToken: vi.fn(async () => ({ status: 'unknown', reason: 'synthetic-timeout', providerRef: '' })) };
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(h.state.payment).toMatchObject({ status: 'UNKNOWN', paymentMethod: 'CARD', failureCode: 'TIMEOUT_UNKNOWN', failureRaw: { reason: 'synthetic-timeout' } });
    // [#1393 owner decision] An ambiguous card answer is a payment being
    // confirmed: its own hold pauses the shared clock (no retry stamp) until
    // the reconciler or a person confirms it.
    expect(h.state.tables['hold']).toEqual([expect.objectContaining({ paymentId: 'payment-1', status: 'ACTIVE' })]);
    expect(h.state.sub.billingConfirmationPausedAt).not.toBeNull();
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.notifications).toEqual([]);
  });

  it('F1 immediate card capture banks after cancellation during the provider call', async () => {
    const h = harness();
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    const charge = vi.fn(async () => {
      applyAuthority(h.state, 'CANCELLED');
      return { status: 'succeeded', providerRef: 'synthetic-immediate' };
    });
    (h.billing as any).payments = { chargeToken: charge };
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('succeeded');
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', paymentMethod: 'CARD', externalRef: 'synthetic-immediate' });
    expect(h.state.sub.status).toBe('CANCELLED');
    expect(h.state.wallet).toBe(2100);
    expect(h.state.notifications).toEqual([]);
    expect(ledger.keys).toEqual(['ledger:bank:payment-1']);
  });

  it('F1 active card advances once and direct CAPTURED replay makes no second posting', async () => {
    const h = cardHarness();
    const snapshot = { ...h.state.sub };
    expect(await (h.billing as any).applySuccessfulCharge(snapshot, 2100, 'synthetic-captured', due, h.periodKey, h.state.payment!.id)).toBe(true);
    expect(await (h.billing as any).applySuccessfulCharge(snapshot, 2100, 'synthetic-captured', due, h.periodKey, h.state.payment!.id)).toBe(false);
    expect(h.state.sub.nextBillingDate).toEqual(new Date(due.getTime() + WEEK));
    expect(h.state.wallet).toBe(0);
    expect(ledger.keys).toEqual([`ledger:success:sub-1:${h.periodKey}`]);
    expect(h.state.notifications).toEqual(['billing_success']);
  });

  it('F2 card decline cannot dun an already covered period', async () => {
    const h = cardHarness();
    h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS', paymentRef: 'prepaid' });
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'failed', reason: 'synthetic-decline' })) };
    await h.billing.reconcileUnknownCardCharges(due);
    expect(h.state.payment).toMatchObject({ status: 'FAILED', failureRaw: { subscriptionOutcome: 'PRESERVED_NO_DUNNING', periodOutcome: 'ALREADY_PAID' } });
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null });
    expect(h.state.notifications).toEqual([]);
  });

  it('F3 charge-path belt also defers not_found instead of reissuing an old intent', async () => {
    const h = cardHarness();
    h.state.events.clear();
    const charge = vi.fn(async () => ({ status: 'succeeded', providerRef: 'synthetic-unwanted' }));
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'not_found' })), chargeToken: charge };
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(charge).not.toHaveBeenCalled();
    expect(h.state.payment?.status).toBe('UNKNOWN');
  });

  it('F4 valid no-lock mutation authority reaches the actual debit observer', async () => {
    const h = harness();
    h.state.wallet = 3000;
    const observed = vi.fn(async () => {});
    vi.spyOn(h.billing as any, 'lockSubscriptionMoneyAuthority').mockResolvedValueOnce({
      payerStatus: 'ACTIVE', payerPhone: '', status: h.state.sub.status, autoRenew: h.state.sub.autoRenew,
      collectionAllowed: true, bankInsteadOfAdvance: false, suppressNotice: false,
    });
    (h.billing as any).observer = { afterSuccessfulChargePrepaidDebit: observed };
    expect(await (h.billing as any).applySuccessfulCharge({ ...h.state.sub }, 2100, 'prepaid', due, h.periodKey, undefined, undefined, 2100)).toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    expect(h.state.wallet).toBe(900);
  });

  it.each(['CANCELLED', 'DEACTIVATED', 'COVERED'] as const)('F2 no-intent failure fallback preserves %s authority', async authority => {
    const h = harness();
    const stale = { ...h.state.sub };
    if (authority === 'COVERED') h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS' });
    else applyAuthority(h.state, authority);
    expect(await (h.billing as any).applyFailedCharge(stale, 2100, 'synthetic-failure', due, h.periodKey)).toBe('skipped');
    expect(h.state.sub.failedAttempts).toBe(0);
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.sub.status).toBe(authority === 'COVERED' ? 'ACTIVE' : 'CANCELLED');
    expect(h.state.notifications).toEqual([]);
  });

  it('card approval pins amount and FX to its own intent attempt, not a later retry quote', async () => {
    const h = cardHarness();
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { currencyCode: 'GYD', amountUsd: 10, fxRateId: 'original', fxRateUsed: 210 });
    expect(await (h.billing as any).applySuccessfulCharge({ ...h.state.sub }, 9000, 'synthetic-captured', due, h.periodKey, h.state.payment!.id, { amountUsd: 50, fxRateId: 'later', fxRateUsed: 180 })).toBe(true);
    expect(h.state.events.get(`success:sub-1:${h.periodKey}`)).toMatchObject({ amount: 2100, currencyCode: 'GYD', amountUsd: 10, fxRateId: 'original', fxRateUsed: 210 });
  });

  it('an MMG approval pins its issued rail and currency after the subscription changes', async () => {
    const h = harness('prior_lookup');
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { currencyCode: 'GYD' });
    Object.assign(h.state.sub, { billingMethod: 'CARD', currencyCode: 'TTD' });

    expect(await (h.billing as any).settleApprovedMmgPayment(
      { ...h.state.sub }, h.state.payment!.id,
      { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference },
      due,
    )).toBe('advanced');

    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', paymentMethod: 'MOBILE_MONEY' });
    expect(h.state.events.get(`success:sub-1:${h.periodKey}`)).toMatchObject({ amount: 2100, currencyCode: 'GYD' });
    expect(ledger.postings).toEqual([[
      { account: 'CLEARING_MMG', debit: 2100 },
      { account: 'FEE_REVENUE', credit: 2100 },
    ]]);
    expect(h.state.notificationPayloads[0]?.body).toMatch(/2,100 GYD/);
  });

  it('a covered MMG approval banks using its issued currency after the subscription changes', async () => {
    const h = harness('prior_lookup');
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { currencyCode: 'GYD' });
    h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS', paymentRef: 'prepaid' });
    Object.assign(h.state.sub, { billingMethod: 'CARD', currencyCode: 'TTD' });

    expect(await (h.billing as any).settleApprovedMmgPayment(
      { ...h.state.sub }, h.state.payment!.id,
      { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference },
      due,
    )).toBe('banked');

    expect(h.state.wallet).toBe(2100);
    expect(h.state.events.get('bank:payment-1')).toMatchObject({ amount: 2100, currencyCode: 'GYD' });
    expect(ledger.postings).toEqual([[
      { account: 'CLEARING_MMG', debit: 2100 },
      { account: 'WALLET_LIABILITY', subledgerId: 'sub-1', credit: 2100 },
    ]]);
    expect(h.state.notificationPayloads[0]?.body).toMatch(/2,100 GYD/);
  });

  it('cancellation winning before card dispatch authorization prevents the provider effect', async () => {
    const h = harness();
    Object.assign(h.state.sub, { billingMethod: 'CARD', paymentToken: 'synthetic-test-token' });
    const charge = vi.fn(async () => ({ status: 'succeeded', providerRef: 'must-not-run' }));
    (h.billing as any).payments = { chargeToken: charge };
    (h.billing as any).observer = {
      beforeProviderEffectAuthorization: async () => applyAuthority(h.state, 'CANCELLED'),
    };

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('skipped');

    expect(charge).not.toHaveBeenCalled();
    expect(h.state.sub).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(h.state.payment).toMatchObject({
      status: 'EXPIRED', paymentMethod: 'CARD', failureCode: 'DISPATCH_REVOKED',
      failureRaw: expect.objectContaining({
        subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        recoveryDisposition: 'NO_PROVIDER_EFFECT',
      }),
    });
  });

  it('deletion winning before MMG dispatch authorization prevents the provider prompt', async () => {
    const h = harness();
    const initiate = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment');
    (h.billing as any).observer = {
      beforeProviderEffectAuthorization: async () => applyAuthority(h.state, 'DEACTIVATED'),
    };

    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('skipped');

    expect(initiate).not.toHaveBeenCalled();
    expect(h.state.sub).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(h.state.payment).toMatchObject({
      status: 'EXPIRED', paymentMethod: 'MOBILE_MONEY', failureCode: 'DISPATCH_REVOKED',
      failureRaw: expect.objectContaining({
        subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        recoveryDisposition: 'NO_PROVIDER_EFFECT',
      }),
    });
  });

  it('a proven-unsent card reservation expires without dunning or reissue', async () => {
    const h = cardHarness();
    h.state.sub.status = 'ACTIVE';
    h.state.sub.autoRenew = true;
    h.state.payment!.failureRaw = { providerEffect: 'NOT_SENT' };
    const charge = vi.fn(async () => ({ status: 'succeeded', providerRef: 'must-not-run' }));
    (h.billing as any).payments = { lookupCharge: vi.fn(async () => ({ status: 'not_found' })), chargeToken: charge };

    expect(await h.billing.reconcileUnknownCardCharges(new Date(h.state.payment!.expiresAt.getTime() + 1)))
      .toMatchObject({ expired: 1, declined: 0, reissued: 0 });

    expect(charge).not.toHaveBeenCalled();
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null });
    expect(h.state.payment).toMatchObject({
      status: 'EXPIRED', failureCode: 'PROVIDER_NOT_FOUND',
      failureRaw: expect.objectContaining({
        subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        recoveryDisposition: 'MANUAL_RECONCILIATION',
      }),
    });
    expect(h.state.notifications).toEqual([]);
  });
});

function applyAuthority(state: ReturnType<typeof harness>['state'], authority: Authority) {
  if (authority === 'CANCELLED') {
    Object.assign(state.sub, { status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
  } else if (authority === 'PAUSED') {
    state.sub.status = 'PAUSED';
  } else if (authority === 'CHURNED') {
    Object.assign(state.sub, { status: 'CHURNED', nextRetryAt: null });
  } else if (authority === 'DEACTIVATED') {
    state.user.status = 'DEACTIVATED';
  } else {
    state.user.status = 'BANNED';
    state.user.phone = `deleted:${state.user.id}`;
  }
}

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  delete process.env['MMG_DRIVER'];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  ledger.keys.length = 0;
  ledger.postings.length = 0;
  vi.mocked(issueReceipt).mockClear();
});

describe('immediate MMG outcomes obey fresh locked authority without services', () => {
  /** [#1393] A prior request still pending at MMG is a payment being confirmed:
   *  it holds the shared clock, so a billing run stops before any lookup or
   *  instruction (proved once below) and the poller resolves it with the same
   *  lookup, the same bound approval rules and the same authority locks. Its
   *  counts map onto the charge path's old verdicts. */
  async function resolvePrior(h: ReturnType<typeof harness>, at = due): Promise<'succeeded' | 'failed' | 'pending'> {
    // An issued request always has its attempt record, which pins the
    // currency MMG's answer is bound to (kept when a case set its own pin).
    const attemptKey = `charge:sub-1:${h.periodKey}:a0`;
    if (!h.state.events.has(attemptKey)) h.state.events.set(attemptKey, { id: 'original-attempt', subscriptionId: 'sub-1', type: 'CHARGE_ATTEMPT', amount: 2100, currencyCode: 'GYD', createdAt: due });
    const polled = await h.billing.pollPendingMmgCharges(at);
    return polled.settled + polled.banked > 0 ? 'succeeded' : polled.failed > 0 ? 'failed' : 'pending';
  }

  it('[#1393] a billing run over a prior request still pending at MMG stops before any lookup and sends nothing', async () => {
    const h = harness('prior_lookup');
    const lookup = vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup');
    const initiate = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment');
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('pending');
    expect(lookup).not.toHaveBeenCalled();
    expect(initiate).not.toHaveBeenCalled();
    expect(h.state.tables['hold']).toEqual([expect.objectContaining({ paymentId: 'payment-1', status: 'ACTIVE' })]);
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: null });
  });

  type GenericSuccessInternals = {
    applySuccessfulCharge(
      snapshot: ReturnType<typeof harness>['state']['sub'],
      amount: number,
      paymentRef: string,
      now: Date,
      periodKey: string,
      settlePaymentId?: string,
      usdTrio?: undefined,
      spendPrepaid?: number,
    ): Promise<boolean>;
  };

  for (const rail of ['prepaid', 'card'] as const) {
    for (const authority of ['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const) {
      it(`generic ${rail} success cannot cross ${authority} authority that committed first`, async () => {
        const h = harness('initiate', true);
        h.state.wallet = rail === 'prepaid' ? 5000 : 0;
        if (rail === 'card') {
          h.state.payment = {
            id: 'payment-1', subscriptionId: 'sub-1', amount: 2100, status: 'UNKNOWN',
            paymentMethod: 'CARD', externalRef: 'card-provider-1', clientKey: 'card:sub-1:2026-09-20:a0',
            periodStart: due, periodEnd: new Date(due.getTime() + WEEK), createdAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000), lastPolledAt: null, pollBackoffSec: 30,
            failureCode: null, failureRaw: null,
          };
        }
        const stale = { ...h.state.sub };
        applyAuthority(h.state, authority);
        const expectedStatus = h.state.sub.status;
        const internals = h.billing as unknown as GenericSuccessInternals;

        const applied = await internals.applySuccessfulCharge(
          stale,
          2100,
          rail === 'prepaid' ? 'prepaid' : 'card-provider-1',
          due,
          h.periodKey,
          rail === 'card' ? h.state.payment!.id : undefined,
          undefined,
          rail === 'prepaid' ? 2100 : undefined,
        );

        // Prepaid was never spent. A card was already captured externally:
        // preserve that money as liability without granting a paid week.
        expect(applied).toBe(rail === 'card');
        expect(h.state.sub.status).toBe(expectedStatus);
        expect(h.state.sub.nextBillingDate).toEqual(due);
        expect(h.state.wallet).toBe(rail === 'prepaid' ? 5000 : 2100);
        expect(h.state.payment?.status ?? null).toBe(rail === 'card' ? 'CAPTURED' : null);
        expect([...h.state.events.keys()].filter((key) => key.startsWith('success:'))).toEqual([]);
        expect(ledger.keys).toEqual(rail === 'card' ? ['ledger:bank:payment-1'] : []);
        if (rail === 'card') expect(ledger.postings).toEqual([[{ account: 'CLEARING_CARD', debit: 2100 }, { account: 'WALLET_LIABILITY', subledgerId: 'sub-1', credit: 2100 }]]);
        expect(h.accessWrites).toEqual([]);
        expect(h.state.notifications).toEqual([]);
      });
    }

    it(`generic ${rail} success that commits first cannot reopen a later deletion`, async () => {
      const h = harness('initiate', true);
      h.state.sub.status = 'SUSPENDED';
      Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' });
      h.state.wallet = rail === 'prepaid' ? 5000 : 0;
      if (rail === 'card') {
        h.state.payment = {
          id: 'payment-1', subscriptionId: 'sub-1', amount: 2100, status: 'UNKNOWN',
          paymentMethod: 'CARD', externalRef: 'card-provider-1', clientKey: 'card:sub-1:2026-09-20:a0',
          periodStart: due, periodEnd: new Date(due.getTime() + WEEK), createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000), lastPolledAt: null, pollBackoffSec: 30,
          failureCode: null, failureRaw: null,
        };
      }
      h.barriers.afterCommit = async () => {
        applyAuthority(h.state, 'BANNED_TOMBSTONE');
        applyAuthority(h.state, 'CANCELLED');
        Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false });
      };
      const internals = h.billing as unknown as GenericSuccessInternals;

      const applied = await internals.applySuccessfulCharge(
        { ...h.state.sub },
        2100,
        rail === 'prepaid' ? 'prepaid' : 'card-provider-1',
        due,
        h.periodKey,
        rail === 'card' ? h.state.payment!.id : undefined,
        undefined,
        rail === 'prepaid' ? 2100 : undefined,
      );

      expect(applied).toBe(true);
      expect(h.state.sub).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
      expect(h.state.vendor).toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
      expect(h.state.wallet).toBe(rail === 'prepaid' ? 2900 : 0);
      expect(h.state.payment?.status).toBe('CAPTURED');
      expect(h.state.notifications).not.toContain('billing_reinstated');
      const paymentNotice = h.state.notificationPayloads.find((notice) => notice.data?.kind === 'billing_success');
      expect(paymentNotice?.body).toMatch(/received for the billing period starting 2026-09-20/i);
      expect(paymentNotice?.body).not.toMatch(/active until|access is restored|welcome back/i);
    });
  }

  it('a captured card replay under current live authority remains a legitimate idempotent repair', async () => {
    const h = harness('prior_lookup');
    h.state.payment!.paymentMethod = 'CARD';
    h.state.payment!.status = 'CAPTURED';
    h.state.payment!.externalRef = 'card-provider-1';
    const internals = h.billing as unknown as GenericSuccessInternals;

    const applied = await internals.applySuccessfulCharge(
      { ...h.state.sub }, 2100, 'card-provider-1', due, h.periodKey, h.state.payment!.id,
    );

    expect(applied).toBe(true);
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', externalRef: 'card-provider-1' });
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', nextBillingDate: new Date(due.getTime() + WEEK) });
    expect(ledger.keys).toEqual([`ledger:success:sub-1:${h.periodKey}`]);
  });

  function terminalFixture(h: ReturnType<typeof harness>, status: 'FAILED' | 'EXPIRED') {
    const payment = h.state.payment!;
    payment.status = status;
    const observedStatus = status === 'FAILED' ? 'declined' : 'expired';
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, {
      id: 'original-attempt', subscriptionId: 'sub-1', type: 'CHARGE_ATTEMPT',
      amount: 2100, currencyCode: 'GYD', createdAt: due,
    });
    // A retained provider observation supplies the negative authority in these
    // repair controls. Separate regressions below keep bare local status unknown.
    payment.failureRaw = { reason: 'original provider failure', mmgTerminalEvidence: {
      version: 1, provider: 'MMG', source: 'LOOKUP', paymentId: payment.id,
      subscriptionId: payment.subscriptionId, transactionId: payment.externalRef,
      reference: payment.clientKey, amountMinor: 210000, currencyCode: 'GYD',
      periodStart: payment.periodStart.toISOString(), periodEnd: payment.periodEnd.toISOString(),
      status: observedStatus, generation: 'synthetic-retained-lookup', observedAt: due.toISOString(),
      observation: { transactionId: payment.externalRef, reference: payment.clientKey,
        amountMinor: 210000, currencyCode: 'GYD', status: observedStatus },
    } };
  }

  it.each(['FAILED', 'EXPIRED'] as const)('a legacy local %s without bound provider evidence stays held without dunning', async (status) => {
    const h = harness('prior_lookup');
    h.state.payment!.status = status;
    h.state.payment!.failureRaw = { reason: 'unproved local status' };
    expect(await h.billing.reconcileTerminalWithoutOutcome(due)).toMatchObject({ repaired: 0, stillOpen: 1 });
    expect(h.state.payment!.status).toBe('PENDING');
    expect(h.state.sub).toMatchObject({ status: 'ACTIVE', failedAttempts: 0 });
    expect(h.state.events.size).toBe(0);
    expect(h.state.tables['hold']).toEqual([expect.objectContaining({ paymentId: 'payment-1', status: 'ACTIVE' })]);
    expect(h.state.notifications).toEqual([]);
  });

  for (const authority of ['DEACTIVATED', 'BANNED_TOMBSTONE', 'CANCELLED', 'PAUSED'] as const) {
    it.each(['before', 'after'] as const)(`terminal repair preserves ${authority} committed %s its subscription snapshot`, async (order) => {
      const h = harness('prior_lookup');
      terminalFixture(h, 'FAILED');
      const retained = cloneBillingValue(h.state.payment!.failureRaw as Record<string, unknown>);
      if (order === 'before') applyAuthority(h.state, authority);
      const read = h.prisma.subscription.findUnique.getMockImplementation()!;
      h.prisma.subscription.findUnique.mockImplementationOnce(async () => {
        const snapshot = await read();
        if (order === 'after') applyAuthority(h.state, authority);
        return snapshot;
      });

      expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ repaired: 1, stillOpen: 0 });

      expect(h.state.sub.status).toBe(authority === 'PAUSED' ? 'PAUSED' : 'CANCELLED');
      expect(h.state.sub.failedAttempts).toBe(0);
      expect(h.state.sub.nextRetryAt).toBeNull();
      if (authority !== 'PAUSED') expect(h.state.sub.autoRenew).toBe(false);
      expect(h.state.payment!.failureRaw).toEqual({
        ...retained, subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        subscriptionStatus: authority === 'PAUSED' ? 'PAUSED' : 'CANCELLED',
      });
      expect([...h.state.events.values()].filter((event) => event['type'] === 'CHARGE_FAILED')).toHaveLength(0);
      expect(h.state.notifications).toEqual([]);
      expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ scanned: 0, repaired: 0 });
    });
  }

  for (const outcome of ['captured', 'reopened', 'success', 'failed', 'preserved'] as const) {
    it(`terminal repair rechecks a concurrent ${outcome} outcome inside the authority transaction`, async () => {
      const h = harness('prior_lookup');
      terminalFixture(h, 'FAILED');
      const read = h.prisma.subscription.findUnique.getMockImplementation()!;
      h.prisma.subscription.findUnique.mockImplementationOnce(async () => {
        const snapshot = await read();
        if (outcome === 'captured') h.state.payment!.status = 'CAPTURED';
        if (outcome === 'reopened') h.state.payment!.status = 'PENDING';
        if (outcome === 'success') h.state.events.set(`success:sub-1:${h.periodKey}`, { type: 'CHARGE_SUCCESS' });
        if (outcome === 'failed') h.state.events.set(`failed:sub-1:${h.periodKey}:a0`, { type: 'CHARGE_FAILED', subscriptionId: 'sub-1' });
        if (outcome === 'preserved') h.state.payment!.failureRaw = { subscriptionOutcome: 'PRESERVED_NO_DUNNING' };
        return snapshot;
      });

      expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ repaired: 0, stillOpen: 0 });
      expect(h.state.sub.status).toBe('ACTIVE');
      expect(h.state.sub.failedAttempts).toBe(0);
      expect(h.state.sub.nextRetryAt).toBeNull();
      expect(h.state.notifications).toEqual([]);
    });
  }

  it('terminal repair applies a live failure once using fresh locked counters', async () => {
    const h = harness('prior_lookup');
    terminalFixture(h, 'EXPIRED');
    h.state.sub.failedAttempts = 2;
    const read = h.prisma.subscription.findUnique.getMockImplementation()!;
    h.prisma.subscription.findUnique.mockImplementationOnce(async () => {
      const snapshot = await read();
      h.state.sub.failedAttempts = 0;
      return snapshot;
    });
    expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ repaired: 1, stillOpen: 0 });
    expect(h.state.sub).toMatchObject({ status: 'PAST_DUE', failedAttempts: 1 });
    expect(h.state.events.get(`failed:sub-1:${h.periodKey}:a0`)).toMatchObject({ amount: 2100 });
    expect(h.state.notifications).toEqual(['billing_failed']);
    expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ repaired: 0, stillOpen: 0 });
    expect(h.state.sub.failedAttempts).toBe(1);
    expect(h.state.notifications).toEqual(['billing_failed']);
  });

  it('terminal repair prefilters every handled outcome and reports work beyond the 500-row cap', async () => {
    const h = harness('prior_lookup');
    terminalFixture(h, 'EXPIRED');
    h.state.rawOpenCount = 501;

    expect(await h.billing.reconcileTerminalWithoutOutcome()).toMatchObject({ scanned: 1, repaired: 1, stillOpen: 500 });

    expect(h.state.rawQueries[0]).toContain('NOT EXISTS');
    expect(h.state.rawQueries[0]).toContain("'CHARGE_FAILED'");
    expect(h.state.rawQueries[0]).toContain("'success:'");
    expect(h.state.rawQueries[0]).toContain('COUNT(*) OVER()');
    expect(h.state.rawQueries[0]).toContain('ORDER BY p."createdAt" ASC, p."id" ASC');
  });

  for (const price of [1000, 3200]) {
    for (const disposition of ['cancelled', 'covered', 'advance'] as const) {
      it(`prior lookup at repriced ${price} preserves the original 2100 for ${disposition}`, async () => {
        const h = harness('prior_lookup');
        h.state.sub.weeklyRate = price;
        h.state.sub.failedAttempts = 1;
        const originalPin = { amountUsd: 10, fxRateId: 'original-rate', fxRateUsed: 210, currencyCode: 'GYD' };
        h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, originalPin);
        const arrived = deferred();
        const release = deferred();
        vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
          arrived.resolve();
          await release.promise;
          return { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
        });
        const pending = resolvePrior(h);
        await arrived.promise;
        if (disposition === 'cancelled') applyAuthority(h.state, 'CANCELLED');
        if (disposition === 'covered') h.state.events.set(`success:sub-1:${h.periodKey}`, { id: 'covered' });
        release.resolve();
        expect(await pending).toBe('succeeded');
        expect(h.state.payment?.amount).toBe(2100);
        expect(ledger.postings).toEqual([[
          { account: 'CLEARING_MMG', debit: 2100 },
          disposition === 'advance' ? { account: 'FEE_REVENUE', credit: 2100 }
            : { account: 'WALLET_LIABILITY', subledgerId: 'sub-1', credit: 2100 },
        ]]);
        if (disposition === 'advance') {
          expect(h.state.events.get(`success:sub-1:${h.periodKey}`)).toMatchObject({ amount: 2100, ...originalPin });
        } else {
          expect(h.state.wallet).toBe(2100);
          expect(h.state.events.get('bank:payment-1')).toMatchObject({ amount: 2100 });
          expect(issueReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 2100 }));
          expect(h.state.sub.nextBillingDate).toEqual(due);
        }
      });
    }
  }

  it('suspension committed during lookup is restored atomically with historical post-commit copy', async () => {
    const h = harness('prior_lookup', true);
    const arrived = deferred();
    const release = deferred();
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      // The settlement's own commit is the next one: arm its check now (once).
      h.barriers.beforeCommit = async () => {
        h.barriers.beforeCommit = undefined;
        expect(h.state.sub.status).toBe('ACTIVE');
        expect(h.state.vendor).toMatchObject({ status: 'ACTIVE', acceptingOrders: true });
        expect(h.accessWrites).toEqual([true, true]);
      };
      return { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
    });
    const pending = resolvePrior(h);
    await arrived.promise;
    h.state.sub.status = 'SUSPENDED';
    Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' });
    release.resolve();
    expect(await pending).toBe('succeeded');
    expect(h.state.notifications).not.toContain('billing_reinstated');
    expect(h.state.notificationPayloads).toEqual([
      expect.objectContaining({
        body: expect.stringMatching(/received for the billing period starting 2026-09-20.*current account status/i),
        data: expect.objectContaining({ kind: 'billing_success' }),
      }),
    ]);
  });

  for (const deletionFirst of [true, false]) {
    it(`vendor deletion ${deletionFirst ? 'before' : 'after'} settlement never permits a stale reopen`, async () => {
      const h = harness('prior_lookup', true);
      h.state.sub.status = 'SUSPENDED';
      Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' });
      const atBoundary = deferred();
      const release = deferred();
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
        if (deletionFirst) { atBoundary.resolve(); await release.promise; }
        // After the lookup, the next commit is the settlement's own (armed once).
        else h.barriers.afterCommit = async () => { h.barriers.afterCommit = undefined; atBoundary.resolve(); await release.promise; };
        return { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
      });
      const pending = resolvePrior(h);
      await atBoundary.promise;
      applyAuthority(h.state, 'DEACTIVATED');
      applyAuthority(h.state, 'CANCELLED');
      Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false });
      release.resolve();
      expect(await pending).toBe('succeeded');
      expect(h.state.sub.status).toBe('CANCELLED');
      expect(h.state.vendor).toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
      expect(h.accessWrites.every(Boolean)).toBe(true);
      expect(h.state.wallet).toBe(deletionFirst ? 2100 : 0);
      if (!deletionFirst) {
        expect(h.state.notifications).not.toContain('billing_reinstated');
        const paymentNotice = h.state.notificationPayloads.find((notice) => notice.data?.kind === 'billing_success');
        expect(paymentNotice?.body).toMatch(/received for the billing period starting 2026-09-20/i);
        expect(paymentNotice?.body).not.toMatch(/active until|access is restored|welcome back/i);
      }
    });
  }

  it.each([
    ['wire currency', { amount: '2100', transactionStatus: 'successful', transactionReference: 'mmgtx-prior', metadata: [{ key: 'description', value: 'sub:sub-1:2026-09-20:a0' }] }],
    ['wire transaction reference', { amount: '2100', currency: 'GYD', transactionStatus: 'successful', metadata: [{ key: 'description', value: 'sub:sub-1:2026-09-20:a0' }] }],
  ] as const)('the live adapter cannot settle when MMG omits %s', async (_label, wireBody) => {
    const h = harness('prior_lookup');
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { currencyCode: 'GYD' });
    const cfg: LiveMmgConfig = {
      baseUrl: 'https://mmg.invalid.test', apiKey: 'synthetic-api', merchantMsisdn: '9991161',
      password: 'synthetic-password', mkey: 'synthetic-mkey', msecret: 'synthetic-msecret',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 120 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => wireBody });
    const evidence = await new LiveMmgProvider(cfg, fetchMock as any).transactionLookup({ transactionId: 'mmgtx-prior' });

    const outcome = await (h.billing as any).settleApprovedMmgPayment(
      { ...h.state.sub }, h.state.payment!.id, evidence, due,
    );

    expect(outcome).toBe('held');
    expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH' });
    expect(h.state.wallet).toBe(0);
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(ledger.keys).toEqual([]);
    expect(vi.mocked(issueReceipt)).not.toHaveBeenCalled();
    expect([...h.state.events.keys()].filter((key) => key.startsWith('success:') || key.startsWith('bank:'))).toEqual([]);
  });

  it('the live adapter exact wire proof still settles through the real authority boundary', async () => {
    const h = harness('prior_lookup');
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { currencyCode: 'GYD' });
    const cfg: LiveMmgConfig = {
      baseUrl: 'https://mmg.invalid.test', apiKey: 'synthetic-api', merchantMsisdn: '9991161',
      password: 'synthetic-password', mkey: 'synthetic-mkey', msecret: 'synthetic-msecret',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 120 }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          amount: '2100', currency: 'GYD', transactionStatus: 'successful', transactionReference: 'mmgtx-prior',
          metadata: [{ key: 'description', value: h.reference }],
        }),
      });
    const evidence = await new LiveMmgProvider(cfg, fetchMock as any).transactionLookup({ transactionId: 'mmgtx-prior' });

    const outcome = await (h.billing as any).settleApprovedMmgPayment(
      { ...h.state.sub }, h.state.payment!.id, evidence, due,
    );

    expect(outcome).toBe('advanced');
    expect(h.state.payment).toMatchObject({ status: 'CAPTURED', failureCode: null });
    expect(h.state.sub.nextBillingDate).toEqual(new Date(due.getTime() + WEEK));
    expect(ledger.keys).toEqual([`ledger:success:sub-1:${h.periodKey}`]);
  });

  it.each(['CANCELLED', 'PAUSED', 'CHURNED', 'BANNED_TOMBSTONE'] as const)(
    'an MMG settlement committed before %s emits only historical payment copy and preserves the later authority',
    async (authority) => {
      const h = harness('prior_lookup', true);
      h.state.sub.status = 'SUSPENDED';
      Object.assign(h.state.vendor, { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' });
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
        // After the lookup, the next commit is the settlement's own (armed once).
        h.barriers.afterCommit = async () => {
          h.barriers.afterCommit = undefined;
          applyAuthority(h.state, authority);
          if (authority === 'BANNED_TOMBSTONE') applyAuthority(h.state, 'CANCELLED');
        };
        return { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
      });

      expect(await resolvePrior(h)).toBe('succeeded');

      expect(h.state.sub.status).toBe(authority === 'BANNED_TOMBSTONE' ? 'CANCELLED' : authority);
      expect(h.state.notifications).not.toContain('billing_reinstated');
      const paymentNotice = h.state.notificationPayloads.find((notice) => notice.data?.kind === 'billing_success');
      expect(paymentNotice?.body).toMatch(/received for the billing period starting 2026-09-20/i);
      expect(paymentNotice?.body).not.toMatch(/active until|access is restored|welcome back/i);
    },
  );
  for (const entry of ['initiate', 'prior_lookup'] as const) {
    for (const authority of ['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const) {
      it(`${entry} approval banks once under ${authority} and emits no false success`, async () => {
        const h = harness(entry);
        if (entry === 'initiate') {
          vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
            applyAuthority(h.state, authority);
            return { status: 'approved', transactionId: 'mmgtx-approved' };
          });
          vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({
            transactionId: 'mmgtx-approved', status: 'approved', amountMinor: 210000,
            currencyCode: 'GYD', reference: h.reference,
          });
        } else {
          vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
            applyAuthority(h.state, authority);
            return { transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
          });
        }

        const initial = entry === 'initiate' ? await h.billing.billSubscription({ ...h.state.sub } as any, due) : await resolvePrior(h);
        if (entry === 'initiate') {
          expect(initial).toBe('pending');
          expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 60_000))).toMatchObject({ banked: 1 });
        } else {
          expect(initial).toBe('succeeded');
        }

        expect(h.state.payment?.status).toBe('CAPTURED');
        expect(h.state.wallet).toBe(2100);
        expect(h.state.sub.status).toBe(authority === 'PAUSED' ? 'PAUSED' : 'CANCELLED');
        expect(h.state.sub.nextBillingDate).toEqual(due);
        expect(h.state.events.has(`bank:${h.state.payment!.id}`)).toBe(true);
        expect(h.state.events.has(`success:${h.state.sub.id}:${h.periodKey}`)).toBe(false);
        expect(ledger.keys).toEqual([`ledger:bank:${h.state.payment!.id}`]);
        expect(h.state.notifications).not.toContain('billing_success');
      });
    }

    it(`${entry} approval keeps the established ACTIVE advance behavior`, async () => {
      const h = harness(entry);
      if (entry === 'initiate') {
        vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({
          status: 'approved', transactionId: 'mmgtx-approved',
        });
        vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({
          transactionId: 'mmgtx-approved', status: 'approved', amountMinor: 210000,
          currencyCode: 'GYD', reference: h.reference,
        });
      } else {
        vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockResolvedValue({
          transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference,
        });
      }

      const initial = entry === 'initiate' ? await h.billing.billSubscription({ ...h.state.sub } as any, due) : await resolvePrior(h);
      if (entry === 'initiate') {
        expect(initial).toBe('pending');
        expect(await h.billing.pollPendingMmgCharges(new Date(due.getTime() + 60_000))).toMatchObject({ settled: 1 });
      } else {
        expect(initial).toBe('succeeded');
      }

      expect(h.state.payment?.status).toBe('CAPTURED');
      expect(h.state.wallet).toBe(0);
      expect(h.state.sub.status).toBe('ACTIVE');
      expect(h.state.sub.nextBillingDate).toEqual(new Date(due.getTime() + WEEK));
      expect(h.state.events.has(`success:${h.state.sub.id}:${h.periodKey}`)).toBe(true);
      expect(h.state.events.has(`bank:${h.state.payment!.id}`)).toBe(false);
      expect(ledger.keys).toEqual([`ledger:success:${h.state.sub.id}:${h.periodKey}`]);
      expect(h.state.notifications.filter((kind) => kind === 'billing_success')).toHaveLength(1);
    });
  }

  const mismatches = [
    ['smaller amount', { amountMinor: 1 }],
    ['greater amount', { amountMinor: 210001 }],
    ['zero amount', { amountMinor: 0 }],
    ['missing amount', { amountMinor: undefined }],
    ['wrong currency', { currencyCode: 'USD' }],
    ['missing currency', { currencyCode: '' }],
    ['wrong provider transaction', { transactionId: 'mmgtx-unrelated' }],
    ['wrong merchant reference', { reference: 'sub:someone-else:2026-09-20:a0' }],
    ['missing merchant reference', { reference: undefined }],
  ] as const;
  for (const disposition of ['ACTIVE', 'CANCELLED', 'PAUSED', 'COVERED'] as const) {
    it.each(mismatches)(`holds %s without granting money or service under ${disposition}`, async (_label, patch) => {
      const h = harness('prior_lookup');
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
        if (disposition === 'CANCELLED') applyAuthority(h.state, 'CANCELLED');
        if (disposition === 'PAUSED') applyAuthority(h.state, 'PAUSED');
        if (disposition === 'COVERED') h.state.events.set(`success:sub-1:${h.periodKey}`, { id: 'covered', type: 'CHARGE_SUCCESS' });
        return {
          transactionId: 'mmgtx-prior', status: 'approved', amountMinor: 210000,
          currencyCode: 'GYD', reference: h.reference, ...patch,
        } as any;
      });

      expect(await resolvePrior(h)).toBe('pending');

      expect(h.state.payment).toMatchObject({ status: 'PENDING', failureCode: 'SETTLEMENT_MISMATCH' });
      expect(h.state.wallet).toBe(0);
      expect(h.state.sub.nextBillingDate).toEqual(due);
      expect(ledger.keys).toEqual([]);
      expect(vi.mocked(issueReceipt)).not.toHaveBeenCalled();
      expect([...h.state.events.keys()].filter((key) => key.startsWith('bank:'))).toEqual([]);
      const successes = [...h.state.events.keys()].filter((key) => key.startsWith('success:'));
      expect(successes).toEqual(disposition === 'COVERED' ? [`success:sub-1:${h.periodKey}`] : []);
      expect(h.state.events.get('mismatch:payment-1')).toMatchObject({ type: 'REMINDER' });
    });
  }

  for (const outcome of ['pending', 'error'] as const) {
    it.each(['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE', 'CHURNED'] as const)(
      `${outcome} initiate tail preserves %s retry stop and suppresses stale approval copy`,
      async (authority) => {
        const h = harness('initiate');
        const arrived = deferred();
        const release = deferred();
        vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
          arrived.resolve();
          await release.promise;
          return outcome === 'pending'
            ? { status: 'pending', transactionId: 'mmgtx-pending' }
            : { status: 'error', transactionId: '', reason: 'transport uncertain' };
        });
        const run = h.billing.billSubscription({ ...h.state.sub } as any, due);
        await arrived.promise;
        if (authority === 'CHURNED') Object.assign(h.state.sub, { status: 'CHURNED', nextRetryAt: null });
        else applyAuthority(h.state, authority);
        release.resolve();

        expect(await run).toBe('pending');
        expect(h.state.sub.nextRetryAt).toBeNull();
        expect(h.state.notifications).not.toContain('billing_mmg_pending');
        expect(h.state.payment?.status).toBe(outcome === 'pending' ? 'PENDING' : 'UNKNOWN');
      },
    );
  }

  it('a stale prior-lookup pending tail cannot re-arm cancellation', async () => {
    const h = harness('prior_lookup');
    const arrived = deferred();
    const release = deferred();
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      return { transactionId: 'mmgtx-prior', status: 'pending', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
    });
    const run = resolvePrior(h);
    await arrived.promise;
    applyAuthority(h.state, 'CANCELLED');
    release.resolve();

    expect(await run).toBe('pending');
    expect(h.state.sub).toMatchObject({ status: 'CANCELLED', autoRenew: false, nextRetryAt: null });
    expect(h.state.notifications).not.toContain('billing_mmg_pending');
  });

  for (const authority of ['CANCELLED', 'PAUSED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const) {
    it(`immediate decline preserves ${authority}, records the terminal marker, and does not arm retry`, async () => {
      const h = harness('initiate');
      vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
        applyAuthority(h.state, authority);
        return { status: 'declined', transactionId: '', reason: 'Payer declined' };
      });

      const result = await h.billing.billSubscription({ ...h.state.sub } as any, due);

      expect(result).toBe('skipped');
      expect(h.state.payment?.status).toBe('FAILED');
      expect(h.state.payment?.failureRaw).toMatchObject({
        subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        subscriptionStatus: authority === 'PAUSED' ? 'PAUSED' : 'CANCELLED',
      });
      expect(h.state.sub.status).toBe(authority === 'PAUSED' ? 'PAUSED' : 'CANCELLED');
      expect(h.state.sub.failedAttempts).toBe(0);
      expect(h.state.sub.nextRetryAt).toBeNull();
      expect(h.state.notifications).not.toContain('billing_failed');
    });
  }

  it('a poll decline after another payment covered the same week records provider evidence without re-dunning', async () => {
    const h = harness('prior_lookup');
    h.state.sub.status = 'PAST_DUE';
    h.state.sub.failedAttempts = 2;
    const arrived = deferred();
    const release = deferred();
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      return { transactionId: 'mmgtx-prior', status: 'declined', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
    });

    // [#1393] The request's issued attempt pins its currency (what MMG's answer is bound to).
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { id: 'original-attempt', subscriptionId: 'sub-1', type: 'CHARGE_ATTEMPT', amount: 2100, currencyCode: 'GYD', createdAt: due });
    const pending = h.billing.pollPendingMmgCharges(new Date());
    await arrived.promise;
    Object.assign(h.state.sub, {
      status: 'ACTIVE',
      failedAttempts: 0,
      nextBillingDate: new Date(due.getTime() + WEEK),
      nextRetryAt: null,
      isInGracePeriod: false,
      gracePeriodEnd: null,
      suspendedAt: null,
    });
    h.state.events.set(`success:${h.state.sub.id}:${h.periodKey}`, { id: 'covered', type: 'CHARGE_SUCCESS' });
    release.resolve();

    expect(await pending).toMatchObject({ failed: 1 });
    expect(h.state.payment).toMatchObject({
      status: 'FAILED',
      failureRaw: {
        subscriptionOutcome: 'PRESERVED_NO_DUNNING',
        subscriptionStatus: 'ACTIVE',
      },
    });
    expect(h.state.sub).toMatchObject({
      status: 'ACTIVE', failedAttempts: 0, nextRetryAt: null,
      nextBillingDate: new Date(due.getTime() + WEEK),
    });
    expect([...h.state.events.keys()].filter((key) => key.startsWith('failed:'))).toEqual([]);
    expect(h.state.notifications).toEqual([]);
  });

  it('a poll decline increments fresh locked counters instead of the pre-lookup snapshot', async () => {
    const h = harness('prior_lookup');
    const arrived = deferred();
    const release = deferred();
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
      arrived.resolve();
      await release.promise;
      return { transactionId: 'mmgtx-prior', status: 'declined', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
    });

    // [#1393] The request's issued attempt pins its currency (what MMG's answer is bound to).
    h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { id: 'original-attempt', subscriptionId: 'sub-1', type: 'CHARGE_ATTEMPT', amount: 2100, currencyCode: 'GYD', createdAt: due });
    const resolvedAt = new Date();
    const pending = h.billing.pollPendingMmgCharges(resolvedAt);
    await arrived.promise;
    h.state.sub.failedAttempts = 2;
    release.resolve();

    expect(await pending).toMatchObject({ failed: 1 });
    expect(h.state.payment?.status).toBe('FAILED');
    // [#1393] The decline resolves the request's confirmation, and a resolution
    // never suspends in its own instant: the ladder is exhausted at the fresh
    // locked level (a2, never the pre-lookup a0). The request was being
    // confirmed since it was sent, so the two days of grace start now: the
    // first run after them suspends.
    expect(h.state.sub).toMatchObject({ status: 'PAST_DUE', failedAttempts: 3 });
    expect(h.state.events.get(`failed:${h.state.sub.id}:${h.periodKey}:a2`)).toMatchObject({ type: 'CHARGE_FAILED' });
    expect(h.state.events.has(`failed:${h.state.sub.id}:${h.periodKey}:a0`)).toBe(false);
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, new Date(resolvedAt.getTime() + 47 * 3_600_000))).toBe('pending');
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, new Date(resolvedAt.getTime() + 48 * 3_600_000 + 60_000))).toBe('suspended');
    expect(h.state.sub).toMatchObject({ status: 'SUSPENDED', failedAttempts: 3 });
    expect(h.state.notifications).toContain('billing_suspended');
  });

  it.each(['CHURNED', 'DEACTIVATED', 'BANNED_TOMBSTONE'] as const)(
    'a poll decline preserves %s authority committed while the provider lookup is in flight',
    async (authority) => {
      const h = harness('prior_lookup');
      const arrived = deferred();
      const release = deferred();
      vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => {
        arrived.resolve();
        await release.promise;
        return { transactionId: 'mmgtx-prior', status: 'declined', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference };
      });

      // [#1393] The request's issued attempt pins its currency (what MMG's answer is bound to).
      h.state.events.set(`charge:sub-1:${h.periodKey}:a0`, { id: 'original-attempt', subscriptionId: 'sub-1', type: 'CHARGE_ATTEMPT', amount: 2100, currencyCode: 'GYD', createdAt: due });
      const pending = h.billing.pollPendingMmgCharges(new Date());
      await arrived.promise;
      if (authority === 'CHURNED') {
        Object.assign(h.state.sub, { status: 'CHURNED', failedAttempts: 2, nextRetryAt: null });
      } else {
        applyAuthority(h.state, authority);
      }
      release.resolve();

      expect(await pending).toMatchObject({ failed: 1 });
      expect(h.state.payment).toMatchObject({
        status: 'FAILED',
        failureRaw: {
          subscriptionOutcome: 'PRESERVED_NO_DUNNING',
          subscriptionStatus: authority === 'CHURNED' ? 'CHURNED' : 'CANCELLED',
        },
      });
      expect(h.state.sub.status).toBe(authority === 'CHURNED' ? 'CHURNED' : 'CANCELLED');
      expect(h.state.sub.nextRetryAt).toBeNull();
      expect([...h.state.events.keys()].filter((key) => key.startsWith('failed:'))).toEqual([]);
      expect(h.state.notifications).toEqual([]);
    },
  );

  it('poller adoption wins the CAS while initiate is awaiting: one bank, one ledger disposition, one notice', async () => {
    const h = harness('initiate');
    const providerWaiting = deferred<void>();
    const releaseProvider = deferred<void>();
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async () => {
      providerWaiting.resolve();
      await releaseProvider.promise;
      return { status: 'approved', transactionId: 'mmgtx-adopted' };
    });
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionHistory').mockImplementation(async () => [{
      transactionId: 'mmgtx-adopted', status: 'approved', amountMinor: 210000,
      currencyCode: 'GYD', reference: h.reference,
    }]);
    vi.spyOn(SandboxMmgProvider.prototype, 'transactionLookup').mockImplementation(async () => ({
      transactionId: 'mmgtx-adopted', status: 'approved', amountMinor: 210000, currencyCode: 'GYD', reference: h.reference,
    }));

    const immediate = h.billing.billSubscription({ ...h.state.sub } as any, due);
    await providerWaiting.promise;
    applyAuthority(h.state, 'CANCELLED');
    expect((await h.billing.pollPendingMmgCharges(new Date(Date.now() + 60_000))).adopted).toBe(1);
    expect((await h.billing.pollPendingMmgCharges(new Date(Date.now() + 3_600_000))).banked).toBe(1);
    releaseProvider.resolve();
    const immediateResult = await immediate;

    expect(immediateResult).toBe('pending');
    expect(h.state.payment?.status).toBe('CAPTURED');
    expect(h.state.sub.status).toBe('CANCELLED');
    expect(h.state.sub.nextBillingDate).toEqual(due);
    expect(h.state.wallet).toBe(2100);
    expect([...h.state.events.keys()].filter((key) => key.startsWith('bank:'))).toHaveLength(1);
    expect([...h.state.events.keys()].filter((key) => key.startsWith('success:'))).toHaveLength(0);
    expect(ledger.keys).toEqual([`ledger:bank:${h.state.payment!.id}`]);
    expect(h.state.notifications.filter((kind) => kind === 'billing_banked')).toHaveLength(1);
    expect(h.state.notifications).not.toContain('billing_mmg_pending');
    expect(h.state.sub.nextRetryAt).toBeNull();
    expect(h.state.notifications).not.toContain('billing_success');

    expect((await h.billing.pollPendingMmgCharges(new Date(Date.now() + 7_200_000))).banked).toBe(0);
    expect(await h.billing.billSubscription({ ...h.state.sub } as any, due)).toBe('skipped');
    expect(h.state.wallet).toBe(2100);
    expect(ledger.keys).toEqual([`ledger:bank:${h.state.payment!.id}`]);
    expect(h.state.notifications.filter((kind) => kind === 'billing_banked')).toHaveLength(1);
  });
});
