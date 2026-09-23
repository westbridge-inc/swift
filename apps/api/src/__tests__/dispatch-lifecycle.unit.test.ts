import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute production method bodies, not copies of the algorithm. Isolating the
// class from module wiring makes accidental provider/service boot impossible.
const sourceText = readFileSync(join(__dirname, '../modules/dispatch/dispatch.service.ts'), 'utf8');
const source = ts.createSourceFile('dispatch.ts', sourceText, ts.ScriptTarget.Latest, true);
const klass = source.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'DispatchService')!;
const helperNames = new Set(['parseOfferValue', 'journalAuthorityWhere', 'deliveryAuthorityVersionFromAttempt', 'riderDeliveryAuthorityVersionFromAttempt', 'deliveryOfferAttemptId', 'offerValue', 'offerKey', 'moverOfferKey', 'offerPendingKey', 'offerPublishingKey', 'offerRecoveryKey', 'offerEpochKey', 'offersSentKey', 'offerOutcomeKey', 'reconciledKey']);
const helpers = source.statements.filter(n =>
  (ts.isFunctionDeclaration(n) && helperNames.has(n.name?.text ?? '')) ||
  (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => helperNames.has(d.name.getText(source))))
).map(n => n.getText(source)).join('\n');
const keys = readFileSync(join(__dirname, '../modules/dispatch/dispatch-generation-keys.ts'), 'utf8');
const noop = () => {};
class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
const testProcess = { env: { DISPATCH_TRIGGER: 'ON_ACCEPT', ALERTS_LOUD: '' } };
const context = vm.createContext({
  exports: {}, Date, Number, Set, Promise, Math,
  NotificationService: class {}, getMapsProvider: () => ({}),
  AppError, process: testProcess,
  require: () => ({ acknowledgeAlert: async () => {} }),
  ORDER_TRANSITIONS: { RIDER_ASSIGNED: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
  notSelfDeliveredFilter: () => ({ OR: [{ fulfillmentMode: null }, { fulfillmentMode: { not: 'VENDOR_DELIVERY' } }] }),
  warnAfterClaimCommit: noop, log: () => ({ warn: noop, info: noop, error: noop }),
  randomUUID: () => 'unit-attempt', RADIUS_STEP_KM: 5, OFFER_TIMEOUT_SECONDS: 20,
  EXPRESS_OFFER_TIMEOUT_SECONDS: 12, OFFER_LOG_TTL_S: 86400,
  rescueIncentiveGyd: async () => 0, riderFloatForOrder: () => 0,
  customerTrustSummaries: async () => new Map(), cashMathForOffer: () => null,
  estimateLoad: () => 'small',
  dispatchSearchesCounter: { inc: noop }, dispatchTimeToAssign: { observe: noop },
  poolForOrder: (o: { orderType: string }) => o.orderType === 'TAXI' ? 'DRIVER' : 'RIDER',
  verticalForOrder: () => 'DELIVERY',
  EXHAUST_TERMINAL_TTL_SECONDS: 21600, EXHAUST_CAP: 3, REDISPATCH_DELAY_MS: 60000,
  BASE_RADIUS_KM: 5,
  RECONCILE_STUCK_MINUTES: 3, RECONCILE_COOLDOWN_SECONDS: 600,
  riderStackingCapacity: async () => 1,
  TERMINAL_ORDER_STATUSES: ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'],
});

// Evaluate the actual final WHERE expressions with a small Prisma predicate
// grader. This is deliberately independent of any earlier read/guard: dropping
// a final fence must fail even if the locked pre-check remains correct.
function assignmentWhere(file: string, method: string, index: number, order: any, now: Date) {
  const parsed = ts.createSourceFile(file, readFileSync(join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const c = parsed.statements.find(ts.isClassDeclaration)!;
  const member = c.members.find(n => n.name?.getText(parsed) === method)!;
  const expressions: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(parsed) === 'tx.order.updateMany') {
      const obj = n.arguments[0] as ts.ObjectLiteralExpression;
      const p = obj.properties.find(p => p.name?.getText(parsed) === 'where') as ts.PropertyAssignment;
      expressions.push(p.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(member);
  Object.assign(context, { lockedOrder: order, paymentGate: order, orderId: order.id, input: { orderId: order.id, moverUserId: 'mover-user' }, options: {}, moverAuthority: { userId: 'mover-user' }, now });
  vm.runInContext(ts.transpileModule(`globalThis.finalWhere = (${expressions[index]!.getText(parsed)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context['finalWhere'];
}

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((p: any) => matches(row, p));
    if (key === 'OR') return value.some((p: any) => matches(row, p));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lte' in value) return row[key] != null && row[key] <= value.lte;
    }
    return row[key] === value;
  });
}

describe('R4 final assignment predicates', () => {
  const entrances = [
    ['../modules/dispatch/dispatch.service.ts', 'claimOrder', 1],
    ['../modules/order/order.service.ts', 'stageDirectRiderAssignment', 0],
  ] as const;
  it.each(entrances)('%s %s denies ON_READY PREPARING at its final write', (file, method, index) => {
    const h = setup(); testProcess.env.DISPATCH_TRIGGER = 'ON_READY'; h.order.status = 'PREPARING';
    expect(matches(h.order, assignmentWhere(file, method, index, h.order, new Date()))).toBe(false);
    testProcess.env.DISPATCH_TRIGGER = 'ON_ACCEPT';
    expect(matches(h.order, assignmentWhere(file, method, index, h.order, new Date()))).toBe(true);
    h.order.orderType = 'COURIER'; testProcess.env.DISPATCH_TRIGGER = 'ON_READY';
    expect(matches(h.order, assignmentWhere(file, method, index, h.order, new Date()))).toBe(true);
  });
  it.each(entrances)('%s %s denies a hold until and includes its expiry instant', (file, method, index) => {
    const h = setup(); h.order.orderType = 'COURIER'; const now = new Date('2026-09-22T00:00:00.000Z');
    const where = assignmentWhere(file, method, index, h.order, now);
    // Grade against the exact timestamp the final statement uses.
    const boundaries: Date[] = [];
    const scan = (x: any) => { if (x && typeof x === 'object') { if (x.holdExpiresAt?.lte) boundaries.push(x.holdExpiresAt.lte); Object.values(x).forEach(scan); } };
    scan(where); expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]!;
    h.order.holdExpiresAt = new Date(boundary.getTime() + 1); expect(matches(h.order, where)).toBe(false);
    h.order.holdExpiresAt = new Date(boundary.getTime()); expect(matches(h.order, where)).toBe(true);
    h.order.holdExpiresAt = new Date(boundary.getTime() - 1); expect(matches(h.order, where)).toBe(true);
    h.order.holdExpiresAt = null; expect(matches(h.order, where)).toBe(true);
  });
});
const triggerSource = ts.createSourceFile('trigger.ts', readFileSync(join(__dirname, '../modules/dispatch/dispatch-trigger.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
vm.runInContext(ts.transpileModule(triggerSource.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(triggerSource)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
vm.runInContext(ts.transpileModule(`${keys}\n${helpers}
const declinedKey=dispatchDeclinedKey, roundKey=dispatchRoundKey, exhaustKey=dispatchExhaustKey;
const incentiveKey=(id,v)=>'dispatch:rescue-incentive:'+id+deliveryGenerationSuffix(v);
${klass.getText(source)}
${source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'makeDispatchService')!.getText(source)}
${source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'reconcileStuckDispatch')!.getText(source)}
globalThis.dispatchPrototype=DispatchService.prototype;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);

function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

function setup() {
  context['Date'] = Date;
  testProcess.env.DISPATCH_TRIGGER = 'ON_ACCEPT';
  testProcess.env.ALERTS_LOUD = '';
  context['randomUUID'] = () => 'unit-attempt';
  context['customerTrustSummaries'] = async () => new Map();
  const order = { id: 'order-unit', orderNumber: 'UNIT', customerId: 'customer-unit', tenantId: 'tenant-unit', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', fulfillmentModeVersion: 0, status: 'READY_FOR_PICKUP', riderId: null as string | null, driverId: null as string | null, foodAgeHeldAt: null, holdExpiresAt: null as Date | null, vendor: null };
  const state = new Map<string, string>();
  const rows: any[] = [];
  const notices: any[] = [];
  const subject = Object.create(context['dispatchPrototype']);
  let mutex = Promise.resolve();
  const match = (row: any, where: any): boolean => Object.entries(where).every(([key, val]: [string, any]) => {
    if (key === 'OR') return val.some((part: any) => match(row, part));
    if (key === 'AND') return val.every((part: any) => match(row, part));
    if (val && typeof val === 'object') {
      if ('in' in val) return val.in.includes(row[key]);
      if ('lte' in val) return row[key] <= val.lte;
    }
    return row[key] === val;
  });
  const journal = {
    findFirst: async ({ where }: any) => rows.find(row => match(row, where)) ?? null,
    update: async ({ where, data }: any) => Object.assign(rows.find(row => match(row, where)), data),
    updateMany: async ({ where, data }: any) => {
      const selected = rows.filter(row => match(row, where)); selected.forEach(row => Object.assign(row, data)); return { count: selected.length };
    },
    create: async ({ data }: any) => { const row = { id: `search-${rows.length}`, startedAt: new Date(), ...data }; rows.push(row); return row; },
  };
  const episode = { sequence: 1 };
  const tx = { $queryRaw: async () => [{ ...order }], order: { findFirst: async () => ({ id: order.id }), findUnique: async ({ select }: any = {}) => select ? Object.fromEntries(Object.keys(select).map(k => [k, (order as any)[k]])) : ({ ...order }) }, dispatchSearch: journal, orderStatusLog: { count: async () => episode.sequence } };
  const transaction = async (fn: (db: typeof tx) => any) => {
    const previous = mutex; const release = barrier(); mutex = release.promise;
    await previous;
    try { return await fn(tx); } finally { release.open(); }
  };
  subject.prisma = { $transaction: transaction, order: tx.order, dispatchSearch: journal };
  subject.redis = {
    pttl: async (key: string) => state.has(key) ? 30_000 : -2,
    get: async (key: string) => state.get(key) ?? null,
    del: async (...ks: string[]) => { ks.forEach(k => state.delete(k)); return ks.length; },
    eval: async (script: string, n: number, ...args: string[]) => {
      const ks = args.slice(0, n), av = args.slice(n);
      if (script.includes('R6_PROMOTE_OFFER')) {
        if (state.get(ks[0]!) !== av[0] || state.get(ks[1]!) !== av[1] || !state.has(ks[2]!) || !state.has(ks[3]!)) return 0;
        state.delete(ks[2]!); state.delete(ks[3]!);
        return 1;
      }
      if (script.includes('R8_COMPLETE_PUBLICATION')) {
        if (state.get(ks[0]!) === av[0] && state.get(ks[1]!) === av[1] && state.get(ks[2]!) === av[2]) state.delete(ks[2]!);
        return 1;
      }
      if (script.includes('R6_ADVANCE_RECONCILE')) {
        if ((state.get(ks[0]!) ?? '') !== av[0]) return 0;
        if (av[1]) state.set(ks[0]!, av[1]); else state.delete(ks[0]!);
        return 1;
      }
      if (script.includes('R6_RELEASE_RECONCILE')) {
        if (state.get(ks[0]!) !== av[0]) return 0;
        state.delete(ks[0]!); return 1;
      }
      if (script.includes("return 'OK'")) {
        if (ks[5] && (state.get(ks[5]) ?? '') !== av[5]) return 'ORDER_TAKEN';
        if (state.has(ks[0]!)) return 'ORDER_TAKEN';
        if (state.has(ks[1]!)) return 'MOVER_BUSY';
        state.set(ks[0]!, av[0]!); state.set(ks[1]!, av[1]!);
        if (ks[2]) state.set(ks[2], '1');
        if (ks[3]) state.set(ks[3], '1');
        if (ks[4]) state.set(ks[4], av[3]!);
        if (ks[6]) state.set(ks[6], av[3]!);
        return 'OK';
      }
      if (script.includes("redis.call('INCR'")) {
        if (script.includes('R8_EXHAUST_EPOCH') && (
          (script.includes("redis.call('EXISTS', KEYS[3]) == 1") && state.has(ks[2]!))
          || (script.includes("(redis.call('GET', KEYS[4]) or '') ~= ARGV[2]") && (state.get(ks[3]!) ?? '') !== av[1])
          || (script.includes("(redis.call('GET', KEYS[2]) or '') ~= ARGV[3]") && (state.get(ks[1]!) ?? '') !== av[2])
          || (script.includes("(redis.call('GET', KEYS[1]) or '') ~= ARGV[4]") && (state.get(ks[0]!) ?? '') !== av[3]))) return 0;
        const next = Number(state.get(ks[0]!) ?? 0) + 1; state.set(ks[0]!, String(next));
        if (ks[1]) state.delete(ks[1]);
        if (ks[4]) state.delete(ks[4]);
        if (ks[5]) state.delete(ks[5]);
        return next;
      }
      throw new Error('Unexpected Redis operation in service-free test');
    },
  };
  subject.removeOfferIfOwned = async (id: string, rider: string, attempt?: string) => {
    const forward = `dispatch:offer:${id}`, reverse = `dispatch:mover-offer:${rider}`;
    if (state.get(forward) !== (attempt ? `${rider}:${attempt}` : rider)) return false;
    state.delete(forward);
    if (state.get(reverse) === (attempt ? `${id}:${attempt}` : id)) state.delete(reverse);
    return true;
  };
  subject.notifications = { send: async (notice: any) => { notices.push(notice); } };
  subject.scheduleRedispatch = async () => true;
  const install = (rider = 'next-rider', attempt = 'fresh~fv0') => {
    state.set('dispatch:offer:order-unit', `${rider}:${attempt}`);
    state.set(`dispatch:mover-offer:${rider}`, `order-unit:${attempt}`);
  };
  return { subject, order, state, rows, notices, transaction, install, episode, tx };
}

describe('dispatch lifecycle serialization — service-free', () => {
  it('preserves a handback offer installed while old cleanup is suspended at its Redis read', async () => {
    const h = setup(); h.order.riderId = 'old-rider'; h.install('old-offered-rider', 'old~fv0');
    const entered = barrier(), resume = barrier(); const get = h.subject.redis.get;
    h.subject.redis.get = async (key: string) => { entered.open(); await resume.promise; return get(key); };
    const retiring = h.subject.retireAfterAssignment(h.order.id, 'old-rider', 0, 1);
    await entered.promise;
    const handback = h.transaction(async () => { h.order.riderId = null; h.install(); });
    await Promise.resolve(); await Promise.resolve(); resume.open();
    await Promise.all([retiring, handback]);
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:fresh~fv0');
    expect(h.state.get('dispatch:mover-offer:next-rider')).toBe('order-unit:fresh~fv0');
  });

  it('does not clear subsequent search memory when the old assignment is no longer current', async () => {
    const h = setup(); h.install();
    h.state.set('dispatch:declined:order-unit', 'old-rider'); h.state.set('dispatch:rescue-incentive:order-unit', 'bonus');
    await h.subject.retireAfterAssignment(h.order.id, 'old-rider', 0, 1);
    expect(h.state.get('dispatch:declined:order-unit')).toBe('old-rider');
    expect(h.state.get('dispatch:rescue-incentive:order-unit')).toBe('bonus');
  });

  it.each(['DELIVERED', 'CANCELLED', 'RIDER_ASSIGNED'])('does not open SEARCHING for an order now %s', async status => {
    const h = setup(); h.order.status = status;
    if (status === 'RIDER_ASSIGNED') h.order.riderId = 'new-rider';
    await h.subject.journalOpenSearch(h.order, 0, 5);
    expect(h.rows).toHaveLength(0);
  });

  it('does not finalize a later search using the old rider identity', async () => {
    const h = setup(); h.order.riderId = 'new-rider'; h.order.status = 'RIDER_ASSIGNED';
    h.rows.push({ id: 'search-current', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0, startedAt: new Date() });
    await h.subject.retireAfterAssignment(h.order.id, 'old-rider', 0, 1);
    expect(h.rows[0].status).toBe('SEARCHING');
    expect(h.rows[0].assignedTo).toBeUndefined();
  });

  it('serializes a new offer with an exhaustion decision and restores a current search journal', async () => {
    const h = setup();
    h.rows.push({ id: 'search-prior', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0, startedAt: new Date() });
    const entered = barrier(), resume = barrier(); const get = h.subject.redis.get; let first = true;
    h.subject.redis.get = async (key: string) => { if (first) { first = false; entered.open(); await resume.promise; return null; } return get(key); };
    const exhausting = h.subject.exhaust(h.order); await entered.promise;
    const installing = h.subject.installOfferPair(h.order.id, 'next-rider', 'fresh~fv0', 40);
    await Promise.resolve(); await Promise.resolve(); resume.open();
    await Promise.all([exhausting, installing]);
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:fresh~fv0');
    expect(h.rows.some(row => row.status === 'SEARCHING')).toBe(true);
  });

  it('does not exhaust when a live offer already exists', async () => {
    const h = setup(); h.install();
    expect(await h.subject.exhaust(h.order)).toBe(false);
    expect(h.notices).toHaveLength(0); expect(h.state.has('dispatch:exhausts:order-unit')).toBe(false);
  });

  it('does not retire a later assignment to the same rider after handback', async () => {
    const h = setup(); h.order.riderId = 'same-rider'; h.order.status = 'RIDER_ASSIGNED'; h.episode.sequence = 2;
    h.install(); h.state.set('dispatch:rescue-incentive:order-unit', 'new-bonus');
    h.rows.push({ id: 'search-later', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0, startedAt: new Date() });
    await h.subject.retireAfterAssignment(h.order.id, 'same-rider', 0, 1);
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:fresh~fv0');
    expect(h.state.get('dispatch:rescue-incentive:order-unit')).toBe('new-bonus');
    expect(h.rows[0].status).toBe('SEARCHING');
  });

  it('still retires a current assignment and finalizes its own journal', async () => {
    const h = setup(); h.order.riderId = 'current-rider'; h.order.status = 'RIDER_ASSIGNED'; h.install();
    h.rows.push({ id: 'search-own', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0, startedAt: new Date() });
    h.state.set('dispatch:round:order-unit', '2');
    await h.subject.retireAfterAssignment(h.order.id, 'current-rider', 0, 1);
    expect(h.state.has('dispatch:offer:order-unit')).toBe(false);
    expect(h.state.has('dispatch:round:order-unit')).toBe(false);
    expect(h.rows[0]).toMatchObject({ status: 'ASSIGNED', assignedTo: 'current-rider' });
  });

  it('preserves rescue evidence for the accepting offer while retiring its search', async () => {
    const h = setup(); h.order.riderId = 'current-rider'; h.order.status = 'RIDER_ASSIGNED';
    h.state.set('dispatch:rescue-incentive:order-unit', 'promised-bonus');
    await h.subject.retireLiveOfferPair(h.order.id, 'current-rider', 'RIDER', 0, 1, true);
    expect(h.state.get('dispatch:rescue-incentive:order-unit')).toBe('promised-bonus');
  });

  it('finalizes a consumed offer whose search exhausted while the claim waited for the order lock', async () => {
    const h = setup(); h.order.riderId = 'current-rider'; h.order.status = 'RIDER_ASSIGNED';
    h.rows.push({ id: 'search-own', subjectId: h.order.id, status: 'EXHAUSTED', resolution: null, deliveryAuthorityVersion: 0, startedAt: new Date() });
    await h.subject.retireAfterAssignment(h.order.id, 'current-rider', 0, 1);
    expect(h.rows[0]).toMatchObject({ status: 'ASSIGNED', assignedTo: 'current-rider' });
  });

  it('preserves a later delivery generation during old assignment retirement', async () => {
    const h = setup(); h.order.fulfillmentModeVersion = 2; h.install('next-rider', 'new~fv2');
    h.state.set('dispatch:round:order-unit:fv2', '2');
    await h.subject.retireAfterAssignment(h.order.id, 'old-rider', 0, 1);
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:new~fv2');
    expect(h.state.get('dispatch:round:order-unit:fv2')).toBe('2');
  });

  it('serializes concurrent openers into one current search', async () => {
    const h = setup();
    await Promise.all([h.subject.journalOpenSearch(h.order, 0, 5), h.subject.journalOpenSearch(h.order, 1, 8)]);
    expect(h.rows.filter(row => row.status === 'SEARCHING')).toHaveLength(1);
  });

  it.each(['VENDOR_DELIVERY', 'PICKUP', 'STALE_GENERATION'])('does not install an offer for %s', async mode => {
    const h = setup();
    if (mode === 'VENDOR_DELIVERY') h.order.fulfillmentMode = mode;
    if (mode === 'PICKUP') h.order.fulfillment = mode;
    if (mode === 'STALE_GENERATION') h.order.fulfillmentModeVersion = 2;
    expect(await h.subject.installOfferPair(h.order.id, 'rider-unit', 'old~fv0', 40)).toBe('ORDER_TAKEN');
    expect(h.state.size).toBe(0);
  });

  it('contains a post-commit database failure without touching offer memory', async () => {
    const h = setup(); h.install();
    h.subject.prisma.$transaction = async () => { throw new Error('simulated DB unavailable'); };
    await expect(h.subject.retireAfterAssignment(h.order.id, 'old-rider', 0, 1)).resolves.toBeUndefined();
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:fresh~fv0');
  });

  it('refreshes an older worker snapshot without deleting a newer live generation', async () => {
    const h = setup(); h.order.fulfillmentModeVersion = 2; h.install('next-rider', 'new~fv2');
    let first = true;
    h.subject.prisma.order.findUnique = async () => {
      const version = first ? 0 : 2; first = false;
      return { ...h.order, fulfillmentModeVersion: version, pickupLat: 6.8, pickupLng: -58.1 };
    };
    h.subject.initializeDeliveryGeneration = async () => {};
    let removeCalls = 0;
    h.subject.removeOfferIfOwned = async () => { removeCalls += 1; return false; };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'next-rider' });
    expect(removeCalls).toBe(0);
  });
});

// R6 regressions: explicit service-free event schedules drive the production
// methods. Expiry below removes only the keys Redis actually expires; there is
// no wall-clock sleep and no assumption that an async worker finishes promptly.
function publishingHarness() {
  const h = setup(); let serial = 0;
  context['randomUUID'] = () => `r6-${++serial}`;
  Object.assign(h.order, { pickupLat: 1, pickupLng: 1, items: [], paymentMethod: 'CASH' });
  h.subject.initializeDeliveryGeneration = async () => {};
  h.subject.findCandidates = async () => [{ riderId: 'rider', userId: 'user', etaMinutes: 3 }];
  h.subject.logLoadGateShadow = () => {}; h.subject.canReceiveOffer = async () => true;
  const emitted: any[] = [], scheduled: string[] = [];
  h.subject.io = { to: () => ({ emit: (_event: string, payload: any) => { emitted.push(payload); } }) };
  h.subject.scheduleTimeout = async (_id: string, _rider: string, _delay: number, attempt: string) => { scheduled.push(attempt); };
  h.subject.prisma.alertDelivery = { create: async () => {} };
  h.subject.redis.zadd = async () => {}; h.subject.redis.expire = async () => {};
  h.subject.redis.set = async (key: string, value: string, ...args: any[]) => {
    if (args.includes('NX') && h.state.has(key)) return null;
    h.state.set(key, value); return 'OK';
  };
  h.subject.prisma.order.findMany = async () => [h.order];
  h.subject.prisma.order.findFirst = async () => ({ id: h.order.id });
  return { ...h, emitted, scheduled };
}

// Exercise the actual route fallback statement without importing route wiring
// (which would boot database/provider dependencies). The factory and constructor
// also execute from source, so their scheduler defaults cannot hide behind mocks.
function inlineDispatch(route: 'courier' | 'driver', app: any, dispatch: any, order: any) {
  const file = ts.createSourceFile('route.ts', readFileSync(join(__dirname, `../modules/${route}/${route}.routes.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
  const branches: ts.IfStatement[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n) && n.expression.getText(file) === 'app.dispatchQueue' && n.elseStatement?.getText(file).includes('dispatch.dispatchOrder(')) branches.push(n);
    ts.forEachChild(n, visit);
  };
  visit(file);
  expect(branches).toHaveLength(1);
  const run = vm.runInContext(ts.transpileModule(`(async (app, dispatch, order, id) => { ${branches[0]!.getText(file)} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return run(app, dispatch, order, order.id);
}

describe('R10 queue arming and exhaustion journal regressions', () => {
  it.each(['factory', 'constructor', 'courier', 'driver'].flatMap(entry => [1, 2].map(prior => ({ entry, prior }))))(
    'keeps recovery without a queue through $entry with prior exhaustion $prior', async ({ entry, prior }) => {
      const h = publishingHarness();
      if (entry === 'courier') h.order.orderType = 'COURIER';
      if (entry === 'driver') { h.order.orderType = 'TAXI'; h.order.status = 'PENDING'; }
      const app: any = { prisma: h.subject.prisma, redis: h.subject.redis, io: h.subject.io };
      const service = entry === 'constructor'
        ? new context['exports'].DispatchService(app.prisma, app.redis, app.io, {})
        : context['exports'].makeDispatchService(app);
      h.subject.scheduleTimeout = service.scheduleTimeout;
      h.subject.scheduleRedispatch = service.scheduleRedispatch;
      h.state.set('dispatch:exhausts:order-unit', String(prior));
      if (entry === 'courier' || entry === 'driver') await inlineDispatch(entry, app, h.subject, h.order);
      else await h.subject.dispatchOrder(h.order.id);
      expect(h.emitted).toEqual([]);
      expect(h.state.has('dispatch:offer:order-unit')).toBe(false);
      expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(true);
      // Expire only short pointers, then restore the queue and re-drive.
      for (const key of [...h.state.keys()]) if (/dispatch:(offer:|mover-offer:|offer-pending:|offer-publishing:)/.test(key)) h.state.delete(key);
      const jobs: any[] = [];
      app.dispatchQueue = { add: async (...args: any[]) => { jobs.push(args); return { id: 'unit-job' }; } };
      const recovered = await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis,
        (id: string) => app.dispatchQueue.add('dispatch-order', { orderId: id }));
      expect(recovered).toEqual({ recovered: ['order-unit'] });
      expect(jobs[0]).toEqual(['dispatch-order', { orderId: 'order-unit' }]);
      h.subject.scheduleTimeout = context['exports'].makeDispatchService(app).scheduleTimeout;
      expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'rider' });
      expect(jobs[1][0]).toBe('offer-timeout');
      expect(jobs[1][1]).toMatchObject({ orderId: h.order.id, riderId: 'rider', attemptId: h.emitted[0].offerAttemptId });
      expect(h.emitted).toHaveLength(1);
      expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(false);
    },
  );

  it('does not publish through the factory until a real queue acknowledgement resolves', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    const app = { prisma: h.subject.prisma, redis: h.subject.redis, io: h.subject.io,
      dispatchQueue: { add: async () => { entered.open(); await resume.promise; return { id: 'unit-job' }; } } };
    h.subject.scheduleTimeout = context['exports'].makeDispatchService(app).scheduleTimeout;
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    expect(h.emitted).toEqual([]); expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(true);
    resume.open(); expect(await publishing).toEqual({ offered: 'rider' });
    expect(h.emitted).toHaveLength(1); expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(false);
  });

  it('keeps SEARCHING when a timed-out install lands after exhaustion acquired the released lock', async () => {
    const h = publishingHarness(), installEntered = barrier(), installResume = barrier(), exhaustEntered = barrier(), exhaustResume = barrier();
    h.rows.push({ id: 'search-current', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0 });
    h.state.set('dispatch:exhausts:order-unit', '2');
    const evalCommand = h.subject.redis.eval; let installCallback!: Promise<unknown>;
    h.subject.redis.eval = async (...args: any[]) => {
      if (args[0].includes("return 'OK'")) { installEntered.open(); await installResume.promise; }
      if (args[0].includes('R8_EXHAUST_EPOCH')) { exhaustEntered.open(); await exhaustResume.promise; }
      return evalCommand(...args);
    };
    h.subject.prisma.$transaction = async (fn: any) => { installCallback = fn(h.tx); await installEntered.promise; throw new Error('install transaction expired'); };
    await expect(h.subject.installOfferPair(h.order.id, 'rider', 'late~fv0', 30)).rejects.toThrow('install transaction expired');
    h.subject.prisma.$transaction = h.transaction;
    const exhausting = h.subject.recordExhaustion(h.order); await exhaustEntered.promise;
    installResume.open(); await installCallback;
    expect(h.state.has('dispatch:offer:order-unit')).toBe(false);
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('late~fv0');
    exhaustResume.open(); expect(await exhausting).toBeNull();
    expect(h.rows[0].status).toBe('SEARCHING'); expect(h.rows[0].exhaustedAt).toBeUndefined();
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('2');
    expect(h.state.get('dispatch:offer-epoch:order-unit')).toBe('late~fv0');
  });

  it.each([0, undefined, null, '3', NaN, -1, 1.5])('leaves the journal SEARCHING for a zero or ambiguous exhaustion result %s', async result => {
    const h = publishingHarness();
    h.rows.push({ id: 'search-current', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 0 });
    h.state.set('dispatch:exhausts:order-unit', '2'); h.state.set('dispatch:offer-recovery:order-unit', 'old~fv0');
    h.subject.redis.eval = async () => result;
    expect(await h.subject.recordExhaustion(h.order)).toBeNull();
    expect(h.rows[0].status).toBe('SEARCHING'); expect(h.rows[0].exhaustedAt).toBeUndefined();
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('2');
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('old~fv0');
  });

  it('records successful exhaustion before a subsequent installation opens a fresh journal', async () => {
    const h = publishingHarness();
    h.rows.push({ id: 'search-current', subjectId: h.order.id, status: 'SEARCHING', resolution: null, deliveryAuthorityVersion: 0, startedAt: new Date() });
    h.state.set('dispatch:exhausts:order-unit', '2'); h.state.set('dispatch:offer-recovery:order-unit', 'old~fv0');
    expect(await h.subject.recordExhaustion(h.order)).toBe(3);
    expect(h.rows[0].status).toBe('EXHAUSTED'); expect(h.rows[0].exhaustedAt).toBeInstanceOf(Date);
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('3'); expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(false);
    expect(await h.subject.installOfferPair(h.order.id, 'rider', 'new~fv0', 30)).toBe('OK');
    expect(h.rows[0]).toMatchObject({ status: 'EXHAUSTED', resolution: 'RETRIED' }); expect(h.rows[1].status).toBe('SEARCHING');
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('new~fv0');
  });
});

describe('R6 publication and durable recovery regressions', () => {
  it('keeps an emitted healthy card while slow alert evidence outlives the preparation lease', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(); let first = true;
    h.subject.prisma.alertDelivery.create = async () => { if (first) { first = false; entered.open(); await resume.promise; } };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    const attempt = h.emitted[0].offerAttemptId;
    h.state.delete(`dispatch:offer-publishing:${h.order.id}:${attempt}`);
    const retry = await h.subject.dispatchOrder(h.order.id);
    resume.open(); await publishing;
    expect(h.emitted.map(x => x.offerAttemptId)).toEqual([attempt]);
    expect(h.scheduled).toEqual([attempt]);
    expect(h.state.get('dispatch:offer:order-unit')).toBe(`rider:${attempt}`);
    expect(retry).toEqual({ offered: 'rider' });
  });

  it.each(['accepted', 'declined', 'expired'])('fences the old notification/timeout tail after an emitted card is %s', async terminal => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    testProcess.env.ALERTS_LOUD = '1';
    h.subject.prisma.alertDelivery.create = async () => { entered.open(); await resume.promise; };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    const attempt = h.emitted[0].offerAttemptId;
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', attempt);
    if (terminal === 'accepted') { h.order.riderId = 'rider'; h.order.status = 'RIDER_ASSIGNED'; }
    else h.install('next-rider', 'new~fv0');
    const schedulesAtWithdrawal = [...h.scheduled];
    resume.open(); expect(await publishing).toEqual({});
    expect(h.notices).toHaveLength(0);
    expect(h.scheduled).toEqual(schedulesAtWithdrawal);
    expect(schedulesAtWithdrawal).toEqual([attempt]);
    if (terminal !== 'accepted') expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:new~fv0');
  });

  it('retains discoverable recovery after timeout enqueue fails despite prior exhaustion', async () => {
    const h = publishingHarness(); h.state.set('dispatch:exhausts:order-unit', '1');
    h.subject.scheduleTimeout = async () => { throw new Error('queue unavailable'); };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
    const enqueued: string[] = [];
    expect(await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); })).toEqual({ recovered: ['order-unit'] });
    expect(enqueued).toEqual(['order-unit']);
    expect(h.emitted).toHaveLength(0);
  });

  it('does not emit or erase a successor after a queue acknowledgement outlives preparation', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(); let first = true;
    h.subject.scheduleTimeout = async (_id: string, _rider: string, _delay: number, attempt: string) => {
      h.scheduled.push(attempt);
      if (first) { first = false; entered.open(); await resume.promise; }
    };
    const old = h.subject.dispatchOrder(h.order.id); await entered.promise;
    expect(h.emitted).toHaveLength(0);
    const attempt = h.scheduled[0]!;
    h.state.delete(`dispatch:offer-publishing:order-unit:${attempt}`);
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'rider' });
    const successor = h.state.get('dispatch:offer:order-unit');
    resume.open(); expect(await old).toEqual({});
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].offerAttemptId).not.toBe(attempt);
    expect(h.state.get('dispatch:offer:order-unit')).toBe(successor);
    expect(h.state.get('dispatch:mover-offer:rider')).toBe(`order-unit:${h.emitted[0].offerAttemptId}`);
  });

  it('keeps an already armed offer during a slow push and never extends its expiry', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    testProcess.env.ALERTS_LOUD = '1';
    h.subject.notifications.send = async (notice: any) => { h.notices.push(notice); entered.open(); await resume.promise; };
    const start = Date.now(), publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    const attempt = h.emitted[0].offerAttemptId;
    h.state.delete(`dispatch:offer-publishing:order-unit:${attempt}`);
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'rider' });
    resume.open(); await publishing;
    expect(h.emitted).toHaveLength(1); expect(h.scheduled).toEqual([attempt]);
    expect(h.notices).toHaveLength(1);
    expect(new Date(h.notices[0].data.expiresAt).getTime()).toBeGreaterThanOrEqual(start + 20_000);
    expect(new Date(h.notices[0].data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 20_000);
  });

  it('fences notification publication if the offer changes during journal evidence', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    testProcess.env.ALERTS_LOUD = '1';
    const update = h.subject.prisma.dispatchSearch.updateMany;
    h.subject.prisma.dispatchSearch.updateMany = async (args: any) => {
      if (args.data.candidatesTried) { entered.open(); await resume.promise; }
      return update(args);
    };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    h.install('next-rider', 'next~fv0'); resume.open();
    expect(await publishing).toEqual({}); expect(h.notices).toHaveLength(0);
    expect(h.scheduled).toEqual([h.emitted[0].offerAttemptId]);
  });

  it.each(['1', '2', '3'])('recovers an interrupted new attempt after every short TTL expired (prior exhaustion %s)', async history => {
    const h = publishingHarness(); h.state.set('dispatch:exhausts:order-unit', history);
    await h.subject.installOfferPair(h.order.id, 'rider', 'crashed~fv0', 30);
    for (const key of [...h.state.keys()]) if (/dispatch:(offer:|mover-offer:|offer-pending:|offer-publishing:)/.test(key)) h.state.delete(key);
    const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual(['order-unit']);
  });

  it('does not reuse an older generation obligation or defeat deliberate exhaustion', async () => {
    const h = publishingHarness();
    await h.subject.installOfferPair(h.order.id, 'rider', 'crashed~fv0', 30);
    h.state.delete('dispatch:offer:order-unit'); h.state.delete('dispatch:mover-offer:rider');
    h.order.fulfillmentModeVersion = 2; h.state.set('dispatch:exhausts:order-unit:fv2', '3');
    const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual([]);
    h.order.fulfillmentModeVersion = 0;
    await h.subject.recordExhaustion(h.order);
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual([]);
  });

  it('does not resurrect recovery if a timed-out installation lands after deliberate exhaustion', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(); const evalCommand = h.subject.redis.eval;
    let callback!: Promise<unknown>;
    h.state.set('dispatch:exhausts:order-unit', '2');
    h.subject.redis.eval = async (...args: any[]) => {
      if (args[0].includes("return 'OK'")) { entered.open(); await resume.promise; }
      return evalCommand(...args);
    };
    h.subject.prisma.$transaction = async (fn: any) => { callback = fn(h.tx); await entered.promise; throw new Error('transaction expired'); };
    await expect(h.subject.installOfferPair(h.order.id, 'rider', 'late~fv0', 30)).rejects.toThrow('transaction expired');
    h.subject.prisma.$transaction = h.transaction;
    await h.subject.recordExhaustion(h.order);
    resume.open(); await callback.catch(() => {});
    const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual([]);
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('3');
  });

  it.each([false, true])('advances beyond 500 stable skipped rows across fresh invocations (enqueue failure=%s)', async failFirst => {
    const h = publishingHarness();
    const rows = Array.from({ length: 501 }, (_, n) => ({ ...h.order, id: `eligible-${String(n + 1).padStart(4, '0')}` }));
    let maxReturned = 0;
    h.subject.prisma.order.findFirst = async () => rows.at(-1);
    h.subject.prisma.order.findMany = async ({ where, take }: any) => {
      const selected = rows.filter(row => (!where.id?.gt || row.id > where.id.gt) && (!where.id?.lte || row.id <= where.id.lte)).slice(0, take);
      maxReturned = Math.max(maxReturned, selected.length); return selected;
    };
    for (const [i, row] of rows.slice(0, 500).entries()) {
      const kind = i % 3 === 0 ? 'offer' : i % 3 === 1 ? 'exhausts' : 'reconciled';
      h.state.set(`dispatch:${kind}:${row.id}`, kind === 'offer' ? 'rider:armed~fv0' : '3');
    }
    const enqueued: string[] = []; let attempts = 0;
    // No process-local state is shared between these function invocations.
    for (let n = 0; n < 6; n++) await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => {
      if (failFirst && ++attempts === 1) throw new Error('queue unavailable');
      enqueued.push(id);
    });
    expect(enqueued).toEqual([rows[500]!.id]);
    expect(maxReturned).toBeLessThanOrEqual(500);
  });

  it('isolates a failed per-row Redis read so a later eligible row progresses', async () => {
    const h = publishingHarness(); const later = { ...h.order, id: 'order-z' };
    h.subject.prisma.order.findMany = async () => [h.order, later];
    h.subject.prisma.order.findFirst = async () => later;
    const get = h.subject.redis.get;
    h.subject.redis.get = async (key: string) => { if (key === 'dispatch:offer:order-unit') throw new Error('transient read failure'); return get(key); };
    const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual(['order-z']);
  });

  it('does not rewind a completed scan when a delayed old page resumes after wrap', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    const rows = Array.from({ length: 501 }, (_, n) => ({ ...h.order, id: `row-${String(n).padStart(4, '0')}` }));
    h.subject.prisma.order.findFirst = async () => rows.at(-1);
    h.subject.prisma.order.findMany = async ({ where, take }: any) => rows.filter(row => row.id > where.id.gt && row.id <= where.id.lte).slice(0, take);
    const get = h.subject.redis.get; let first = true;
    h.subject.redis.get = async (key: string) => {
      if (first && key === 'dispatch:offer:row-0000') { first = false; entered.open(); await resume.promise; }
      return get(key);
    };
    for (const row of rows) h.state.set(`dispatch:exhausts:${row.id}`, '3');
    const reconcile = context['exports'].reconcileStuckDispatch;
    const delayed = reconcile(h.subject.prisma, h.subject.redis, async () => {}); await entered.promise;
    await reconcile(h.subject.prisma, h.subject.redis, async () => {});
    await reconcile(h.subject.prisma, h.subject.redis, async () => {});
    const wrapped = h.state.get('dispatch:reconcile-scan:v1');
    expect(wrapped).toBeDefined(); expect(JSON.parse(wrapped!).after).toBe('');
    resume.open(); await delayed;
    expect(h.state.get('dispatch:reconcile-scan:v1')).toBe(wrapped);
  });

  it('does not clear a successor cooldown when a delayed enqueue rejects', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    const reconcile = context['exports'].reconcileStuckDispatch;
    const old = reconcile(h.subject.prisma, h.subject.redis, async () => { entered.open(); await resume.promise; throw new Error('late queue failure'); });
    await entered.promise;
    h.state.set('dispatch:reconciled:order-unit', 'successor-claim');
    resume.open(); expect(await old).toEqual({ recovered: [] });
    expect(h.state.get('dispatch:reconciled:order-unit')).toBe('successor-claim');
  });
});

