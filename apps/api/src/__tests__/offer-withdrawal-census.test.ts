import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [DISPATCH 1/3 · B4] EVERY CANCELLATION WITHDRAWS THE CARD — the census.
//
// A cancel committed the order and left its live offer card in Redis: the
// pinged mover could keep tapping it for the rest of the countdown, and their
// reverse pointer held them out of every other offer until it lapsed. It was
// reported on the customer cancel and was true of every cancel: the courier
// sender, the store rejecting, an admin, the no-response auto-cancel, the taxi
// released for lack of drivers, the food-age cutoff.
//
// The fix has ONE point (modules/dispatch/offer-withdrawal.ts) and this census
// holds every writer to it:
//
//   * the canonical transition seam withdraws after every operational
//     cancellation it commits — the vendor, courier, admin, auto-cancel and
//     cash-refusal cancels all pass through it;
//   * a writer that bypasses the seam and writes `status: 'CANCELLED'` itself
//     must be registered below AND call the point after its write;
//   * an order write whose status the scan cannot read (a computed `data`, a
//     computed status) must be reviewed below, with why it cannot cancel;
//   * no raw SQL writes an order to CANCELLED;
//   * every production OrderService is built with the offer store, or its
//     seam would skip the withdrawal silently.
//
// A new CANCELLED writer fails this file until it withdraws and is registered.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const POINT = 'withdrawOfferOfClosedOrder';
const SEAM_HELPER = 'this.withdrawLiveOffer';

/** Direct `status: 'CANCELLED'` order writers that bypass the canonical seam. */
const CANCELLING_WRITERS: Record<string, string> = {
  'modules/order/order.service.ts#cancelOrder':
    'the customer cancel: its own locked transaction (refund policy, float, mover release), then the withdrawal once it commits',
  'modules/dispatch/dispatch.service.ts#publishExhaustion':
    'the taxi released after TAXI_WAIT_LIMIT_MIN with no driver: a compare-and-set, so a card a re-sweep installed meanwhile is withdrawn after it',
  'modules/dispatch/rescue.ts#settleTooOldOrder':
    'the food-age cutoff: a compare-and-set by the system, then the card withdrawn as a pair before the rest of the search memory is dropped',
};

/** Order writes the scan cannot read a status from, each reviewed. */
const REVIEWED_WRITERS: Record<string, string> = {
  'modules/order/order.service.ts#stageCanonicalOrderTransition':
    'THE SEAM: status is input.target. Its caller transitionOrderAtomically withdraws after every operational cancellation (asserted below).',
  'modules/chat/chat-authority.ts#rotateLeakedRidePin': 'rotates the ride PIN (freshRidePinReset); never touches status.',
  'modules/order/mmg-claim.service.ts#recordCustomerMmgClaim': 'MMG claim facts and revision only; never the order status.',
  'modules/order/mmg-claim.service.ts#resolveMmgClaimDisagreement': 'MMG claim resolution and paymentStatus only; never the order status.',
  'modules/vendor/vendor.routes.ts#recordPrepProgress': 'kitchen milestone timestamps while a rider owns the status lane; never the status.',
  'modules/dispatch/delivery-watchdog.ts#reopenPreCustodyLeg':
    'reopens a released leg to its kitchen stage (releaseStageFor: ACCEPTED, PREPARING or READY_FOR_PICKUP); never CANCELLED.',
};

const ORDER_WRITE = /(^|\.)order\.(update|updateMany|upsert)$/;
const ROUTE = /(^|\.)(get|post|put|patch|delete)$/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') productionFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The function a node sits in: a method or function by name, a route handler by its route. */
function enclosing(node: ts.Node, sf: ts.SourceFile): { fn: ts.Node; label: string } | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) return { fn: n, label: n.name.getText(sf) };
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      if (ts.isCallExpression(n.parent) && ROUTE.test(n.parent.expression.getText(sf))) {
        const path = n.parent.arguments[0];
        const method = n.parent.expression.getText(sf).split('.').pop()!.toUpperCase();
        return { fn: n, label: `${method} ${path && ts.isStringLiteralLike(path) ? path.text : '?'}` };
      }
      if (ts.isVariableDeclaration(n.parent)) return { fn: n, label: n.parent.name.getText(sf) };
    }
  }
  return null;
}

function calls(root: ts.Node, sf: ts.SourceFile, callee: string, after = -1): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === callee && n.getStart(sf) > after) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

type Site = { key: string; kind: 'cancels' | 'unreadable'; withdrawsAfter: boolean };

