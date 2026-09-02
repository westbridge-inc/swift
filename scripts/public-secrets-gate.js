#!/usr/bin/env node
/**
 * The public-prefix gate [GRD-1 §2 · WS-15 / 15.8].
 *
 *   node scripts/public-secrets-gate.js [repo-root]
 *   node scripts/public-secrets-gate.js --bundle <built-dir> [repo-root]
 *
 * `EXPO_PUBLIC_*` (Metro) and `NEXT_PUBLIC_*` (Next.js) are INLINED AT BUILD
 * TIME. A value given one of those prefixes is not "exposed if someone digs" —
 * it is published, in plaintext, inside every install and every page load.
 * Obfuscation, code splitting and certificate pinning change nothing: the
 * reader has the bytes.
 *
 * gitleaks already scans source history for things that LOOK like credentials.
 * It cannot catch this class, because the dangerous act here leaves no
 * credential-shaped string in the repository at all — someone writes
 * `process.env.NEXT_PUBLIC_MMG_SECRET` and the real value is injected by the
 * build, from CI's own environment, straight into the bundle. The source looks
 * innocent. The artefact is a leak.
 *
 * So the gate is on the NAME, at the source, before any value exists: every
 * public-prefixed identifier must appear in `security/public-env-allowlist.txt`
 * with a written justification, and a name that reads like a secret needs an
 * explicit `!not-a-secret` marker on top of that — turning the risky case into
 * a deliberate, reviewed act instead of an accident nobody noticed.
 *
 * --bundle additionally scans a BUILT directory for any public-prefixed
 * identifier that is not allowlisted, which catches a dependency or a generated
 * file introducing one where no source grep would look.
 *
 * LOCAL-RUN CAVEAT: this walks the filesystem. In this repo a worktree's disk
 * copy can legitimately LAG origin/main (work ships through a temp index and
 * never lands on disk), so a local run can under-report. CI checks out the real
 * tree and is the authority.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let bundleDir = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--bundle') {
    bundleDir = args[i + 1];
    i += 1;
  } else if (args[i] === '--allowlist') {
    positional.allowlist = args[i + 1];
    i += 1;
  } else {
    positional.push(args[i]);
  }
}

// House convention (scripts/unreachable-routes.js): derive the root from the
// script's own location so this runs from any checkout; argv overrides.
const ROOT = positional[0] ? path.resolve(positional[0]) : path.resolve(__dirname, '..');
const ALLOWLIST_PATH = positional.allowlist
  ? path.resolve(positional.allowlist)
  : path.join(ROOT, 'security/public-env-allowlist.txt');

/** Names that read like a credential. A match needs an explicit marker. */
const SECRET_WORD = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|PRIVATE|AUTH)/;
// [TA-S0-006] Three naming seams inline at build time, not two: Expo and
// Next publish `*_PUBLIC_*`, and Vite (the Mission Control desktop app)
// publishes every `VITE_*` through import.meta.env. The desktop bundle was
// outside this gate entirely until the third prefix was named here.
const PUBLIC_PREFIX = /\b((?:EXPO_PUBLIC|NEXT_PUBLIC|VITE)_[A-Z0-9_]+)\b/g;
/**
 * The one escape hatch, and it is deliberately narrow.
 *
 * A gate's own negative tests must be able to WRITE the forbidden thing —
 * `NEXT_PUBLIC_MMG_SECRET` has to appear somewhere or nothing proves the gate
 * refuses it. Excluding all test files would be the easy fix and the wrong one:
 * a test fixture holding a real key is a classic leak, so tests are exactly
 * where scanning must continue.
 *
 * So: a line carrying this marker is skipped, ONLY in a test file, and the
 * count of skips is printed on success — an escape hatch nobody can see is an
 * escape hatch that grows.
 */
const FIXTURE_MARKER = 'public-secrets-gate:fixture';
const TEST_FILE = /\.test\.(ts|tsx|js|jsx)$/;
const SOURCE_DIRS = ['apps', 'packages'];
const SCANNED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'ios', 'android']);

function walk(dir, matchExt, out = [], skip = SKIP_DIRS) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, matchExt, out);
    else if (!matchExt || matchExt.test(entry.name)) out.push(full);
  }
  return out;
}

/** Parse `NAME [!not-a-secret] # justification` lines. */
function readAllowlist(file) {
  const entries = new Map();
  const problems = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    problems.push(`Allowlist not found: ${file}`);
    return { entries, problems };
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const hash = line.indexOf('#');
    const head = (hash === -1 ? line : line.slice(0, hash)).trim();
    const justification = hash === -1 ? '' : line.slice(hash + 1).trim();
    const parts = head.split(/\s+/).filter(Boolean);
    const name = parts[0];
    const marked = parts.includes('!not-a-secret');
    if (!name) continue;
    if (justification.length < 20) {
      problems.push(`${name}: needs a written justification (what is the value, who can read it, what can they do with it)`);
    }
    if (SECRET_WORD.test(name) && !marked) {
      problems.push(
        `${name}: reads like a secret. If it genuinely is not one, add the explicit \`!not-a-secret\` marker and say why in the justification.`,
      );
    }
    entries.set(name, { marked, justification });
  }
  return { entries, problems };
}

const { entries: allowed, problems: allowlistProblems } = readAllowlist(ALLOWLIST_PATH);

/** name -> Set of "file:line" */
const found = new Map();
/** How many lines the fixture marker suppressed — printed so it stays visible. */
let fixtureSkips = 0;
/** Files the scanner could not read. Reported, because 'scanned nothing' and
 *  'scanned everything and found nothing' must never print the same. */
