/**
 * Deployment preflight: what would this deploy/.env actually do on boot?
 *
 * The whole point of this script is that it does NOT reimplement the boot
 * guards. It imports the real `assertSafeBootConfig` from
 * apps/api/src/utils/boot-config.ts and runs it against the env you are about
 * to deploy, with NODE_ENV forced to production. A reimplementation in bash
 * would drift from the guard the moment either changed, and a preflight that
 * says PASS where the server would refuse to start is worse than no preflight.
 *
 * TWO SECTIONS, AND THEY ARE NOT THE SAME KIND OF ANSWER:
 *
 *   THE VERDICT is authoritative. It is one call to the real guard against
 *   your unmodified env. If it says PASS, the server will not refuse to start
 *   on configuration. If it says FATAL, that is the exact message the server
 *   would print.
 *
 *   THE WALKTHROUGH is a preview, and it is labelled as one. The guard throws
 *   on the FIRST problem, so a single run tells you one thing at a time. To
 *   show the whole list, this re-runs the guard with each problem temporarily
 *   stubbed and collects what comes next. Those stubs are placeholders, never
 *   suggestions — they exist only to see past a failure, and the verdict above
 *   is always computed without them.
 *
 * Usage:  npx tsx deploy/preflight.ts [path/to/.env]     (default: deploy/.env)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBootConfig } from '../apps/api/src/utils/boot-config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envPath = process.argv[2] ?? path.join(HERE, '.env');

if (!existsSync(envPath)) {
  console.error(`FATAL: ${envPath} does not exist. Run ./deploy/gen-secrets.sh first.`);
  process.exit(1);
}

/** Minimal .env reader. Deliberately not dotenv: this script must run from a
 *  bare checkout before anything is installed. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Strip an inline comment only when the value is unquoted — a secret may
    // legitimately contain '#'.
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Placeholders that satisfy a guard so the walkthrough can see past it. NEVER
 *  deploy these — several are deliberately absurd so they cannot be mistaken
 *  for real configuration if someone copies this output into a file. */
const STUBS: Record<string, string> = {
  DEV_OTP_BYPASS: '0',
  OTP_HASH_SECRET: 'x'.repeat(48),
  JWT_SECRET: 'x'.repeat(48),
  KYC_PROVIDER: 'didit',
  DIDIT_API_KEY: 'STUB-NOT-A-REAL-KEY',
  ID_ANALYZER_API_KEY: 'STUB-NOT-A-REAL-KEY',
  PAYMENT_PROVIDER: 'powertranz',
  PAYMENT_GATEWAY_KEY: 'STUB-NOT-A-REAL-KEY',
  PAYMENT_GATEWAY_SECRET: 'STUB-NOT-A-REAL-KEY',
  POWERTRANZ_API_URL: 'https://stub.invalid/powertranz',
  STRIPE_SECRET_KEY: 'sk_live_STUB',
  MMG_DRIVER: 'live',
  MMG_API_KEY: 'STUB', MMG_MERCHANT_ID: 'STUB', MMG_MKEY: 'STUB',
  MMG_MSECRET: 'STUB', MMG_PASSWORD: 'STUB',
  MMG_API_URL: 'https://stub.invalid/mmg',
  NOTIFICATION_PROVIDER: 'twilio',
  PUSH_PROVIDER: 'expo',
  MASTER_KEK: Buffer.alloc(32, 7).toString('base64'),
  STORAGE_SIGNING_SECRET: 'x'.repeat(48),
  STORAGE_PROVIDER: 's3',
  CONSENT_IP_PEPPER: 'x'.repeat(48),
};

const fileEnv = readEnvFile(envPath);
const production = { ...fileEnv, NODE_ENV: 'production' };

