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
 *   ON THE CONFIGURATION THIS SCRIPT CHECKS — it does NOT run the
 *   database-dependent tenant-wall gate (`assertTenantWall`), which reads the
 *   live connection's posture at boot and can refuse on
 *   TENANT_WALL_EXPAND_ATTESTED / TENANT_RLS_BIND / TENANT_UNSCOPED_ACCESS.
 *   A PASS here is not a promise about that gate. [REPORT-111 P0.3]
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
 * SECRETS ARE NOT IN THE FILE. deploy/.env holds settings; every secret lives
 * in the encrypted host store and reaches the app as NAME_FILE=/run/secrets/NAME
 * (apps/api/src/utils/secret-files.ts). This script runs the SAME loader: a
 * NAME_FILE line in the candidate file is honoured, and `--secrets-dir DIR`
 * wires DIR/NAME for every allowlisted name present there, exactly as Compose
 * does. Without it, store-held secrets read as MISSING here — which is true of
 * the file, and not of the server. On the host, run it as root against
 * /run/swift-secrets.
 *
 * Usage:  npx tsx deploy/preflight.ts [path/to/.env] [--secrets-dir DIR]     (default: deploy/.env)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSafeBootConfig } from '../apps/api/src/utils/boot-config';
import { SECRET_FILE_NAMES, applySecretFiles, assembleDatabaseUrl } from '../apps/api/src/utils/secret-files';
import { bucketVersioningStatus, kekEscrowStatus, parseBucketVersioning } from '../apps/api/src/modules/ops/document-durability';
import { darkFeatureStatus } from '../apps/api/src/modules/ops/dark-features';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.join(HERE, '.env');
let secretsDir: string | null = null;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i] as string;
  if (arg === '--secrets-dir') {
    secretsDir = process.argv[i + 1] ?? null;
    i += 1;
    if (!secretsDir) {
      console.error('FATAL: --secrets-dir needs a directory.');
      process.exit(2);
    }
  } else {
    envPath = arg;
  }
}

if (!existsSync(envPath)) {
  console.error(`FATAL: ${envPath} does not exist. Run ./deploy/gen-secrets.sh first.`);
  process.exit(1);
}

