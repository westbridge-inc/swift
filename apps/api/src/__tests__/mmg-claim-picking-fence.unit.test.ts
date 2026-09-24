/**
 * [ORDER-SPINE S1-6 · R2 · Sol review S1] Affirmative grocery picking and
 * substitution proposal commit under the SAME order-row fence as the direct-MMG
 * claim authority.
 *
 * Ticking a shelf-picked line and opening a substitution are affirmative
 * preparation. R1 gated them on a PREVIEW read and then wrote with only the
 * line state and the order lifecycle in the predicate, so a customer's "I did
 * not pay" could commit between the two and the pick still landed on a held
 * order. These drive the real `PickingService` and the real
 * `recordCustomerMmgClaim` against one in-memory order row with a FIFO row lock
 * — the stand-in for `SELECT … FOR UPDATE` — in both arrival orders:
 *
 *   - the denial commits between the picking preview and its write: the
 *     affirmative write must be refused on the locked row;
 *   - the picking command holds the row first: the denial must WAIT on that
 *     same lock, and the dispute is then recorded after the (legitimate) pick.
 *
 * The real two-session PostgreSQL version lives in mmg-claim-races.test.ts and
 * is held with the database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PickingService } from '../modules/order/picking.service';
import { mmgClaimLockObserver, recordCustomerMmgClaim, resolveMmgClaimDisagreement, type MmgClaimTx } from '../modules/order/mmg-claim.service';

type Row = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const PICKABLE_ORDER = {
  id: 'order-1', tenantId: 'tenant-a', orderNumber: 'SW-2001', customerId: 'customer-1', vendorId: 'vendor-1',
  orderType: 'GROCERY_DELIVERY', status: 'PREPARING', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
  mmgAttestedRef: 'MMGA0001', customerMmgClaim: 'UNRECORDED', customerMmgClaimAt: null, customerClaimedPaidAt: null,
  customerPaymentRef: null, mmgClaimMismatchAt: null, mmgClaimRevision: 1, mmgClaimResolution: null,
  mmgClaimResolvedAt: null, mmgClaimResolvedRevision: null, riderId: null, totalAmount: 1500,
};
const LINE = {
  id: 'line-1', orderId: 'order-1', itemId: 'item-rice', name: 'Rice 5kg', quantity: 1, picked: false,
  subStatus: 'NONE', substituteItemId: null, substituteName: null, substitutePrice: null, totalCustomer: 1000,
};
const ITEMS: Row[] = [
  { id: 'item-rice', vendorId: 'vendor-1', name: 'Rice 5kg', isAvailable: false, substitutionGroup: 'rice', basePrice: 1000 },
  { id: 'item-rice-b', vendorId: 'vendor-1', name: 'Rice 5kg (other brand)', isAvailable: true, substitutionGroup: 'rice', basePrice: 1000 },
];

/** One order row, its lines and a catalogue, with a FIFO row lock, per-
 *  transaction working copies, commit-only-on-success, and a commit sequence
 *  that records WHEN the dispute and the first affirmative line write landed. */
class FakeOrderDb {
  orders = new Map<string, Row>([[PICKABLE_ORDER.id, clone(PICKABLE_ORDER)]]);
  lines = new Map<string, Row>([[LINE.id, clone(LINE)]]);
  items = new Map<string, Row>(ITEMS.map((i) => [i['id'] as string, clone(i)]));
  audits: Row[] = [];
  outbox: Row[] = [];
  statusLogs: Row[] = [];
  seq = 0;
  disputeSeq: number | null = null;
  affirmativeSeq: number | null = null;
  lockGrants: string[] = [];
  /** One-shot pause after a PREVIEW read (outside any transaction). */
  previewHook?: () => Promise<void>;
  /** Pause while a lock is held, by the label of whoever holds it. */
  lockHook?: (label: string) => Promise<void>;
  private queues = new Map<string, Promise<void>>();

  order(id = 'order-1'): Row { return clone(this.orders.get(id)!); }
  line(id = 'line-1'): Row { return clone(this.lines.get(id)!); }

  private commitOrder(next: Row): void {
    const prev = this.orders.get(next['id'])!;
    this.seq += 1;
    if (prev['mmgClaimMismatchAt'] == null && next['mmgClaimMismatchAt'] != null && this.disputeSeq == null) this.disputeSeq = this.seq;
    this.orders.set(next['id'], next);
  }