/** Every order write in one source, classified. Pure: the guard below runs it on a planted source. */
function scanOrderWrites(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  /** What one write payload does to the status: cancels, unreadable, or neither. */
  const classify = (payload: ts.ObjectLiteralElementLike | undefined): Site['kind'] | null => {
    if (!payload) return null;
    if (!ts.isPropertyAssignment(payload) || !ts.isObjectLiteralExpression(payload.initializer)) return 'unreadable';
    const status = payload.initializer.properties.find((p) => p.name?.getText(sf) === 'status');
    if (!status) return null;
    if (!ts.isPropertyAssignment(status) || !ts.isStringLiteralLike(status.initializer)) return 'unreadable';
    return status.initializer.text === 'CANCELLED' ? 'cancels' : null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ORDER_WRITE.test(n.expression.getText(sf))) {
      const arg = n.arguments[0];
      let kind: Site['kind'] | null;
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        kind = 'unreadable';
      } else {
        // update/updateMany write `data`; an upsert writes `create` and `update`.
        const kinds = ['data', 'create', 'update'].map((name) => classify(arg.properties.find((p) => p.name?.getText(sf) === name)));
        kind = kinds.includes('cancels') ? 'cancels' : kinds.includes('unreadable') ? 'unreadable' : null;
      }
      if (kind) {
        const owner = enclosing(n, sf);
        const key = `${file}#${owner?.label ?? '<module>'}`;
        const withdrawsAfter = !!owner && (
          calls(owner.fn, sf, POINT, n.getEnd()).length > 0 || calls(owner.fn, sf, SEAM_HELPER, n.getEnd()).length > 0
        );
        sites.push({ key, kind, withdrawsAfter });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

const files = productionFiles(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const sites = files.flatMap((f) => scanOrderWrites(f.rel, f.text));

function method(file: string, name: string): { node: ts.MethodDeclaration; sf: ts.SourceFile } {
  const sf = ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let node: ts.MethodDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (!node && ts.isMethodDeclaration(n) && n.name.getText(sf) === name) node = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!node) throw new Error(`${file}: no method ${name}`);
  return { node, sf };
}

describe('[DISPATCH 1/3 · B4] every cancellation withdraws the live offer card through the one point', () => {
  it('every direct CANCELLED order write is registered, and withdraws the card after its write', () => {
    const cancelling = sites.filter((s) => s.kind === 'cancels');
    expect(
      [...new Set(cancelling.map((s) => s.key))].sort(),
      'a new writer commits orders to CANCELLED: call withdrawOfferOfClosedOrder after its commit and register it here (or go through the canonical seam)',
    ).toEqual(Object.keys(CANCELLING_WRITERS).sort());
    for (const site of cancelling) {
      expect(site.withdrawsAfter, `${site.key} commits CANCELLED but never withdraws the card after it`).toBe(true);
    }
  });

  it('every order write whose status the scan cannot read is reviewed', () => {
    const unreadable = [...new Set(sites.filter((s) => s.kind === 'unreadable').map((s) => s.key))].sort();
    expect(
      unreadable,
      'an order write computes its data or its status: if it can write CANCELLED it must withdraw the card; either way review it here',
    ).toEqual(Object.keys(REVIEWED_WRITERS).sort());
    for (const [key, why] of Object.entries({ ...CANCELLING_WRITERS, ...REVIEWED_WRITERS })) {
      expect(why.length, `${key} needs a written reason`).toBeGreaterThan(40);
    }
  });

  it('the canonical seam withdraws after every operational cancellation it commits, and only after the commit', () => {
    const { node, sf } = method('modules/order/order.service.ts', 'transitionOrderAtomically');
    const committing = calls(node, sf, 'this.prisma.$transaction');
    expect(committing, 'the seam commits in one transaction').toHaveLength(1);
    const withdrawals = calls(node, sf, SEAM_HELPER);
    expect(withdrawals, 'the seam withdraws the card').toHaveLength(1);
    expect(withdrawals[0]!.getStart(sf), 'after the commit, never inside it').toBeGreaterThan(committing[0]!.getEnd());
    // Guarded by THE cancellation predicate: a REFUNDED after a finished trip is
    // accounting, while a REFUNDED from a live state is a cancellation.
    let guard: ts.IfStatement | undefined;
    for (let n: ts.Node | undefined = withdrawals[0]!.parent; n && n !== node; n = n.parent) {
      if (ts.isIfStatement(n)) { guard = n; break; }
    }
    expect(guard?.expression.getText(sf)).toMatch(/^isCancellationTerminalization\(committed\.sourceStatus, input\.target\)$/);
  });

  it('the seam helper goes through the one point', () => {
    const { node, sf } = method('modules/order/order.service.ts', 'withdrawLiveOffer');
    expect(calls(node, sf, POINT)).toHaveLength(1);
  });

  it('every production OrderService is built with the offer store — without it the seam skips the withdrawal', () => {
    const built: string[] = [];
    for (const { rel, text } of files) {
      const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isNewExpression(n) && n.expression.getText(sf) === 'OrderService') {
          const store = n.arguments?.[4];
          built.push(`${rel}: ${store ? store.getText(sf) : 'NO OFFER STORE'}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(built.length, 'the scan found the composition roots').toBeGreaterThanOrEqual(10);
    for (const line of built) expect(line, 'pass the app/job Redis as the fifth argument').toMatch(/: (app|ctx)\.redis$/);
  });

  it('no raw SQL writes an order to CANCELLED', () => {
    const raw: string[] = [];
    for (const { rel, text } of files) {
      for (const m of text.matchAll(/UPDATE\s+"?orders"?\s+SET[\s\S]{0,400}?'CANCELLED'/gi)) raw.push(`${rel}: ${m[0].slice(0, 60)}`);
    }
    expect(raw, 'a raw CANCELLED write bypasses the census: use the canonical seam').toEqual([]);
  });

  it('the scan sees what it bans (guards the guard)', () => {
    const planted = scanOrderWrites('planted.ts', `
      export async function sneakyCancel(prisma: any, id: string) {
        await prisma.order.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
      }
      export async function honestCancel(prisma: any, redis: any, id: string) {
        await prisma.order.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await withdrawOfferOfClosedOrder({ prisma, redis }, id);
      }
      export async function computed(prisma: any, id: string, data: any) {
        await prisma.order.update({ where: { id }, data });
      }
      export async function unrelated(prisma: any, id: string) {
        await prisma.order.update({ where: { id }, data: { notes: 'x' } });
        await prisma.booking.update({ where: { id }, data: { status: 'CANCELLED' } });
      }
    `);
    expect(planted).toEqual([
      { key: 'planted.ts#sneakyCancel', kind: 'cancels', withdrawsAfter: false },
      { key: 'planted.ts#honestCancel', kind: 'cancels', withdrawsAfter: true },
      { key: 'planted.ts#computed', kind: 'unreadable', withdrawsAfter: false },
    ]);
    expect(files.length, 'the real tree was scanned').toBeGreaterThan(200);
  });
});
