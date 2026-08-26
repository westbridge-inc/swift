// Enumerate every HTTP route the API defines, then every path string the
// clients actually call, and report routes nothing reaches.
const fs = require('fs'), path = require('path');
const ROOT = '/Users/westbridgeinc/swift-location-wt';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const f = path.join(dir, e);
    const st = fs.statSync(f);
    if (st.isDirectory()) walk(f, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(f);
  }
  return out;
}

// 1) Route table: prefix per registration + each app.<verb>('<path>')
const server = fs.readFileSync(path.join(ROOT, 'apps/api/src/server.ts'), 'utf8');
const prefixes = new Map();
for (const m of server.matchAll(/register\((\w+),\s*\{\s*prefix:\s*'([^']+)'/g)) prefixes.set(m[1], m[2]);

const routes = [];
for (const f of walk(path.join(ROOT, 'apps/api/src/modules'))) {
  const body = fs.readFileSync(f, 'utf8');
  const fnMatch = body.match(/export\s+async\s+function\s+(\w+)\s*\(/);
  const fn = fnMatch ? fnMatch[1] : null;
  const prefix = fn && prefixes.has(fn) ? prefixes.get(fn) : null;
  if (!prefix) continue;
  for (const m of body.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']*)'/g)) {
    routes.push({ verb: m[1].toUpperCase(), full: (prefix + m[2]).replace(/\/$/, '') || prefix, file: path.relative(ROOT, f) });
  }
}

// 2) Everything the clients reference, as one haystack.
const clientFiles = [
  ...walk(path.join(ROOT, 'apps/mobile/src')),
  ...walk(path.join(ROOT, 'apps/web/src')),
  ...walk(path.join(ROOT, 'apps/admin/src')).slice(0, 100000),
];
const hay = clientFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// A route is "reached" if its literal path (minus the /api/v1 prefix and with
// :params turned into a wildcard) appears anywhere in client source.
function reached(full) {
  const rel = full.replace(/^\/api\/v1/, '');
  const segs = rel.split('/').filter(Boolean);
  const stat = [];
  for (const s of segs) { if (s.startsWith(':')) break; stat.push(s); }
  if (!stat.length) return true;
  const needle = '/' + stat.join('/');
  return hay.includes(needle);
}

const dead = routes.filter((r) => !reached(r.full));
const byArea = new Map();
for (const r of dead) {
  const area = r.file.split('/')[4] || r.file;
  if (!byArea.has(area)) byArea.set(area, []);
  byArea.get(area).push(r);
}
console.log(`routes defined: ${routes.length}   with no client reference: ${dead.length}\n`);
for (const [area, list] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${area} (${list.length})`);
  for (const r of list.slice(0, 8)) console.log(`   ${r.verb.padEnd(6)} ${r.full}`);
  if (list.length > 8) console.log(`   … +${list.length - 8} more`);
}
