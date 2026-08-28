#!/usr/bin/env node
/**
 * Find API routes that no client ever calls.
 *
 *   node scripts/unreachable-routes.js [repo-root]
 *
 * Swift's recurring defect is not a wrong line of code — it is a finished,
 * tested server engine with nothing calling it. The SOS fan-out had no
 * emergency contacts to text; the address book could not be edited; reported
 * content reached a queue no human could open; advertisers and their creatives
 * sat in review queues with no reviewer, so the ads business could not onboard
 * anyone. Every one of those passed its own unit tests. The break was BETWEEN
 * the layers, which is the one place no unit test looks.
 *
 * So: extract every route the API defines (with the prefix it is registered
 * under in server.ts), then every path literal the clients contain, and print
 * the difference.
 *
 * READ THE OUTPUT, DO NOT ACT ON IT BLIND. A route with no caller is not
 * automatically a defect. Three legitimate kinds show up every run:
 *   - inbound webhooks and server-to-server endpoints (payment callbacks,
 *     index sync) — nothing in a client should ever call them;
 *   - pages a browser visits directly rather than fetching (/legal/*);
 *   - honest placeholders — a real page that states a feature is not built and
 *     deliberately calls nothing. That is the correct pattern, not a gap.
 * What is left after those is the list worth working.
 */
const fs = require('fs');
const path = require('path');

// House convention (see scripts/command.sh): derive the root from the script's
// own location so this runs from any checkout, and let argv override it.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const serverPath = path.join(ROOT, 'apps/api/src/server.ts');
if (!fs.existsSync(serverPath)) {
  console.error(`Not a Swift checkout: ${serverPath} does not exist.`);
  console.error('Usage: node scripts/unreachable-routes.js [repo-root]');
  process.exit(1);
}

// 1. Route table — each module's registration prefix, then its app.<verb>(path).
const server = fs.readFileSync(serverPath, 'utf8');
const prefixes = new Map();
for (const m of server.matchAll(/register\((\w+),\s*\{\s*prefix:\s*'([^']+)'/g)) prefixes.set(m[1], m[2]);

const routes = [];
for (const file of walk(path.join(ROOT, 'apps/api/src/modules'))) {
  const body = fs.readFileSync(file, 'utf8');
  const fn = body.match(/export\s+async\s+function\s+(\w+)\s*\(/)?.[1];
  const prefix = fn && prefixes.get(fn);
  if (!prefix) continue;
  for (const m of body.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']*)'/g)) {
    routes.push({
      verb: m[1].toUpperCase(),
      full: (prefix + m[2]).replace(/\/$/, '') || prefix,
      file: path.relative(ROOT, file),
    });
  }
}

// 2. Every path literal the clients contain, as one haystack.
const haystack = ['apps/mobile/src', 'apps/web/src', 'apps/admin/src']
  .flatMap((d) => walk(path.join(ROOT, d)))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

/** Reached if the route's static prefix (up to its first :param) appears anywhere. */
function reached(full) {
  const stat = [];
  for (const seg of full.replace(/^\/api\/v1/, '').split('/').filter(Boolean)) {
    if (seg.startsWith(':')) break;
    stat.push(seg);
  }
  return stat.length === 0 || haystack.includes('/' + stat.join('/'));
}

const dead = routes.filter((r) => !reached(r.full));
const byArea = new Map();
for (const r of dead) {
  const area = r.file.split('/')[4] ?? r.file;
  if (!byArea.has(area)) byArea.set(area, []);
  byArea.get(area).push(r);
}

console.log(`routes defined: ${routes.length}   no client reference: ${dead.length}\n`);
for (const [area, list] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${area} (${list.length})`);
  for (const r of list) console.log(`   ${r.verb.padEnd(6)} ${r.full}`);
}
