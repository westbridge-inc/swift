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
 * [SCR-006] --bundle is bound to the artifact manifest the build emitted
 * (scripts/artifact-manifest.js): `--manifest <file> --app <name> --commit <sha>`
 * proves the directory is THIS build — every declared file by digest, the tree
 * digest recomputed from the bytes, the entrypoints present and non-empty, no
 * undeclared file, no symlink escaping the root, nothing unreadable — and
 * `--receipt <file>` writes the scan attestation for it, only on a pass.
 * VALUES are the other half: a bundler inlines a server secret under a new
 * name, and scripts/secret-canary.js arms and scans for those. Two gates, one
 * artifact, no overlap.
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
// [SCR-006] Bundle mode is bound to an artifact manifest (what the build IS)
// and the app and commit it must be for; --receipt records the certification.
const opt = { manifest: null, app: null, commit: null, receipt: null };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--bundle') {
    bundleDir = args[i + 1];
    i += 1;
  } else if (args[i] === '--manifest' || args[i] === '--app' || args[i] === '--commit' || args[i] === '--receipt') {
    opt[args[i].slice(2)] = args[i + 1];
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
const SOURCE_DIRS = ['apps', 'packages', '.github/workflows', 'infrastructure'];
// [SCR-005] Root-level config files are seams too (Expo/Next/Vite config, EAS, env templates).
const ROOT_FILES = /^(app\.config\.(ts|js)|eas\.json|next\.config\.(js|mjs|ts)|vite\.config\.(ts|js)|\.env(\..*)?)$/;
const SCANNED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|plist|xml|env|example)$/;
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
    // [SCR-005] The skip set travels with the recursion. It used to be dropped
    // below the top level, so a bundle walked with NO skip still skipped every
    // nested ios/, android/, build/ or dist/ — and an Expo export keeps its JS
    // at dist/ios/_expo/static/js/ios/: the mobile bundle was never scanned.
    if (entry.isDirectory()) walk(full, matchExt, out, skip);
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

/**
 * [SCR-006] A bundle is certified only against its manifest: the right app, the
 * right commit, every declared file present with its digest, every entrypoint
 * present and non-empty, no symlink escaping the root, nothing unreadable.
 * A nonempty directory proves nothing; the manifest proves it is THIS build.
 */
