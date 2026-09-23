/**
 * [ORDER-SPINE S1-6 · REPORT-211 · ORDER-SPINE-CROSS-LANE-INTEGRATION-GATE] The
 * direct-MMG claim authority, proved WITHOUT a database.
 *
 * On a direct-MMG marketplace order Swift holds no money: the customer pays the
 * store's own wallet, and the only signals are two people's words — the store's
 * "it arrived" and the customer's "I paid" / "I did not pay". Current main let
 * those two words race: a customer denial recorded before the store's claim was
 * not durable at all, a concurrent denial could read a stale preview and never
 * raise the dispute, and the admin resolver cleared whatever dispute was open
 * with an unlocked, unversioned write followed by a separate audit call.
 *
 * This suite pins the replacement contract at three layers:
 *   1. the decision table — every command, every state, every refusal;
 *   2. the transaction staging — lock first, then fresh read, then state +
 *      audit + outbox in ONE transaction, all-or-nothing, against an in-memory
 *      store that enforces the same CHECK constraints as the migration;
 *   3. the durable notices — deterministic keys, truthful at delivery time.
 *
 * What it does NOT prove, and says so: PostgreSQL row-lock waits, rollback on a
 * real server, and the migration itself. Those live in mmg-claim-races.test.ts
 * and the migration forward/rollback evidence.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  MMG_CLAIM_NOTICE_KIND,
  adjudicationCoversCurrentFacts,
  claimsDisagree,
  completeMmgClaimNotice,
  decideCustomerMmgClaim,
  decideMmgClaimResolution,
  decideStoreMmgClaim,
  deliverMmgClaimNotice,
  isRejectedMmgAttempt,
  mmgClaimLockObserver,
  mmgClaimNoticeDedupeKey,
  mmgClaimView,
  mmgDispatchBlocked,
  mmgDispatchEligibleWhere,
  parseMmgClaimNoticePayload,
  recordCustomerMmgClaim,
  resolveMmgClaimDisagreement,
  stageStoreMmgClaim,
  violatesDisagreementHold,
  type MmgClaimFacts,
  type MmgClaimNotice,
  type MmgClaimTx,
} from '../modules/order/mmg-claim.service';
import * as outboxModule from '../modules/order/checkout-outbox';
import { JOB_RECOVERY } from '../jobs/recovery-policy';

const { checkoutOutboxId } = outboxModule;

const T0 = new Date('2026-09-22T10:00:00.000Z');
const T1 = new Date('2026-09-22T10:05:00.000Z');
const T2 = new Date('2026-09-22T10:10:00.000Z');
const REF_A = 'MMGA0001';
const REF_B = 'MMGB0002';

function facts(over: Partial<MmgClaimFacts> = {}): MmgClaimFacts {
  return {
    id: 'order-1',
    tenantId: 'tenant-a',
    orderNumber: 'SW-1001',
    customerId: 'customer-1',
    vendorId: 'vendor-1',
    orderType: 'FOOD_DELIVERY',
    status: 'ACCEPTED',
    paymentMethod: 'MOBILE_MONEY',
    paymentStatus: 'PENDING',
    customerMmgClaim: 'UNRECORDED',
    customerMmgClaimAt: null,
    customerClaimedPaidAt: null,
    customerPaymentRef: null,
    mmgAttestedRef: null,
    mmgClaimMismatchAt: null,
    mmgClaimRevision: 0,
    mmgClaimResolution: null,
    mmgClaimResolvedAt: null,
    mmgClaimResolvedRevision: null,
    ...over,
  };
}

function refusal(fn: () => unknown): { statusCode: number; code: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    return err as { statusCode: number; code: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal, got a decision');
}

// ---------------------------------------------------------------------------
// The migration's CHECK constraints, written out INDEPENDENTLY of the service.
// The in-memory store below refuses any statement that leaves a row violating
// one of them — exactly what PostgreSQL does — so the staging tests cannot pass
// by producing a row the database would reject.
// ---------------------------------------------------------------------------
type Row = MmgClaimFacts & Record<string, unknown>;

function checkDisagreementHeld(r: Row): boolean {
  const storeSaysPaid = r.paymentStatus === 'CLAIMED' || r.paymentStatus === 'CAPTURED';
  const denied = r.customerMmgClaim === 'NOT_PAID';
  const referencesDiffer = r.customerMmgClaim === 'PAID'
    && r.customerPaymentRef != null && r.mmgAttestedRef != null && r.customerPaymentRef !== r.mmgAttestedRef;
  const adjudicated = r.mmgClaimResolution === 'CUSTOMER_PAID' && r.mmgClaimResolvedRevision === r.mmgClaimRevision;
  return !(storeSaysPaid && r.mmgClaimMismatchAt == null && (denied || referencesDiffer) && !adjudicated);
}
function checkCustomerShape(r: Row): boolean {
  if (r.customerMmgClaim === 'UNRECORDED') return r.customerMmgClaimAt == null;
  if (r.customerMmgClaim === 'PAID') return r.customerMmgClaimAt != null && r.customerClaimedPaidAt != null;
  return r.customerMmgClaimAt != null && r.customerClaimedPaidAt == null && r.customerPaymentRef == null;
}
function checkResolutionShape(r: Row): boolean {
  const none = r.mmgClaimResolution == null && r.mmgClaimResolvedAt == null && r.mmgClaimResolvedRevision == null;
  const all = r.mmgClaimResolution != null && r.mmgClaimResolvedAt != null && r.mmgClaimResolvedRevision != null
    && r.mmgClaimResolvedRevision >= 1 && r.mmgClaimResolvedRevision <= r.mmgClaimRevision;
  return none || all;
}
function checkAll(r: Row): string | null {
  if (r.mmgClaimRevision < 0) return 'chk_orders_mmg_claim_revision_nonneg';
  if (!checkCustomerShape(r)) return 'chk_orders_customer_mmg_claim_shape';
  if (!checkResolutionShape(r)) return 'chk_orders_mmg_claim_resolution_shape';
  if (!checkDisagreementHeld(r)) return 'chk_orders_mmg_disagreement_held';
  return null;
}

// ---------------------------------------------------------------------------
// An in-memory stand-in for ONE PostgreSQL order row under `SELECT … FOR
// UPDATE`: a per-row FIFO lock, a working copy per transaction, commit only if
// the callback resolves, and per-statement CHECK enforcement.
// ---------------------------------------------------------------------------
class FakeStore {
  rows = new Map<string, Row>();
  audits: Array<Record<string, unknown>> = [];
  outbox: Array<Record<string, unknown>> = [];
  lockStatements: string[] = [];
  readsBeforeLock = 0;
  lockGrants: string[] = [];
  private queues = new Map<string, Promise<void>>();

  seed(row: MmgClaimFacts): void {
    this.rows.set(row.id, structuredClone(row) as Row);
  }

  get(id: string): Row {
    return structuredClone(this.rows.get(id)!) as Row;
  }

  private async acquire(id: string, who: string): Promise<() => void> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.queues.set(id, prior.then(() => mine));
    await prior;
    this.lockGrants.push(who);
    return release;
  }

  async transaction<T>(who: string, fn: (tx: MmgClaimTx) => Promise<T>, failOn?: string): Promise<T> {
    const releases: Array<() => void> = [];
    const working = new Map<string, Row>();
    const audits: Array<Record<string, unknown>> = [];
    const outbox: Array<Record<string, unknown>> = [];
    let locked = false;
    const fail = (op: string) => { if (failOn === op) throw new Error(`injected failure: ${op}`); };
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('$?');
        this.lockStatements.push(sql);
        if (!/FOR UPDATE/.test(sql)) throw new Error(`unexpected raw statement: ${sql}`);
        const id = values[0] as string;
        releases.push(await this.acquire(id, who));
        locked = true;
        const committed = this.rows.get(id);
        if (!committed) return [];
        for (let i = 0; i < values.length; i += 1) {
          const column = /"?(\w+)"?\s*=\s*$/.exec(strings[i] ?? '')?.[1];
          if (column && committed[column] !== values[i]) return [];
        }
        working.set(id, structuredClone(committed) as Row);
        return [{ id }];
      },
      order: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (!locked) this.readsBeforeLock += 1;
          const row = working.get(where.id) ?? this.rows.get(where.id);
          return row ? structuredClone(row) : null;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          fail('order.updateMany');
          const row = working.get(where['id'] as string);
          if (!row) return { count: 0 };
          for (const [key, expected] of Object.entries(where)) {
            if (key === 'id') continue;
            if (expected && typeof expected === 'object' && 'notIn' in (expected as object)) {
              if ((expected as { notIn: unknown[] }).notIn.includes(row[key])) return { count: 0 };
              continue;
            }
            if (row[key] !== expected) return { count: 0 };
          }
          const next = { ...row, ...data } as Row;
          const violated = checkAll(next);
          if (violated) throw Object.assign(new Error(`new row violates check constraint "${violated}"`), { code: '23514' });
          working.set(row.id, next);
          return { count: 1 };
        },
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          fail('auditLog.create');
          audits.push(data);
          return { id: `audit-${this.audits.length + audits.length}` };
        },
      },
      orderOutbox: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
          fail('orderOutbox.createMany');
          let count = 0;
          for (const row of data) {
            const exists = [...this.outbox, ...outbox].some((o) => o['dedupeKey'] === row['dedupeKey']);
            if (!exists) { outbox.push(row); count += 1; }
          }
          return { count };
        },
      },
    } as unknown as MmgClaimTx;
    try {
      const result = await fn(tx);
      for (const [id, row] of working) this.rows.set(id, row);
      this.audits.push(...audits);
      this.outbox.push(...outbox);
      return result;
    } finally {
      for (const release of releases) release();
    }
  }
}

/** The vendor route's transaction, in the order the route performs it: lock
 *  (with the tenant predicate), fresh read, decision, revision-bound CAS,
 *  attestation evidence, then the staged effects. */
