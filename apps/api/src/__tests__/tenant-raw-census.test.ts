import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [L04 · R5] Census of TOP-LEVEL raw SQL (\$queryRaw/\$executeRaw and their
// Unsafe forms called outside a transaction callback's own client).
//
// Under the tenant wall a raw statement is bound like a model query when a
// request tenant is bound (the rawTenantBinding extension), and runs UNBOUND
// otherwise — on the least-privilege login that reads nothing of a walled
// table. Whether a site is safe therefore depends on how it is reached, which
// a file's ROLE describes:
//   INFRA   catalog, health, boot or operator tooling — reads no tenant rows;
//   REQUEST reached from an authenticated request: bound automatically;
//   JOB     background or provider-callback work: needs a named runAsSystem
//           capability or a per-tenant bind (the job/webhook lanes own these);
//   SHARED  reached from both; the R4 shadow run is the behavioural proof.
// A new top-level raw site, or a new file with one, fails here until it is
// added with its role — the author decides how it is bound, it is never
// silently unbound.
// ---------------------------------------------------------------------------

type Role = 'INFRA' | 'REQUEST' | 'JOB' | 'SHARED';
const CENSUS: Record<string, { sites: number; role: Role }> = {
  'app.ts': { sites: 1, role: 'INFRA' },
  'lib/rls-attestation.ts': { sites: 2, role: 'INFRA' },
  'modules/admin/admin.routes.ts': { sites: 3, role: 'REQUEST' },
  'modules/ads/checkout-scan.ts': { sites: 2, role: 'SHARED' },
  'modules/ads/refund.service.ts': { sites: 3, role: 'SHARED' },
  'modules/billing/agent-cash.service.ts': { sites: 2, role: 'JOB' },
  'modules/billing/billing-confirmation-backfill.ts': { sites: 2, role: 'JOB' },
  'modules/billing/billing-notice-delivery.ts': { sites: 5, role: 'JOB' },
  'modules/billing/billing.service.ts': { sites: 2, role: 'SHARED' },
  'modules/billing/invariants.ts': { sites: 2, role: 'JOB' },
  'modules/billing/provider-identity-backfill.ts': { sites: 1, role: 'JOB' },
  'modules/billing/receipts.ts': { sites: 1, role: 'SHARED' },
  'modules/billing/sales-components.ts': { sites: 1, role: 'SHARED' },
  'modules/billing/sales-digest.ts': { sites: 1, role: 'JOB' },
  'modules/billing/settlement-import.ts': { sites: 2, role: 'JOB' },
  'modules/discovery/discovery.routes.ts': { sites: 1, role: 'REQUEST' },
  'modules/dispatch/dispatch.service.ts': { sites: 4, role: 'SHARED' },
  'modules/mover-authority-cutover-preparation.ts': { sites: 1, role: 'JOB' },
  'modules/mover-revocation-outbox.ts': { sites: 4, role: 'JOB' },
  'modules/ops/purge-plan.ts': { sites: 2, role: 'INFRA' },
  'modules/order/checkout-outbox.ts': { sites: 1, role: 'JOB' },
  'modules/order/order.service.ts': { sites: 3, role: 'REQUEST' },
  'modules/order/refund-review.ts': { sites: 1, role: 'SHARED' },
  'modules/promo/promo-terms.ts': { sites: 3, role: 'SHARED' },
  'modules/qr/qr-analytics.service.ts': { sites: 2, role: 'SHARED' },
  'modules/rides/queue.service.ts': { sites: 2, role: 'SHARED' },
  'modules/safety/guardian-delivery.ts': { sites: 4, role: 'JOB' },
  'modules/safety/incident.service.ts': { sites: 2, role: 'SHARED' },
  'modules/safety/legal-hold.ts': { sites: 4, role: 'JOB' },
  'modules/safety/sos-escalation.ts': { sites: 5, role: 'JOB' },
  'modules/safety/sos-retrigger.ts': { sites: 3, role: 'JOB' },
  'modules/subscription/mover-fee-authority.ts': { sites: 1, role: 'SHARED' },
  'modules/subscription/mover-fee-history.ts': { sites: 3, role: 'SHARED' },
  'modules/user/partner-wind-down.ts': { sites: 2, role: 'SHARED' },
  'modules/vendor/vendor.routes.ts': { sites: 1, role: 'REQUEST' },
  'modules/verification/mover-document-authority.ts': { sites: 2, role: 'SHARED' },
  'modules/verification/object-authority.ts': { sites: 3, role: 'SHARED' },
  'modules/verification/subjects.ts': { sites: 1, role: 'SHARED' },
  'plugins/prisma.ts': { sites: 1, role: 'INFRA' },
  'plugins/readiness.ts': { sites: 2, role: 'INFRA' },
  'scripts/backfill-billing-confirmation.ts': { sites: 1, role: 'INFRA' },
  'utils/infrastructure-clock.ts': { sites: 1, role: 'INFRA' },
};

const SRC = join(__dirname, '..');
const SITE = /([A-Za-z_][A-Za-z_.]*)\.\$(queryRaw|executeRaw)(Unsafe)?\s*(<|`|\()/g;
const TX_CLIENT = new Set(['tx', 't', 'trx']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('[R5] top-level raw SQL census', () => {
  it('every top-level raw SQL site is counted under its file and role', () => {
    const found: Record<string, number> = {};
    for (const file of files(SRC)) {
      let n = 0;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) continue;
        for (const m of line.matchAll(SITE)) if (!TX_CLIENT.has(m[1]!.split('.').pop()!)) n += 1;
      }
      if (n) found[relative(SRC, file)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(CENSUS).map(([f, c]) => [f, c.sites])));
  });
});
