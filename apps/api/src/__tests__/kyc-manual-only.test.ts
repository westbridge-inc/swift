import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKycProvider, ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { degradedProvider, extractWithLadder, EXTRACTION_UNAVAILABLE } from '../modules/verification/degradation';

// [NO-AI · owner rule 2026-09-07] The manual review engine is the only KYC provider
// left. It reads nothing and decides nothing: a result is a reference for the ledger,
// and the contract has no field through which a verdict could travel. The factory
// refuses to construct anything else; boot-config.test.ts grades the boot refusal.

afterEach(() => vi.unstubAllEnvs());

describe('the manual review engine — the only KYC provider', () => {
  it('returns a reference and nothing else: no verdict, no fields, no confidence', async () => {
    const result = await new ManualReviewKycProvider().verifyDocument();
    expect(result.referenceToken).toMatch(/^manual_[0-9a-f-]{36}$/);
    expect(Object.keys(result)).toEqual(['referenceToken']);
    expect(result).not.toHaveProperty('status');
  });

  it('mints a fresh reference per document (the ledger can tell two submissions apart)', async () => {
    const engine = new ManualReviewKycProvider();
    const [a, b] = await Promise.all([engine.verifyDocument(), engine.verifyDocument()]);
    expect(a.referenceToken).not.toBe(b.referenceToken);
  });

  it('describes itself as a local engine: nothing leaves Swift infrastructure', () => {
    expect(new ManualReviewKycProvider().engine).toEqual({ name: 'manual-review', version: '1', external: false });
  });

  it('the factory constructs it for KYC_PROVIDER=manual and refuses every other value, naming the value it saw', () => {
    vi.stubEnv('KYC_PROVIDER', 'manual');
    expect(getKycProvider()).toBeInstanceOf(ManualReviewKycProvider);
    for (const name of ['sandbox', 'unknown', '', 'MANUAL', ['di', 'dit'].join(''), ['id', 'analyzer'].join('')]) {
      vi.stubEnv('KYC_PROVIDER', name);
      expect(() => getKycProvider(), name).toThrow(`got ${JSON.stringify(name)}`);
    }
  });

  it('refuses an unset KYC_PROVIDER too — there is no default to fall through to', () => {
    const previous = process.env['KYC_PROVIDER'];
    delete process.env['KYC_PROVIDER'];
    try {
      expect(() => getKycProvider()).toThrow(/got unset/);
    } finally {
      if (previous !== undefined) process.env['KYC_PROVIDER'] = previous;
    }
  });

  it('an outage through the ladder is not a verdict either: the degraded result carries only the tag and the reason', async () => {
    const down = degradedProvider(new ManualReviewKycProvider(), 'throw');
    const result = await extractWithLadder(() => down.verifyDocument({ userId: 'u', docType: 'national_id', fileUrl: 'f' }));
    expect(result).toEqual({ referenceToken: '', reason: 'extraction service down', degraded: EXTRACTION_UNAVAILABLE });
  });
});
