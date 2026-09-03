import { PrismaClient } from '@prisma/client';
import { seedPlatformSpine } from './seed-platform';
import { promoteBootstrapAdmin, type SeedPlan } from '../src/modules/ops/seed-plan';
import type { Approval } from '../src/modules/ops/purge-plan';

/**
 * The PRODUCTION spine seed — the platform config plan and, optionally, the
 * first SUPER_ADMIN. No demo data, ever.
 *
 * [R048-005] This is a CEREMONY, not a script that overwrites:
 *   1. The plan is built against the database's own deployment identity and
 *      PRINTED as a diff (table, key, field, from → to) before anything runs.
 *   2. On a production target the apply needs TWO distinct approvals signed
 *      over the plan digest with SEED_PLAN_SECRET —
 *      `SEED_PLAN_APPROVALS='[{"approver":"…","signature":"…"}]'`; without
 *      them it prints the plan digest to sign and exits 2. Anywhere else the
 *      plan applies directly (an empty diff applies nothing and says so).
 *   3. The first SUPER_ADMIN (SEED_ADMIN_PHONE) is minted only while NONE
 *      exists; afterwards it is a break-glass change needing two approvals
 *      over the target and the phone (`SEED_PROMOTION_APPROVALS`).
 * Every apply and promotion is a durable privileged-change audit row.
 */

function parseApprovals(raw: string | undefined, name: string): Approval[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.map((a) => {
      const o = a as { approver?: unknown; signature?: unknown };
      if (typeof o.approver !== 'string' || typeof o.signature !== 'string') throw new Error('an approval needs approver and signature');
      return { approver: o.approver, signature: o.signature };
    });
  } catch (err) {
    throw new Error(`${name} is not a JSON array of {approver, signature}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function printPlan(plan: SeedPlan): void {
  console.warn(`Plan ${plan.digest.slice(0, 12)} · config ${plan.configVersion} · target ${plan.target.deploymentId}/${plan.target.environment} (${plan.target.database} on ${plan.target.host})`);
  if (plan.changes.length === 0) { console.warn('  nothing to change'); return; }
  for (const ch of plan.changes) {
    const where = ch.table === 'countryConfig' ? `${ch.table} ${ch.key}.${ch.field}` : `${ch.table} ${ch.key}`;
    if ('from' in ch) console.warn(`  ${ch.op.padEnd(6)} ${where}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`);
    else console.warn(`  ${ch.op.padEnd(6)} ${where}`);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const secret = process.env['SEED_PLAN_SECRET'];
  const approvals = parseApprovals(process.env['SEED_PLAN_APPROVALS'], 'SEED_PLAN_APPROVALS');
  const actor = process.env['SEED_ACTOR'] ?? 'seed-production';
  try {
    console.warn('Seeding PRODUCTION spine (no demo data)…');
    let previewed: SeedPlan | null = null;
    try {
      await seedPlatformSpine(prisma, {
        databaseUrl,
        secret,
        approvals,
        actor,
        onPlan: (plan) => { previewed = plan; printPlan(plan); },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'APPROVALS_REQUIRED' && previewed) {
        console.error(`\nThis target is production. Two people must sign the plan digest above with SEED_PLAN_SECRET and re-run with SEED_PLAN_APPROVALS. Digest: ${(previewed as SeedPlan).digest}`);
        process.exit(2);
      }
      throw err;
    }
    const adminPhone = process.env['SEED_ADMIN_PHONE'];
    if (adminPhone) {
      const promotionApprovals = parseApprovals(process.env['SEED_PROMOTION_APPROVALS'], 'SEED_PROMOTION_APPROVALS');
      const result = await promoteBootstrapAdmin(prisma, databaseUrl, adminPhone, { secret, approvals: promotionApprovals, actor });
      console.warn(`SUPER_ADMIN ${result.mode === 'bootstrap' ? 'bootstrapped' : 'promoted by break-glass'} for ${adminPhone}.`);
    } else {
      console.warn('SEED_ADMIN_PHONE not set — spine seeded WITHOUT a bootstrap admin. Set it to mint the first SUPER_ADMIN.');
    }
    console.warn('Production spine seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
