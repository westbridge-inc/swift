import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// G9 — denying a permission must never be a silent dead end.
//
// On iOS the OS permission prompt appears once; after that, every tap on
// "Take photo" returned instantly and silently. A mover who cannot upload a
// licence cannot verify, go online, or earn — and nothing told them the fix
// lives in Settings. These are source assertions (the house pattern for
// component contracts): the denied branch must exist, must distinguish
// "cannot ask again" from a dismissed prompt, must open Settings, and must
// offer the OTHER source as a genuine escape hatch.
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/components/onboarding/DocumentUploadCard.tsx');

function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (out.trim().length < 500) throw new Error('comment stripper emptied the file — assertions would be vacuous');
  return out;
}

describe('document capture — permission denial is explained, with a way out', () => {
  const src = stripComments(readFileSync(FILE, 'utf8'));

  it('a denial no longer returns bare — both pickers route through the explainer', () => {
    // The old shape was `if (!perm.granted) return;` twice. Zero of those may
    // remain; both denials must call the explainer.
    expect(src).not.toMatch(/if \(!perm\.granted\) return;/);
    expect((src.match(/explainPermissionDenied\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // def + 2 calls
  });

  it('respects the difference between "dismissed the prompt" and "turned it off"', () => {
    // A user who swiped the OS prompt away has not chosen anything — nagging
    // them is wrong. Only canAskAgain === false gets the alert.
    expect(src).toContain('canAskAgain');
    expect(src).toMatch(/if \(canAskAgain\) return/);
  });

  it('offers Settings, because that is where the only real fix lives', () => {
    expect(src).toContain('Linking.openSettings');
    expect(src).toMatch(/Open Settings/);
  });

  it('offers the OTHER source — camera and library are separate permissions, so each is the other\'s escape hatch', () => {
    expect(src).toMatch(/explainPermissionDenied\('camera'[\s\S]{0,80}fromLibrary/);
    expect(src).toMatch(/explainPermissionDenied\('library'[\s\S]{0,80}fromCamera/);
  });
});