const crypto = require('crypto');
function verifyManifest(dir) {
  if (!opt.manifest) { console.error('\n✖ --bundle requires --manifest <artifact manifest> (scripts/artifact-manifest.js). A directory is not an artifact.\n'); process.exit(1); }
  let m;
  try { m = JSON.parse(fs.readFileSync(path.resolve(opt.manifest), 'utf8')); } catch (e) { console.error(`\n✖ manifest ${opt.manifest} unreadable: ${e.message}\n`); process.exit(1); }
  const problems = [];
  if (!m || m.version !== 1 || !Array.isArray(m.files)) problems.push('manifest is not a version-1 artifact manifest');
  if (opt.app && m.app !== opt.app) problems.push(`manifest is for app "${m.app}", not "${opt.app}"`);
  if (opt.commit && m.commit !== opt.commit) problems.push(`manifest is for commit ${m.commit}, not ${opt.commit} (stale or foreign build)`);
  if (!Array.isArray(m.entrypoints) || m.entrypoints.length === 0) problems.push('manifest declares no entrypoints');
  const realRoot = fs.realpathSync(dir);
  /** path → the digest line the GATE computed, so the tree digest is recomputed from the bytes, never copied from the manifest. */
  const seen = [];
  for (const f of m.files || []) {
    const full = path.join(dir, f.path);
    if (!full.startsWith(dir + path.sep) && full !== dir) { problems.push(`${f.path}: path escapes the bundle`); continue; }
    let st;
    try { st = fs.lstatSync(full); } catch { problems.push(`${f.path}: declared but missing`); continue; }
    if (f.unreadable) { problems.push(`${f.path}: could not be read at build time (${f.unreadable}) — a partial scan is not a scan`); continue; }
    if (st.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(full); } catch { problems.push(`${f.path}: dangling symlink`); continue; }
      if (!target.startsWith(realRoot + path.sep)) problems.push(`${f.path}: symlink escapes the bundle (${target})`);
      seen.push({ path: f.path, line: `${f.path}:symlink:${fs.readlinkSync(full)}` });
      continue;
    }
    if (!st.isFile()) { problems.push(`${f.path}: not a regular file`); continue; }
    let buf;
    try { buf = fs.readFileSync(full); } catch (e) { problems.push(`${f.path}: could not be read (${e.code || e.message}) — a partial scan is not a scan`); continue; }
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    seen.push({ path: f.path, line: `${f.path}:${digest}` });
    if (f.sha256 && digest !== f.sha256) problems.push(`${f.path}: digest ${digest.slice(0, 12)}… does not match the manifest`);
    if (typeof f.bytes === 'number' && buf.length !== f.bytes) problems.push(`${f.path}: ${buf.length} byte(s), manifest says ${f.bytes}`);
  }
  for (const entry of m.entrypoints || []) {
    const full = path.join(dir, entry);
    let st;
    try { st = fs.statSync(full); } catch { problems.push(`entrypoint ${entry}: missing`); continue; }
    if (!st.isFile() || st.size === 0) problems.push(`entrypoint ${entry}: ${st.isFile() ? 'zero bytes' : 'not a file'}`);
  }
  // every file in the tree must be declared: an undeclared file is an unscanned seam
  const declared = new Set((m.files || []).map((f) => f.path));
  const present = walk(dir, null, [], NO_SKIP).map((f) => path.relative(dir, f).split(path.sep).join('/'));
  for (const p of present) if (!declared.has(p)) problems.push(`${p}: present in the bundle but not in the manifest`);
  // the tree digest names the whole artifact in the receipt; it is recomputed here exactly as the generator computes it
  const tree = crypto.createHash('sha256').update(seen.sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => e.line).join('\n')).digest('hex');
  if (typeof m.treeDigest !== 'string' || m.treeDigest.length !== 64) problems.push('manifest carries no tree digest');
  else if (tree !== m.treeDigest) problems.push(`tree digest ${tree.slice(0, 12)}… recomputed from the bytes does not match the manifest's ${m.treeDigest.slice(0, 12)}…`);
  if (problems.length) {
    console.error(`\n✖ --bundle ${bundleDir} does not match its manifest ${opt.manifest}:\n`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    console.error('\n  Nothing is certified until the artifact and the manifest agree.\n');
    process.exit(1);
  }
  console.log(`  manifest ok: ${m.app} @ ${m.commit}, ${m.files.length} file(s) verified by digest, ${m.entrypoints.length} entrypoint(s) present, tree ${tree.slice(0, 12)}…`);
  return m;
}
// [TA-S0-006] The skip list is for SOURCE trees (a checkout's node_modules,
// its build outputs, its native folders). A bundle IS a build output, and a
// mobile export lays its platforms out as ios/ and android/ — so in bundle
// mode nothing is skipped: every directory under the bundle is scanned.
const NO_SKIP = new Set();
const files = scanRoots.flatMap((dir) => walk(dir, bundleDir ? null : SCANNED_EXT, [], bundleDir ? NO_SKIP : SKIP_DIRS));
// [SCR-005] In source mode the root-level config seams are scanned as well.
if (!bundleDir) {
  for (const name of fs.readdirSync(ROOT)) if (ROOT_FILES.test(name)) files.push(path.join(ROOT, name));
  for (const app of ['apps/mobile', 'apps/web', 'apps/admin', 'apps/desktop']) {
    const dir = path.join(ROOT, app);
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (ROOT_FILES.test(name)) files.push(path.join(dir, name));
  }
}
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
const manifest = bundleDir ? verifyManifest(path.resolve(bundleDir)) : null;

const exemptFiles = new Set(); // [SCR-007] source files whose lines were skipped on the fixture marker
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
  const isYaml = /\.ya?ml$/.test(file);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isYaml && /^\s*#/.test(line)) continue; // a workflow comment is prose, not a variable reaching a build
    if (isTest && line.includes(FIXTURE_MARKER)) {
      if (PUBLIC_PREFIX.test(line)) { fixtureSkips += 1; exemptFiles.add(file); }
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

// [SCR-007] A fixture exemption is honoured only in a test file that NO production source imports.
// The same fixture imported by a non-test file, or copied into a build, is a leak wearing a comment.
if (!bundleDir && exemptFiles.size) {
  const importers = new Map();
  const IMPORT = /(?:import\s+(?:[^'"]*from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    if (TEST_FILE.test(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let m;
    while ((m = IMPORT.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), spec);
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
        if (exemptFiles.has(cand)) { if (!importers.has(cand)) importers.set(cand, []); importers.get(cand).push(file); }
      }
    }
  }
  if (importers.size) {
    failed = true;
    console.error(`\n✖ ${importers.size} fixture-exempt test file(s) are imported by production source — an exemption that production can reach is a leak:\n`);
    for (const [exempt, by] of importers) console.error(`  ${path.relative(ROOT, exempt)} ← ${by.map((b) => path.relative(ROOT, b)).join(', ')}`);
    console.error('');
  }
}

if (failed) process.exit(1);

// [SCR-006] The scan receipt: one attestation per certified artifact, tied to
// the manifest's tree digest and the release commit. Written only on a pass —
// a receipt that exists says the bytes it names were scanned whole and passed.
if (bundleDir && opt.receipt) {
  const receipt = {
    version: 1, gate: 'public-secrets-gate', result: 'pass', app: manifest.app, commit: manifest.commit, treeDigest: manifest.treeDigest,
    manifestFiles: manifest.files.length, scannedFiles: files.length, scannedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.resolve(opt.receipt), JSON.stringify(receipt, null, 2));
  console.log(`  receipt → ${opt.receipt} (${manifest.app} @ ${manifest.commit}, tree ${manifest.treeDigest.slice(0, 12)}…)`);
}

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