  private commitLine(next: Row): void {
    const prev = this.lines.get(next['id'])!;
    this.seq += 1;
    const affirmative = (!prev['picked'] && next['picked']) || (prev['subStatus'] === 'NONE' && next['subStatus'] === 'PENDING');
    if (affirmative && this.affirmativeSeq == null) this.affirmativeSeq = this.seq;
    this.lines.set(next['id'], next);
  }

  private async acquire(id: string, label: string): Promise<() => void> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.queues.set(id, prior.then(() => mine));
    await prior;
    this.lockGrants.push(label);
    await this.lockHook?.(label);
    return release;
  }

  private lineMatches(line: Row, order: Row, where: Row): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'order') {
        const status = (cond as { status?: { in?: string[] } }).status;
        if (status?.in && !status.in.includes(order['status'])) return false;
        continue;
      }
      if (cond && typeof cond === 'object' && 'notIn' in (cond as Row)) {
        if ((cond as { notIn: unknown[] }).notIn.includes(line[key])) return false;
        continue;
      }
      if (line[key] !== cond) return false;
    }
    return true;
  }

  client(): unknown {
    const db = this;
    return {
      orderItem: {
        findFirst: async ({ where }: { where: Row }) => {
          const line = db.lines.get(where['id']);
          if (!line || line['orderId'] !== where['orderId']) return null;
          const snapshot = { ...clone(line), order: clone(db.orders.get(line['orderId'])!) };
          const hook = db.previewHook;
          db.previewHook = undefined;
          await hook?.();
          return snapshot;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const line = db.lines.get(where['id']);
          if (!line) return { count: 0 };
          const order = db.orders.get(line['orderId'])!;
          if (!db.lineMatches(line, order, where)) return { count: 0 };
          db.commitLine({ ...clone(line), ...data });
          return { count: 1 };
        },
        findUnique: async ({ where }: { where: Row }) => clone(db.lines.get(where['id']) ?? null),
      },
      item: { findUnique: async ({ where }: { where: Row }) => clone(db.items.get(where['id']) ?? null) },
      orderStatusLog: { create: async ({ data }: { data: Row }) => { db.seq += 1; db.statusLogs.push(data); return data; } },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => db.transaction(fn),
    };
  }

  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    const orders = new Map<string, Row>();
    const lines = new Map<string, Row>();
    const staged: { audits: Row[]; outbox: Row[]; logs: Row[] } = { audits: [], outbox: [], logs: [] };
    const db = this;
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('$?');
        if (!/FOR UPDATE/.test(sql) || !/FROM "orders"/.test(sql)) throw new Error(`unexpected raw statement: ${sql}`);
        const id = values[0] as string;
        releases.push(await db.acquire(id, /"customerId"/.test(sql) ? 'CUSTOMER' : /"tenantId"/.test(sql) ? 'ADMIN' : 'PICK'));
        const committed = db.orders.get(id);
        if (!committed) return [];
        for (let i = 0; i < values.length; i += 1) {
          const column = /"?(\w+)"?\s*=\s*$/.exec(strings[i] ?? '')?.[1];
          if (column && committed[column] !== values[i]) return [];
        }
        orders.set(id, clone(committed));
        return [{ id }];
      },
      order: {
        findUnique: async ({ where }: { where: Row }) => clone(orders.get(where['id']) ?? db.orders.get(where['id']) ?? null),
        findFirst: async ({ where }: { where: Row }) => clone(orders.get(where['id']) ?? db.orders.get(where['id']) ?? null),
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const row = orders.get(where['id']);
          if (!row) return { count: 0 };
          for (const [k, v] of Object.entries(where)) if (k !== 'id' && row[k] !== v) return { count: 0 };
          orders.set(row['id'], { ...row, ...data });
          return { count: 1 };
        },
      },
      orderItem: {
        findFirst: async ({ where }: { where: Row }) => {
          const line = lines.get(where['id']) ?? db.lines.get(where['id']);
          return line && line['orderId'] === where['orderId'] ? clone(line) : null;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const line = lines.get(where['id']) ?? db.lines.get(where['id']);
          if (!line) return { count: 0 };
          const order = orders.get(line['orderId']) ?? db.orders.get(line['orderId'])!;
          if (!db.lineMatches(line, order, where)) return { count: 0 };
          lines.set(line['id'], { ...clone(line), ...data });
          return { count: 1 };
        },
      },
      auditLog: { create: async ({ data }: { data: Row }) => { staged.audits.push(data); return { id: `audit-${staged.audits.length}` }; } },
      orderOutbox: { createMany: async ({ data }: { data: Row[] }) => { staged.outbox.push(...data); return { count: data.length }; } },
      orderStatusLog: { create: async ({ data }: { data: Row }) => { staged.logs.push(data); return data; } },
    };
    try {
      const result = await fn(tx);
      for (const row of orders.values()) db.commitOrder(row);
      for (const row of lines.values()) db.commitLine(row);
      db.audits.push(...staged.audits);
      db.outbox.push(...staged.outbox);
      if (staged.logs.length) { db.seq += 1; db.statusLogs.push(...staged.logs); }
      return result;
    } finally {
      for (const release of releases) release();
    }
  }
}