describe('R8 delayed acknowledgements and enrichment — exact production methods', () => {
  function clock() {
    let now = Date.parse('2026-09-23T00:00:00Z');
    context['Date'] = class extends Date {
      constructor(value?: string | number | Date) { super(value === undefined ? now : value instanceof Date ? value.getTime() : value); }
      static override now() { return now; }
    };
    return { advance: (ms: number) => { now += ms; } };
  }

  it.each(['successor', 'same-mover-successor', 'assigned', 'terminal', 'generation', 'hold', 'expired', 'reverse', 'capacity'])('does not publish after successful promotion acknowledgement is delayed across %s', async change => {
    const h = publishingHarness(), time = clock(), entered = barrier(), resume = barrier();
    const evalCommand = h.subject.redis.eval;
    h.subject.redis.eval = async (...args: any[]) => {
      const result = await evalCommand(...args);
      if (args[0].includes('R6_PROMOTE_OFFER')) { entered.open(); await resume.promise; }
      return result;
    };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    const old = h.scheduled[0]!;
    if (change === 'successor' || change === 'same-mover-successor') {
      await h.subject.removeOfferIfOwned(h.order.id, 'rider', old);
      h.install(change === 'successor' ? 'next-rider' : 'rider', 'new~fv0');
    }
    if (change === 'assigned') { h.order.riderId = 'winner'; h.order.status = 'RIDER_ASSIGNED'; }
    if (change === 'terminal') h.order.status = 'CANCELLED';
    if (change === 'generation') h.order.fulfillmentModeVersion = 2;
    if (change === 'hold') h.order.holdExpiresAt = new Date(context['Date'].now() + 60_000);
    if (change === 'expired') time.advance(20_000); // exact deadline, pair still in grace
    if (change === 'reverse') h.state.set('dispatch:mover-offer:rider', 'another:other~fv0');
    if (change === 'capacity') h.subject.canReceiveOffer = async () => false;
    resume.open();
    expect(await publishing).toEqual({}); expect(h.emitted).toEqual([]);
    if (change.includes('successor')) expect(h.state.get('dispatch:offer:order-unit')).toContain('new~fv0');
  });

  it('publishes once when promotion acknowledgement precedes consumption, then withholds the consumed return', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(); clock();
    h.subject.prisma.alertDelivery.create = async () => { entered.open(); await resume.promise; };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    expect(h.emitted).toHaveLength(1); expect(h.emitted[0].expiresInSeconds).toBe(20);
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', h.emitted[0].offerAttemptId);
    resume.open(); expect(await publishing).toEqual({});
  });

  it('does not restart a deadline after a delayed promotion acknowledgement', async () => {
    const h = publishingHarness(), time = clock(), evalCommand = h.subject.redis.eval;
    h.subject.redis.eval = async (...args: any[]) => { const result = await evalCommand(...args); if (args[0].includes('R6_PROMOTE_OFFER')) time.advance(7_000); return result; };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'rider' });
    expect(h.emitted[0].expiresInSeconds).toBe(13);
  });

  it.each(['trust', 'rider', 'driver', 'maps', 'incentive'])('revalidates a recovery card after awaited %s enrichment', async boundary => {
    const h = publishingHarness(), entered = barrier(), resume = barrier();
    h.install('rider', 'old~fv0');
    context['customerTrustSummaries'] = async () => { if (boundary === 'trust') { entered.open(); await resume.promise; } return new Map(); };
    h.subject.prisma.rider = { findUnique: async () => { if (boundary === 'rider') { entered.open(); await resume.promise; } return boundary === 'driver' ? null : { currentLat: 1, currentLng: 1 }; } };
    h.subject.prisma.driver = { findUnique: async () => { entered.open(); await resume.promise; return null; } };
    h.subject.maps = { etaMinutesFrom: async () => { if (boundary === 'maps') { entered.open(); await resume.promise; } return [3]; } };
    h.subject.rescueIncentiveOn = async () => { if (boundary === 'incentive') { entered.open(); await resume.promise; } return null; };
    const recovery = h.subject.currentOfferFor('rider'); await entered.promise;
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', 'old~fv0');
    h.order.riderId = 'winner'; h.order.status = 'RIDER_ASSIGNED';
    resume.open(); expect(await recovery).toBeNull();
  });

  it.each(['terminal', 'generation', 'hold', 'reverse', 'pending', 'expired'])('rejects %s authority after delayed trust even when the forward pointer survives', async change => {
    const h = publishingHarness(), time = clock(), entered = barrier(), resume = barrier();
    h.install('rider', 'old~fv0');
    h.subject.prisma.rider = { findUnique: async () => null }; h.subject.prisma.driver = { findUnique: async () => null };
    context['customerTrustSummaries'] = async () => { entered.open(); await resume.promise; return new Map(); };
    const recovery = h.subject.currentOfferFor('rider'); await entered.promise;
    if (change === 'terminal') h.order.status = 'CANCELLED';
    if (change === 'generation') h.order.fulfillmentModeVersion = 2;
    if (change === 'hold') h.order.holdExpiresAt = new Date(context['Date'].now() + 60_000);
    if (change === 'reverse') h.state.set('dispatch:mover-offer:rider', 'other:new~fv0');
    if (change === 'pending') h.state.set('dispatch:offer-pending:order-unit:old~fv0', '1');
    if (change === 'expired') time.advance(20_000);
    resume.open(); expect(await recovery).toBeNull();
  });

  it('returns the same attempt with reduced time when trust completes before consumption', async () => {
    const h = publishingHarness(), time = clock(); h.install('rider', 'old~fv0');
    h.subject.prisma.rider = { findUnique: async () => null }; h.subject.prisma.driver = { findUnique: async () => null };
    context['customerTrustSummaries'] = async () => { time.advance(7_000); return new Map(); };
    expect(await h.subject.currentOfferFor('rider')).toMatchObject({ offerAttemptId: 'old~fv0', expiresInSeconds: 13 });
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', 'old~fv0');
    expect(await h.subject.currentOfferFor('rider')).toBeNull();
  });

  it.each([19_999, 20_000])('uses millisecond expiry after trust consumes %s ms', async elapsed => {
    const h = publishingHarness(), time = clock(), installedAt = context['Date'].now();
    h.install('rider', 'old~fv0');
    h.subject.redis.pttl = async () => 30_000 - (context['Date'].now() - installedAt);
    h.subject.prisma.rider = { findUnique: async () => null }; h.subject.prisma.driver = { findUnique: async () => null };
    context['customerTrustSummaries'] = async () => { time.advance(elapsed); return new Map(); };
    const recovered = await h.subject.currentOfferFor('rider');
    if (elapsed === 20_000) expect(recovered).toBeNull();
    else expect(recovered).toMatchObject({ offerAttemptId: 'old~fv0', expiresInSeconds: 1 });
  });

  it.each([false, true])('preserves a newer recovery obligation when old exhaustion lands after transaction timeout (short keys already expired=%s)', async expireFirst => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(), evalCommand = h.subject.redis.eval;
    h.state.set('dispatch:exhausts:order-unit', '2'); let callback!: Promise<unknown>;
    h.subject.redis.eval = async (...args: any[]) => { if (args[0].includes("redis.call('INCR'")) { entered.open(); await resume.promise; } return evalCommand(...args); };
    h.subject.prisma.$transaction = async (fn: any) => { callback = fn(h.tx); await entered.promise; throw new Error('old exhaustion transaction expired'); };
    await expect(h.subject.recordExhaustion(h.order)).rejects.toThrow('old exhaustion transaction expired');
    h.subject.prisma.$transaction = h.transaction;
    expect(await h.subject.installOfferPair(h.order.id, 'rider', 'new~fv0', 30)).toBe('OK');
    const expire = () => { for (const key of [...h.state.keys()]) if (/dispatch:(offer:|mover-offer:|offer-pending:|offer-publishing:)/.test(key)) h.state.delete(key); };
    if (expireFirst) expire();
    resume.open(); await callback;
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('new~fv0');
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('2');
    expire(); const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual(['order-unit']);
  });

  it('allows exhaustion first and preserves the subsequent new recovery obligation', async () => {
    const h = publishingHarness(); h.state.set('dispatch:exhausts:order-unit', '2');
    expect(await h.subject.recordExhaustion(h.order)).toBe(3);
    expect(await h.subject.installOfferPair(h.order.id, 'rider', 'new~fv0', 30)).toBe('OK');
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('new~fv0');
  });

  it('fences old exhaustion even after new promotion clears recovery and its pair later expires', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(), evalCommand = h.subject.redis.eval;
    h.state.set('dispatch:exhausts:order-unit', '2'); let callback!: Promise<unknown>;
    h.subject.redis.eval = async (...args: any[]) => { if (args[0].includes("redis.call('INCR'")) { entered.open(); await resume.promise; } return evalCommand(...args); };
    h.subject.prisma.$transaction = async (fn: any) => { callback = fn(h.tx); await entered.promise; throw new Error('expired'); };
    await expect(h.subject.recordExhaustion(h.order)).rejects.toThrow('expired');
    h.subject.prisma.$transaction = h.transaction;
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'rider' });
    expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(false);
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', h.emitted[0].offerAttemptId);
    h.state.set('dispatch:round:order-unit', 'new-round'); h.state.set('dispatch:declined:order-unit', 'new-decline');
    resume.open(); await callback;
    expect(h.state.get('dispatch:exhausts:order-unit')).toBe('2');
    expect(h.state.get('dispatch:round:order-unit')).toBe('new-round');
    expect(h.state.get('dispatch:declined:order-unit')).toBe('new-decline');
  });

  it.each([undefined, null, '1', 2, NaN])('fails closed on ambiguous promotion result %s', async result => {
    const h = publishingHarness(), evalCommand = h.subject.redis.eval;
    h.subject.redis.eval = async (...args: any[]) => { const actual = await evalCommand(...args); return args[0].includes('R6_PROMOTE_OFFER') ? result : actual; };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({}); expect(h.emitted).toEqual([]);
  });

  it.each(['capacity', 'deadline', 'ambiguous'])('retains recovery if post-promotion %s rejects publication over prior exhaustion', async change => {
    const h = publishingHarness(), time = clock(), evalCommand = h.subject.redis.eval;
    h.state.set('dispatch:exhausts:order-unit', '2');
    h.subject.redis.eval = async (...args: any[]) => {
      const result = await evalCommand(...args);
      if (args[0].includes('R6_PROMOTE_OFFER')) {
        if (change === 'capacity') h.subject.canReceiveOffer = async () => false;
        if (change === 'deadline') time.advance(20_000);
        if (change === 'ambiguous') return undefined;
      }
      return result;
    };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({}); expect(h.emitted).toEqual([]);
    const enqueued: string[] = [];
    await context['exports'].reconcileStuckDispatch(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); });
    expect(enqueued).toEqual(['order-unit']);
  });

  it('retains recovery and emits nothing if a timeout scheduler is absent', async () => {
    const h = publishingHarness(); h.subject.scheduleTimeout = undefined;
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
    expect(h.emitted).toEqual([]); expect(h.state.has('dispatch:offer-recovery:order-unit')).toBe(true);
  });

  it('does not delete a successor obligation when publication completion executes late', async () => {
    const h = publishingHarness(), entered = barrier(), resume = barrier(), evalCommand = h.subject.redis.eval;
    h.subject.redis.eval = async (...args: any[]) => { if (args[0].includes('R8_COMPLETE_PUBLICATION')) { entered.open(); await resume.promise; } return evalCommand(...args); };
    const publishing = h.subject.dispatchOrder(h.order.id); await entered.promise;
    expect(h.emitted).toHaveLength(1);
    await h.subject.removeOfferIfOwned(h.order.id, 'rider', h.emitted[0].offerAttemptId);
    await h.subject.installOfferPair(h.order.id, 'rider', 'new~fv0', 30);
    resume.open(); expect(await publishing).toEqual({});
    expect(h.state.get('dispatch:offer-recovery:order-unit')).toBe('new~fv0');
    expect(h.state.get('dispatch:offer:order-unit')).toBe('rider:new~fv0');
  });

  it.each(['ttl', 'reverse', 'terminal', 'pending'])('does not return an existing %s-invalid offer', async invalid => {
    const h = publishingHarness(); h.install('rider', 'old~fv0');
    if (invalid === 'ttl') h.subject.redis.pttl = async () => 10_000;
    if (invalid === 'reverse') h.state.delete('dispatch:mover-offer:rider');
    if (invalid === 'terminal') h.order.status = 'CANCELLED';
    if (invalid === 'pending') { h.state.set('dispatch:offer-pending:order-unit:old~fv0', '1'); h.state.set('dispatch:offer-publishing:order-unit:old~fv0', '1'); }
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({}); expect(h.emitted).toEqual([]);
  });
});

