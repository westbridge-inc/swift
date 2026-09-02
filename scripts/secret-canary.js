#!/usr/bin/env node
/**
 * [TA-S0-006] The artifact secret canary — proof that a shipped client
 * contains no server secret.
 *
 * The public-secrets gate (scripts/public-secrets-gate.js) reasons about
 * NAMES: a `NEXT_PUBLIC_`/`EXPO_PUBLIC_`/`VITE_` identifier is inlined into
 * every client build, so each one needs a written justification. That is the
 * right gate for the naming seam and the wrong one for the artifact: a
 * bundler replaces the identifier with its VALUE and drops the name, so a
 * built bundle that "contains no public-prefixed variable" proves almost
 * nothing about what it actually carries. And CI builds without secrets, so
 * scanning the built output for real secret values finds nothing by
 * construction.
 *
 * So this script asks the question the other way round. Before a client
 * build, every server-only secret name the codebase knows is ARMED with a
 * canary value — `SWIFT_CANARY_<NAME>_<nonce>` — in the build's environment.
 * After the build, the artifacts that ship to clients are searched for the
 * canary prefix. A hit names the variable and the file: that value would have
 * been the real secret on a real build. This is the same proof on the built
 * artifact that the name gate gives on the source, and it works exactly as
 * well in a secretless CI as in a real release build.
 *
 * The list of names is GENERATED, never maintained by hand (the house rule
 * for every census): every secret-shaped environment variable the API reads,
 * plus every secret-shaped name in the deploy template. Names carrying a
 * public prefix are the name gate's business, not this one's. A client-
 * embedded key that is public BY DESIGN is excluded with a written reason.
 *
 *   node scripts/secret-canary.js --names            the armed set, one per line
 *   node scripts/secret-canary.js --emit             NAME=value lines for $GITHUB_ENV
 *   node scripts/secret-canary.js --scan <dir>...    fail on any canary in the artifacts
 *
 * `--scan` refuses to pass when the canaries are not armed in its own
 * environment (a workflow that forgot `--emit` cannot go green), when a
 * directory is missing or empty (a gate that scanned nothing is not a gate —
 * REPORT-037 R037-23), or when a file could not be read (a partial scan is
 * not a scan). `--root <dir>` points every mode at another tree; the test
 * suite uses it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANARY_PREFIX = 'SWIFT_CANARY_';
/** Secret-shaped. Broader than the name gate's pattern on purpose: the API's
 *  master encryption key is `MASTER_KEK`, and a canary set that missed it
 *  would certify the one artifact leak that matters most. */
const SECRET_WORD = /(KEY|KEK|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|PRIVATE|AUTH|SALT|PEPPER|SIGNING|HMAC|CERT)/;
const PUBLIC_PREFIX = /^(EXPO_PUBLIC|NEXT_PUBLIC|VITE)_/;
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
const ENV_LINE = /^([A-Z][A-Z0-9_]*)=/;

/**
 * Client-embedded BY DESIGN. A canary here would be a true positive the
 * product already accepts, so each exclusion carries the reason a reviewer
 * can check. Adding a name here is a product decision, not a convenience.
 */
const EMBEDDED_BY_DESIGN = {
  ANDROID_GOOGLE_MAPS_API_KEY:
    "lives in every Android install's manifest by design (react-native-maps needs it before any JS runs); " +
    'restricted to the package name + signing SHA-1 at the Google console, so possession grants nothing.',
};

