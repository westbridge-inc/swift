import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// [owner, staging 12 Oct] Customers read plain words. "Swift's server confirms
// …" is how the system works inside, not something a customer needs: the
// pages say "we confirm …" instead. Comments may still name the server.
const SRC = join(process.cwd(), 'src');
function filesUnder(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, found); else found.push(path);
  }
  return found;
}
const sources = filesUnder(SRC).filter((file) => /\.tsx$/.test(file) && !/\.test\./.test(file));
/** Drop // and block comments so only what can reach the screen is checked. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('customer words', () => {
  it('no page tells a customer about "Swift’s server"', () => {
    const found = sources.flatMap((file) => withoutComments(readFileSync(file, 'utf8')).split('\n')
      .filter((line) => /Swift[’']s server/.test(line))
      .map((line) => `${relative(SRC, file)}: ${line.trim().slice(0, 120)}`));
    expect(found).toEqual([]);
  });

  // [GUARDRAILS §8, owner 13 Oct 2026] Swift never sells alcohol, tobacco, vapes,
  // 18+ items, medicines, cooking gas or fuel, so no page promises them — the
  // Groceries chip once offered "Markets & pharmacies" and the Shops card "Pharmacy".
  it('no page promises a pharmacy, medicines, alcohol, tobacco or vapes', () => {
    const banned = /\b(pharmac\w*|medicines?|liquor|alcohol|beer|wine|rum|tobacco|cigarettes?|vapes?)\b/i;
    const found = sources.flatMap((file) => withoutComments(readFileSync(file, 'utf8')).split('\n')
      .filter((line) => banned.test(line))
      .map((line) => `${relative(SRC, file)}: ${line.trim().slice(0, 120)}`));
    expect(found).toEqual([]);
  });
});
