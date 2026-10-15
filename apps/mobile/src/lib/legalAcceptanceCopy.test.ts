import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLINE_LINE, acceptLabel, acceptTitle } from './legalAcceptanceCopy';

// ---------------------------------------------------------------------------
// [R26 · legal research G2] Phone build 12 asks for the fresh acceptance tick the website asks for: the same words,
// an unticked tick, Accept off until it is ticked, the served version sent, and a way out (delete the account).
// ---------------------------------------------------------------------------

const SRC = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');
const WEB_GATE = readFileSync(join(process.cwd(), '..', 'web', 'src', 'components', 'legal-acceptance-gate.tsx'), 'utf8');

describe('the phone fresh acceptance tick', () => {
  it('names every document, like the website', () => {
    expect(acceptLabel({ acceptedVersion: null, agreements: [] })).toBe('I agree to the Terms of Service and Privacy Policy.');
    expect(acceptLabel({ acceptedVersion: '2026-10-15', agreements: ['driver_agreement'] })).toBe('I agree to the updated Terms of Service, Privacy Policy and Mover Agreement.');
    expect(acceptLabel({ acceptedVersion: null, agreements: ['vendor_agreement'] })).toBe('I agree to the Terms of Service, Privacy Policy and Business Agreement.');
    // the website builds the same sentence the same way
    expect(WEB_GATE).toContain("return `I agree to the ${s.acceptedVersion ? 'updated ' : ''}${list}.`;");
    expect(acceptTitle({ acceptedVersion: '2026-10-15' })).toBe('We’ve updated our Terms');
    expect(acceptTitle({ acceptedVersion: null })).toBe('Please accept our Terms');
    expect(DECLINE_LINE).toMatch(/delete your account/);
  });

  it('the modal: unticked to start, Accept off until ticked, the served version sent, shown only to a signed-in person the server asks', () => {
    const modal = SRC('components', 'LegalAcceptanceModal.tsx');
    expect(modal).toMatch(/const \[ticked, setTicked\] = useState\(false\);/);
    expect(modal).toMatch(/disabled=\{!ticked\}/);
    expect(modal).toMatch(/accept\.mutate\(s\.currentVersion\)/);
    expect(modal).toMatch(/if \(!isAuthenticated \|\| !s\?\.needsAcceptance\) return null;/);
    expect(modal).toMatch(/enabled: isAuthenticated/);
  });

  it('is mounted over every stack', () => {
    expect(SRC('navigation', 'RootNavigator.tsx')).toMatch(/<LegalAcceptanceModal \/>/);
  });

  it('calls the API the website calls', () => {
    const api = SRC('services', 'api.ts');
    expect(api).toMatch(/legalAcceptance: \(\) => api\.get\('\/auth\/legal-acceptance'\)/);
    expect(api).toMatch(/acceptLegal: \(version: string\) => api\.post\('\/auth\/legal-acceptance', \{ version, accept: true \}\)/);
  });
});