function guardMessage(env: Record<string, string | undefined>): string | null {
  try {
    assertSafeBootConfig(env);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The variables a message is about — the guards name them in caps. */
function varsIn(message: string): string[] {
  return [...new Set(message.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [])]
    .filter((v) => v in STUBS);
}

console.log(`\nSwift deployment preflight — ${envPath}`);
console.log(`Evaluating as NODE_ENV=production against the real boot guard.\n`);

// ── THE WALKTHROUGH ────────────────────────────────────────────────────────
console.log('PROBLEMS, in the order the boot guard checks them');
console.log('─'.repeat(72));
const probe: Record<string, string | undefined> = { ...production };
const problems: string[] = [];
for (let i = 0; i < 40; i += 1) {
  const message = guardMessage(probe);
  if (!message) break;
  problems.push(message);
  const targets = varsIn(message);
  if (targets.length === 0) {
    console.log(`  ✗ ${message}`);
    console.log('    (no stubbable variable in this message — the walkthrough stops here)');
    break;
  }
  console.log(`  ✗ ${message}`);
  for (const v of targets) probe[v] = STUBS[v];
}
if (problems.length === 0) console.log('  none — the guard is satisfied by this file as written');
console.log('');

// ── THE INVENTORY ──────────────────────────────────────────────────────────
const WATCHED = Object.keys(STUBS).sort();
console.log('VARIABLES THE GUARD READS');
console.log('─'.repeat(72));
for (const v of WATCHED) {
  const present = fileEnv[v] !== undefined && fileEnv[v] !== '';
  console.log(`  ${present ? 'PRESENT' : 'MISSING'.padEnd(7)}  ${v}`);
}
console.log('');

// ── BACKUP READINESS ───────────────────────────────────────────────────────
// Deliberately separate from the boot guard: a server with no offsite backup
// still starts, and should. But "it started" is not the question anyone asks
// after a disk fails, so this gets read before going live rather than after.
console.log('BACKUPS');
console.log('─'.repeat(72));
{
  const bucket = fileEnv['BACKUP_BUCKET'];
  const endpoint = fileEnv['AWS_S3_ENDPOINT'];
  const keyId = fileEnv['AWS_ACCESS_KEY_ID'];
  if (!bucket) {
    console.log('  ✗ BACKUP_BUCKET is not set.');
    console.log('    Dumps will be written to the same machine they back up. One disk');
    console.log('    failure loses the database AND every backup of it. That is a copy,');
    console.log('    not a backup.');
  } else if (!endpoint || !keyId) {
    console.log(`  ✗ BACKUP_BUCKET is ${bucket} but the S3 credentials are incomplete.`);
    console.log('    backup.sh will exit non-zero rather than pretend it succeeded.');
  } else {
    console.log(`  ✓ offsite target configured (${bucket})`);
    console.log('    backup.sh verifies the upload byte-for-byte before calling a run good.');
  }
  console.log('');
  console.log('  Neither this check nor backup.sh covers two things that lose documents:');
  console.log('    - the object-storage bucket holding KYC files (version it separately)');
  console.log('    - MASTER_KEK, without which restored documents stay ciphertext forever');
  console.log('');
  console.log('  And a backup is not real until restore.sh has restored from it.');
  console.log('  Rehearse once, with a stopwatch. That number is your recovery time.');
}
console.log('');

// ── THE VERDICT ────────────────────────────────────────────────────────────
// Computed against the UNMODIFIED env. No stub can influence this line.
const verdict = guardMessage(production);
console.log('VERDICT (the real guard, your file, nothing stubbed)');
console.log('─'.repeat(72));
if (verdict === null) {
  console.log('  PASS — this configuration will not be refused at boot.');
  console.log('');
  console.log('  Note what this does NOT say: it does not say the credentials are');
  console.log('  valid, only that they are present and shaped correctly. It also');
  console.log('  does not cover assertProductionData(), which refuses to start on a');
  console.log('  database with zero CountryConfig rows — seed the platform spine');
  console.log('  with prisma/seed-production.ts.');
  process.exit(0);
}
console.log(`  REFUSED — the server would print this and stop:\n`);
console.log(`    ${verdict}\n`);
console.log(`  ${problems.length} problem(s) found in total. Fix them and re-run.`);
process.exit(1);