function harness() {
  const db = new FakeOrderDb();
  const io = { to: () => ({ emit: () => undefined }) };
  const picking = new PickingService(db.client() as never, io as never);
  const notices = { send: vi.fn(async () => 'notice-1') };
  (picking as unknown as { notifications: unknown }).notifications = notices;
  const deny = () => db.transaction((tx) => recordCustomerMmgClaim(tx as MmgClaimTx, {
    orderId: 'order-1', customerId: 'customer-1', tenantId: 'tenant-a', paid: false, reference: null,
  }));
  return { db, picking, notices, deny };
}

const outcome = (p: Promise<unknown>) => p.then(() => 'written', (err: { code?: string }) => err.code ?? String(err));

const COMMANDS = {
  pick: (h: ReturnType<typeof harness>) => h.picking.setPicked('order-1', 'line-1', true),
  propose: (h: ReturnType<typeof harness>) => h.picking.proposeSubstitution('order-1', 'line-1', 'item-rice-b', 'owner-user'),
} as const;

afterEach(() => {
  delete mmgClaimLockObserver.afterLock;
});

describe.each(Object.keys(COMMANDS) as Array<keyof typeof COMMANDS>)('grocery %s under the disagreement fence', (name) => {
  const affirmative = (h: ReturnType<typeof harness>) => (name === 'pick' ? h.db.line()['picked'] === true : h.db.line()['subStatus'] === 'PENDING');

  it('a customer denial committing between the preview and the write: the affirmative write is refused on the locked row', async () => {
    const h = harness();
    let paused!: () => void;
    const atPreview = new Promise<void>((r) => { paused = r; });
    let resume!: () => void;
    h.db.previewHook = async () => { paused(); await new Promise<void>((r) => { resume = r; }); };

    const result = outcome(COMMANDS[name](h));
    await atPreview;
    await h.deny(); // the dispute COMMITS while the picking command still holds only its preview
    expect(h.db.order()['mmgClaimMismatchAt']).not.toBeNull();
    resume();

    expect(await result, 'no affirmative preparation may commit after the dispute').toBe('MMG_CLAIM_MISMATCH');
    expect(affirmative(h)).toBe(false);
    expect(h.db.affirmativeSeq).toBeNull();
    expect(h.notices.send).not.toHaveBeenCalled();
  });

  it('the picking command holds the SAME order row: a concurrent denial waits, then records the dispute after it', async () => {
    const h = harness();
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    h.db.lockHook = async (label) => {
      if (label !== 'PICK') return;
      h.db.lockHook = undefined;
      held();
      await gate;
    };

    const command = COMMANDS[name](h);
    const first = await Promise.race([
      holding.then(() => 'holds the order row'),
      command.then(() => 'finished without the order row lock', () => 'failed without the order row lock'),
    ]);
    expect(first, 'the affirmative write must serialize on the order row the claim authority locks').toBe('holds the order row');

    const denial = h.deny();
    await tick();
    expect(h.db.lockGrants, 'the denial is waiting on the order row').toEqual(['PICK']);
    open();
    await Promise.all([command, denial]);

    expect(h.db.lockGrants).toEqual(['PICK', 'CUSTOMER']);
    expect(affirmative(h), 'the preparation that preceded the dispute stands').toBe(true);
    expect(h.db.order()['mmgClaimMismatchAt']).not.toBeNull();
    expect(h.db.affirmativeSeq!).toBeLessThan(h.db.disputeSeq!);
  });

  it('with the dispute already committed, the command is refused and nothing is written', async () => {
    const h = harness();
    await h.deny();
    expect(await outcome(COMMANDS[name](h))).toBe('MMG_CLAIM_MISMATCH');
    expect(affirmative(h)).toBe(false);
    expect(h.db.statusLogs).toHaveLength(0);
  });

  it('a cancellation committing between the preview and the write: nothing is written, nobody is told', async () => {
    const h = harness();
    h.db.previewHook = async () => { h.db.orders.set('order-1', { ...h.db.order(), status: 'CANCELLED' }); };
    expect(await outcome(COMMANDS[name](h))).toBe('NOT_PICKABLE');
    expect(affirmative(h)).toBe(false);
    expect(h.db.statusLogs).toHaveLength(0);
    expect(h.notices.send).not.toHaveBeenCalled();
  });
});

