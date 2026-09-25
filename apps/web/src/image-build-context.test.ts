import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Q11] The site's own code imports two things from outside apps/web by path
// (src/lib/design-tokens.ts: the canonical tokens in packages/ui and the
// vertical tints in the mobile kit). The self-hosted image
// (apps/web/Dockerfile) builds from a context that carries only what it
// copies, so a new import from elsewhere in the monorepo would build here and
// in CI and then fail on the server, at deploy time. This keeps the two in
// step: every module the site imports from outside apps/web is copied into
// the image's build stage.
// ---------------------------------------------------------------------------

const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, '../..');

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test' && name !== '__tests__') sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Repo-relative paths the site's non-test code imports from outside apps/web. */
function importsOutsideTheSite(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(WEB_ROOT, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]!);
      if (relative(WEB_ROOT, target).startsWith('..')) found.add(relative(REPO_ROOT, target).split(sep).join('/'));
    }
  }
  return [...found].sort();
}

/** The repo paths the Dockerfile's build copies in (COPY sources, without --from stages). */
function copiedIntoTheImage(): string[] {
  const dockerfile = readFileSync(join(WEB_ROOT, 'Dockerfile'), 'utf8');
  return [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)$/gm)].flatMap((match) => {
    const args = match[1]!.split(/\s+/).filter((arg) => !arg.startsWith('--'));
    return args.slice(0, -1).map((source) => source.replace(/\/+$/, ''));
  });
}

describe('[Q11] the image build context carries what the site imports', () => {
  it('finds the imports it guards (the scan is not vacuous)', () => {
    expect(importsOutsideTheSite()).toEqual(
      expect.arrayContaining(['packages/ui/src', 'apps/mobile/src/kit/vertical-tint']),
    );
  });

  it('copies every module the site imports from outside apps/web into the build stage', () => {
    const copied = copiedIntoTheImage();
    // A COPY names a directory or one file; an import names a module without
    // its extension, so a file COPY covers the module it holds.
    const covers = (source: string, target: string): boolean =>
      target === source || target.startsWith(`${source}/`) || target === source.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
    const missing = importsOutsideTheSite().filter((target) => !copied.some((source) => covers(source, target)));
    expect(missing, 'add a COPY for each to apps/web/Dockerfile').toEqual([]);
  });
});
