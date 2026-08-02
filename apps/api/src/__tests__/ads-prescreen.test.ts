import { describe, it, expect } from 'vitest';
import { HeuristicAdPreScreenProvider, getAdPreScreenProvider } from '../providers/prescreen/ad-prescreen-provider';

// Ads §10.4 — the advisory pre-screen. The LAW under test: it annotates,
// it never decides — `ok:false` is "look closer", and the provider is
// deterministic + killable (ADS_PRESCREEN_PROVIDER=off → null → no
// annotation at all). Review/approval stays a human action everywhere.

const provider = new HeuristicAdPreScreenProvider();

describe('§10.4 heuristic pre-screen (advisory only)', () => {
  it('flags restricted-category terms ONLY when the tenant restricts them', async () => {
    const gambling = { headline: 'Big jackpot weekend', kind: 'IMAGE' as const };
    const restricted = await provider.screen({ ...gambling, restrictedCategories: { gambling: true } });
    expect(restricted.ok).toBe(false);
    expect(restricted.flags.map((f) => f.code)).toContain('RESTRICTED_CATEGORY');

    const unrestricted = await provider.screen({ ...gambling, restrictedCategories: { gambling: false } });
    expect(unrestricted.flags.map((f) => f.code)).not.toContain('RESTRICTED_CATEGORY');
  });

  it('flags superlative claims, shouting headlines, and non-http URL destinations', async () => {
    const r = await provider.screen({
      kind: 'IMAGE',
      headline: 'BEST DEALS GUARANTEED',
      body: 'The cheapest in town',
      destinationType: 'URL',
      destinationValue: 'javascript:alert(1)',
    });
    const codes = r.flags.map((f) => f.code);
    expect(codes).toContain('POSSIBLE_MISLEADING_CLAIM');
    expect(codes).toContain('ALL_CAPS_HEADLINE');
    expect(codes).toContain('LANDING_PAGE_SUSPECT');
    expect(r.ok).toBe(false);
  });

  it('a clean creative passes with zero flags', async () => {
    const r = await provider.screen({
      kind: 'IMAGE',
      headline: 'Fresh roti, hot daily',
      ctaLabel: 'Order now',
      destinationType: 'URL',
      destinationValue: 'https://roti.gy',
      restrictedCategories: { alcohol: true, gambling: true },
    });
    expect(r.ok).toBe(true);
    expect(r.flags).toHaveLength(0);
    expect(r.provider).toBe('heuristic');
  });

  it('the kill switch returns null — no provider, no annotation', () => {
    const prev = process.env['ADS_PRESCREEN_PROVIDER'];
    process.env['ADS_PRESCREEN_PROVIDER'] = 'off';
    expect(getAdPreScreenProvider()).toBeNull();
    process.env['ADS_PRESCREEN_PROVIDER'] = 'heuristic';
    expect(getAdPreScreenProvider()).not.toBeNull();
    if (prev === undefined) delete process.env['ADS_PRESCREEN_PROVIDER'];
    else process.env['ADS_PRESCREEN_PROVIDER'] = prev;
  });
});