describe('R4 exact-review regressions — service-free', () => {
  it.each(['ACCEPTED', 'PREPARING'])('withholds FOOD_DELIVERY %s at every final offer and re-drive boundary under ON_READY', async status => {
    const h = setup(); testProcess.env.DISPATCH_TRIGGER = 'ON_READY'; h.order.status = status;
    h.subject.initializeDeliveryGeneration = async () => { throw new Error('must not initialize a withheld order'); };
    expect(h.subject.searchable(h.order, 'RIDER', 0)).toBe(false);
    expect((await h.subject.offerAuthority(h.order.id, 'RIDER', 0)).offerable).toBe(false);
    expect(await h.subject.prepareForPlatformDelivery(h.order.id, 0)).toBe(false);
    expect(await h.subject.installOfferPair(h.order.id, 'rider', 'pending~fv0', 30)).toBe('ORDER_TAKEN');
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
    let redrives = 0; h.subject.dispatchOrder = async () => { redrives++; };
    await h.subject.retireForVendorDelivery(h.order.id, 0);
    expect(redrives).toBe(0);
  });

  it.each(['CANCELLED', 'DELIVERED', 'PENDING'])('does not initialize a platform generation for terminal/ineligible %s', async status => {
    const h = setup(); h.order.status = status;
    h.subject.initializeDeliveryGeneration = async () => { throw new Error('invalid generation initialization'); };
    expect(await h.subject.prepareForPlatformDelivery(h.order.id, 0)).toBe(false);
  });

  it.each([
    ['ON_READY', 'FOOD_DELIVERY', 'READY_FOR_PICKUP', 'RIDER'],
    ['ON_ACCEPT', 'FOOD_DELIVERY', 'PREPARING', 'RIDER'],
    ['ON_READY', 'COURIER', 'PREPARING', 'RIDER'],
    ['ON_READY', 'TAXI', 'PENDING', 'DRIVER'],
  ])('preserves %s %s %s as positive authority', async (trigger, type, status, pool) => {
    const h = setup(); testProcess.env.DISPATCH_TRIGGER = trigger; h.order.orderType = type; h.order.status = status;
    expect(h.subject.searchable(h.order, pool, 0)).toBe(true);
    expect((await h.subject.offerAuthority(h.order.id, pool, 0)).offerable).toBe(true);
  });

  it('does not adopt fv2 as a vendor cutoff after an fv0 acceptance loses to fv1', async () => {
    const h = setup(); h.install('rider', 'old~fv0');
    h.subject.poolOf = async () => 'RIDER'; h.subject.requireMover = async () => ({ id: 'rider' });
    h.subject.claimOrder = async () => {
      h.order.fulfillmentModeVersion = 2; h.install('next-rider', 'fresh~fv2');
      h.rows.push({ id: 'new', subjectId: h.order.id, status: 'SEARCHING', deliveryAuthorityVersion: 2 });
      throw new AppError(409, 'VENDOR_DELIVERY_SELECTED', 'lost at fv1; fv2 committed before catch');
    };
    h.subject.dispatchOrder = async () => {};
    await expect(h.subject.acceptOffer(h.order.id, 'user', undefined, 'old~fv0')).rejects.toMatchObject({ code: 'VENDOR_DELIVERY_SELECTED' });
    expect(h.state.get('dispatch:offer:order-unit')).toBe('next-rider:fresh~fv2');
    expect(h.rows[0]).toMatchObject({ status: 'SEARCHING', deliveryAuthorityVersion: 2 });
  });

  it.each(['ORDER_NOT_READY', 'ORDER_HELD'])('treats %s as neutral stale authority after consuming a real offer', async code => {
    const h = setup(); h.install('rider', 'old~fv0');
    h.subject.poolOf = async () => 'RIDER'; h.subject.requireMover = async () => ({ id: 'rider' });
    h.subject.claimOrder = async () => { throw new AppError(409, code, 'authority changed'); };
    let declined = 0, redriven = 0;
    h.subject.redis.sadd = async () => { declined++; };
    h.subject.redis.expire = async () => {};
    h.subject.dispatchOrder = async () => { redriven++; };
    await expect(h.subject.acceptOffer(h.order.id, 'user', undefined, 'old~fv0')).rejects.toMatchObject({ code });
    expect({ declined, redriven }).toEqual({ declined: 0, redriven: 0 });
  });

  it.each(['journal-read', 'journal-create', 'commit', 'ambiguous-redis'])('compensates the exact unpublished pair after %s failure', async fault => {
    const h = setup(); const failure = new Error(fault);
    if (fault === 'journal-read') h.tx.dispatchSearch.findFirst = async () => { throw failure; };
    if (fault === 'journal-create') h.tx.dispatchSearch.create = async () => { throw failure; };
    if (fault === 'commit') h.subject.prisma.$transaction = async (fn: any) => { await fn(h.tx); throw failure; };
    if (fault === 'ambiguous-redis') {
      const evalCommand = h.subject.redis.eval;
      h.subject.redis.eval = async (...args: any[]) => { await evalCommand(...args); throw failure; };
    }
    await expect(h.subject.installOfferPair(h.order.id, 'rider', 'failed~fv0', 30)).rejects.toThrow(fault);
    expect(h.state.get('dispatch:offer:order-unit')).toBeUndefined();
    expect(h.state.get('dispatch:mover-offer:rider')).toBeUndefined();
  });

  it('compensation after transaction rejection cannot delete a newer attempt', async () => {
    const h = setup();
    h.subject.prisma.$transaction = async (fn: any) => { await fn(h.tx); h.install('rider', 'new~fv0'); throw new Error('commit rejected'); };
    await expect(h.subject.installOfferPair(h.order.id, 'rider', 'old~fv0', 30)).rejects.toThrow('commit rejected');
    expect(h.state.get('dispatch:offer:order-unit')).toBe('rider:new~fv0');
    expect(h.state.get('dispatch:mover-offer:rider')).toBe('order-unit:new~fv0');
  });

  it('withdraws a delayed Redis install even after the outer transaction already rejected', async () => {
    const h = setup(), entered = barrier(), resume = barrier(); const evalCommand = h.subject.redis.eval;
    let callback!: Promise<unknown>;
    h.subject.redis.eval = async (...args: any[]) => { entered.open(); await resume.promise; return evalCommand(...args); };
    h.subject.prisma.$transaction = async (fn: any) => { callback = fn(h.tx); await entered.promise; throw new Error('transaction expired'); };
    await expect(h.subject.installOfferPair(h.order.id, 'rider', 'late~fv0', 30)).rejects.toThrow('transaction expired');
    resume.open(); await callback.catch(() => {});
    expect(h.state.get('dispatch:offer:order-unit')).toBeUndefined();
    expect(h.state.get('dispatch:mover-offer:rider')).toBeUndefined();
  });

  it('enforces the future customer hold at final offer and prepare boundaries', async () => {
    const h = setup(); h.order.orderType = 'COURIER'; h.order.holdExpiresAt = new Date(Date.now() + 60000);
    h.subject.initializeDeliveryGeneration = async () => {};
    expect(h.subject.searchable(h.order, 'RIDER', 0)).toBe(false);
    expect((await h.subject.offerAuthority(h.order.id, 'RIDER', 0)).offerable).toBe(false);
    expect(await h.subject.prepareForPlatformDelivery(h.order.id, 0)).toBe(false);
    expect(await h.subject.installOfferPair(h.order.id, 'rider', 'held~fv0', 30)).toBe('ORDER_TAKEN');
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
  });

  it('uses inclusive hold expiry for searchable and final offer authority', async () => {
    const h = setup(); h.order.orderType = 'COURIER'; const instant = new Date('2026-09-22T00:00:00.000Z');
    const policy = context['dispatchHoldExpired'];
    expect(policy({ holdExpiresAt: new Date(instant.getTime() + 1) }, instant)).toBe(false);
    expect(policy({ holdExpiresAt: new Date(instant) }, instant)).toBe(true);
    expect(policy({ holdExpiresAt: new Date(instant.getTime() - 1) }, instant)).toBe(true);
    expect(policy({ holdExpiresAt: null }, instant)).toBe(true);
    h.order.holdExpiresAt = new Date(Date.now() - 1);
    expect(h.subject.searchable(h.order, 'RIDER', 0)).toBe(true);
    expect((await h.subject.offerAuthority(h.order.id, 'RIDER', 0)).offerable).toBe(true);
  });

  it('reconciles an unarmed pair even while Redis still holds the pointers', async () => {
    const h = setup(); h.install('orphan-rider', 'orphan~fv0');
    h.state.set('dispatch:offer-pending:order-unit:orphan~fv0', '1');
    // A retry wave carries prior exhaustion history; that counter cannot
    // suppress repair of a new, unarmed attempt.
    h.state.set('dispatch:exhausts:order-unit', '1');
    const enqueued: string[] = [];
    h.subject.prisma.order.findMany = async () => [h.order];
    h.subject.redis.set = async () => 'OK';
    const reconcile = context['exports'].reconcileStuckDispatch;
    expect(await reconcile(h.subject.prisma, h.subject.redis, async (id: string) => { enqueued.push(id); })).toEqual({ recovered: ['order-unit'] });
    expect(enqueued).toEqual(['order-unit']);
  });

  it.each(['timeout', 'release', 'decline'])('keeps a stale ON_READY offer %s neutral to the mover', async action => {
    const h = setup(); testProcess.env.DISPATCH_TRIGGER = 'ON_READY'; h.order.status = 'PREPARING'; h.install('rider', 'old~fv0');
    h.subject.poolOf = async () => 'RIDER'; h.subject.requireMover = async () => ({ id: 'rider' });
    h.subject.offerWasDeliverable = async () => true;
    let declined = 0, outcomes = 0, redriven = 0;
    h.subject.redis.sadd = async () => { declined++; };
    h.subject.redis.zadd = async () => {}; h.subject.redis.expire = async () => {};
    h.subject.recordOfferOutcome = async () => { outcomes++; };
    h.subject.dispatchOrder = async () => { redriven++; };
    if (action === 'timeout') await h.subject.handleOfferTimeout(h.order.id, 'rider', 'old~fv0');
    if (action === 'release') await h.subject.releaseHeldOffer('rider');
    if (action === 'decline') await h.subject.declineOffer(h.order.id, 'user', 'old~fv0');
    expect({ declined, outcomes, redriven }).toEqual({ declined: 0, outcomes: 0, redriven: 0 });
  });

  it('does not retire a newer publisher that still owns its publication lease', async () => {
    const h = setup(); h.install('new-rider', 'new~fv0');
    Object.assign(h.order, { pickupLat: 1, pickupLng: 1 });
    h.state.set('dispatch:offer-pending:order-unit:new~fv0', '1');
    h.state.set('dispatch:offer-publishing:order-unit:new~fv0', '1');
    h.subject.initializeDeliveryGeneration = async () => {};
    h.subject.findCandidates = async () => { throw new Error('new publisher must not be replaced'); };
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
    expect(h.state.get('dispatch:offer:order-unit')).toBe('new-rider:new~fv0');
    expect(h.state.get('dispatch:mover-offer:new-rider')).toBe('order-unit:new~fv0');
  });

  it.each(['interrupted-publication', 'journal-and-compensation-failure', 'redis-applies-after-rejection', 'held-before-publication', 'publication-lease-expired'])('converges %s through current authority and a fully armed publication', async fault => {
    const h = setup();
    if (fault === 'journal-and-compensation-failure') {
      const find = h.tx.dispatchSearch.findFirst, remove = h.subject.removeOfferIfOwned;
      h.tx.dispatchSearch.findFirst = async () => { throw new Error('journal unavailable'); };
      h.subject.removeOfferIfOwned = async () => { throw new Error('cleanup unavailable'); };
      await expect(h.subject.installOfferPair(h.order.id, 'orphan-rider', 'orphan~fv0', 30)).rejects.toThrow('journal unavailable');
      expect(h.state.get('dispatch:offer:order-unit')).toBe('orphan-rider:orphan~fv0');
      expect(h.state.get('dispatch:offer-pending:order-unit:orphan~fv0')).toBe('1');
      h.tx.dispatchSearch.findFirst = find; h.subject.removeOfferIfOwned = remove;
    } else if (fault === 'redis-applies-after-rejection') {
      const evalCommand = h.subject.redis.eval, resume = barrier();
      let lateApplication!: Promise<unknown>;
      h.subject.redis.eval = (...args: any[]) => {
        lateApplication = resume.promise.then(() => evalCommand(...args));
        return Promise.reject(new Error('Redis result lost before command application'));
      };
      await expect(h.subject.installOfferPair(h.order.id, 'orphan-rider', 'orphan~fv0', 30)).rejects.toThrow('Redis result lost');
      expect(h.state.get('dispatch:offer:order-unit')).toBeUndefined();
      resume.open(); await lateApplication;
      expect(h.state.get('dispatch:offer-pending:order-unit:orphan~fv0')).toBe('1');
      h.subject.redis.eval = evalCommand;
    } else {
      h.install('orphan-rider', 'orphan~fv0');
      h.state.set('dispatch:offer-pending:order-unit:orphan~fv0', '1');
    }
    Object.assign(h.order, { pickupLat: 1, pickupLng: 1, items: [], paymentMethod: 'CASH' });
    h.subject.initializeDeliveryGeneration = async () => {};
    h.subject.findCandidates = async () => [{ riderId: 'fresh-rider', userId: 'fresh-user', etaMinutes: 3 }];
    h.subject.logLoadGateShadow = () => {};
    h.subject.canReceiveOffer = async () => true;
    const emitted: any[] = [], scheduled: any[] = [];
    h.subject.io = { to: () => ({ emit: (...args: any[]) => emitted.push(args) }) };
    h.subject.scheduleTimeout = async (...args: any[]) => { scheduled.push(args); };
    h.subject.prisma.alertDelivery = { create: async () => {} };
    h.subject.redis.zadd = async () => {}; h.subject.redis.expire = async () => {};
    if (['journal-and-compensation-failure', 'redis-applies-after-rejection'].includes(fault)) {
      // The Redis test adapter does not run a wall clock. Prove the retry
      // preserves active publication ownership, then model server lease expiry.
      expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
      expect(h.state.get('dispatch:offer:order-unit')).toBe('orphan-rider:orphan~fv0');
      expect(emitted).toHaveLength(0); expect(scheduled).toHaveLength(0);
      h.state.delete('dispatch:offer-publishing:order-unit:orphan~fv0');
    }
    if (fault === 'held-before-publication') {
      context['customerTrustSummaries'] = async () => { h.order.holdExpiresAt = new Date(Date.now() + 60000); return new Map(); };
      expect(await h.subject.dispatchOrder(h.order.id)).toEqual({});
      expect(emitted).toHaveLength(0); expect(scheduled).toHaveLength(0);
      expect(h.state.get('dispatch:offer:order-unit')).toBeUndefined();
      return;
    }
    if (fault === 'publication-lease-expired') {
      context['customerTrustSummaries'] = async () => {
        for (const key of h.state.keys()) if (key.startsWith('dispatch:offer-publishing:')) h.state.delete(key);
        return new Map();
      };
      await expect(h.subject.dispatchOrder(h.order.id)).rejects.toMatchObject({ code: 'OFFER_PUBLICATION_EXPIRED' });
      expect(emitted).toHaveLength(0); expect(scheduled).toHaveLength(0);
      expect(h.state.get('dispatch:offer:order-unit')).toBeUndefined();
      return;
    }
    expect(await h.subject.dispatchOrder(h.order.id)).toEqual({ offered: 'fresh-rider' });
    expect(emitted).toHaveLength(1); expect(scheduled).toHaveLength(1);
    expect(emitted[0][1].offerAttemptId).toBe(scheduled[0][3]);
    expect(h.state.get('dispatch:offer-pending:order-unit:' + scheduled[0][3])).toBeUndefined();
    expect(h.state.get('dispatch:mover-offer:orphan-rider')).toBeUndefined();
  });
});
