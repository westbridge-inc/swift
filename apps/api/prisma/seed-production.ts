import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { desiredPlatformConfig, seedPlatformSpine } from './seed-platform';
import { spineRequestContext } from '../src/modules/ops/platform-config';
import {
  cancelSoloReseeds, planApprovalRequest, promoteBootstrapAdmin, promotionApprovalRequest, SOLO_RESEED_CODE_TTL_MS, startSoloReseed, unsetEmptyChannelSettings, type ApplyResult, type SeedPlan,
} from '../src/modules/ops/seed-plan';
import { parseSignedApprovals, SOLO_COOLING_OFF_MS } from '../src/modules/ops/approver-signatures';

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
 *   [SOLO SEED] While there is no second admin (owner ruling 13 Oct), the
 *      seed that mints the FIRST SUPER_ADMIN may instead be approved by ONE
 *      pinned person: SEED_SOLO=1 prints a solo request (it says so in the
 *      words signed, valid 48 hours), and the run with its one line is
 *      refused until 12 hours after the request was issued. Solo never
 *      covers anything else; the signed record is kept in the audit.
 *   [SOLO RE-SEED] Owner ruling 26 Oct (D1, under 30 Sep #13 SOLO MODE):
 *      while the owner is the ONLY admin, a LATER re-seed may be approved by
 *      them alone. With a SUPER_ADMIN on the database, SEED_SOLO=1 prints a
 *      solo re-seed request (its own words; exit 2). Run with its one signed
 *      line, it STARTS a 12-hour wait and emails and texts the owner (exit 4).
 *      The same run before the wait ends is refused (COOLING_OFF); after it,
 *      the admins are counted again, a sign-in code is texted to the owner's
 *      phone and read back from this terminal, and the plan applies, emailing
 *      and texting the owner. SEED_SOLO_CANCEL=1 cancels every waiting solo
 *      re-seed (exit 0). A second admin turns all of this off: two people.
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

/** [SOLO SEED] The one-person request, and when its single line may run. */
function printSoloRequest(request: string): void {
  const issued = /^issued: (.+)$/m.exec(request)?.[1] ?? '';
  const expires = /^expires: (.+)$/m.exec(request)?.[1] ?? '';
  const runsFrom = new Date(Date.parse(issued) + SOLO_COOLING_OFF_MS).toISOString();
  console.warn(`\nSolo mode (there is no second admin yet): ONE approval mints the first SUPER_ADMIN. The approver saves the request below (between the lines) to a file and signs it on their own computer:\n  ./deploy/seed-approve.sh <their-name> <their-key> < request.txt\nThen, no earlier than 12 hours after it was issued (from ${runsFrom}) and before ${expires}, re-run with SEED_SOLO=1 and the one printed line. Keep the request and the line with the seed evidence.\n-----`);
  process.stdout.write(request);
  console.warn('-----');
}

/** SEED_SOLO: exactly 1 (solo), or unset/empty (the two-person ceremony). */
function soloMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  if (raw === '1') return true;
  throw new Error('SEED_SOLO must be exactly 1 (solo: one approver, 12-hour cooling-off) or unset; refusing to guess');
}

/** [SOLO RE-SEED] SEED_SOLO_CANCEL: exactly 1 (cancel every waiting solo re-seed), or unset/empty. */
function soloCancelMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  if (raw === '1') return true;
  throw new Error('SEED_SOLO_CANCEL must be exactly 1 (cancel every waiting solo re-seed) or unset; refusing to guess');
}

/** [SOLO RE-SEED] The one-person re-seed request, and what happens next. */
function printSoloReseedRequest(request: string): void {
  const expires = /^expires: (.+)$/m.exec(request)?.[1] ?? '';
  console.warn(`\nSolo re-seed (you are the only admin): ONE approval, a 12-hour wait, then a sign-in code. The approver saves the request below (between the lines) to a file and signs it on their own computer:\n  ./deploy/seed-approve.sh <their-name> <their-key> < request.txt\nThen re-run with SEED_SOLO=1 and the one printed line: that run STARTS the 12-hour wait and emails and texts you (exit 4). After the wait, and before ${expires}, the same command applies it with a sign-in code texted to your phone. SEED_SOLO_CANCEL=1 cancels it until then.\n-----`);
  process.stdout.write(request);
  console.warn('-----');
}

/** [SOLO RE-SEED] One line typed on this terminal (seed-production.sh keeps it
 *  off the screen), or '' at the end of input or after five minutes. */
