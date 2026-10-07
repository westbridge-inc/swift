import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [L04 · R5] Census of TOP-LEVEL raw SQL: \$queryRaw/\$executeRaw and their
// Unsafe forms called on anything but a transaction callback's own client.
//
// Under the tenant wall a raw statement is bound like a model query when a
// request tenant is bound (the rawTenantBinding extension), and runs UNBOUND
// otherwise — on the least-privilege login that reads nothing of a walled
// table. Whether a site is safe depends on how it is reached, which its
// file's ROLE records, and the role is CHECKED where a structural check exists:
//   INFRA        catalog, health, boot, operator tooling — must live outside
//                the product modules (app.ts, lib/, plugins/, utils/,
//                scripts/, modules/ops/);
//   REQUEST      reached from an authenticated request (bound automatically) —
//                must be a routes or service file;
//   JOB          background or provider work — must name its capability
//                (runAsSystem / runWithTenant / runWithoutTenant) in the file;
//   JOB_PENDING  background work that does not yet name one: the job/webhook
//                lanes' list, which can only shrink (a file that gains a
//                capability must move to JOB);
//   SHARED       reached from both; the R4 shadow run is the behavioural proof.
// This is a tripwire, not a proof: a site on a client named tx/t/trx is read
// as a transaction client and skipped, and a role check reads the FILE, not
// the call path. Any receiver shape — a cast, a call, an index — is counted.
// ---------------------------------------------------------------------------

type Role = 'INFRA' | 'REQUEST' | 'JOB' | 'JOB_PENDING' | 'SHARED';
const CENSUS: Record<string, { sites: number; role: Role }> = {
  'app.ts': { sites: 1, role: 'INFRA' },
  'lib/rls-attestation.ts': { sites: 4, role: 'INFRA' },
  'modules/admin/admin.routes.ts': { sites: 3, role: 'REQUEST' },
  'modules/ads/checkout-scan.ts': { sites: 2, role: 'SHARED' },
  'modules/ads/refund.service.ts': { sites: 3, role: 'SHARED' },
  'modules/billing/agent-cash.service.ts': { sites: 2, role: 'JOB' },
  'modules/billing/billing-confirmation-backfill.ts': { sites: 2, role: 'JOB_PENDING' },
  'modules/billing/billing-notice-delivery.ts': { sites: 5, role: 'JOB_PENDING' },
  'modules/billing/billing.service.ts': { sites: 2, role: 'SHARED' },
  'modules/billing/invariants.ts': { sites: 2, role: 'JOB_PENDING' },
  'modules/billing/provider-identity-backfill.ts': { sites: 1, role: 'JOB_PENDING' },
  'modules/billing/receipts.ts': { sites: 1, role: 'SHARED' },
  'modules/billing/sales-components.ts': { sites: 1, role: 'SHARED' },
  'modules/billing/sales-digest.ts': { sites: 1, role: 'JOB_PENDING' },
  'modules/billing/settlement-import.ts': { sites: 2, role: 'JOB' },
  'modules/discovery/discovery.routes.ts': { sites: 1, role: 'REQUEST' },
  'modules/dispatch/dispatch.service.ts': { sites: 4, role: 'SHARED' },
  'modules/mover-authority-cutover-preparation.ts': { sites: 1, role: 'JOB_PENDING' },
  'modules/mover-revocation-outbox.ts': { sites: 4, role: 'JOB_PENDING' },
  'modules/ops/purge-plan.ts': { sites: 2, role: 'INFRA' },
  'modules/order/checkout-outbox.ts': { sites: 1, role: 'JOB_PENDING' },
  'modules/order/order.service.ts': { sites: 3, role: 'REQUEST' },
  'modules/order/refund-review.ts': { sites: 1, role: 'SHARED' },
  'modules/promo/promo-terms.ts': { sites: 3, role: 'SHARED' },
  'modules/qr/qr-analytics.service.ts': { sites: 2, role: 'SHARED' },
  'modules/rides/queue.service.ts': { sites: 2, role: 'SHARED' },
  'modules/safety/guardian-delivery.ts': { sites: 4, role: 'JOB_PENDING' },
  'modules/safety/incident.service.ts': { sites: 2, role: 'SHARED' },
  'modules/safety/legal-hold.ts': { sites: 4, role: 'JOB_PENDING' },
  'modules/safety/sos-escalation.ts': { sites: 5, role: 'JOB_PENDING' },
  'modules/safety/sos-retrigger.ts': { sites: 3, role: 'JOB_PENDING' },
  'modules/subscription/mover-fee-authority.ts': { sites: 1, role: 'SHARED' },
  'modules/subscription/mover-fee-history.ts': { sites: 3, role: 'SHARED' },
  // isFiction (store-review demo check): reached only from authenticated requests — document
  // submission (vendor, verification routes) and an admin's approval (admin routes).
  'modules/subscription/subscription.service.ts': { sites: 1, role: 'REQUEST' },
  // Account erasure runs from customer/admin requests and the tenant-bound retry sweep.
  'modules/user/account.service.ts': { sites: 1, role: 'SHARED' },
  'modules/user/partner-wind-down.ts': { sites: 2, role: 'SHARED' },
  'modules/vendor/vendor.routes.ts': { sites: 1, role: 'REQUEST' },
  'modules/verification/mover-document-authority.ts': { sites: 2, role: 'SHARED' },
  'modules/verification/object-authority.ts': { sites: 3, role: 'SHARED' },
  'modules/verification/subjects.ts': { sites: 1, role: 'SHARED' },
  'plugins/prisma.ts': { sites: 2, role: 'INFRA' },
  'plugins/readiness.ts': { sites: 2, role: 'INFRA' },
  'scripts/backfill-billing-confirmation.ts': { sites: 1, role: 'INFRA' },
  'utils/infrastructure-clock.ts': { sites: 1, role: 'INFRA' },
};

