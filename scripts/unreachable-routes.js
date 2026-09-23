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

function splitTopLevelArguments(source) {
  const arguments_ = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      arguments_.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  arguments_.push(source.slice(start).trim());
  return arguments_;
}

/** Return app.register calls with balanced arguments; regex alone would turn an
 * unsupported second argument into a misleading root mount. */
function appRegisterCalls(source) {
  const calls = [];
  const start = /\bapp\.register\s*\(/g;
  for (let match; (match = start.exec(source));) {
    const open = source.indexOf('(', match.index);
    let quote = null;
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close === -1) throw new Error('Unsupported app.register grammar: unterminated call.');
    calls.push(splitTopLevelArguments(source.slice(open + 1, close)));
    start.lastIndex = close + 1;
  }
  return calls;
}

/** Parse composition-root plugin registrations without importing them (which
 * would boot plugins and require live infrastructure). Root-mounted plugins
 * deliberately receive an empty prefix. When `pluginNames` is supplied, calls
 * outside that source-derived route/helper set are intentionally ignored. */
function registrationPrefixes(source, pluginNames) {
  const prefixes = new Map();
  for (const args of appRegisterCalls(source)) {
    const plugin = args[0];
    if (pluginNames && !pluginNames.has(plugin)) continue;
    if (!/^\w+$/.test(plugin)) {
      throw new Error(`Unsupported app.register plugin expression: ${plugin}.`);
    }
    if (args.length === 1) {
      prefixes.set(plugin, '');
      continue;
    }
    if (args.length !== 2) {
      throw new Error(`Unsupported app.register options for ${plugin}: expected no options or a literal prefix.`);
    }
    const literalPrefix = /^\{\s*prefix\s*:\s*(['"])([^'"\\]*)\1\s*,?\s*\}$/.exec(args[1]);
    if (!literalPrefix) {
      throw new Error(`Unsupported app.register options for ${plugin}: expected a literal { prefix: '...' }.`);
    }
    prefixes.set(plugin, literalPrefix[2]);
  }
  return prefixes;
}

function routePluginName(source) {
  return source.match(/export\s+(?:default\s+)?async\s+function\s+(\w+)\s*\(/)?.[1];
}

function finiteLoopValues(source, variable) {
  const loop = new RegExp(`\\bfor\\s*\\(\\s*const\\s+${variable}\\s+of\\s+(\\w+)\\s*\\)`).exec(source);
  if (!loop) return null;
  const declaration = new RegExp(`\\b(?:const|let)\\s+${loop[1]}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as\\s+const)?\\s*;`).exec(source);
  if (!declaration) return null;
  const values = declaration[1].split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || !values.every((value) => /^(['"])([^'"\\]*)\1$/.test(value))) return null;
  return values.map((value) => value.slice(1, -1));
}

function staticRoutePaths(source, declaredPath) {
  let paths = [declaredPath];
  for (const variable of new Set([...declaredPath.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]))) {
    const values = finiteLoopValues(source, variable);
    paths = paths.flatMap((current) => (values ?? [':dynamic']).map((value) => current.replace(`\${${variable}}`, value)));
  }
  return paths;
}

function moduleRoutes(source, prefix, file, root) {
  const routes = [];
  let routeDeclarations = 0;
  for (const match of source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"`])([\s\S]*?)\2/g)) {
    routeDeclarations += 1;
    for (const declaredPath of staticRoutePaths(source, match[3])) {
      routes.push({
        verb: match[1].toUpperCase(),
        full: (prefix + declaredPath).replace(/\/$/, '') || '/',
        file: path.relative(root, file),
      });
    }
  }
  const routeMethodMentions = [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\b/g)].length;
  if (routeDeclarations !== routeMethodMentions) {
    throw new Error(
      `Unsupported route declaration grammar in ${path.relative(root, file)}: `
      + `${routeMethodMentions} app method calls but ${routeDeclarations} static declarations parsed.`,
    );
  }
  return routes;
}

function resolveImportPath(compositionPath, specifier) {
  const base = path.resolve(path.dirname(compositionPath), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve composition-root import ${specifier} from ${compositionPath}.`);
}

function compositionImports(source, compositionPath) {
  const imports = new Map();
  for (const match of source.matchAll(/import\s+([^;\n]+?)\s+from\s+(['"])(\.[^'"]+)\2\s*;/g)) {
    const bindings = match[1];
    const file = resolveImportPath(compositionPath, match[3]);
    const defaultBinding = /^\s*(\w+)/.exec(bindings)?.[1];
    if (defaultBinding) imports.set(defaultBinding, file);
    const named = /\{([^}]*)\}/.exec(bindings)?.[1];
    if (!named) continue;
    for (const item of named.split(',')) {
      const binding = item.trim().replace(/^type\s+/, '');
      if (!binding) continue;
      const local = /\s+as\s+(\w+)$/.exec(binding)?.[1] ?? binding;
      if (/^\w+$/.test(local)) imports.set(local, file);
    }
  }
  return imports;
}

function directAppHelpers(source, imports) {
  const helpers = new Set();
  for (const match of source.matchAll(/\b(\w+)\s*\(\s*app(?:\s*,|\s*\))/g)) {
    if (imports.has(match[1])) helpers.add(match[1]);
  }
  return helpers;
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
  // The composition import resolver returns absolute paths. Normalize here,
  // not only in the CLI wrapper, so programmatic callers cannot compare a
  // relative `scanned` path with an absolute imported-helper path and count
  // the same routes twice.
  root = path.resolve(root);
  const compositionPath = path.join(root, 'apps/api/src/app.ts');
  if (!fs.existsSync(compositionPath)) {
    throw new Error(`Not a Swift checkout: ${compositionPath} does not exist.`);
  }

  // 1. Route table — each module's registration prefix, then its app.<verb>(path).
  // Also scan source files for composition-root helpers/plugins actually invoked
  // by app.ts. This remains a static declaration census, not Fastify runtime data.
  const composition = fs.readFileSync(compositionPath, 'utf8');
  const imports = compositionImports(composition, compositionPath);
  const moduleFiles = walk(path.join(root, 'apps/api/src/modules')).filter((file) => file.endsWith('.routes.ts'));
  const modulePlugins = new Set(moduleFiles.map((file) => routePluginName(fs.readFileSync(file, 'utf8'))));
  if (modulePlugins.has(undefined)) {
    throw new Error('Unsupported route-plugin export grammar in apps/api/src/modules.');
  }
  const prefixes = registrationPrefixes(composition, new Set([...imports.keys(), ...modulePlugins]));
  const routes = moduleRoutes(composition, '', compositionPath, root);
  const scanned = new Set([compositionPath]);
  for (const file of moduleFiles) {
    const body = fs.readFileSync(file, 'utf8');
    const plugin = routePluginName(body);
    if (!plugin) {
      throw new Error(`Unsupported route-plugin export grammar in ${path.relative(root, file)}.`);
    }
    if (!prefixes.has(plugin)) {
      throw new Error(`Route plugin ${plugin} is not registered by ${path.relative(root, compositionPath)}.`);
    }
    routes.push(...moduleRoutes(body, prefixes.get(plugin), file, root));
    scanned.add(file);
  }
  for (const helper of new Set([...prefixes.keys(), ...directAppHelpers(composition, imports)])) {
    const file = imports.get(helper);
    if (!file || scanned.has(file)) continue;
    routes.push(...moduleRoutes(fs.readFileSync(file, 'utf8'), prefixes.get(helper) ?? '', file, root));
    scanned.add(file);
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
