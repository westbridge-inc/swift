// Swift live golden-path harness — runner [SWIFT-081].
// Seeds the sanctioned roster through the real signup path, provisions vendors,
// runs the golden-path flows against a RUNNING API, prints a pass/fail summary,
// and exits non-zero on any failure. HTTP only — never touches the DB.
//
//   LIVETEST_BASE_URL=http://localhost:3000 npx tsx scripts/livetest/run.ts
//
// Requires DEV_OTP_BYPASS=1 on the target API (local/staging only — the boot
// guard forbids it in production).

import { BASE } from './client.js';
import { seedRoster } from './roster.js';
import { provisionVendors } from './provision.js';
import { runFlows } from './flows.js';

const log = (s: string) => console.log(s);

async function main() {
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

main().catch((e) => { console.error('\nHARNESS ERROR:', e?.message ?? e); process.exit(2); });
