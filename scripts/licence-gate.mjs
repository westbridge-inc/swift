#!/usr/bin/env node
/**
 * [DOC-1 §26.1 · DOC-INV-23] The licence gate — no dependency outside the allowlist
 * without an exception row. Walks every installed package manifest under the pnpm
 * store (the real dependency tree, transitive included), reads its licence, and fails
 * the build on a copyleft/source-available/revenue-clause licence unless
 * `licence-exceptions.md` carries a row naming the package. No third-party action, no
 * network: the tree that is installed is the tree that is judged.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const ALLOW = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib', 'MIT-0', 'CC-BY-4.0', 'CC-BY-3.0', 'WTFPL', 'MPL-2.0', 'Artistic-2.0', 'BSD-2-Clause-Patent', 'PSF-2.0', 'OFL-1.1', 'W3C', 'BSL-1.0']);
const DENY_PATTERNS = [/AGPL/i, /SSPL/i, /BUSL/i, /Business Source/i, /Commons Clause/i, /Elastic/i, /RSAL/i, /Hippocratic/i, /GPL-?[23]/i, /LGPL/i, /CC-BY-NC/i, /EUPL/i, /OSL-3/i, /Parity/i, /Prosperity/i, /Polyform/i];

function exceptions() {
  const f = join(ROOT, 'licence-exceptions.md');
  if (!existsSync(f)) return new Map();
  const rows = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line);
    if (m) rows.set(m[1].trim(), { licence: m[2].trim(), reason: m[3].trim() });
  }
  return rows;
}

function* manifests(dir, depth = 0) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isSymbolicLink && st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (name === '.bin' || name === '.cache') continue;
      if (existsSync(join(p, 'package.json')) && !name.startsWith('.') && !name.startsWith('@')) {
        yield join(p, 'package.json');
        // a package's own nested node_modules
        yield* manifests(join(p, 'node_modules'), depth + 1);
        continue;
      }
      if (depth < 6) yield* manifests(p, depth + 1);
    }
  }
}

/** Old manifests spell MIT as "MIT/X11"; SPDX has one id for it. */
function normalise(expr) { return expr.replace(/MIT\/X11/gi, 'MIT').replace(/\bBSD\b(?!-)/g, 'BSD-3-Clause'); }

/** An exception row names a package or a `prefix*` glob. */
function excused(name, exc) {
  if (exc.has(name)) return exc.get(name);
  for (const [key, row] of exc) if (key.endsWith('*') && name.startsWith(key.slice(0, -1))) return row;
  return null;
}

function licenceOf(pkg) {
  const l = pkg.license ?? pkg.licence ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ') : undefined);
  if (!l) return null;
  if (typeof l === 'object') return l.type ?? null;
  return normalise(String(l));
}

/** Every licence in an SPDX expression must be allowed (an `OR` with one allowed side passes). */
function judge(expr) {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (e.includes(' OR ')) return e.split(/\s+OR\s+/).some((part) => judge(part) === 'ok') ? 'ok' : 'deny';
  const parts = e.split(/\s+AND\s+/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (ALLOW.has(p)) continue;
    if (DENY_PATTERNS.some((re) => re.test(p))) return 'deny';
    return 'unknown';
  }
  return 'ok';
}

const stores = [join(ROOT, 'node_modules', '.pnpm'), join(ROOT, 'node_modules')];
const seen = new Map(); // name@version → licence
for (const store of stores) for (const file of manifests(store)) {
  let pkg; try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
  if (!pkg.name) continue;
  if (pkg.private === true || pkg.name.startsWith('prisma-client-')) continue; // our own workspace packages and Prisma's generated client
  const key = `${pkg.name}@${pkg.version ?? '?'}`;
  if (!seen.has(key)) seen.set(key, licenceOf(pkg));
}
const exc = exceptions();
const denied = []; const unknown = []; const excusedRows = [];
for (const [key, lic] of seen) {
  const name = key.slice(0, key.lastIndexOf('@'));
  const verdict = lic ? judge(lic) : 'unknown';
  if (verdict === 'ok') continue;
  const row = excused(name, exc);
  if (row) { excusedRows.push(`${key}: ${lic ?? 'no licence field'} — ${row.reason}`); continue; }
  (verdict === 'deny' ? denied : unknown).push(`${key}: ${lic ?? 'no licence field'}`);
}
console.log(`[licence-gate] ${seen.size} packages judged; ${excusedRows.length} excused by licence-exceptions.md; ${unknown.length} with an unrecognised licence; ${denied.length} denied`);
for (const line of excusedRows) console.log(`  excused  ${line}`);
for (const line of unknown) console.log(`  unknown  ${line}`);
for (const line of denied) console.log(`  DENIED   ${line}`);
if (denied.length > 0) { console.error(`[licence-gate] FAIL: ${denied.length} dependency(ies) carry a licence outside the §26.1 allowlist and have no exception row.`); process.exit(1); }
if (unknown.length > 0 && process.env.LICENCE_GATE_STRICT === '1') { console.error('[licence-gate] FAIL (strict): unrecognised licences must be classified.'); process.exit(1); }