describe('two staff on one line', () => {
  it('two proposals at once: one question opens, with one status log and one customer prompt', async () => {
    const h = harness();
    const results = await Promise.all([outcome(COMMANDS.propose(h)), outcome(COMMANDS.propose(h))]);
    expect(results.sort()).toEqual(['SUBSTITUTION_EXISTS', 'written']);
    expect(h.db.statusLogs).toHaveLength(1);
    expect(h.notices.send).toHaveBeenCalledTimes(1);
  });

  it('the same tick twice is one fact, each under the row lock', async () => {
    const h = harness();
    expect(await Promise.all([outcome(COMMANDS.pick(h)), outcome(COMMANDS.pick(h))])).toEqual(['written', 'written']);
    expect(h.db.line()['picked']).toBe(true);
    expect(h.db.lockGrants).toEqual(['PICK', 'PICK']);
  });
});

describe('an operator decision is what the locked gate obeys next', () => {
  const decide = (h: ReturnType<typeof harness>, resolution: 'CUSTOMER_PAID' | 'CUSTOMER_DID_NOT_PAY') =>
    h.db.transaction((tx) => resolveMmgClaimDisagreement(tx as MmgClaimTx, {
      orderId: 'order-1', tenantId: 'tenant-a', resolution, expectedClaimRevision: h.db.order()['mmgClaimRevision'] as number,
      note: 'Wallet statement reviewed', actorId: 'admin-1', audit: async () => undefined,
    }));

  it('"the customer did not pay" closes the dispute but not the gate: picking stays refused', async () => {
    const h = harness();
    await h.deny();
    await decide(h, 'CUSTOMER_DID_NOT_PAY');
    expect(h.db.order()).toMatchObject({ mmgClaimMismatchAt: null, paymentStatus: 'PENDING' });
    expect(await outcome(COMMANDS.pick(h))).toBe('MMG_PAYMENT_PENDING');
    expect(await outcome(COMMANDS.propose(h))).toBe('MMG_PAYMENT_PENDING');
    expect(h.db.lockGrants).toEqual(['CUSTOMER', 'ADMIN']);
  });

  it('upholding the store\'s claim reopens preparation', async () => {
    const h = harness();
    await h.deny();
    await decide(h, 'CUSTOMER_PAID');
    expect(await outcome(COMMANDS.pick(h))).toBe('written');
  });
});

describe('what the fence does not block', () => {
  it('unticking a line (corrective) stays open during a dispute', async () => {
    const h = harness();
    await h.picking.setPicked('order-1', 'line-1', true);
    await h.deny();
    expect(await outcome(h.picking.setPicked('order-1', 'line-1', false))).toBe('written');
    expect(h.db.line()['picked']).toBe(false);
  });

  it('a proposal commits its status-log evidence with the line, and speaks only after it commits', async () => {
    const h = harness();
    expect(await outcome(COMMANDS.propose(h))).toBe('written');
    expect(h.db.line()).toMatchObject({ subStatus: 'PENDING', substituteItemId: 'item-rice-b' });
    expect(h.db.statusLogs).toHaveLength(1);
    expect(h.notices.send).toHaveBeenCalledTimes(1);
  });
});
