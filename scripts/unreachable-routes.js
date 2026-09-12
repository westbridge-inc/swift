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
 * under in app.ts), then every path literal the clients contain, and print
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

/** Parse the composition root without importing it (importing would boot
 * plugins and require live infrastructure). Root-mounted plugins deliberately
 * receive an empty prefix. */
function registrationPrefixes(source) {
  const prefixes = new Map();
  for (const match of source.matchAll(/app\.register\(\s*(\w+)(?:\s*,\s*\{\s*prefix:\s*(['"])(.*?)\2)?/g)) {
    prefixes.set(match[1], match[3] ?? '');
  }
  return prefixes;
}

function routePluginName(source) {
  return source.match(/export\s+(?:default\s+)?async\s+function\s+(\w+)\s*\(/)?.[1];
}

function moduleRoutes(source, prefix, file, root) {
  const routes = [];
  for (const match of source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"`])([\s\S]*?)\2/g)) {
    const declaredPath = match[3].replace(/\$\{[^}]+\}/g, ':dynamic');
    routes.push({
      verb: match[1].toUpperCase(),
      full: (prefix + declaredPath).replace(/\/$/, '') || '/',
      file: path.relative(root, file),
    });
  }
  const routeMethodMentions = [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\b/g)].length;
  if (routes.length !== routeMethodMentions) {
    throw new Error(
      `Unsupported route declaration grammar in ${path.relative(root, file)}: `
      + `${routeMethodMentions} app method calls but ${routes.length} static declarations parsed.`,
    );
  }
  return routes;
}

function assertNonEmptyRouteCensus(routes, compositionPath) {
  if (routes.length === 0) {
    throw new Error(`Route census is empty: ${compositionPath} yielded no registered module routes.`);
  }
}

function isProductionClientFile(file, root) {
  const relative = path.relative(root, file);
  return !/(^|\/)(__tests__|fixtures|mocks)(\/|$)/.test(relative)
    && !/\.(test|spec)\.[^.]+$/.test(relative);
}

function scanRepo(root) {
  const compositionPath = path.join(root, 'apps/api/src/app.ts');
  if (!fs.existsSync(compositionPath)) {
    throw new Error(`Not a Swift checkout: ${compositionPath} does not exist.`);
  }

  // 1. Route table — each module's registration prefix, then its app.<verb>(path).
  const composition = fs.readFileSync(compositionPath, 'utf8');
  const prefixes = registrationPrefixes(composition);
  const routes = moduleRoutes(composition, '', compositionPath, root);
  for (const file of walk(path.join(root, 'apps/api/src/modules'))) {
    if (!file.endsWith('.routes.ts')) continue;
    const body = fs.readFileSync(file, 'utf8');
    const plugin = routePluginName(body);
    if (!plugin) {
      throw new Error(`Unsupported route-plugin export grammar in ${path.relative(root, file)}.`);
    }
    if (!prefixes.has(plugin)) {
      throw new Error(`Route plugin ${plugin} is not registered by ${path.relative(root, compositionPath)}.`);
    }
    routes.push(...moduleRoutes(body, prefixes.get(plugin), file, root));
  }

  // A zero-route success is worse than a failed audit: it says the platform
  // is clean after examining nothing. Keep this detector report-only, but make
  // an empty census impossible to mistake for evidence.
  assertNonEmptyRouteCensus(routes, compositionPath);

  // 2. Every path literal the clients contain, as one haystack.
//
// `apps/desktop/src` was missing from this list. Mission Control is a real
// client — it makes 30 calls of its own — so every admin route ONLY it uses
// was being counted as having no client at all, and the headline number was
// overstated by exactly that much. A reachability tool that cannot see one of
// the four clients reports gaps that are not gaps, which is the fastest way to
// get a report like this one ignored.
  const haystack = ['apps/mobile/src', 'apps/web/src', 'apps/admin/src', 'apps/desktop/src']
    .flatMap((directory) => walk(path.join(root, directory)))
    .filter((file) => isProductionClientFile(file, root))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

/** Reached if the route's static prefix (up to its first :param) appears anywhere. */
  function reached(full) {
    const stat = [];
    for (const segment of full.replace(/^\/api\/v1/, '').split('/').filter(Boolean)) {
      if (segment.startsWith(':')) break;
      stat.push(segment);
    }
    return stat.length === 0 || haystack.includes('/' + stat.join('/'));
  }

  return { routes, dead: routes.filter((route) => !reached(route.full)), prefixes };
}

function printReport({ routes, dead }) {
  const byArea = new Map();
  for (const route of dead) {
    const area = route.file.split('/')[4] ?? route.file;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(route);
  }

  console.log(`routes defined: ${routes.length}   no client reference: ${dead.length}\n`);
  for (const [area, list] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`── ${area} (${list.length})`);
    for (const route of list) console.log(`   ${route.verb.padEnd(6)} ${route.full}`);
  }
}

if (require.main === module) {
  try {
    printReport(scanRepo(ROOT));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: node scripts/unreachable-routes.js [repo-root]');
    process.exitCode = 1;
  }
}

module.exports = {
  assertNonEmptyRouteCensus,
  isProductionClientFile,
  moduleRoutes,
  registrationPrefixes,
  routePluginName,
  scanRepo,
};
