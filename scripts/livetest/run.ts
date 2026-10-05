// Swift live golden-path harness — runner [SWIFT-081].
// Seeds the sanctioned roster through the real signup path, provisions vendors,
// runs the golden-path flows against a RUNNING API, prints a pass/fail summary,
// and exits non-zero on any failure. HTTP only — never touches the DB.
//
//   LIVETEST_BASE_URL=http://localhost:3000 LIVETEST_ADMIN_PHONE=+5920400000 npx tsx scripts/livetest/run.ts
//
// Requires DEV_OTP_BYPASS=1 on the target API (local/staging only — the boot
// guard forbids it in production).
//
// [TASK-057] `--suite=journeys` runs the 42 pilot-launch journeys instead
// (scripts/livetest/journeys/) and writes journeys-result.json +
// journeys-summary.md to LIVETEST_OUT_DIR. It first refuses any target that is
// not the private journeys instance (guard.ts), before its first write:
//
//   LIVETEST_BASE_URL=http://127.0.0.1:3291 LIVETEST_ADMIN_PHONE=+5920400000 \
//     apps/api/node_modules/.bin/tsx scripts/livetest/run.ts --suite=journeys [--only=AUTH-01,CUST-02]
//
// Every phone the suite uses is +5920… (never a subscriber); the run is refused
// before its first request otherwise (guard.ts gate p).
//
// Exit: 0 no journey failed · 1 a journey failed · 2 harness error · 3 target refused.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, ORIGIN, GET, login, type Session } from './client.js';
import { seedRoster } from './roster.js';
import { provisionVendors } from './provision.js';
import { runFlows } from './flows.js';
import { refusePublicTarget, refuseUnsafeIdentity, refuseLivePhones, TargetRefused } from './guard.js';
import { requireAdminPhone } from './provision.js';
import { fixturePhones } from './roster.js';
import { freshPhone } from './journeys/common.js';
import { UK_FICTIONAL } from './journeys/auth.js';

const log = (s: string) => console.log(s);

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

/** Gate (p) for both suites: every fixed and generated phone is +5920…, before any request. */
function refusePhones(): void {
  const sample = Array.from({ length: 20 }, (_, i) => freshPhone('guard', 'sample', i));
  const admins = [process.env.LIVETEST_ADMIN_PHONE, process.env.LIVETEST_ADMIN2_PHONE].filter((p): p is string => !!p && p.trim() !== '').map((p) => p.trim());
  refuseLivePhones([...fixturePhones(), ...sample, ...admins, UK_FICTIONAL('guard')], [UK_FICTIONAL('guard')]);
}

async function main() {
  refusePhones();
  // The seed admin is needed in Phase 2; require it before the first request, not after seeding.
  requireAdminPhone(process.env.LIVETEST_ADMIN_PHONE);
  log(`\nSwift live golden-path harness → ${BASE}\n`);

  log('Phase 1 — seed the 24-account roster (real signup path)');
  const roster = await seedRoster(log);

  log('\nPhase 2 — provision vendors (admin approve + menu + stock)');
  const provisioned = await provisionVendors(roster, log);

  log('\nPhase 3 — golden-path flows');
  const results = await runFlows(roster, provisioned, log);

  const pass = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok && !r.skip);
  const skip = results.filter((r) => r.skip);

  log('\n──────────────────────────────────────────');
  for (const r of results) {
    log(`  ${r.skip ? '○ SKIP' : r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  log('──────────────────────────────────────────');
  log(`  ${pass.length} passed · ${fail.length} failed · ${skip.length} cataloged (need live driver/redis setup)\n`);

  process.exit(fail.length > 0 ? 1 : 0);
}

async function journeys() {
  const runId = process.env.LIVETEST_RUN_ID || `local-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const outDir = process.env.LIVETEST_OUT_DIR || join(tmpdir(), 'swift-journeys', runId);
  log(`\nSwift pilot journeys → ${ORIGIN} (run ${runId})\n`);

  // Gate (p): no phone this suite uses can reach a real person.
  refusePhones();
  const adminPhone = requireAdminPhone(process.env.LIVETEST_ADMIN_PHONE);
  // Gate (a): by name, then by resolution — no request to a public target, ever.
  await refusePublicTarget(ORIGIN);
  // Gates (b) and (c): the admin signs in only after the route proved to exist.
  let admin: Session | null = null;
  const identity = await refuseUnsafeIdentity(
    { get: async (p, token) => { const r = await GET(p, token); return { status: r.status, json: r.json }; } },
    async () => { admin = await login(adminPhone); return admin.token; },
  );
  log(`Target identity: deployment ${identity.deploymentId} · environment ${identity.environment} · build ${identity.buildSha} · data ${identity.dataClassification}\n`);

  const { runJourneySuite } = await import('./journeys/index.js');
  const code = await runJourneySuite({ runId, outDir, identity, admin: admin!, adminPhone, only: arg('only'), log });
  process.exit(code);
}

const suite = arg('suite') ?? process.env.LIVETEST_SUITE ?? 'golden';
const entry = suite === 'journeys' ? journeys : suite === 'golden' ? main : null;
if (!entry) {
  console.error(`unknown --suite=${suite} (golden | journeys)`);
  process.exit(2);
}
entry().catch((e) => {
  if (e instanceof TargetRefused) {
    console.error(`\nREFUSED (${e.gate}): ${e.message}\n`);
    process.exit(3);
  }
  console.error('\nHARNESS ERROR:', e?.message ?? e);
  process.exit(2);
});
