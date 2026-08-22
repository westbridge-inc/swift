/**
 * DCR-SC-01 — THE DPA READINESS SCORECARD.
 *
 * `pnpm dpa:readiness` — LIVE checks, no cached statuses, prints the table,
 * exits non-zero on RED. Nightly CI and ad hoc.
 *
 * Why this exists: DCR-1 has five non-retrofittable gates plus the
 * commencement watch, and "which of them are actually done?" has been a
 * question answered from memory and from a register file. That is exactly the
 * kind of answer that drifts. This turns it into a command whose output is
 * derived from the database and the code, every time it runs.
 *
 * Two rules it holds itself to, because a scorecard that lies is worse than no
 * scorecard:
 *
 *   1. **NO PARALLEL LOGIC.** Where a gate has an implementation, this reads
 *      the same models and constants that implementation uses. It must never
 *      grow a second, subtly-different definition of "green" that then
 *      disagrees with the product.
 *   2. **NOT-IMPLEMENTED IS NOT GREEN, AND IT IS NOT RED EITHER.** A gate with
 *      no implementation reports `ABSENT` in its own colour. Reporting it green
 *      would be a lie; reporting it red would be indistinguishable from a gate
 *      that exists and is failing, which is a different and more urgent thing.
 *
 * Exit codes, per the spec: 0 = all green · 1 = YELLOW (CI warns) ·
 * 2 = RED (CI fails). Any NR row not GREEN prints `LAUNCH GATE: BLOCKED`.
 */
import { PrismaClient } from '@prisma/client';
import { RETENTION_DEFAULTS } from '../src/modules/compliance/retention.service';

const prisma = new PrismaClient();

type Colour = 'GREEN' | 'YELLOW' | 'RED' | 'ABSENT';

interface Row {
  /** NR-1 … NR-5, CW, PACK, FOUNDER, LEGAL */
  gate: string;
  colour: Colour;
  /** The measured facts behind the colour. Never prose-only. */
  detail: string;
  /** True for the five non-retrofittable gates: any non-GREEN blocks launch. */
  nonRetrofittable: boolean;
}

const rows: Row[] = [];
const add = (gate: string, colour: Colour, detail: string, nonRetrofittable = false) =>
  rows.push({ gate, colour, detail, nonRetrofittable });

/** A check that throws is RED with its reason — never a silent skip. */
async function check(gate: string, nonRetrofittable: boolean, fn: () => Promise<[Colour, string]>) {
  try {
    const [colour, detail] = await fn();
    add(gate, colour, detail, nonRetrofittable);
  } catch (err) {
    add(gate, 'RED', `check itself failed: ${(err as Error).message}`, nonRetrofittable);
  }
}

