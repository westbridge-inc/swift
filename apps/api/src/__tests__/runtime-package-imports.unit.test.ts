import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// THE COMPILED API CAN ONLY LOAD A WORKSPACE PACKAGE THAT SHIPS A BUILD.
//
// The API runs as compiled CommonJS (apps/api/dist). A workspace package whose
// package.json has no "require" export condition ships TypeScript source only,
// so `require('@swift/types')` in dist hits `export` and the process dies at
// boot ("SyntaxError: Unexpected token 'export'"). The tests never see it:
// vitest runs the TypeScript source. On 15 Oct the first private production
// boot crash-looped on exactly this (one value import from @swift/types).
//
// Rule: from such a package the API may import TYPES only. A package that ships
// a build (a "require" condition, e.g. @swift/ui, built in apps/api/Dockerfile)
// may be imported normally.
// ---------------------------------------------------------------------------

const API_SRC = join(__dirname, '..');
const PACKAGES = join(API_SRC, '..', '..', '..', 'packages');

function sourceOnlyPackages(): string[] {
  return readdirSync(PACKAGES)
    .filter((dir) => statSync(join(PACKAGES, dir)).isDirectory())
    .flatMap((dir) => {
      const file = join(PACKAGES, dir, 'package.json');
      let pkg: { name?: string; exports?: Record<string, unknown> };
      try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
      const root = pkg.exports?.['.'];
      const hasRequireBuild = typeof root === 'object' && root !== null && 'require' in root;
      return pkg.name && !hasRequireBuild ? [pkg.name] : [];
    });
}

function runtimeSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'generated' ? [] : runtimeSources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every import/export-from/require of `pkg` in `text` that can load a runtime value. */
export function runtimeImportsOf(source: string, pkg: string): string[] {
  // Comments never load anything (and may say "import … from" in prose).
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const quoted = `['"]${pkg.replace('/', '\\/')}['"]`;
  const found: string[] = [];
  const fromClause = new RegExp(`^\\s*(import|export)\\s+([^;]*?)\\s+from\\s+${quoted}`, 'gms');
  for (const m of text.matchAll(fromClause)) {
    const clause = (m[2] ?? '').trim();
    if (clause.startsWith('type ') || clause.startsWith('type{')) continue; // import type { … } / export type { … }
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces) {
      const names = (braces[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue; // import { type A, type B }
    }
    found.push(m[0].replace(/\s+/g, ' '));
  }
  for (const m of text.matchAll(new RegExp(`(import|require)\\s*\\(\\s*${quoted}\\s*\\)`, 'g'))) found.push(m[0]);
  for (const m of text.matchAll(new RegExp(`import\\s+${quoted}`, 'g'))) found.push(m[0]);
  return found;
}

describe('the compiled API loads no runtime value from a source-only workspace package', () => {
  it('finds the source-only packages (guards the census itself)', () => {
    expect(sourceOnlyPackages()).toContain('@swift/types');
    expect(sourceOnlyPackages()).not.toContain('@swift/ui');
  });

  it('the matcher tells type imports from value imports', () => {
    expect(runtimeImportsOf(`import type { A } from '@swift/types';`, '@swift/types')).toEqual([]);
    expect(runtimeImportsOf(`import {\n  type A,\n  type B,\n} from '@swift/types';`, '@swift/types')).toEqual([]);
    expect(runtimeImportsOf(`import { A } from '@swift/types';`, '@swift/types')).toHaveLength(1);
    expect(runtimeImportsOf(`import { type A, B } from '@swift/types';`, '@swift/types')).toHaveLength(1);
    expect(runtimeImportsOf(`export { A } from '@swift/types';`, '@swift/types')).toHaveLength(1);
    expect(runtimeImportsOf(`const t = require('@swift/types');`, '@swift/types')).toHaveLength(1);
    expect(runtimeImportsOf(`const t = await import('@swift/types');`, '@swift/types')).toHaveLength(1);
    expect(runtimeImportsOf(`// the import below pins it\nimport type { A } from '@swift/types';`, '@swift/types')).toEqual([]);
    expect(runtimeImportsOf(`/* import { A } from '@swift/types' */`, '@swift/types')).toEqual([]);
  });

  it('no API runtime file imports a value from one', () => {
    const packages = sourceOnlyPackages();
    const offenders = runtimeSources(API_SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return packages.flatMap((pkg) => runtimeImportsOf(text, pkg).map((hit) => `${relative(API_SRC, file)}: ${hit}`));
    });
    expect(offenders).toEqual([]);
  });
});
