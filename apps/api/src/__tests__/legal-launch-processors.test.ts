import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVACY } from '../modules/legal/legal.routes';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { productionKycReach } from './helpers/kyc-production-reach';

// ---------------------------------------------------------------------------
// [L13 item 3] THE PRIVACY POLICY NAMES THE PROCESSORS PRODUCTION CAN REACH
//
// The policy used to name an external identity-verification provider (Didit or
// ID Analyzer) as a recipient of every verification document and selfie. The
// launch build refuses both in production (manual review only), so that
// sentence described processing that cannot happen. The reverse failure is
// just as bad: the adapters still exist in source, so a later change could
// re-admit one while the policy says nobody receives the documents.
//
// So the policy is graded against what the production factory actually admits,
// derived here from the code rather than from a list in this test.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllEnvs(); });

const partyOf = (ref: string) => PROCESSOR_REGISTER.find((p) => p.ref === ref)!.party;

describe('[L13 item 3] the Privacy Policy names only processors production can reach', () => {
  it('production admits no external identity-verification processor (guard: both adapters are seen and refused)', () => {
    const { admitted, refused } = productionKycReach();
    expect([...admitted]).toEqual([]);
    expect([...refused].sort()).toEqual(['DIDIT', 'ID_ANALYZER']);
  });

  it('a processor production refuses is not presented as a recipient', () => {
    const { refused } = productionKycReach();
    for (const ref of refused) {
      expect(PRIVACY, `${partyOf(ref)} cannot receive documents in production but the policy names it`).not.toContain(partyOf(ref));
    }
    expect(PRIVACY).not.toMatch(/processed by our identity-verification provider/i);
  });

  it('while no external identity processor is admitted, the policy says verification is done by people, without automated reading or face-matching', () => {
    const { admitted } = productionKycReach();
    if (admitted.size > 0) {
      for (const ref of admitted) expect(PRIVACY, `${partyOf(ref)} is admitted in production and must be disclosed`).toContain(partyOf(ref));
      return;
    }
    expect(PRIVACY).toMatch(/Identity verification is done by (?:people|our verification team)/);
    expect(PRIVACY).toMatch(/no automated document-reading or face-matching/i);
    expect(PRIVACY).toMatch(/no identity-verification provider receives your documents or selfie/i);
  });

  it('error reports are described as the self-hosted service the register records, not a third party', () => {
    const tracking = PROCESSOR_REGISTER.find((p) => p.ref === 'ERROR_TRACKING')!;
    expect(tracking.transferBasis).toBe('SELF_HOSTED');
    expect(PRIVACY).not.toMatch(/\bSentry\b/);
    expect(PRIVACY).toMatch(/error-tracking service that Swift runs on its own servers/i);
  });

  it('routes and travel estimates are attributed to Swift\'s own servers, not to Google', () => {
    const google = PROCESSOR_REGISTER.find((p) => p.ref === 'GOOGLE_MAPS')!;
    const osrm = PROCESSOR_REGISTER.find((p) => p.ref === 'OSRM')!;
    expect(osrm.transferBasis).toBe('SELF_HOSTED');
    expect(google.note).toMatch(/DORMANT/);
    expect(PRIVACY).not.toMatch(/Google Maps \([^)]*travel estimates/i);
    expect(PRIVACY).toMatch(/Routes, travel estimates and address search run on Swift's own servers/);
  });

  it('the hosting and storage company is named', () => {
    expect(PRIVACY).toMatch(/DigitalOcean \(hosts Swift's servers and databases, and the encrypted storage/);
  });
});
