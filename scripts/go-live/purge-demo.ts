/**
 * Go-Live demo-data purge + pre-launch cleanliness check [LIVE-001, engagement #4].
 *
 * [SCR-001 / SCR-002] This file is a thin CLI over `apps/api/src/modules/ops/purge-plan.ts`,
 * which holds the workflow and its tests. Nothing here deletes on its own:
 *
 *   verify (default)   classify + report; refuses to say "clean" without a deployment identity.
 *   plan               write a signed, target-bound plan file (expires in 1 hour).
 *   execute            run an approved plan: same target, two distinct approvers, a backup manifest
 *                      with tested-restore evidence, unchanged counts, production only under a
 *                      time-bound break-glass approval. Deletion goes through the canonical
 *                      account-deletion path; partner accounts are reported for the partner
 *                      closure workflow, never hard-deleted; held accounts are quarantined.
 *
 * Run (from apps/api, where @prisma/client resolves):
 *   DATABASE_URL=... npx tsx ../../scripts/go-live/purge-demo.ts verify
 *   DATABASE_URL=... npx tsx ../../scripts/go-live/purge-demo.ts plan --out purge-plan.json
 *   DATABASE_URL=... PURGE_APPROVAL_SECRET=... npx tsx ../../scripts/go-live/purge-demo.ts approve --plan purge-plan.json --as alice
 *   DATABASE_URL=... PURGE_APPROVAL_SECRET=... npx tsx ../../scripts/go-live/purge-demo.ts execute \
 *     --plan purge-plan.json --approvals approvals.json --backup backup-manifest.json [--break-glass break-glass.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { buildPlan, classify, executePlan, signApproval, syntheticMarkersPresent, targetFingerprint, type Approval, type BackupManifest, type BreakGlass, type PurgePlan } from '../../apps/api/src/modules/ops/purge-plan';
import { AccountService } from '../../apps/api/src/modules/user/account.service';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'verify';
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const readJson = <T,>(path: string | undefined, what: string): T => { if (!path) throw new Error(`--${what} is required`); return JSON.parse(readFileSync(path, 'utf8')) as T; };
const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const prisma = new PrismaClient();

async function main() {
  const target = await targetFingerprint(prisma, databaseUrl);
  console.log(`\n=== Swift Go-Live · demo-data purge (${mode}) ===`);
  console.log(`TARGET: ${target.database} on ${target.host} · deployment ${target.deploymentId} · environment ${target.environment}`);
  if (mode === 'verify') {
    const c = await classify(prisma);
    console.log(`users total: ${c.total} · admins kept: ${c.adminIds.length} · demo customers: ${c.demoCustomerIds.length} · demo partners (partner closure workflow): ${c.demoPartnerIds.length} · quarantined (legal hold): ${c.quarantinedIds.length} · unclassified (reviewed, never selected): ${c.unclassified}`);
    if (target.environment === 'unknown') { console.log('⚠️  no deployment identity — this database cannot be certified clean'); process.exitCode = 2; return; }
    if (target.environment === 'production' && (await syntheticMarkersPresent(prisma)) > 0) { console.log('❌ synthetic markers present in PRODUCTION'); process.exitCode = 1; return; }
    console.log(c.demoCustomerIds.length + c.demoPartnerIds.length + c.unclassified === 0 ? '✅ CLEAN: only admins and the platform spine remain' : 'ℹ️  not clean — plan a purge for the synthetic set; review the unclassified by hand');
    return;
  }
  if (mode === 'plan') {
    const plan = await buildPlan(prisma, databaseUrl);
    const out = arg('out') ?? 'purge-plan.json';
    writeFileSync(out, JSON.stringify(plan, null, 2));
    console.log(`plan ${plan.digest} written to ${out} (expires ${plan.expiresAt}): ${plan.counts.demoCustomers} demo customers to delete, ${plan.counts.demoPartners} partners reported, ${plan.counts.quarantined} quarantined, ${plan.counts.unclassified} unclassified untouched`);
    return;
  }
  if (mode === 'approve') {
    const secret = process.env['PURGE_APPROVAL_SECRET']; if (!secret) throw new Error('PURGE_APPROVAL_SECRET is required');
    const plan = readJson<PurgePlan>(arg('plan'), 'plan'); const who = arg('as'); if (!who) throw new Error('--as <approver> is required');
    console.log(JSON.stringify(signApproval(secret, who, plan.digest)));
    return;
  }
  if (mode === 'execute') {
    const secret = process.env['PURGE_APPROVAL_SECRET']; if (!secret) throw new Error('PURGE_APPROVAL_SECRET is required');
    const plan = readJson<PurgePlan>(arg('plan'), 'plan');
    const approvals = readJson<Approval[]>(arg('approvals'), 'approvals');
    const backup = readJson<BackupManifest>(arg('backup'), 'backup');
    const breakGlass = arg('break-glass') ? readJson<BreakGlass>(arg('break-glass'), 'break-glass') : null;
    // the canonical deletion path, on the minimal app surface it uses (prisma, log, io): the same erasure a person's own request runs
    const app = { prisma, log: { info: console.log, warn: console.warn, error: console.error, debug: () => {} }, io: { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } } };
    const accounts = new AccountService(app as never);
    const res = await executePlan(prisma, databaseUrl, plan, { secret, approvals, backup, breakGlass, deleteUser: async (id) => { await accounts.deleteAccount(id); } });
    console.log(`✅ executed plan ${plan.digest}: deleted ${res.deleted.length}, skipped ${res.skippedAlreadyGone.length} already gone, ${res.partnersReported.length} partner account(s) reported for closure, ${res.quarantined.length} quarantined`);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main()
  .catch((e) => { console.error('purge refused:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