const SRC = join(__dirname, '..');
const SITE = /(\b[A-Za-z_][A-Za-z0-9_]*\b|\)|\])?\s*\.\s*\$(queryRaw|executeRaw)(Unsafe)?\s*(<|`|\()/g;
const TX_CLIENT = new Set(['tx', 't', 'trx']);
const CAPABILITY = /runAsSystem\(|runWithoutTenant\(|runWithTenant\(/;
const INFRA_PATH = /^(app\.ts$|lib\/|plugins\/|utils\/|scripts\/|modules\/ops\/)/;
const REQUEST_PATH = /\.(routes|service)\.ts$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

function countSites(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    for (const m of line.matchAll(SITE)) if (!TX_CLIENT.has(m[1] ?? '')) n += 1;
  }
  return n;
}

describe('[R5] top-level raw SQL census', () => {
  it('every top-level raw SQL site is counted under its file', () => {
    const found: Record<string, number> = {};
    for (const file of files(SRC)) {
      const n = countSites(readFileSync(file, 'utf8'));
      if (n) found[relative(SRC, file)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(CENSUS).map(([f, c]) => [f, c.sites])));
  });

  it('every recorded role holds for its file', () => {
    const wrong: string[] = [];
    for (const [file, { role }] of Object.entries(CENSUS)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      if (role === 'INFRA' && !INFRA_PATH.test(file)) wrong.push(`${file}: INFRA outside the infrastructure paths`);
      if (role === 'REQUEST' && !REQUEST_PATH.test(file)) wrong.push(`${file}: REQUEST in a file that is not routes or service`);
      if (role === 'JOB' && !CAPABILITY.test(text)) wrong.push(`${file}: JOB without a named capability`);
      if (role === 'JOB_PENDING' && CAPABILITY.test(text)) wrong.push(`${file}: names a capability now — move it to JOB`);
    }
    expect(wrong).toEqual([]);
  });

  it('the site pattern counts cast and call receivers, and skips only transaction clients', () => {
    expect(countSites('await (client as unknown as X).$executeRaw`SELECT 1`;')).toBe(1);
    expect(countSites('await (await db()).$queryRaw`SELECT 1`;')).toBe(1);
    expect(countSites('await clients[0].$queryRawUnsafe(sql);')).toBe(1);
    expect(countSites('await prisma.$queryRaw<Row[]>`SELECT 1`;')).toBe(1);
    expect(countSites('await tx.$queryRaw`SELECT 1`;')).toBe(0);
    expect(countSites('// prisma.$queryRaw`SELECT 1` in a comment')).toBe(0);
  });
});
