import { PrismaClient } from '@prisma/client';
import { seedPlatformSpine } from './seed-platform';
import { spineRequestContext } from '../src/modules/ops/platform-config';
import { planApprovalRequest, promoteBootstrapAdmin, promotionApprovalRequest, type ApplyResult, type SeedPlan } from '../src/modules/ops/seed-plan';
import { parseSignedApprovals } from '../src/modules/ops/approver-signatures';

/**
 * The PRODUCTION spine seed — the platform config plan and, optionally, the
 * first SUPER_ADMIN. No demo data, ever.
 *
 * [R048-005] This is a CEREMONY, not a script that overwrites:
 *   1. The plan is built against the database's own deployment identity and
 *      PRINTED as a diff (table, key, field, from → to) before anything runs.
 *   2. On a production target the apply needs TWO approvals by two different
 *      people. [PROD-PATH] Each approver signs the printed request with their
 *      OWN key on their own computer (deploy/seed-approve.sh), which shows
 *      them, in words, the database, the configuration and FX rate, the first
 *      admin's phone (last four digits) and every change; the server rebuilds
 *      those words at apply and requires them exactly. It holds only their
 *      pinned public keys (SEED_APPROVER_KEYS, from the encrypted store), so
 *      it cannot sign for anyone. Without approvals the run prints the request
 *      to sign (valid 24 hours from now) and exits 2; the operator re-runs
 *      with `SEED_PLAN_APPROVALS='[<line>,<line>]'`. Approvals are single-use,
 *      even when there is nothing to change. Anywhere else the plan applies
 *      directly (an empty diff applies nothing and says so).
 *   3. The first SUPER_ADMIN (SEED_ADMIN_PHONE) is minted only while NONE
 *      exists — on production only by the signed plan, which names that
 *      phone; afterwards it is a break-glass change: the run prints the
 *      promotion request and exits 3, and the operator re-runs with
 *      `SEED_PROMOTION_APPROVALS`. A phone that already holds SUPER_ADMIN
 *      changes nothing.
 * Every apply, promotion and consumed approval is a durable audit row.
 */

function printPlan(plan: SeedPlan): void {
  console.warn(`Plan ${plan.digest.slice(0, 12)} · config ${plan.configVersion} · target ${plan.target.deploymentId}/${plan.target.environment} (${plan.target.database} on ${plan.target.host})`);
  if (plan.changes.length === 0) { console.warn('  nothing to change'); return; }
  for (const ch of plan.changes) {
    const where = ch.table === 'countryConfig' ? `${ch.table} ${ch.key}.${ch.field}` : `${ch.table} ${ch.key}`;
    if ('from' in ch) console.warn(`  ${ch.op.padEnd(6)} ${where}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`);
    else console.warn(`  ${ch.op.padEnd(6)} ${where}`);
  }
}

/** The request goes to stdout alone, so it can be saved to a file and signed as-is. */
function printRequest(what: string, request: string): void {
  console.warn(`\n${what} Each approver saves the request below (between the lines) to a file and signs it on their own computer:\n  ./deploy/seed-approve.sh <their-name> <their-key> < request.txt\nThen re-run with both printed lines. The request is valid for 24 hours.\n-----`);
  process.stdout.write(request);
  console.warn('-----');
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const approverKeys = process.env['SEED_APPROVER_KEYS'];
  const approvals = parseSignedApprovals(process.env['SEED_PLAN_APPROVALS'], 'SEED_PLAN_APPROVALS');
  const actor = process.env['SEED_ACTOR'] ?? 'seed-production';
  const adminPhone = process.env['SEED_ADMIN_PHONE'] || null;
  try {
    console.warn('Seeding PRODUCTION spine (no demo data)…');
    let previewed: SeedPlan | null = null;
    let applied: ApplyResult | null = null;
    try {
      await seedPlatformSpine(prisma, {
        databaseUrl,
        approvals,
        approverKeys,
        actor,
        request: { adminPhone },
        onPlan: (plan) => { previewed = plan; printPlan(plan); },
        onApplied: (result) => { applied = result; },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'APPROVALS_REQUIRED' && previewed && approvals.length === 0) {
        printRequest('This target is production: two different people must approve this plan.', planApprovalRequest(previewed as SeedPlan, spineRequestContext(adminPhone)));
        process.exit(2);
      }
      throw err;
    }
    if ((applied as ApplyResult | null)?.firstAdmin) {
      console.warn('SUPER_ADMIN minted by the signed plan for the given phone.');
    } else if (adminPhone) {
      const promotionApprovals = parseSignedApprovals(process.env['SEED_PROMOTION_APPROVALS'], 'SEED_PROMOTION_APPROVALS');
      try {
        const result = await promoteBootstrapAdmin(prisma, databaseUrl, adminPhone, { approvals: promotionApprovals, approverKeys, actor });
        console.warn(result.mode === 'already' ? 'The given phone already holds SUPER_ADMIN; nothing changed.'
          : `SUPER_ADMIN ${result.mode === 'bootstrap' ? 'bootstrapped' : 'promoted by break-glass'} for the given phone.`);
      } catch (err) {
        if ((err as { code?: string }).code === 'BREAK_GLASS_REQUIRED') {
          printRequest('A SUPER_ADMIN already exists: promoting another is a break-glass change two different people must approve.', await promotionApprovalRequest(prisma, databaseUrl, adminPhone));
          process.exit(3);
        }
        throw err;
      }
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