const args = process.argv.slice(2);
let mode = null;
let root = path.resolve(__dirname, '..');
const scanDirs = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--names' || a === '--emit' || a === '--scan') mode = a;
  else if (a === '--root') { root = path.resolve(args[i + 1]); i += 1; }
  else if (mode === '--scan') scanDirs.push(a);
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
if (!mode) {
  console.error('usage: secret-canary.js [--root <dir>] --names | --emit | --scan <dir>...');
  process.exit(2);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** The generated census of server-only secret names. */
function secretNames(rootDir) {
  const names = new Set();
  const apiSrc = path.join(rootDir, 'apps', 'api', 'src');
  for (const f of walk(apiSrc)) {
    if (!/\.(ts|js|cjs|mjs)$/.test(f) || /\.test\.(ts|js)$/.test(f)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ENV_READ)) {
      const n = m[1] || m[2];
      if (n) names.add(n);
    }
  }
  const example = path.join(rootDir, 'deploy', '.env.deploy.example');
  if (fs.existsSync(example)) {
    for (const line of fs.readFileSync(example, 'utf8').split('\n')) {
      const m = ENV_LINE.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return [...names]
    .filter((n) => SECRET_WORD.test(n) && !PUBLIC_PREFIX.test(n) && !Object.hasOwn(EMBEDDED_BY_DESIGN, n))
    .sort();
}

const names = secretNames(root);

if (mode === '--names') {
  if (names.length === 0) {
    console.error(`✖ no secret-shaped names found under ${root} — a canary set of zero certifies nothing.`);
    process.exit(1);
  }
  for (const n of names) console.log(n);
  process.exit(0);
}

if (mode === '--emit') {
  if (names.length === 0) {
    console.error(`✖ no secret-shaped names found under ${root} — refusing to arm an empty canary set.`);
    process.exit(1);
  }
  const nonce = crypto.randomBytes(6).toString('hex');
  for (const n of names) console.log(`${n}=${CANARY_PREFIX}${n}_${nonce}`);
  process.exit(0);
}

// --scan
if (scanDirs.length === 0) {
  console.error('✖ --scan needs at least one artifact directory.');
  process.exit(2);
}

// 1. The canaries must be ARMED in this very environment, all of them. A
//    scan that ran in a shell where nothing was armed would pass vacuously.
const unarmed = names.filter((n) => !String(process.env[n] || '').startsWith(CANARY_PREFIX));
if (names.length === 0 || unarmed.length) {
  console.error(`\n✖ secret-canary: the canaries are not armed in this environment (${unarmed.length} of ${names.length} missing).`);
  console.error('  Run `node scripts/secret-canary.js --emit >> "$GITHUB_ENV"` in a step BEFORE the build,');
  console.error('  so the build sees a canary in every server-only secret and this scan can mean something.');
  for (const n of unarmed.slice(0, 10)) console.error(`    ${n}`);
  console.error('');
  process.exit(1);
}

// 2. Every directory must exist and hold bytes.
const files = [];
for (const d of scanDirs) {
  const abs = path.resolve(d);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    console.error(`\n✖ secret-canary: ${d} does not exist. Nothing was scanned — a gate that found no files is not a gate.\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`\n✖ secret-canary: ${d} is not a directory.\n`);
    process.exit(1);
  }
  const here = walk(abs);
  if (here.length === 0) {
    console.error(`\n✖ secret-canary: ${d} is empty. Did the build run?\n`);
    process.exit(1);
  }
  files.push(...here);
}

// 3. Read every byte of every file. Binary or text, compressed or not — a
//    canary is a plain ASCII string wherever it landed.
const needle = Buffer.from(CANARY_PREFIX, 'latin1');
const hitPattern = new RegExp(`${CANARY_PREFIX}([A-Z][A-Z0-9_]*?)_[0-9a-f]{12}`, 'g');
const hits = new Map(); // name → files
let bytes = 0;
let unreadable = 0;
for (const f of files) {
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch {
    unreadable += 1;
    continue;
  }
  bytes += buf.length;
  if (buf.indexOf(needle) === -1) continue;
  const text = buf.toString('latin1');
  let any = false;
  for (const m of text.matchAll(hitPattern)) {
    any = true;
    if (!hits.has(m[1])) hits.set(m[1], new Set());
    hits.get(m[1]).add(f);
  }
  if (!any) {
    // The prefix without a well-formed canary: still the prefix, still a leak
    // of something armed. Report it under its own heading rather than lose it.
    if (!hits.has('(malformed)')) hits.set('(malformed)', new Set());
    hits.get('(malformed)').add(f);
  }
}

if (unreadable) {
  console.error(`\n✖ secret-canary: ${unreadable} file(s) could not be read. A partial scan is not a scan.\n`);
  process.exit(1);
}

if (hits.size) {
  console.error('\n✖ secret-canary: a SERVER SECRET reached a client artifact. On a real build this would be the real value:\n');
  for (const [name, where] of [...hits.entries()].sort()) {
    console.error(`  ${name}`);
    for (const f of [...where].slice(0, 5)) console.error(`      ${path.relative(process.cwd(), f)}`);
  }
  console.error('\n  A client must never read a server-only variable. Move the read behind the API, or, if the');
  console.error('  value is genuinely public, give it a public prefix and justify it in security/public-env-allowlist.txt.\n');
  process.exit(1);
}

console.log(
  `✔ secret-canary: ${names.length} server-only secret(s) armed, ${files.length} file(s) / ${(bytes / 1024 / 1024).toFixed(1)} MB of client artifacts scanned, no canary reached them.`,
);