function readSignInCode(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let done = false;
    const finish = (line: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      process.stdin.destroy();
      process.stderr.write('\n');
      resolve(line);
    };
    const timer = setTimeout(() => finish(''), SOLO_RESEED_CODE_TTL_MS);
    rl.once('line', finish);
    rl.once('close', () => finish(''));
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const approverKeys = process.env['SEED_APPROVER_KEYS'];
  const approvals = parseSignedApprovals(process.env['SEED_PLAN_APPROVALS'], 'SEED_PLAN_APPROVALS');
  const actor = process.env['SEED_ACTOR'] ?? 'seed-production';
  const adminPhone = process.env['SEED_ADMIN_PHONE'] || null;
  // [OWNER EMAIL] Typed by the owner at seed-production.sh's hidden prompt; never printed.
  const adminEmail = process.env['SEED_ADMIN_EMAIL']?.trim() || null;
  const solo = soloMode(process.env['SEED_SOLO']);
  const cancel = soloCancelMode(process.env['SEED_SOLO_CANCEL']);
  // [SOLO RE-SEED] Compose hands an unset notification setting over as an empty string: unset it (seed-plan.ts).
  unsetEmptyChannelSettings(process.env);
  try {
    // [SOLO RE-SEED] The brake: needs no approval, no code and no plan.
    if (cancel) {
      const cancelled = await cancelSoloReseeds(prisma, databaseUrl, { actor });
      const n = cancelled.length;
      console.warn(n === 0 ? 'No solo re-seed was waiting; nothing changed.' : `Cancelled ${n} waiting solo re-seed${n === 1 ? '' : 's'}: ${n === 1 ? 'it' : 'they'} never run. A new one needs a new signed request.`);
      for (const c of cancelled) console.warn(`  cancelled: config ${c.configVersion} (${c.changes} change${c.changes === 1 ? '' : 's'}, plan ${c.plan.slice(0, 12)}), signed by ${c.approver}, started ${c.startedAt}, would have run from ${c.eligibleAt}`);
      return;
    }
    // [SOLO RE-SEED] With a SUPER_ADMIN on the database, solo is the solo re-seed (its own words).
    const reseed = solo && (await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0;
    console.warn('Seeding PRODUCTION spine (no demo data)…');
    let previewed: SeedPlan | null = null;
    let applied: ApplyResult | null = null;
    try {
      await seedPlatformSpine(prisma, {
        databaseUrl,
        approvals,
        approverKeys,
        actor,
        request: { adminPhone, adminEmail, solo: solo && !reseed, soloReseed: reseed },
        ...(reseed ? { readSignInCode } : {}),
        onPlan: (plan) => { previewed = plan; printPlan(plan); },
        onApplied: (result) => { applied = result; },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'APPROVALS_REQUIRED' && previewed && approvals.length === 0) {
        if (reseed) printSoloReseedRequest(planApprovalRequest(previewed as SeedPlan, spineRequestContext(adminPhone, false, adminEmail, true)));
        else if (solo) printSoloRequest(planApprovalRequest(previewed as SeedPlan, spineRequestContext(adminPhone, true, adminEmail)));
        else printRequest('This target is production: two different people must approve this plan.', planApprovalRequest(previewed as SeedPlan, spineRequestContext(adminPhone, false, adminEmail)));
        process.exit(2);
      }
      // [SOLO RE-SEED] The signed line of a re-seed that has not started: start its 12-hour wait.
      if (code === 'SOLO_NOT_STARTED' && reseed && previewed) {
        const started = await startSoloReseed(prisma, databaseUrl, desiredPlatformConfig(), previewed as SeedPlan, { approvals, approverKeys, actor, request: spineRequestContext(adminPhone, false, adminEmail, true) });
        console.warn(`\nSolo re-seed STARTED: the owner was emailed and texted. It may run from ${started.eligibleAt.toISOString()} (12 hours from now) until ${started.expiresAt.toISOString()}: run the same command again then, in the owner's own terminal, and type the sign-in code texted to the owner's phone. Nothing changed yet. To cancel: SEED_SOLO_CANCEL=1 ./deploy/seed-production.sh <sha>`);
        process.exit(4);
      }
      throw err;
    }
    if (reseed && (applied as ApplyResult | null)) console.warn('Solo re-seed applied with the sign-in code; the owner was emailed and texted.');
    if ((applied as ApplyResult | null)?.firstAdmin) {
      console.warn(`SUPER_ADMIN minted by the signed plan for the given phone${solo ? ' (solo approval)' : ''}.${adminEmail ? " The owner's email is on that account." : ''}`);
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
