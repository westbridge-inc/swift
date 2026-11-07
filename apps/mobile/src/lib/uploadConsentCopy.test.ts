import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_CONSENT_TEXT } from './uploadConsentCopy';

// ---------------------------------------------------------------------------
// [R17 · legal research D2/B1/G4, in-app ¶15] Phone build 12 asks for a tick before any upload: the document
// checklist (partners) and the customer ID screen. [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b)] This app has no
// customer ID screen any more (Swift asks for no customer ID): the checklist's tick is the one left. The words are the ones the API anchors the ledger row to, the
// ticks start unticked, nothing uploads before them, and the uploads tell the API the tick was shown. Builds 9-11
// send no tick and get no ledger row.
// ---------------------------------------------------------------------------

const API = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'verification', 'upload-consent.ts'), 'utf8');
const SRC = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');
const textOf = (key: string) => new RegExp(`${key}: \\{[\\s\\S]*?text: '([^']+)'`).exec(API)?.[1];

describe('the phone upload ticks', () => {
  it('say the words the API records, word for word', () => {
    expect(textOf('document_v1')).toBe(DOCUMENT_CONSENT_TEXT);
  });

  it('the checklist: an unticked tick, and every card waits for it', () => {
    const list = SRC('components', 'onboarding', 'DocumentChecklist.tsx');
    // [DOC-CONSENT] Unticked unless the person ticks it on this visit or their own grant is on record (the server's
    // ledger); DocumentChecklist.consent.navigation.test.ts renders both ways and every "not on record" answer.
    expect(list).toMatch(/const \[choice, setChoice\] = useState<boolean \| null>\(null\);/);
    expect(list).toMatch(/const consented = choice \?\? record\.given;/);
    expect(list).toMatch(/const record = documentConsentOnRecord\(status\);/);
    expect(list).toMatch(/\{DOCUMENT_CONSENT_TEXT\}/);
    expect((list.match(/consented=\{consented\}/g) ?? []).length).toBe((list.match(/<DocumentUploadCard\b/g) ?? []).length);
    const card = SRC('components', 'onboarding', 'DocumentUploadCard.tsx');
    expect(card).toMatch(/consented = false,/);
    // [POLICE-CLEARANCE CONSENT] the card waits for its tick: the list's, or a police clearance's own
    expect(card).toMatch(/disabled=\{approved \|\| upload\.isPending \|\| !canUpload\}/);
    expect(card).toMatch(/const canUpload = ownTick \? policeTicked : consented;/);
    expect(card).toMatch(/const \[policeTicked, setPoliceTicked\] = useState\(false\);/);
  });

  it('[CHECKLIST-LEGAL (b)] there is no customer ID screen and no customer ID tick', () => {
    expect(() => SRC('modules', 'account', 'screens', 'IdentityVerificationScreen.tsx')).toThrow();
    expect(SRC('hooks', 'verification.ts')).not.toMatch(/customer_id_v/);
  });

  it('the uploads tell the API which tick they showed', () => {
    const hooks = SRC('hooks', 'verification.ts');
    expect(hooks).toMatch(/consentTick: 'document_v1'/);
  });

  it('no review-time promise faster than the support hours', () => {
    for (const f of [SRC('components', 'onboarding', 'DocumentChecklist.tsx'), SRC('modules', 'mover', 'screens', 'MoverOnboardingScreen.tsx')]) {
      expect(f).not.toMatch(/within 24 hours/);
      // [Owner 30 Oct 2026] The review hours are the support hours: Monday to Saturday, 8:00–16:00 Guyana time.
      expect(f).toContain('Monday to Saturday, 8:00–16:00 Guyana time');
      expect(f).not.toContain('20:00');
    }
  });
});
