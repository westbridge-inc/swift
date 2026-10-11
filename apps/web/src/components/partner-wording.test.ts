import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner ruling (8 Oct, legal): Swift holds no money for anyone, so no partner
// screen may say "wallet", "top up" or speak of a money "balance". Prepaid
// weekly-fee credit is "Fee paid ahead"; paying is "Pay weekly fee". This scans
// what the partner consoles can put on screen (code comments are not screens).

const SRC = join(__dirname, '..');
const ROOTS = ['app/dashboard', 'app/portal', 'app/advertiser'];
const FILES = ['components/console-shell.tsx', 'components/business-status.tsx', 'components/advertiser-campaigns.tsx', 'components/notifications.tsx'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('partner consoles never use stored-money words', () => {
  const files = [...ROOTS.flatMap((root) => sources(join(SRC, root))), ...FILES.map((file) => join(SRC, file))];

  it('scans every console page', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((file) => [relative(SRC, file), file]))('%s', (_name, file) => {
    const code = withoutComments(readFileSync(file, 'utf8'));
    expect(code).not.toMatch(/\bwallet\b/i);
    expect(code).not.toMatch(/\btop[\s-]?up\b/i);
    expect(code).not.toMatch(/\bbalance\b/i);
  });
});