async function main() {
  const now = Date.now();

  // ── NR-1 · THE CONSENT LEDGER ────────────────────────────────────────────
  await check('NR-1 consent ledger', true, async () => {
    const total = await prisma.consentRecord.count();
    if (total === 0) return ['YELLOW', 'ledger present, ZERO records — nothing has been captured yet'];
    // A record with no content hash cannot prove WHICH document was agreed to.
    const unhashed = await prisma.consentRecord.count({ where: { OR: [{ documentContentHash: '' }, { documentVersion: '' }] } });
    if (unhashed > 0) return ['RED', `${unhashed}/${total} records cannot prove which document version was agreed to`];
    const docTypes = (await prisma.consentRecord.groupBy({ by: ['documentType'] })).map((d) => d.documentType);
    return ['GREEN', `${total} records · 0 unhashed/draft · documentTypes: ${docTypes.join(', ') || 'none'}`];
  });

  // ── NR-2 · RETENTION CLOCKS ──────────────────────────────────────────────
  await check('NR-2 retention clocks', true, async () => {
    const policies = await prisma.retentionPolicy.count();
    const expected = RETENTION_DEFAULTS.length; // reused, not re-derived
    if (policies === 0) return ['RED', `0 retention policies seeded; ${expected} defaults are defined in retention.service`];
    const newest = await prisma.retentionSweepReceipt.findFirst({ orderBy: { ranAt: 'desc' }, select: { ranAt: true, dataClass: true } });
    if (!newest) return ['YELLOW', `${policies}/${expected} policies present but the sweep has NEVER run — clocks exist, nothing enforces them`];
    const ageH = (now - newest.ranAt.getTime()) / 3_600_000;
    if (ageH > 25) return ['RED', `${policies}/${expected} policies · newest sweep receipt is ${ageH.toFixed(1)}h old (>25h)`];
    return ['GREEN', `${policies}/${expected} policies · newest sweep ${ageH.toFixed(1)}h ago (${newest.dataClass})`];
  });

  // ── NR-3 · DELETION THAT DELETES ─────────────────────────────────────────
  await check('NR-3 deletion', true, async () => {
    // The account-deletion path exists (account.service); what is NOT yet
    // present is a durable deletion RECEIPT table, which is what the spec's
    // "receipts complete last 5" row measures.
    const hasReceipts = 'deletionReceipt' in prisma;
    if (!hasReceipts) {
      return ['ABSENT', 'deletion path exists in account.service, but no durable deletion-receipt store — "receipts complete last 5" is unmeasurable'];
    }
    return ['YELLOW', 'receipt store present; cascade + sole-path checks not yet wired into this scorecard'];
  });

  // ── NR-4 · THE RESTRICTED STORE ──────────────────────────────────────────
  await check('NR-4 restricted store', true, async () => {
    // Special-category isolation. IDV-1 (#39) is its build spec.
    const models = Object.keys(prisma).filter((k) => !k.startsWith('$') && !k.startsWith('_'));
    const hasStore = models.some((m) => /restricted|specialCategory|identityVault/i.test(m));
    if (!hasStore) return ['ABSENT', 'no restricted/special-category store exists; IDV-1 (#39) is its build spec — NOT started'];
    return ['YELLOW', 'store present; app-role denial and access-log 1:1 not yet wired into this scorecard'];
  });

  // ── NR-5 · MINIMISATION AT CAPTURE ───────────────────────────────────────
  await check('NR-5 minimisation', true, async () => {
    const { CAPTURE_ALLOWLISTS } = await import('../src/modules/compliance/capture-allowlists');
    const surfaces = Object.keys(CAPTURE_ALLOWLISTS ?? {});
    if (surfaces.length === 0) return ['RED', 'capture allowlist is empty — nothing constrains what is collected'];
    return ['GREEN', `${surfaces.length} capture surfaces allow-listed: ${surfaces.slice(0, 6).join(', ')}${surfaces.length > 6 ? ' …' : ''}`];
  });

  // ── CW · COMMENCEMENT WATCH ──────────────────────────────────────────────
  await check('CW commencement watch', false, async () => {
    const lastRun = await prisma.cwRun.findFirst({ orderBy: { ranAt: 'desc' }, select: { ranAt: true, sourceId: true, error: true } });
    if (!lastRun) return ['YELLOW', 'watch is implemented but has NEVER run — a watch that has not run is not watching'];
    const ageH = (now - lastRun.ranAt.getTime()) / 3_600_000;
    const degraded = await prisma.cwAlert.count({ where: { eventType: 'WATCH_DEGRADED', acknowledgedBy: null } });
    const pending = await prisma.cwAlert.count({ where: { notifiedAt: null } });
    if (ageH > 7) return ['RED', `last scan ${ageH.toFixed(1)}h ago (>7h) · ${degraded} unacked degraded · ${pending} un-notified`];
    if (degraded > 0) return ['RED', `${degraded} UNACKNOWLEDGED degraded-watch alerts · last scan ${ageH.toFixed(1)}h ago`];
    return ['GREEN', `last scan ${ageH.toFixed(1)}h ago (${lastRun.sourceId}) · 0 degraded · ${pending} pending notify`];
  });

  // ── PACK · REGISTRATION PACK ─────────────────────────────────────────────
  await check('PACK registration', false, async () => ['ABSENT', 'registration pack (Part IV) not started — no artefact store to measure']);

  // ── FOUNDER DECISIONS ────────────────────────────────────────────────────
  await check('FOUNDER decisions', false, async () => {
    // FD-R1 (attorney) is the long pole and is explicitly open.
    return ['YELLOW', 'FD-R1 attorney engagement OPEN (the long pole) · FD-R2..R7 not individually tracked in-system'];
  });

  // ── OUTPUT ───────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  const ICON: Record<Colour, string> = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴', ABSENT: '⚪' };

  console.log('\nDPA READINESS SCORECARD — live, uncached\n');
  console.log(`${pad('GATE', 26)} ${pad('STATE', 8)} DETAIL`);
  console.log('─'.repeat(110));
  for (const r of rows) {
    console.log(`${pad(r.gate, 26)} ${ICON[r.colour]} ${pad(r.colour, 6)} ${r.detail}`);
  }

  const nr = rows.filter((r) => r.nonRetrofittable);
  const blocked = nr.filter((r) => r.colour !== 'GREEN');
  const red = rows.some((r) => r.colour === 'RED');
  const yellow = rows.some((r) => r.colour === 'YELLOW' || r.colour === 'ABSENT');

  console.log('');
  if (blocked.length > 0) {
    console.log(`LAUNCH GATE: BLOCKED — ${blocked.length}/${nr.length} non-retrofittable gates are not GREEN:`);
    for (const r of blocked) console.log(`  · ${r.gate} — ${r.colour}`);
  } else {
    console.log(`LAUNCH GATE: all ${nr.length} non-retrofittable gates GREEN.`);
  }
  console.log('\n⚪ ABSENT means NOT BUILT. It is deliberately not green (that would be a lie) and');
  console.log('   not red (which would be indistinguishable from a built gate that is failing).');
  console.log('\nREADING THIS ON A DEV RIG: staleness rows (NR-2 sweep age, CW scan age) go RED');
  console.log('   because a rig has no continuously-running cron, not because the mechanism is');
  console.log('   broken. That is correct behaviour — the check measures whether the clock is');
  console.log('   ACTUALLY being wound, and on a rig it is not. Judge those two rows against');
  console.log('   production; judge the ABSENT rows anywhere, because nothing built them.');

  process.exitCode = red ? 2 : yellow ? 1 : 0;
  console.log(`\nexit ${process.exitCode} (0 all-green · 1 yellow/absent · 2 red)`);
}

main()
  .catch((e) => { console.error('SCORECARD FAILED:', e.message); process.exitCode = 2; })
  .finally(() => prisma.$disconnect());
