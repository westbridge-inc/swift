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
  const banned = /\b(pharmac\w*|medicines?|liquor|alcohol|beer|wine|rum|tobacco|cigarettes?|vapes?)\b/i;
  // [owner #67] The one sentence that names the goods only to refuse them, beside the parcel tick. It is exempt only
  // as the WHOLE text of an element (">…<"), exactly as written: a sentence that goes on ("…, but our partners
  // deliver beer"), is negated or quoted, or differs by a word is checked like any other line.
  const REFUSAL = 'Swift never carries alcohol, tobacco, vapes, medicines, cannabis or other drugs, cooking gas (LPG), fuel or 18+ items.';
  const REFUSALS: readonly string[] = [REFUSAL];
  /** The lines of a page's source that name the goods, after removing only exact, whole-element refusals. */
  const promisingLines = (text: string): string[] => withoutComments(text).split('\n')
    .filter((line) => banned.test(REFUSALS.reduce((rest, sentence) => rest.split(`>${sentence}<`).join('><'), line)));

  it('a refusal is exempt only as the exact, whole sentence; a promise is still caught', () => {
    const refusal = `<span id="x">${REFUSAL}</span>`;
    expect(promisingLines(refusal)).toEqual([]);
    for (const promise of [
      '<p>Markets & pharmacies</p>',
      '<p>Cold beer and wine delivered</p>',
      '<p>Swift never sells alcohol, but our partners deliver beer</p>',
      `<span>${REFUSAL} Cold beer delivered.</span>`,
      `<span>${REFUSAL.replace('.', ', but partners deliver beer.')}</span>`,
      `<span>It is not true that ${REFUSAL}</span>`,
      `<span>"${REFUSAL}"</span>`,
      `<span>${REFUSAL.replace('never', 'now')}</span>`,
      `<span>${REFUSAL.replace('alcohol, ', '')}</span>`,
    ]) expect(promisingLines(promise), promise).toEqual([promise]);
    // The refusal on a page that promises the goods elsewhere: the promise is still found.
    expect(promisingLines(`${refusal}\n<p>Rum and wine to your door</p>`)).toEqual(['<p>Rum and wine to your door</p>']);
  });

  it('no page promises a pharmacy, medicines, alcohol, tobacco or vapes', () => {
    // Every page is read: 165 when the refusal exemption came in (owner #67), the courier page among them.
    expect(sources.length).toBeGreaterThanOrEqual(165);
    expect(sources.some((file) => file.endsWith(join('(app)', 'courier', 'page.tsx')))).toBe(true);
    const found = sources.flatMap((file) => promisingLines(readFileSync(file, 'utf8'))
      .map((line) => `${relative(SRC, file)}: ${line.trim().slice(0, 120)}`));
    expect(found).toEqual([]);
  });
});