async function storeClaim(store: FakeStore, reference: string, now: Date, opts: { hold?: () => Promise<void> } = {}) {
  return store.transaction('STORE', async (tx) => {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${'order-1'} AND "tenantId" = ${'tenant-a'} FOR UPDATE`;
    const locked = (await tx.order.findUnique({ where: { id: 'order-1' } })) as MmgClaimFacts;
    await opts.hold?.();
    const decision = decideStoreMmgClaim(locked, reference, now);
    if (decision.kind === 'ALREADY_CLAIMED') return decision;
    const cas = await tx.order.updateMany({
      where: { id: 'order-1', paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] }, mmgClaimRevision: locked.mmgClaimRevision },
      data: { paymentStatus: 'CLAIMED', ...decision.data },
    });
    expect(cas.count).toBe(1);
    await tx.order.updateMany({ where: { id: 'order-1' }, data: { mmgAttestedRef: reference, mmgAttestedById: 'owner-user', mmgAttestedAt: now } });
    const fresh = (await tx.order.findUnique({ where: { id: 'order-1' } })) as MmgClaimFacts;
    await stageStoreMmgClaim(tx, { facts: fresh, decision, actorId: 'owner-user', reference, now });
    return decision;
  });
}

function customerClaim(store: FakeStore, paid: boolean, reference: string | null, now: Date) {
  return store.transaction('CUSTOMER', (tx) => recordCustomerMmgClaim(tx, {
    orderId: 'order-1', customerId: 'customer-1', tenantId: 'tenant-a', paid, reference, now,
  }));
}

function adminResolve(store: FakeStore, resolution: 'CUSTOMER_PAID' | 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: number, now: Date, failOn?: string) {
  const audit = vi.fn(async (tx: { auditLog: { create(a: { data: Record<string, unknown> }): Promise<unknown> } }, extra: Record<string, unknown>) => {
    await tx.auditLog.create({ data: { action: 'ADMIN POST /api/v1/admin/orders/:id/payment-claim/resolve', entityId: 'order-1', changes: extra } });
  });
  const run = store.transaction('ADMIN', (tx) => resolveMmgClaimDisagreement(tx, {
    orderId: 'order-1', tenantId: 'tenant-a', resolution, expectedClaimRevision, note: 'Checked the wallet statement', actorId: 'admin-1', now, audit,
  }), failOn);
  return { run, audit };
}

afterEach(() => {
  delete mmgClaimLockObserver.afterLock;
});

// ===========================================================================
describe('customer statements — the decision table', () => {
  it('a denial BEFORE any store claim is durable: NOT_PAID recorded, revision advances, payment stays pending, no dispute yet', () => {
    const d = decideCustomerMmgClaim(facts(), { paid: false, reference: null }, T1);
    expect(d.kind).toBe('RECORD');
    if (d.kind !== 'RECORD') return;
    expect(d.next.customerMmgClaim).toBe('NOT_PAID');
    expect(d.next.customerMmgClaimAt).toEqual(T1);
    expect(d.next.paymentStatus).toBe('PENDING');
    expect(d.next.mmgClaimRevision).toBe(1);
    expect(d.next.mmgClaimMismatchAt).toBeNull();
    expect(d.opened).toBe(false);
  });

  it('a denial AFTER the store claimed opens the disagreement in the same write', () => {
    const d = decideCustomerMmgClaim(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }), { paid: false, reference: null }, T1);
    expect(d.kind === 'RECORD' && d.opened).toBe(true);
    if (d.kind !== 'RECORD') return;
    expect(d.data).toMatchObject({ customerMmgClaim: 'NOT_PAID', mmgClaimMismatchAt: T1, mmgClaimRevision: 2 });
    expect(d.reason).toBe('CUSTOMER_DENIED');
  });

  it('a denial against a provider CAPTURE also holds, and never downgrades the capture', () => {
    const d = decideCustomerMmgClaim(facts({ paymentStatus: 'CAPTURED', mmgClaimRevision: 3 }), { paid: false, reference: null }, T1);
    expect(d.kind === 'RECORD' && d.opened).toBe(true);
    if (d.kind !== 'RECORD') return;
    expect(d.next.paymentStatus).toBe('CAPTURED');
    expect(d.data).not.toHaveProperty('paymentStatus');
  });

  it('"I paid" before the store claims records PAID with the reference NORMALISED like the store\'s; nothing is held', () => {
    const d = decideCustomerMmgClaim(facts(), { paid: true, reference: '  mmga0001 ' }, T1);
    expect(d.kind).toBe('RECORD');
    if (d.kind !== 'RECORD') return;
    expect(d.next).toMatchObject({ customerMmgClaim: 'PAID', customerPaymentRef: REF_A, customerClaimedPaidAt: T1, paymentStatus: 'PENDING' });
    expect(d.opened).toBe(false);
  });

  it('a customer statement never authorises fulfilment: PAID leaves the payment state untouched', () => {
    const d = decideCustomerMmgClaim(facts(), { paid: true, reference: null }, T1);
    expect(d.kind === 'RECORD' && d.data).not.toHaveProperty('paymentStatus');
  });

  it('both say paid but the references differ: that is a disagreement, whichever arrives second', () => {
    const d = decideCustomerMmgClaim(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }), { paid: true, reference: REF_B }, T1);
    expect(d.kind === 'RECORD' && d.opened).toBe(true);
    if (d.kind === 'RECORD') expect(d.reason).toBe('REFERENCE_MISMATCH');
  });

  it('matching references (case/space-equivalent) and a positive claim with no reference do not raise a dispute', () => {
    const claimed = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 });
    const same = decideCustomerMmgClaim(claimed, { paid: true, reference: ' mmga0001' }, T1);
    const bare = decideCustomerMmgClaim(claimed, { paid: true, reference: null }, T1);
    expect(same.kind === 'RECORD' && same.opened).toBe(false);
    expect(bare.kind === 'RECORD' && bare.opened).toBe(false);
  });

  it('an exact repeat is a no-op: no new time, no revision, nothing to audit or announce', () => {
    const denied = facts({ customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 1 });
    expect(decideCustomerMmgClaim(denied, { paid: false, reference: null }, T1)).toEqual({ kind: 'UNCHANGED' });
    const paid = facts({ customerMmgClaim: 'PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: T0, customerPaymentRef: REF_A, mmgClaimRevision: 1 });
    expect(decideCustomerMmgClaim(paid, { paid: true, reference: 'mmga0001' }, T1)).toEqual({ kind: 'UNCHANGED' });
  });

  it('a changed statement during an OPEN dispute is recorded but the hold stays latched — neither party clears it', () => {
    const open = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 });
    const d = decideCustomerMmgClaim(open, { paid: true, reference: REF_A }, T1);
    expect(d.kind).toBe('RECORD');
    if (d.kind !== 'RECORD') return;
    expect(d.next.mmgClaimMismatchAt).toEqual(T0);
    expect(d.data).not.toHaveProperty('mmgClaimMismatchAt');
    expect(d.opened).toBe(false);
    expect(d.next.mmgClaimRevision).toBe(3);
  });

  it('an identical denial after an operator upheld the store does NOT reopen the case', () => {
    const upheld = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 });
    expect(decideCustomerMmgClaim(upheld, { paid: false, reference: null }, T2)).toEqual({ kind: 'UNCHANGED' });
  });

  it('a CHANGED statement after an adjudication is new evidence: back to paid then denied again opens a new dispute', () => {
    const upheld = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 });
    const paid = decideCustomerMmgClaim(upheld, { paid: true, reference: null }, T1);
    expect(paid.kind === 'RECORD' && paid.opened).toBe(false);
    if (paid.kind !== 'RECORD') return;
    const deniedAgain = decideCustomerMmgClaim(paid.next, { paid: false, reference: null }, T2);
    expect(deniedAgain.kind === 'RECORD' && deniedAgain.opened).toBe(true);
  });

  it.each([
    ['CASH', 'FOOD_DELIVERY', 'vendor-1', 'NOT_A_WALLET_ORDER'],
    ['MOBILE_MONEY', 'TAXI', null, 'NOT_A_MARKETPLACE_ORDER'],
    ['MOBILE_MONEY', 'COURIER', null, 'NOT_A_MARKETPLACE_ORDER'],
  ])('refuses %s / %s orders (%s)', (paymentMethod, orderType, vendorId, code) => {
    expect(refusal(() => decideCustomerMmgClaim(facts({ paymentMethod, orderType, vendorId }), { paid: false, reference: null }, T1))).toMatchObject({ statusCode: 409, code });
  });

  it.each(['CANCELLED', 'REFUNDED', 'FAILED', 'DELIVERED', 'COMPLETED'])('refuses a claim on closed %s history', (status) => {
    expect(refusal(() => decideCustomerMmgClaim(facts({ status }), { paid: false, reference: null }, T1))).toMatchObject({ statusCode: 409, code: 'ORDER_CLOSED' });
  });

  it.each(['FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED', 'CANCELLED'])('refuses a claim against a %s payment', (paymentStatus) => {
    expect(refusal(() => decideCustomerMmgClaim(facts({ paymentStatus }), { paid: false, reference: null }, T1))).toMatchObject({ statusCode: 409, code: 'PAYMENT_NOT_CLAIMABLE' });
  });

  it('refuses a reference that is not an MMG reference, with the store\'s own validator', () => {
    expect(refusal(() => decideCustomerMmgClaim(facts(), { paid: true, reference: 'ab' }, T1))).toMatchObject({ statusCode: 400, code: 'REFERENCE_REQUIRED' });
    expect(refusal(() => decideCustomerMmgClaim(facts(), { paid: true, reference: 'not a ref!' }, T1))).toMatchObject({ statusCode: 400, code: 'REFERENCE_INVALID' });
  });
});

// ===========================================================================
describe('store claims — the decision table', () => {
  it('a store claim after a durable denial commits CLAIMED and the disagreement in ONE statement', () => {
    const d = decideStoreMmgClaim(facts({ customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 1 }), REF_A, T1);
    expect(d.kind).toBe('CLAIM');
    if (d.kind !== 'CLAIM') return;
    expect(d.data).toEqual({ mmgClaimRevision: 2, mmgClaimMismatchAt: T1 });
    expect(d.opened).toBe(true);
    expect(d.reason).toBe('CUSTOMER_DENIED');
  });

  it('a store reference that differs from the customer\'s opens the disagreement too', () => {
    const d = decideStoreMmgClaim(facts({ customerMmgClaim: 'PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: T0, customerPaymentRef: REF_B, mmgClaimRevision: 1 }), REF_A, T1);
    expect(d.kind === 'CLAIM' && d.opened && d.reason).toBe('REFERENCE_MISMATCH');
  });

  it('agreement and silence do not hold the order', () => {
    const agree = decideStoreMmgClaim(facts({ customerMmgClaim: 'PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: T0, customerPaymentRef: REF_A, mmgClaimRevision: 1 }), REF_A, T1);
    const silent = decideStoreMmgClaim(facts(), REF_A, T1);
    expect(agree).toEqual({ kind: 'CLAIM', data: { mmgClaimRevision: 2 }, opened: false, reason: null });
    expect(silent).toEqual({ kind: 'CLAIM', data: { mmgClaimRevision: 1 }, opened: false, reason: null });
  });

  it.each(['CLAIMED', 'CAPTURED'])('a repeat tap on a %s order is answered without a write, whatever reference it carries', (paymentStatus) => {
    expect(decideStoreMmgClaim(facts({ paymentStatus, mmgAttestedRef: REF_A, mmgClaimRevision: 1 }), REF_B, T1)).toEqual({ kind: 'ALREADY_CLAIMED' });
  });

  it('an attempt an operator already rejected cannot be revived — same reference or a new one', () => {
    const rejected = facts({ paymentStatus: 'PENDING', mmgAttestedRef: REF_A, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY', mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 });
    for (const reference of [REF_A, REF_B]) {
      expect(refusal(() => decideStoreMmgClaim(rejected, reference, T2))).toMatchObject({ statusCode: 409, code: 'MMG_ATTEMPT_REJECTED' });
    }
  });
});

// ===========================================================================
describe('admin resolution — the decision table', () => {
  const open = () => facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 });

  it('CUSTOMER_PAID clears the hold, keeps the store claim AND the customer\'s own words, and binds the decision to the next revision', () => {
    const d = decideMmgClaimResolution(open(), { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 2 }, T1);
    expect(d.kind).toBe('RESOLVE');
    if (d.kind !== 'RESOLVE') return;
    expect(d.data).toEqual({ mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T1, mmgClaimRevision: 3, mmgClaimResolvedRevision: 3 });
    expect(d.next).toMatchObject({ paymentStatus: 'CLAIMED', customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0 });
  });

  it('CUSTOMER_DID_NOT_PAY returns the unresolved claim to PENDING and keeps the store\'s evidence reserved', () => {
    const d = decideMmgClaimResolution(open(), { resolution: 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: 2 }, T1);
    expect(d.kind).toBe('RESOLVE');
    if (d.kind !== 'RESOLVE') return;
    expect(d.data).toMatchObject({ paymentStatus: 'PENDING', mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY' });
    expect(d.data).not.toHaveProperty('mmgAttestedRef');
    expect(d.next.mmgAttestedRef).toBe(REF_A);
    expect(isRejectedMmgAttempt(d.next)).toBe(true);
  });

  it('a decision against an older generation is refused with the current revision', () => {
    expect(refusal(() => decideMmgClaimResolution(open(), { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 1 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'MMG_CLAIM_STALE', details: { currentRevision: 2 } });
  });

  it('nothing to decide when no disagreement is open', () => {
    expect(refusal(() => decideMmgClaimResolution(facts({ paymentStatus: 'CLAIMED', mmgClaimRevision: 1 }), { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 1 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'MMG_CLAIM_NOT_DISPUTED' });
  });

  it('the same decision retried at the same generation is a replay; a different one is refused', () => {
    const d = decideMmgClaimResolution(open(), { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 2 }, T1);
    if (d.kind !== 'RESOLVE') throw new Error('expected RESOLVE');
    expect(decideMmgClaimResolution(d.next, { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 2 }, T2)).toEqual({ kind: 'REPLAY' });
    expect(refusal(() => decideMmgClaimResolution(d.next, { resolution: 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: 2 }, T2)))
      .toMatchObject({ statusCode: 409, code: 'MMG_CLAIM_ALREADY_RESOLVED' });
  });

  it('a provider CAPTURE is never downgraded by a decision', () => {
    expect(refusal(() => decideMmgClaimResolution({ ...open(), paymentStatus: 'CAPTURED' }, { resolution: 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: 2 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'MMG_CAPTURE_NOT_REVERSIBLE' });
  });

  it.each(['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'])('after custody (%s) a not-paid decision needs the recovery workflow', (status) => {
    expect(refusal(() => decideMmgClaimResolution({ ...open(), status }, { resolution: 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: 2 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'MMG_RECOVERY_REQUIRED' });
  });

  it('closed history is not rewritten', () => {
    expect(refusal(() => decideMmgClaimResolution({ ...open(), status: 'CANCELLED' }, { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 2 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'ORDER_CLOSED' });
  });

  it('a decision cannot manufacture a store claim that does not exist', () => {
    expect(refusal(() => decideMmgClaimResolution({ ...open(), paymentStatus: 'PENDING', mmgAttestedRef: null }, { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 2 }, T1)))
      .toMatchObject({ statusCode: 409, code: 'MMG_NO_STORE_CLAIM' });
  });
});

// ===========================================================================
describe('the invariant the migration enforces', () => {
  it('the TypeScript predicate and the independent CHECK oracle agree on the finding-6 end state', () => {
    const bad = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 2 });
    expect(violatesDisagreementHold(bad)).toBe(true);
    expect(checkDisagreementHeld(bad as Row)).toBe(false);
    expect(claimsDisagree(bad)).toBe(true);
    const upheld = { ...bad, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_PAID' as const, mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 };
    expect(adjudicationCoversCurrentFacts(upheld)).toBe(true);
    expect(violatesDisagreementHold(upheld)).toBe(false);
    const stale = { ...upheld, mmgClaimRevision: 4 };
    expect(violatesDisagreementHold(stale)).toBe(true);
  });

  it('EXHAUSTIVE: from every valid state, every command yields a row the database accepts', () => {
    const payments = ['PENDING', 'AUTHORIZED', 'CLAIMED', 'CAPTURED'];
    const customers: Array<Partial<MmgClaimFacts>> = [
      { customerMmgClaim: 'UNRECORDED' },
      { customerMmgClaim: 'PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: T0 },
      { customerMmgClaim: 'PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: T0, customerPaymentRef: REF_A },
      { customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0 },
    ];
    const storeRefs = [null, REF_A, REF_B];
    const mismatches = [null, T0];
    const decisions: Array<Partial<MmgClaimFacts>> = [
      {},
      { mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T0, mmgClaimResolvedRevision: 5 },
      { mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T0, mmgClaimResolvedRevision: 4 },
      { mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY', mmgClaimResolvedAt: T0, mmgClaimResolvedRevision: 5 },
    ];
    let states = 0;
    let transitions = 0;
    for (const paymentStatus of payments) for (const c of customers) for (const mmgAttestedRef of storeRefs) for (const mmgClaimMismatchAt of mismatches) for (const dec of decisions) {
      const start = facts({ paymentStatus, mmgAttestedRef, mmgClaimMismatchAt, mmgClaimRevision: 5, ...c, ...dec });
      if (checkAll(start as Row)) continue; // not a state the database can hold
      states += 1;
      const apply = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const next = { ...start, ...data, ...extra } as Row;
        expect(checkAll(next), JSON.stringify({ start, data })).toBeNull();
        transitions += 1;
      };
      for (const cmd of [{ paid: false, reference: null }, { paid: true, reference: null }, { paid: true, reference: REF_A }, { paid: true, reference: REF_B }]) {
        try {
          const d = decideCustomerMmgClaim(start, cmd, T1);
          if (d.kind === 'RECORD') apply(d.data);
        } catch (err) { expect((err as { statusCode: number }).statusCode).toBe(409); }
      }
      for (const reference of [REF_A, REF_B]) {
        try {
          const d = decideStoreMmgClaim(start, reference, T1);
          if (d.kind === 'CLAIM') {
            apply({ paymentStatus: 'CLAIMED', ...d.data });
            apply({ paymentStatus: 'CLAIMED', ...d.data }, { mmgAttestedRef: reference });
          }
        } catch (err) { expect((err as { code: string }).code).toBe('MMG_ATTEMPT_REJECTED'); }
      }
      for (const resolution of ['CUSTOMER_PAID', 'CUSTOMER_DID_NOT_PAY'] as const) {
        try {
          const d = decideMmgClaimResolution(start, { resolution, expectedClaimRevision: start.mmgClaimRevision }, T1);
          if (d.kind === 'RESOLVE') apply(d.data);
        } catch (err) { expect((err as { statusCode: number }).statusCode).toBe(409); }
      }
    }
    expect(states).toBeGreaterThan(60);
    expect(transitions).toBeGreaterThan(200);
  });

  it('the migration carries the same four constraints, with the same load-bearing terms', () => {
    const dir = join(process.cwd(), 'prisma', 'migrations');
    const name = readdirSync(dir).find((d) => d.endsWith('_mmg_claim_disagreement'));
    expect(name, 'the direct-MMG claim migration exists').toBeTruthy();
    const sql = readFileSync(join(dir, name!, 'migration.sql'), 'utf8');
    for (const constraint of ['chk_orders_mmg_claim_revision_nonneg', 'chk_orders_customer_mmg_claim_shape', 'chk_orders_mmg_claim_resolution_shape', 'chk_orders_mmg_disagreement_held']) {
      expect(sql).toContain(`"${constraint}"`);
    }
    const held = sql.slice(sql.indexOf('"chk_orders_mmg_disagreement_held"'));
    // NULL-safe on purpose: a CHECK passes when its expression is NULL, so the
    // coverage clause must never be able to evaluate to NULL.
    for (const term of [`"paymentStatus" IN ('CLAIMED', 'CAPTURED')`, `"mmgClaimMismatchAt" IS NULL`, `"customerMmgClaim" = 'NOT_PAID'`, `"customerPaymentRef" <> "mmgAttestedRef"`, `"mmgClaimResolution" IS NOT DISTINCT FROM 'CUSTOMER_PAID'`, `"mmgClaimResolvedRevision" IS NOT DISTINCT FROM "mmgClaimRevision"`]) {
      expect(held, term).toContain(term);
    }
  });
});

// ===========================================================================
describe('the one locked authority — transaction staging', () => {
  it('the customer command takes the row lock FIRST — with the customer and tenant predicates — then reads', async () => {
    const store = new FakeStore();
    store.seed(facts());
    await customerClaim(store, false, null, T1);
    expect(store.readsBeforeLock).toBe(0);
    expect(store.lockStatements[0]).toMatch(/FROM "orders" WHERE "id" = \$\? AND "customerId" = \$\? AND "tenantId" = \$\? FOR UPDATE/);
  });

  it('a foreign customer or a foreign tenant finds nothing — and nothing is written', async () => {
    const store = new FakeStore();
    store.seed(facts());
    await expect(store.transaction('X', (tx) => recordCustomerMmgClaim(tx, { orderId: 'order-1', customerId: 'someone-else', tenantId: 'tenant-a', paid: false, reference: null, now: T1 })))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(store.transaction('X', (tx) => recordCustomerMmgClaim(tx, { orderId: 'order-1', customerId: 'customer-1', tenantId: 'tenant-b', paid: false, reference: null, now: T1 })))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(store.get('order-1').customerMmgClaim).toBe('UNRECORDED');
    expect(store.audits).toHaveLength(0);
  });

  it('a recorded change writes the state, its evidence and (when a dispute opens) its durable obligation together', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }));
    const out = await customerClaim(store, false, null, T1);
    expect(out).toMatchObject({ replayed: false, opened: true });
    expect(store.get('order-1')).toMatchObject({ customerMmgClaim: 'NOT_PAID', mmgClaimMismatchAt: T1, mmgClaimRevision: 2 });
    expect(store.audits.map((a) => a['action'])).toEqual(['CUSTOMER_CLAIMED_NOT_PAID', 'MMG_CLAIM_MISMATCH']);
    expect(store.outbox).toHaveLength(1);
    const row = store.outbox[0]!;
    expect(row).toMatchObject({ kind: MMG_CLAIM_NOTICE_KIND, queue: 'notification', orderId: 'order-1', tenantId: 'tenant-a', dedupeKey: mmgClaimNoticeDedupeKey('order-1', 2) });
    expect(row['id']).toBe(checkoutOutboxId(mmgClaimNoticeDedupeKey('order-1', 2)));
    expect(row['payload']).toMatchObject({ orderId: 'order-1', tenantId: 'tenant-a', revision: 2, effect: 'DISAGREEMENT_OPENED', openedBy: 'CUSTOMER', reason: 'CUSTOMER_DENIED' });
  });

  it('a duplicate claim from the same party writes nothing at all', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }));
    await customerClaim(store, false, null, T1);
    const before = { audits: store.audits.length, outbox: store.outbox.length, row: store.get('order-1') };
    const again = await customerClaim(store, false, null, T2);
    expect(again).toMatchObject({ replayed: true, opened: false, notice: null });
    expect(store.audits).toHaveLength(before.audits);
    expect(store.outbox).toHaveLength(before.outbox);
    expect(store.get('order-1')).toEqual(before.row);
  });

  it.each(['order.updateMany', 'auditLog.create', 'orderOutbox.createMany'])('a failure at %s rolls the claim back entirely', async (failOn) => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }));
    await expect(store.transaction('CUSTOMER', (tx) => recordCustomerMmgClaim(tx, { orderId: 'order-1', customerId: 'customer-1', tenantId: 'tenant-a', paid: false, reference: null, now: T1 }), failOn))
      .rejects.toThrow(/injected failure/);
    expect(store.get('order-1')).toMatchObject({ customerMmgClaim: 'UNRECORDED', mmgClaimMismatchAt: null, mmgClaimRevision: 1 });
    expect(store.audits).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  async function race(first: 'CUSTOMER' | 'STORE') {
    const store = new FakeStore();
    store.seed(facts());
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const hold = async () => { holding(); await gate; };
    mmgClaimLockObserver.afterLock = async ({ actor }) => { if (actor === first) await hold(); };
    const a = first === 'CUSTOMER' ? customerClaim(store, false, null, T1) : storeClaim(store, REF_A, T1, { hold });
    await held;
    const b = first === 'CUSTOMER' ? storeClaim(store, REF_A, T2) : customerClaim(store, false, null, T2);
    await new Promise((r) => setTimeout(r, 25));
    // The second command is WAITING on the row lock — it has not been granted it.
    expect(store.lockGrants).toEqual([first]);
    open();
    await Promise.all([a, b]);
    return store;
  }

  it.each(['CUSTOMER', 'STORE'] as const)('%s first, contended: both commit, and the final row is CLAIMED + NOT_PAID + an open disagreement', async (first) => {
    const store = await race(first);
    expect(store.lockGrants).toHaveLength(2);
    const row = store.get('order-1');
    expect(row).toMatchObject({ paymentStatus: 'CLAIMED', customerMmgClaim: 'NOT_PAID', mmgAttestedRef: REF_A, mmgClaimRevision: 2 });
    expect(row.mmgClaimMismatchAt).not.toBeNull();
    expect(checkAll(row)).toBeNull();
    const opened = store.outbox.filter((o) => (o['payload'] as { effect: string }).effect === 'DISAGREEMENT_OPENED');
    expect(opened, 'exactly one durable disagreement obligation').toHaveLength(1);
    expect(store.audits.filter((a) => a['action'] === 'MMG_CLAIM_MISMATCH')).toHaveLength(1);
  });

  it('the admin decision locks with the tenant predicate, binds the revision, and stages audit + obligation in the same transaction', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 }));
    const { run, audit } = adminResolve(store, 'CUSTOMER_PAID', 2, T1);
    const out = await run;
    expect(store.lockStatements[0]).toMatch(/FROM "orders" WHERE "id" = \$\? AND "tenantId" = \$\? FOR UPDATE/);
    expect(out).toMatchObject({ replayed: false });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![1]).toMatchObject({ decision: 'CUSTOMER_PAID', expectedClaimRevision: 2, claimRevision: 3, paymentStatusBefore: 'CLAIMED', paymentStatusAfter: 'CLAIMED' });
    expect(store.get('order-1')).toMatchObject({ mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedRevision: 3, mmgClaimRevision: 3 });
    expect(store.outbox.map((o) => (o['payload'] as { effect: string; resolution: string })))
      .toEqual([expect.objectContaining({ effect: 'RESOLVED', resolution: 'CUSTOMER_PAID', revision: 3 })]);
  });

  it('a retried decision: one resolution, one audit, one durable event', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 }));
    const first = adminResolve(store, 'CUSTOMER_DID_NOT_PAY', 2, T1);
    await first.run;
    const second = adminResolve(store, 'CUSTOMER_DID_NOT_PAY', 2, T2);
    const replay = await second.run;
    expect(replay).toMatchObject({ replayed: true, notice: null });
    expect(first.audit).toHaveBeenCalledTimes(1);
    expect(second.audit).not.toHaveBeenCalled();
    expect(store.audits).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
    expect(store.get('order-1')).toMatchObject({ paymentStatus: 'PENDING', mmgClaimRevision: 3 });
  });

  it('two different decisions on one generation: exactly one winner; the conflicting one is refused', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 }));
    const paid = adminResolve(store, 'CUSTOMER_PAID', 2, T1);
    const notPaid = adminResolve(store, 'CUSTOMER_DID_NOT_PAY', 2, T1);
    const results = await Promise.allSettled([paid.run, notPaid.run]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ statusCode: 409, code: 'MMG_CLAIM_ALREADY_RESOLVED' });
    expect(store.audits).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
  });

  it.each(['order.updateMany', 'auditLog.create', 'orderOutbox.createMany'])('a failure at %s rolls the decision back: the dispute stays open', async (failOn) => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 }));
    await expect(adminResolve(store, 'CUSTOMER_PAID', 2, T1, failOn).run).rejects.toThrow(/injected failure/);
    expect(store.get('order-1')).toMatchObject({ mmgClaimMismatchAt: T0, mmgClaimResolution: null, mmgClaimRevision: 2, paymentStatus: 'CLAIMED' });
    expect(store.outbox).toHaveLength(0);
  });

  it('a delayed decision against D0 cannot clear a newer dispute D1', async () => {
    const store = new FakeStore();
    store.seed(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 }));
    await adminResolve(store, 'CUSTOMER_PAID', 2, T1).run;          // D0 resolved -> revision 3
    await customerClaim(store, true, null, T1);                        // changed statement -> 4
    await customerClaim(store, false, null, T2);                       // changed again -> D1 opened at 5
    expect(store.get('order-1').mmgClaimMismatchAt).toEqual(T2);
    await expect(adminResolve(store, 'CUSTOMER_PAID', 2, T2).run).resolves.toMatchObject({ replayed: true });
    expect(store.get('order-1').mmgClaimMismatchAt, 'D1 survives the D0 replay').toEqual(T2);
    await expect(adminResolve(store, 'CUSTOMER_DID_NOT_PAY', 3, T2).run).rejects.toMatchObject({ code: 'MMG_CLAIM_STALE' });
    expect(store.get('order-1').mmgClaimMismatchAt).toEqual(T2);
  });

  it('the store path stages its disagreement evidence and obligation inside the claim transaction', async () => {
    const store = new FakeStore();
    store.seed(facts({ customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 1 }));
    await storeClaim(store, REF_A, T1);
    expect(store.audits.map((a) => a['action'])).toEqual(['MMG_CLAIM_MISMATCH']);
    expect(store.outbox.map((o) => o['payload'])).toEqual([expect.objectContaining({ effect: 'DISAGREEMENT_OPENED', openedBy: 'STORE', reason: 'CUSTOMER_DENIED', revision: 2 })]);
  });

  it('an undisputed store claim stages exactly one customer notice obligation', async () => {
    const store = new FakeStore();
    store.seed(facts());
    await storeClaim(store, REF_A, T1);
    expect(store.audits).toHaveLength(0);
    expect(store.outbox.map((o) => o['payload'])).toEqual([expect.objectContaining({ effect: 'STORE_CLAIMED', revision: 1 })]);
  });
});

// ===========================================================================
describe('durable notices — keyed, truthful when delivered', () => {
  const owner = { vendor: { owner: { userId: 'owner-user' } } };
  function deps(row: MmgClaimFacts, adminReach = 2) {
    const sent: Array<Record<string, unknown>> = [];
    const pages: Array<Record<string, unknown>> = [];
    const processed: Array<Record<string, unknown>> = [];
    return {
      sent, pages, processed,
      deps: {
        prisma: {
          order: { findFirst: vi.fn(async () => ({ ...row, ...owner })) },
          orderOutbox: { updateMany: vi.fn(async (a: Record<string, unknown>) => { processed.push(a); return { count: 1 }; }) },
        },
        notifications: { send: vi.fn(async (p: Record<string, unknown>) => { sent.push(p); return `n-${sent.length}`; }) },
        pageAdmins: vi.fn(async (p: Record<string, unknown>) => { pages.push(p); return adminReach; }),
      },
    };
  }
  const notice = (over: Partial<MmgClaimNotice>): MmgClaimNotice => ({ orderId: 'order-1', tenantId: 'tenant-a', revision: 2, effect: 'DISAGREEMENT_OPENED', openedBy: 'CUSTOMER', reason: 'CUSTOMER_DENIED', resolution: null, ...over });
  const disputed = facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T0, mmgClaimRevision: 2 });

  it('an open disagreement reaches the customer, the store and the tenant\'s operators, each under a deterministic key', async () => {
    const h = deps(disputed);
    const out = await deliverMmgClaimNotice(h.deps as never, notice({}));
    expect(out.complete).toBe(true);
    expect(h.sent.map((s) => [s['userId'], s['dedupeKey'], s['audience']])).toEqual([
      ['customer-1', 'mmg-claim:order-1:r2:customer', 'customer'],
      ['owner-user', 'mmg-claim:order-1:r2:business', 'business'],
    ]);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({ tenantId: 'tenant-a', dedupeKey: 'mmg-claim:order-1:r2:admin', data: { kind: 'mmg_claim_mismatch', orderId: 'order-1' } });
    expect(String(h.pages[0]!['body'])).toContain('order-1');
    expect(h.deps.prisma.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1', tenantId: 'tenant-a' } }));
  });

  it('a delayed obligation never portrays a dispute that is already resolved as open', async () => {
    const h = deps({ ...disputed, mmgClaimMismatchAt: null, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 });
    const out = await deliverMmgClaimNotice(h.deps as never, notice({}));
    expect(out).toMatchObject({ complete: true, sent: [] });
    expect(h.pages).toHaveLength(0);
  });

  it('the store\'s claim is announced as the store\'s word — never as a confirmation', async () => {
    const h = deps(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, mmgClaimRevision: 1 }));
    await deliverMmgClaimNotice(h.deps as never, notice({ effect: 'STORE_CLAIMED', revision: 1, openedBy: null, reason: null }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ userId: 'customer-1', type: 'PAYMENT_RECEIVED', dedupeKey: 'mmg-claim:order-1:r1:customer', data: { kind: 'mmg_payment_confirmed', orderId: 'order-1' } });
    expect(String(h.sent[0]!['body'])).toMatch(/reported/);
    expect(`${String(h.sent[0]!['title'])} ${String(h.sent[0]!['body'])}`).not.toMatch(/is confirmed|Payment received\b/);
    expect(h.pages).toHaveLength(0);
  });

  it('a store-claim notice is withheld if a dispute opened before it could be delivered', async () => {
    const h = deps(disputed);
    const out = await deliverMmgClaimNotice(h.deps as never, notice({ effect: 'STORE_CLAIMED', revision: 1, openedBy: null, reason: null }));
    expect(out.sent).toEqual([]);
    expect(out.skipped).toContain('customer');
  });

  it('a decision reaches both parties; a superseded decision is not announced', async () => {
    const decided = facts({ paymentStatus: 'PENDING', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_DID_NOT_PAY', mmgClaimResolvedAt: T1, mmgClaimResolvedRevision: 3 });
    const h = deps(decided);
    await deliverMmgClaimNotice(h.deps as never, notice({ effect: 'RESOLVED', revision: 3, openedBy: null, reason: null, resolution: 'CUSTOMER_DID_NOT_PAY' }));
    expect(h.sent.map((s) => s['dedupeKey'])).toEqual(['mmg-claim:order-1:r3:customer', 'mmg-claim:order-1:r3:business']);
    const later = deps({ ...decided, mmgClaimRevision: 4, customerMmgClaim: 'PAID', customerClaimedPaidAt: T2, customerMmgClaimAt: T2 });
    const out = await deliverMmgClaimNotice(later.deps as never, notice({ effect: 'RESOLVED', revision: 3, openedBy: null, reason: null, resolution: 'CUSTOMER_DID_NOT_PAY' }));
    expect(out.sent).toEqual([]);
  });

  it('an admin page that reached nobody leaves the obligation unfinished; a complete delivery marks it processed', async () => {
    const nobody = deps(disputed, 0);
    const pending = await completeMmgClaimNotice(nobody.deps as never, { outboxId: 'oob_1', notice: notice({}) });
    expect(pending.complete).toBe(false);
    expect(nobody.processed).toHaveLength(0);
    const reached = deps(disputed, 1);
    const done = await completeMmgClaimNotice(reached.deps as never, { outboxId: 'oob_1', notice: notice({}) });
    expect(done.complete).toBe(true);
    expect(reached.processed).toEqual([expect.objectContaining({ where: { id: 'oob_1', processedAt: null } })]);
  });

  it('the worker payload is parsed strictly; a malformed obligation fails closed', () => {
    expect(parseMmgClaimNoticePayload({ orderId: 'order-1', tenantId: 'tenant-a', revision: 2, effect: 'DISAGREEMENT_OPENED', openedBy: 'STORE', reason: 'CUSTOMER_DENIED', resolution: null }))
      .toMatchObject({ orderId: 'order-1', revision: 2 });
    expect(() => parseMmgClaimNoticePayload({ orderId: 'order-1', revision: 2, effect: 'DISAGREEMENT_OPENED' })).toThrow();
    expect(() => parseMmgClaimNoticePayload({ orderId: 'order-1', tenantId: 'tenant-a', revision: -1, effect: 'DISAGREEMENT_OPENED' })).toThrow();
    expect(() => parseMmgClaimNoticePayload({ orderId: 'order-1', tenantId: 'tenant-a', revision: 2, effect: 'SOMETHING_ELSE' })).toThrow();
  });

  // [R2 · Sol review S2] A queue worker cannot confirm delivery: the publisher
  // marks the row done when BullMQ accepts the job. So the obligation is NOT
  // published — the sweep delivers it in process and closes it only on success.
  it('the outbox sweep — not a publish-and-forget queue job — delivers the obligation', () => {
    const queue = readFileSync(join(process.cwd(), 'src', 'jobs', 'queue.ts'), 'utf8');
    const worker = queue.slice(queue.indexOf('const notificationWorker = buildWorker('), queue.indexOf('const dispatchWorker = buildWorker('));
    expect(worker, 'no queue worker handles the kind').not.toMatch(/mmg-claim-notice/);
    expect(JOB_RECOVERY['mmg-claim-notice' as keyof typeof JOB_RECOVERY], 'and no job class exists for it').toBeUndefined();
    const sweep = queue.slice(queue.indexOf("if (job.name === 'checkout-outbox')"), queue.indexOf("if (job.name === 'mover-revocation-outbox')"));
    expect(sweep).toMatch(/drainMmgClaimNotices\(/);
    expect(sweep.indexOf('drainMmgClaimNotices(')).toBeGreaterThan(sweep.indexOf('drainCheckoutOutbox('));
    const inProcess = (outboxModule as Record<string, unknown>)['IN_PROCESS_OUTBOX_KINDS'] as readonly string[] | undefined;
    expect(inProcess, 'the generic publisher names the kinds it must never consume').toContain(MMG_CLAIM_NOTICE_KIND);
    expect(MMG_CLAIM_NOTICE_KIND).toBe('mmg-claim-notice');
  });
});

// ===========================================================================
describe('projection and dispatch visibility', () => {
  it('the customer projection says what each party said, whether it is held, and whether a claim may be made', () => {
    const view = mmgClaimView(facts({ paymentStatus: 'CLAIMED', mmgAttestedRef: REF_A, customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, mmgClaimMismatchAt: T1, mmgClaimRevision: 2 }));
    expect(view).toEqual({
      customerClaim: 'NOT_PAID', customerClaimAt: T0.toISOString(), storeClaimed: true, providerCaptured: false,
      disputed: true, disputedAt: T1.toISOString(), resolution: null, resolvedAt: null, attemptRejected: false, revision: 2, canClaim: true,
    });
    expect(mmgClaimView(facts({ paymentMethod: 'CASH' }))).toBeNull();
    expect(mmgClaimView(facts({ orderType: 'TAXI', vendorId: null }))).toBeNull();
    expect(mmgClaimView(facts({ status: 'DELIVERED' }))?.canClaim).toBe(false);
    expect(mmgClaimView(facts({ paymentStatus: 'PENDING', mmgAttestedRef: REF_A }))?.attemptRejected).toBe(true);
  });

  const matrix: Array<[string, Partial<MmgClaimFacts>, boolean]> = [
    ['undisputed store claim', { paymentStatus: 'CLAIMED' }, false],
    ['provider capture', { paymentStatus: 'CAPTURED' }, false],
    ['open disagreement on a claim', { paymentStatus: 'CLAIMED', mmgClaimMismatchAt: T0 }, true],
    ['open disagreement on a capture', { paymentStatus: 'CAPTURED', mmgClaimMismatchAt: T0 }, true],
    ['unpaid MMG', { paymentStatus: 'PENDING' }, true],
    ['rejected attempt', { paymentStatus: 'PENDING', mmgAttestedRef: REF_A }, true],
    ['cash', { paymentMethod: 'CASH', paymentStatus: 'PENDING' }, false],
    ['taxi', { orderType: 'TAXI', vendorId: null, paymentStatus: 'PENDING' }, false],
  ];

  it.each(matrix)('dispatch visibility — %s', (_label, over, blocked) => {
    expect(mmgDispatchBlocked(facts(over))).toBe(blocked);
  });

  it('the board filter and the offer predicate agree on every case', () => {
    const where = mmgDispatchEligibleWhere() as { OR: Array<Record<string, unknown>> };
    const matches = (row: MmgClaimFacts) => where.OR.some((clause) => Object.entries(clause).every(([k, v]) => {
      const value = (row as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'not' in (v as object)) return value !== (v as { not: unknown }).not;
      if (v && typeof v === 'object' && 'in' in (v as object)) return (v as { in: unknown[] }).in.includes(value);
      return value === v;
    }));
    for (const [label, over, blocked] of matrix) {
      expect(matches(facts(over)), label).toBe(!blocked);
    }
  });

  it('an unprojected disagreement column fails closed rather than passing', () => {
    expect(() => mmgDispatchBlocked({ paymentMethod: 'MOBILE_MONEY', orderType: 'FOOD_DELIVERY', paymentStatus: 'CLAIMED' } as never)).toThrow(/not projected/);
  });

  it('agrees with the LOCKED assignment gate on every case — visibility never offers what assignment refuses', async () => {
    const { assertMmgFulfilmentAllowed } = await import('../modules/order/order.service');
    for (const [label, over, blocked] of matrix) {
      let refused = false;
      try {
        assertMmgFulfilmentAllowed(facts(over) as never, 'RIDER_ASSIGNED');
      } catch {
        refused = true;
      }
      expect(refused, label).toBe(blocked);
    }
  });

  it('offer generation and the rider board both apply it', () => {
    const dispatch = readFileSync(join(process.cwd(), 'src', 'modules', 'dispatch', 'dispatch.service.ts'), 'utf8');
    const offer = dispatch.slice(dispatch.indexOf('async dispatchOrder('), dispatch.indexOf('// One live offer at a time'));
    expect(offer).toMatch(/mmgClaimMismatchAt: true/);
    expect(offer).toMatch(/mmgDispatchBlocked\(order\)/);
    const rider = readFileSync(join(process.cwd(), 'src', 'modules', 'rider', 'rider.routes.ts'), 'utf8');
    const board = rider.slice(rider.indexOf("app.get('/orders/available'"), rider.indexOf('customerTrustSummaries(app.prisma, orders.map'));
    expect(board).toMatch(/mmgDispatchEligibleWhere\(\)/);
  });
});

// ===========================================================================
describe('route contracts — no unlocked writer survives', () => {
  const handler = (file: string, start: string, end: string) => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', ...file.split('/')), 'utf8');
    const i = src.indexOf(start);
    expect(i, `${start} in ${file}`).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf(end, i + start.length));
  };

  it('customer payment-claim: one transaction through the authority; no bare order update or after-commit audit', () => {
    const h = handler('user/customer.routes.ts', "app.post('/orders/:id/payment-claim'", "app.post('/orders/:id/cancel'");
    expect(h).toMatch(/app\.prisma\.\$transaction\(\s*\(tx\) => recordCustomerMmgClaim\(tx,/);
    expect(h).not.toMatch(/app\.prisma\.order\.update\(/);
    expect(h).not.toMatch(/app\.prisma\.auditLog\.create\(/);
    expect(h).not.toMatch(/notifyAdmins\(/);
  });

  it('admin resolve: the reviewed revision is REQUIRED, and state + audit + obligation share one transaction', () => {
    const h = handler('admin/admin.routes.ts', "app.post('/orders/:id/payment-claim/resolve'", "app.put('/verification/:id/revoke'");
    expect(h).toMatch(/expectedClaimRevision: z\.number\(\)\.int\(\)\.min\(0\)/);
    expect(h).toMatch(/\$transaction\(\s*\(tx\) => resolveMmgClaimDisagreement\(tx,/);
    expect(h).toMatch(/auditWithin\(/);
    expect(h).not.toMatch(/await audit\(/);
    expect(h).not.toMatch(/app\.prisma\.order\.update\(/);
  });

  it('vendor confirm-payment: the decision is taken on the LOCKED row and bound to its revision', () => {
    const h = handler('vendor/vendor.routes.ts', "app.post<{ Params: IdParam }>('/orders/:id/confirm-payment'", "app.get('/cash-settlements'");
    expect(h.indexOf('decideStoreMmgClaim(locked')).toBeGreaterThan(h.indexOf('FOR UPDATE'));
    expect(h).toMatch(/"tenantId" = \$\{order\.tenantId\} FOR UPDATE/);
    expect(h).toMatch(/mmgClaimRevision: locked\.mmgClaimRevision/);
    expect(h).toMatch(/stageStoreMmgClaim\(tx,/);
    expect(h).not.toMatch(/is confirmed\./);
  });
});

// Keep the fixtures honest: the migration exists where the Prisma CLI will look.
describe('artifact presence', () => {
  it('the service module exists', () => {
    expect(existsSync(join(process.cwd(), 'src', 'modules', 'order', 'mmg-claim.service.ts'))).toBe(true);
  });
});