let unreadable = 0;
function record(name, where) {
  if (!found.has(name)) found.set(name, new Set());
  found.get(name).add(where);
}

const scanRoots = bundleDir ? [path.resolve(bundleDir)] : SOURCE_DIRS.map((d) => path.join(ROOT, d));

/**
 * A scanner's failure mode is SILENCE [REPORT-037 R037-23].
 *
 * `walk()` turns a missing or unreadable directory into an empty result, so
 * `--bundle` against a path that does not exist printed green with zero
 * variables found — captured: `exit=0 directory_exists=no`. A renamed Next
 * `distDir`, a build that did not run, or a wrong path in a workflow would
 * remove this gate entirely while CI stayed green, which is the exact shape of
 * assurance-without-evidence this gate was written to prevent.
 *
 * So bundle mode now proves it actually scanned something before it is allowed
 * to pass.
 */
function assertScannableBundle(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    console.error(`\n✖ --bundle ${dir} does not exist. Nothing was scanned.`);
    console.error('  A gate that passes because it found no files is not a gate.\n');
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`\n✖ --bundle ${dir} is not a directory. Nothing was scanned.\n`);
    process.exit(1);
  }
}

if (bundleDir) assertScannableBundle(path.resolve(bundleDir));

// [TA-S0-006] The skip list is for SOURCE trees (a checkout's node_modules,
// its build outputs, its native folders). A bundle IS a build output, and a
// mobile export lays its platforms out as ios/ and android/ — so in bundle
// mode nothing is skipped: every directory under the bundle is scanned.
const NO_SKIP = new Set();
const files = scanRoots.flatMap((dir) => walk(dir, bundleDir ? null : SCANNED_EXT, [], bundleDir ? NO_SKIP : SKIP_DIRS));

if (bundleDir) {
  const bytes = files.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
  if (files.length === 0 || bytes === 0) {
    console.error(`\n✖ --bundle ${bundleDir} contained ${files.length} file(s), ${bytes} byte(s).`);
    console.error('  An empty build output cannot prove anything. Did the build run?\n');
    process.exit(1);
  }
  console.log(`  scanned ${files.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB of built output`);
}

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    unreadable += 1; // counted, not silently skipped — see the report below
    continue;
  }
  const lines = text.split('\n');
  // [TA-S0-006] The fixture marker is a SOURCE-mode courtesy for the gate's
  // own test file. A built bundle has no test files, so nothing in it may be
  // skipped on the strength of a comment — a bundle is scanned whole.
  const isTest = !bundleDir && TEST_FILE.test(file);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isTest && line.includes(FIXTURE_MARKER)) {
      if (PUBLIC_PREFIX.test(line)) fixtureSkips += 1;
      PUBLIC_PREFIX.lastIndex = 0; // the regex is /g — .test() advances it
      continue;
    }
    for (const match of line.matchAll(PUBLIC_PREFIX)) {
      record(match[1], `${path.relative(ROOT, file)}:${i + 1}`);
    }
  }
}

const unlisted = [...found.keys()].filter((name) => !allowed.has(name)).sort();
// An allowlist entry nothing uses is stale permission — audited from BOTH sides,
// exactly like the stock-photo gate's exemptions.
const unused = [...allowed.keys()].filter((name) => !found.has(name)).sort();

const label = bundleDir ? `built bundle ${bundleDir}` : 'source';
let failed = false;

if (allowlistProblems.length) {
  failed = true;
  console.error(`\n✖ ${ALLOWLIST_PATH} has problems:`);
  for (const problem of allowlistProblems) console.error(`    ${problem}`);
}

if (unlisted.length) {
  failed = true;
  console.error(`\n✖ Public-prefixed variables in the ${label} that are NOT allowlisted:\n`);
  for (const name of unlisted) {
    console.error(`  ${name}`);
    for (const where of [...found.get(name)].slice(0, 5)) console.error(`      ${where}`);
    if (SECRET_WORD.test(name)) {
      console.error('      ⚠ this name reads like a SECRET. A public prefix publishes its value in every build.');
    }
  }
  console.error(
    '\n  Anything with these prefixes is inlined at build time and shipped to every user.',
  );
  console.error(
    '  If it is genuinely public, add it to security/public-env-allowlist.txt with a written',
  );
  console.error('  justification. If it is not, it belongs behind a server-side proxy, not in a bundle.\n');
}

if (!bundleDir && unused.length) {
  failed = true;
  console.error(`\n✖ Allowlisted but used nowhere — stale permission, remove it:\n`);
  for (const name of unused) console.error(`  ${name}`);
  console.error('');
}

// [TA-S0-006] In bundle mode a file that could not be read is a file that was
// not certified. "scanned everything and found nothing" must never print over
// a partial read: the count used to be a footnote on a green result.
if (bundleDir && unreadable) {
  failed = true;
  console.error(`\n✖ ${unreadable} file(s) in ${bundleDir} could not be read. A partial scan is not a scan.\n`);
}

if (failed) process.exit(1);

console.log(
  `✔ public-secrets-gate: ${found.size} public-prefixed variable(s) in the ${label}, all allowlisted with justifications.`,
);
if (unreadable) {
  console.log(`    (${unreadable} file(s) could not be read and were NOT scanned)`);
}
if (fixtureSkips) {
  console.log(`    (${fixtureSkips} line(s) skipped as gate-test fixtures — test files only)`);
}
for (const name of [...found.keys()].sort()) {
  console.log(`    ${name} (${found.get(name).size} use${found.get(name).size === 1 ? '' : 's'})`);
}
