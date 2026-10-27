import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// [Board 13a "CASH COLLECTED" · owner 25 Oct 22:33Z] The earnings screen's fourth tile, beside ALL TIME: the cash the
// mover kept from cash jobs this week, read from the server's figure (cashInHand, GET /{rider,driver}/earnings/summary).
// Never computed on the phone, never shown as a guessed 0 when an older API sends nothing, and worded per role: a
// rider's figure is after paying stores, a driver's is cash fares (an MMG fare is never counted as cash).
const screen = readFileSync(new URL('./EarningsScreen.tsx', import.meta.url), 'utf8');
const tiles = screen.slice(screen.indexOf('label="ALL TIME"'), screen.indexOf('RECENT BREAKDOWN'));

describe('[board 13a] CASH COLLECTED tile', () => {
  it("shows the server's this-week cash in hand, only when the server sent it", () => {
    expect(screen).toContain('const cashThisWeek = cashInHandThisWeek(summaryQ.data);');
    expect(tiles).toMatch(/\{cashThisWeek != null \? \(\s*<StatTile label="CASH COLLECTED" total=\{cashThisWeek\} sub="This week" \/>/);
  });

  it('says what the figure is for each role, whole, under the row (the tile sub is one line) [REVIEW-F S3-1]', () => {
    const caption = tiles.slice(tiles.indexOf('label="CASH COLLECTED"'));
    expect(caption).toMatch(/\{cashThisWeek != null \? \(\s*<T variant="caption"/);
    expect(caption).toContain("'Cash collected this week: the fares passengers paid you in cash.'");
    expect(caption).toContain("'Cash collected this week, after paying stores for the goods.'");
    expect(caption).not.toMatch(/numberOfLines/);
  });

  it('sits in the row beside ALL TIME (the 2 x 2 grid of the board)', () => {
    const row = screen.slice(screen.lastIndexOf('<View', screen.indexOf('label="ALL TIME"')), screen.indexOf('RECENT BREAKDOWN'));
    expect(row.indexOf('label="ALL TIME"')).toBeLessThan(row.indexOf('label="CASH COLLECTED"'));
    expect(row.slice(0, row.indexOf('label="CASH COLLECTED"'))).not.toContain('</View>');
  });
});

// [CARS-DELIVER PR4 · REVIEW-M #2138 S4-3] An account with a taxi AND a delivery profile also sees the other profile's
// week (otherProfileWeek, earner-data.test.ts), read from that profile's own summary only for such an account.
describe('[CARS-DELIVER PR4] the other profile’s week on the earnings screen', () => {
  it('asks for the other summary only for an account with both, and shows it in its own card', () => {
    expect(screen).toContain("const otherKind: 'DRIVER' | 'RIDER' | null = mover.dual === true && kind ? (kind === 'DRIVER' ? 'RIDER' : 'DRIVER') : null;");
    expect(screen).toContain('const otherSummaryQ = useEarningsSummary<unknown>(otherKind);');
    expect(screen).toContain('const other = otherKind ? otherProfileWeek(otherKind, otherSummaryQ.data) : undefined;');
    const card = screen.slice(screen.indexOf('{other ? ('));
    expect(card).toMatch(/^\{other \? \(\s*<Card[^>]*>\s*<T variant="micro" tone="muted">\{other\.title\}<\/T>/);
    expect(card).toContain('{money(other.total)}');
    expect(card).toContain('{other.cash ? ');
    expect(card).toContain('{other.note}');
  });
});
