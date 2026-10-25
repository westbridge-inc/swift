import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// [DOMAIN-1 · owner 2026-09-24] "everywhere in this whole platform even the
// email support, the emails are admin@swiftgy.com not swift.gy". Swift's domain
// is swiftgy.com. swift.gy is a domain Swift does not own, so every live
// reference to it (links, the API host, the pinned host, support and privacy
// addresses, CORS and CSP entries) sends a person, a share or a TLS pin to
// someone else.
//
// THE LAW: no product source, config or script names swift.gy, except where it
// is DENIED: the livetest guard and the test-target lock refuse it as
// production-looking, so a mistyped target can never be treated as ours. Tests
// may name it (they assert those refusals and the history).
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const OLD = /swift\.gy(?![a-z0-9-])/i; // swift.gy, never swiftgy.com

/** Directories and files whose contents ship or run. */
const SCOPES = [
  'apps/api/src', 'apps/api/prisma/seed.ts', 'apps/api/.env.example',
  'apps/mobile/src', 'apps/mobile/app.config.ts', 'apps/mobile/eas.json', 'apps/mobile/plugins', 'apps/mobile/.env.example',
  'apps/web/src', 'apps/web/next.config.ts', 'apps/web/.env.example', 'apps/web/public',
  'apps/admin/src', 'apps/admin/next.config.ts', 'apps/admin/.env.example', 'apps/admin/public',
  'apps/mobile/package.json', 'apps/mobile/index.js', 'package.json',
  'apps/desktop/src', 'apps/desktop/src-tauri/tauri.conf.json',
  'deploy', 'scripts', 'tools',
];

/** The two deny-lists, where naming swift.gy is the point. */
const DENY_LISTS = new Set(['scripts/livetest/guard.ts']);

const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|toml|md|example|conf|caddy|Caddyfile|html|txt|webmanifest|xml)$|Caddyfile$|\.env\.example$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'target', '.expo', 'coverage', 'gen', '__tests__']);

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    out.push(path);
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(path, name), out);
  }
}

describe('swiftgy.com everywhere', () => {
  const files: string[] = [];
  for (const scope of SCOPES) walk(join(ROOT, scope), files);
  const shipped = files
    .map((f) => relative(ROOT, f))
    .filter((f) => SOURCE.test(f) && !/\.test\.(ts|tsx|js)$/.test(f));

  it('scans what ships (the scan is not vacuous)', () => {
    expect(shipped.length).toBeGreaterThan(500);
    for (const must of ['apps/mobile/app.config.ts', 'apps/mobile/eas.json', 'apps/api/src/modules/legal/legal.routes.ts', 'scripts/livetest/guard.ts']) {
      expect(shipped).toContain(must);
    }
  });

  it('no shipped file names swift.gy outside the deny-lists', () => {
    const offenders = shipped
      .filter((f) => !DENY_LISTS.has(f))
      .flatMap((f) => readFileSync(join(ROOT, f), 'utf8').split('\n').map((line, i) => ({ f, line, n: i + 1 })))
      // The test-target lock's deny regex spells it with an escaped dot, which never matches OLD.
      .filter(({ line }) => OLD.test(line))
      .map(({ f, n, line }) => `${f}:${n}: ${line.trim().slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });

  it('the deny-lists still refuse the old name, so it can never be mistaken for production that is ours', () => {
    expect(readFileSync(join(ROOT, 'scripts/livetest/guard.ts'), 'utf8')).toMatch(/PUBLIC_SUFFIXES = \[[^\]]*'swift\.gy'/);
    expect(readFileSync(join(ROOT, 'apps/api/src/lib/test-target-lock.ts'), 'utf8')).toContain('swift\\.gy');
  });

  it('the live hosts are swiftgy.com: the production API, its TLS pin, share links, and the privacy and child-safety inboxes', () => {
    const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
    expect(read('apps/mobile/src/services/apiOrigin.ts')).toContain("'https://api.swiftgy.com'");
    expect(read('apps/mobile/app.config.ts')).toContain("'api.swiftgy.com': {");
    expect(read('apps/mobile/plugins/withTlsPinning.js')).toContain('<domain includeSubdomains="true">api.swiftgy.com</domain>');
    expect(JSON.parse(read('apps/mobile/eas.json')).build.production.env.EXPO_PUBLIC_API_URL).toBe('https://api.swiftgy.com');
    const legal = read('apps/api/src/modules/legal/legal.routes.ts');
    expect(legal).toContain('privacy@swiftgy.com');
    expect(legal).toContain('childsafety@swiftgy.com');
  });
});