/** Minimal .env reader. Deliberately not dotenv: this script must run from a
 *  bare checkout before anything is installed. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const literalTwilioFields = new Set(['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID']);
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const sourceLine = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Strip an inline comment only when the value is unquoted — a secret may
    // legitimately contain '#'.
    // Identity syntax is literal: do not hide padding before the boot guard.
    let value = literalTwilioFields.has(key)
      ? sourceLine.slice(sourceLine.indexOf('=') + 1)
      : line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = literalTwilioFields.has(key) ? value.slice(0, hash) : value.slice(0, hash).trim();
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
  PAYMENT_PROVIDER: 'disabled',
  CARD_RAIL_KILL: '1',
  PAYMENT_GATEWAY_KEY: 'STUB-NOT-A-REAL-KEY',
  PAYMENT_GATEWAY_SECRET: 'STUB-NOT-A-REAL-KEY',
  POWERTRANZ_API_URL: 'https://stub.invalid/powertranz',
  STRIPE_SECRET_KEY: 'sk_live_STUB',
  MMG_DRIVER: 'live',
  MMG_API_KEY: 'STUB', MMG_MERCHANT_ID: 'STUB', MMG_MKEY: 'STUB',
  MMG_MSECRET: 'STUB', MMG_PASSWORD: 'STUB',
  MMG_API_URL: 'https://stub.invalid/mmg',
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'STUB-NOT-A-REAL-SECRET',
  TWILIO_FROM: '+15550000000',
  PUSH_PROVIDER: 'expo',
  MASTER_KEK: Buffer.alloc(32, 7).toString('base64'),
  STORAGE_SIGNING_SECRET: 'x'.repeat(48),
  STORAGE_PROVIDER: 's3',
  CONSENT_IP_PEPPER: 'x'.repeat(48),
};

const fileEnv: Record<string, string | undefined> = readEnvFile(envPath);
// The store, wired the way Compose wires it: DIR/NAME → NAME_FILE for every
// allowlisted name present in DIR. Then the real loader, with its real
// refusals — a refusal here is the exact message the server would print.
if (secretsDir) {
  for (const name of SECRET_FILE_NAMES) {
    const candidate = path.join(secretsDir, name);
    if (fileEnv[`${name}_FILE`] === undefined && existsSync(candidate)) fileEnv[`${name}_FILE`] = candidate;
  }
}
let fromStore: string[] = [];
try {
  fromStore = applySecretFiles(fileEnv);
  assembleDatabaseUrl(fileEnv);
} catch (error) {
  console.error(`FATAL (secret files, before any guard): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
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
console.log(`Evaluating as NODE_ENV=production against the real boot guard.`);
if (secretsDir) {
  console.log(`Secrets from ${secretsDir}: ${fromStore.length} loaded through the *_FILE loader.\n`);
} else {
  console.log('No --secrets-dir: store-held secrets are not in this file and read as MISSING below.\n');
}

// ── THE WALKTHROUGH ────────────────────────────────────────────────────────
console.log('PROBLEMS, in the order the boot guard checks them');
console.log('─'.repeat(72));
const probe: Record<string, string | undefined> = { ...production };
const problems: string[] = [];
for (let i = 0; i < 40; i += 1) {
  const message = guardMessage(probe);
  if (!message) break;
  // Stubs only ADD values, so a refusal caused by two variables both being
  // set (the exactly-one Twilio sender rule) cannot be "seen past". Stop on
  // the first repeat instead of echoing the same problem 40 times.
  if (problems.includes(message)) break;
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
  const source = fromStore.includes(v) ? 'STORE  ' : present ? 'PRESENT' : 'MISSING';
  console.log(`  ${source}  ${v}`);
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
    console.log('    backup.sh checks the remote object length; a restore drill proves contents.');
  }
  console.log('');
  // [D-4] A database dump does not save the documents. Two controls, graded:
  // the object bucket must be versioned, and the escrowed KEK must be THIS key.
  console.log('  Documents (not in any database dump):');
  const printVerdict = (v: { ok: boolean; line: string; detail?: string[] }) => {
    console.log(`  ${v.ok ? '✓' : '✗'} ${v.line}`);
    for (const d of v.detail ?? []) console.log(`      ${d}`);
  };
  const storage = fileEnv['STORAGE_PROVIDER'] ?? 'local';
  const objectBucket = fileEnv['AWS_S3_BUCKET'];
  if (storage === 'local') {
    console.log('  ✗ STORAGE_PROVIDER=local — KYC documents would live on this disk, outside every backup.');
  } else if (!objectBucket || !endpoint || !keyId) {
    console.log(`  ✗ STORAGE_PROVIDER=${storage} but AWS_S3_BUCKET / endpoint / credentials are incomplete.`);
  } else {
    const probe = spawnSync('aws', ['s3api', 'get-bucket-versioning', '--bucket', objectBucket, '--endpoint-url', endpoint, '--output', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: fileEnv['AWS_SECRET_ACCESS_KEY'] ?? '', AWS_REGION: fileEnv['AWS_REGION'] ?? 'auto' },
    });
    if (probe.error || probe.status !== 0) {
      console.log(`  ✗ could not ask ${objectBucket} about versioning (${probe.error ? 'aws CLI not installed' : (probe.stderr || '').trim().split('\n')[0]}).`);
      console.log('      Versioning is what lets a deleted or overwritten KYC document be recovered. Verify it by hand.');
    } else {
      printVerdict(bucketVersioningStatus(objectBucket, endpoint, parseBucketVersioning(probe.stdout)));
    }
  }
  printVerdict(kekEscrowStatus(fileEnv));
  console.log('');
  console.log('  And a backup is not real until restore.sh has restored from it.');
  console.log('  Rehearse once, with a stopwatch. That number is your recovery time.');
}
console.log('');

// ── SWITCHED OFF, AND IT WILL NOT TELL YOU ─────────────────────────────────
// The verdict below covers everything the boot guard REFUSES over. This
// section covers the opposite failure: capabilities that are configured off,
// start cleanly, and quietly render a fallback. Nothing here stops a deploy —
// it is printed because the alternative is finding out from a founder opening
// the app, which is how both of the examples in dark-features.ts were found.
{
  const rows = darkFeatureStatus(production).filter((r) => r.source === 'env');
  const off = rows.filter((r) => !r.on);
  console.log('SWITCHED OFF (starts fine; nothing will report these)');
  console.log('─'.repeat(72));
  if (off.length === 0) {
    console.log('  Every env-gated capability in the register is on.');
  } else {
    for (const f of off) {
      console.log(`  ${f.title}  [${f.setting}]`);
      console.log(`    ${f.whileOff}`);
    }
  }
  const configRows = darkFeatureStatus(production).filter((r) => r.source === 'config');
  if (configRows.length > 0) {
    console.log('');
    console.log('  Database-held switches this file cannot read (check PlatformConfig):');
    for (const f of configRows) console.log(`    ${f.setting} — ${f.title}`);
  }
  console.log('');
}

// ── THE VERDICT ────────────────────────────────────────────────────────────
// Computed against the UNMODIFIED env. No stub can influence this line.
const verdict = guardMessage(production);
console.log('VERDICT (the real guard, your file, nothing stubbed)');
console.log('─'.repeat(72));
if (verdict === null) {
  console.log('  PASS — this configuration will not be refused at boot by the checks above.');
  console.log('         (The tenant-wall gate reads the live database at boot and is NOT checked here.)');
  console.log('');
  console.log('  Note what this does NOT say: it does not say the credentials are');
  console.log('  valid, only that required values pass local format checks. It also');
  console.log('  does not cover assertProductionData(), which refuses to start on a');
  console.log('  database with zero CountryConfig rows — seed the platform spine');
  console.log('  with prisma/seed-production.ts.');
  process.exit(0);
}
console.log(`  REFUSED — the server would print this and stop:\n`);
console.log(`    ${verdict}\n`);
console.log(`  ${problems.length} problem(s) found in total. Fix them and re-run.`);
process.exit(1);
