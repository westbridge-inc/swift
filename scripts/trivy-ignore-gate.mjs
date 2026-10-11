#!/usr/bin/env node
/**
 * The dependency-scan suppression gate. Runs in the CI Security Scan job BEFORE Trivy.
 *
 * The scan blocks on every HIGH/CRITICAL advisory in pnpm-lock.yaml. An advisory with
 * no fixed release that is not reachable in what we ship may be suppressed in
 * `.trivyignore.yaml`, but only as a scoped, dated, explained entry:
 *   - `id`          a single CVE or GHSA identifier (no wildcards);
 *   - `purls`       one or more exact npm package@version purls (no `paths`, no ranges),
 *                   so another version of the same package is still reported;
 *   - `expired_at`  YYYY-MM-DD, after today and at most --max-days (default 31) ahead.
 *                   Trivy stops honouring an entry ON its expiry date, so the scan goes
 *                   red again and the reason must be re-checked before it is renewed;
 *   - `statement`   why it is unreachable here, carrying a `Tracking:` note.
 * Only the `vulnerabilities` section may exist (no secret, licence or misconfiguration
 * suppressions), and a plain `.trivyignore` (undated, unscoped) must not exist.
 *
 * The file is read as a small, fixed YAML shape (the job has no dependencies installed);
 * any line outside that shape is refused rather than guessed at, so the gate fails closed.
 *
 * Usage: node scripts/trivy-ignore-gate.mjs [--root <dir>] [--today YYYY-MM-DD] [--max-days N]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}
const ROOT = resolve(flag('--root', '.'));
const TODAY = flag('--today', new Date().toISOString().slice(0, 10));
const MAX_DAYS = Number(flag('--max-days', '31'));

const problems = [];
const refuse = (who, why) => problems.push(`trivy-ignore-gate: REFUSED ${who}: ${why}`);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function day(text) {
  const m = DATE.exec(text);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject dates that roll over (2026-02-30 -> March 2).
  return new Date(t).toISOString().slice(0, 10) === text ? t / 86_400_000 : null;
}

const today = day(TODAY);
if (today === null) {
  console.error(`trivy-ignore-gate: REFUSED --today: '${TODAY}' is not a YYYY-MM-DD date`);
  process.exit(1);
}
if (!Number.isInteger(MAX_DAYS) || MAX_DAYS < 1) {
  console.error(`trivy-ignore-gate: REFUSED --max-days: '${MAX_DAYS}' is not a positive whole number`);
  process.exit(1);
}

const FILE = join(ROOT, '.trivyignore.yaml');
if (existsSync(join(ROOT, '.trivyignore'))) {
  refuse('.trivyignore', 'a plain .trivyignore cannot carry a scope or an expiry; move its entries to .trivyignore.yaml');
}
if (!existsSync(FILE)) {
  refuse('.trivyignore.yaml', `not found under ${ROOT} (the Security Scan passes it to Trivy with --ignorefile)`);
  for (const p of problems) console.error(p);
  process.exit(1);
}

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
const entries = [];
let section = null;
let current = null;
let key = null;

readFileSync(FILE, 'utf8').split('\n').forEach((raw, index) => {
  const line = raw.replace(/\s+$/, '');
  const where = `line ${index + 1}`;
  if (line === '' || /^\s*#/.test(line)) return;

  let m;
  if (!/^\s/.test(line)) {
    m = /^([A-Za-z_]+):\s*(\[\])?$/.exec(line);
    if (!m || m[1] !== 'vulnerabilities') {
      refuse(where, `only a 'vulnerabilities' section is allowed, found '${line}'`);
      section = 'other';
    } else {
      section = 'vulnerabilities';
    }
    current = null;
    key = null;
    return;
  }
  if (section !== 'vulnerabilities') {
    if (section === null) refuse(where, `'${line.trim()}' is outside any section`);
    return;
  }
  if ((m = /^ {2}- ([a-z_]+):\s*(.*)$/.exec(line))) {
    current = { id: m[1] === 'id' ? unquote(m[2]) : `(${where})`, line: index + 1, purls: null, expires: null, statement: null, keys: [] };
    entries.push(current);
    key = null;
    if (m[1] !== 'id') refuse(current.id, `an entry must start with 'id', found '${m[1]}'`);
    return;
  }
  if (!current) {
    refuse(where, `'${line.trim()}' is not inside an entry`);
    return;
  }
  if ((m = /^ {4}([a-z_]+):\s*(.*)$/.exec(line))) {
    key = m[1];
    const value = m[2].trim();
    current.keys.push(key);
    if (key === 'purls') {
      current.purls = [];
      if (value !== '') refuse(current.id, `write purls as a list, one '- pkg:npm/name@version' per line`);
    } else if (key === 'expired_at') {
      current.expires = unquote(value);
    } else if (key === 'statement') {
      current.statement = /^[>|][-+]?$/.test(value) ? '' : unquote(value);
    } else if (key === 'paths') {
      refuse(current.id, `'paths' scopes by file, not package; scope with an exact 'purls' entry instead`);
    } else {
      refuse(current.id, `'${key}' is not allowed (only id, purls, expired_at, statement)`);
    }
    return;
  }
  if ((m = /^ {6}- (.*)$/.exec(line)) && key === 'purls') {
    current.purls.push(unquote(m[1]));
    return;
  }
  if (/^ {6,}\S/.test(line) && key === 'statement') {
    current.statement = `${current.statement} ${line.trim()}`.trim();
    return;
  }
  refuse(current.id, `${where} is not part of the allowed shape: '${line.trim()}'`);
});

const ID = /^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/;
// pkg:npm/name@x.y.z or pkg:npm/%40scope/name@x.y.z (also '@scope'): an exact version only.
const PURL = /^pkg:npm\/(?:(?:%40|@)[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

for (const e of entries) {
  if (!ID.test(e.id)) refuse(e.id, `'id' must be one CVE-YYYY-NNNN or GHSA-xxxx-xxxx-xxxx identifier`);
  for (const k of new Set(e.keys)) {
    if (e.keys.filter((x) => x === k).length > 1) refuse(e.id, `'${k}' is given more than once`);
  }

  if (!e.purls || e.purls.length === 0) {
    refuse(e.id, `no 'purls': scope the entry to the exact package@version it covers`);
  } else {
    for (const p of e.purls) if (!PURL.test(p)) refuse(e.id, `purl '${p}' is not an exact pkg:npm/name@version`);
  }

  if (e.expires === null || e.expires === '') {
    refuse(e.id, `no 'expired_at': every suppression needs an expiry at most ${MAX_DAYS} days out`);
  } else {
    const expires = day(e.expires);
    if (expires === null) {
      refuse(e.id, `'expired_at: ${e.expires}' is not a real YYYY-MM-DD date`);
    } else if (expires <= today) {
      refuse(e.id, `expired on ${e.expires} (Trivy no longer honours it): re-check the advisory, then renew or delete the entry`);
    } else if (expires - today > MAX_DAYS) {
      refuse(e.id, `'expired_at: ${e.expires}' is more than ${MAX_DAYS} days after ${TODAY}`);
    }
  }

  if (!e.statement || e.statement.length < 40) {
    refuse(e.id, `no 'statement': say who pulls the package in and why it is unreachable here`);
  } else if (!/Tracking:/.test(e.statement)) {
    refuse(e.id, `the 'statement' has no 'Tracking:' note (what ends this suppression)`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`trivy-ignore-gate: ${problems.length} problem(s) in ${FILE}`);
  process.exit(1);
}
const n = entries.length;
console.log(`trivy-ignore-gate: OK, ${n} suppression${n === 1 ? '' : 's'}, each scoped to an exact package version, expiring within ${MAX_DAYS} days and explained`);
