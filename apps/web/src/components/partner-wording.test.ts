import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner ruling (8 Oct, legal): Swift holds no money for anyone, so no partner
// screen may say "wallet", "top up" or speak of a money "balance". Prepaid
// weekly-fee credit is "Fee paid ahead"; paying is "Pay weekly fee". This scans
// what the partner consoles can put on screen (code comments are not screens).

const SRC = join(__dirname, '..');
const ROOTS = ['app/dashboard', 'app/portal', 'app/advertiser'];
const FILES = ['components/console-shell.tsx', 'components/advertiser-campaigns.tsx', 'components/notifications.tsx',
  // The weekly-fee page every partner pays through, and its MMG words. (lib/card-fee.ts is
  // byte-identical to the phone copy by census and still says "added to your balance" for a
  // banked card payment: it has to be renamed in both apps together, so it is not scanned here.)
  'components/weekly-fee.tsx', 'components/card-pay.tsx', 'components/weekly-fee-destination.tsx', 'lib/weekly-fee.ts',
  // Everything else a console draws: the new-order takeover, the Switch app
  // sheet, the error and notice blocks, and the API helpers whose messages
  // reach the screen.
  'components/NewOrderTakeover.tsx', 'components/customer-shell.tsx', 'components/data-unavailable.tsx', 'components/mutation-notice.tsx',
  'lib/vendor-api.ts', 'lib/mover-api.ts', 'lib/partner-api.ts', 'lib/catalogue-name.ts',
  // The Orders home's cards and the app helpers they read (PR A).
  'components/orders-home.tsx', 'lib/vendor-hub.ts', 'lib/store-role.ts', 'lib/profile-store.ts', 'lib/mmg-pay-words.ts'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// Drop block comments and whole-line `//` comments only. A trailing `// …`
// after code is kept on purpose: a stray word there is a false alarm, never a
// missed screen string (the old pattern also cut real text after any `//`).
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
