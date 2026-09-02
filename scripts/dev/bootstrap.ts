/**
 * The developer database bootstrap [INF-002].
 *
 * A thin CLI over `apps/api/src/modules/ops/bootstrap-plan.ts`, which holds the
 * proof, the decisions and their tests. Four separate stages, each with a dry
 * run, each proving its target BEFORE the first SQL statement and asking for a
 * typed confirmation naming the database. No stage authors schema: `migrate`
 * applies the immutable checked-in migration set with `prisma migrate deploy`
 * and nothing else.
 *
 *   verify              read-only: prints every proof and the decision each stage would reach
 *   create              as the OWNER (the one owner stage): stamps the disposable marker on an EMPTY
 *                       database, installs the extensions only a superuser may, provisions the
 *                       least-privilege `swift_bootstrap` login
 *   migrate             as `swift_bootstrap`: applies the checked-in set; resumes a partial history;
 *                       refuses a failed or unknown one
 *   seed                as `swift_bootstrap`: the idempotent demo dataset, only on a fully migrated
 *                       database; records the deployment identity
 *
 * Run from apps/api (where @prisma/client resolves):
 *   SWIFT_DEV_BOOTSTRAP=YES DATABASE_URL=postgresql://swift:…@localhost:5434/swift \
 *     npx tsx ../../scripts/dev/bootstrap.ts verify
 *   … create   (DATABASE_URL = the owner; SWIFT_BOOTSTRAP_PASSWORD = the login it provisions)
 *   … migrate  (SWIFT_BOOTSTRAP_URL = postgresql://swift_bootstrap:…@localhost:5434/swift)
 *   … seed
 *   add --dry-run to any stage to see the proof and the plan without confirming or running anything.
 *
 * Every stage appends to ~/.swift/bootstrap-journal.jsonl (override: SWIFT_BOOTSTRAP_JOURNAL);
 * the journal never carries a connection string.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  BootstrapRefused, STAGES, appendJournal, checkedInMigrations, defaultJournalPath, runStage, seedVersion, type Stage } from '../../apps/api/src/modules/ops/bootstrap-plan';
import { prismaRawClient } from '../../apps/api/scripts/dev/bootstrap-raw-client';



const argv = process.argv.slice(2);
const stage = (argv.find((a) => !a.startsWith('--')) ?? 'verify') as Stage;
if (!STAGES.includes(stage)) { console.error(`usage: bootstrap.ts <${STAGES.join('|')}> [--dry-run]`); process.exit(2); }
const dryRun = argv.includes('--dry-run');
const apiDir = process.cwd();
const journalPath = defaultJournalPath();

const ownerUrl = process.env['DATABASE_URL'] ?? '';
const bootstrapUrl = process.env['SWIFT_BOOTSTRAP_URL'] ?? '';
const url = stage === 'migrate' || stage === 'seed' ? bootstrapUrl : ownerUrl;
if (!url) {
  console.error(stage === 'migrate' || stage === 'seed'
    ? 'SWIFT_BOOTSTRAP_URL is required: migrate and seed run only as the least-privilege swift_bootstrap login that `create` provisions'
    : 'DATABASE_URL is required');
  process.exit(2);
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const result = await runStage(stage, {
    env: process.env,
    url,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    connect: prismaRawClient,
    exec: (args, env) => { execFileSync('npx', args, { cwd: apiDir, stdio: 'inherit', env: { ...process.env, ...env } }); },
    confirm: ask,
    checkedIn: checkedInMigrations(join(apiDir, 'prisma', 'migrations')),
    journal: (entry) => appendJournal(journalPath, entry),
    seedVersion: seedVersion(apiDir),
    dryRun,
  });
  const t = result.target;
  console.log(`\n=== Swift developer bootstrap · ${stage}${dryRun ? ' (dry run)' : ''} ===`);
  console.log(`target     ${t.host}:${t.port}/${t.database} as ${result.probe.role.name}${result.probe.role.superuser ? ' (superuser)' : ''}${result.probe.role.owner ? ' (owner)' : ''}`);
  console.log(`marker     ${result.probe.marker ?? '(absent)'}`);
  console.log(`schema     ${result.fingerprint.state} — ${result.fingerprint.detail}`);
  console.log(`decision   ${result.decision.code}${result.decision.reasons.length ? ` — ${result.decision.reasons.join('; ')}` : ''}`);
  if (result.commands.length) console.log(`${dryRun ? 'would run ' : 'ran       '}${result.commands.map((c) => c.join(' ')).join(' · ')}`);
  console.log(`journal    ${journalPath}`);
  if (stage === 'verify' && result.decision.reasons.length) process.exitCode = 2;
}

main().catch((err) => {
  if (err instanceof BootstrapRefused) { console.error(`\n✖ refused ${err.message}`); process.exit(1); }
  console.error(err); process.exit(1);
});
