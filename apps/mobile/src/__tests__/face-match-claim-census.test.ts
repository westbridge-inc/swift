import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faceMatchedDocTypes } from '../components/onboarding/documentChecklistPresentation';

// ---------------------------------------------------------------------------
// [GUARDRAILS §4 · §8 · counsel packet, Part 1 "Documents and identity checks"] Face-matching is OFF
// (FD-D5; owner 13 Oct: automated identity decisions stay off) — identity checks are made by people.
// No screen may tell a person their face was matched while it is off. Since #1429 (1 Oct) the one
// sentence that says so — the document card's "Face-matched against your profile selfie" — shows
// ONLY for a document the server's GET /verification/status names in `faceMatchDocTypes`, which the
// server leaves empty while face-matching is off (apps/api verification-face-match-truth.test.ts).
// This census pins the client side of that promise across the phone app, the website and the admin
// console: the words appear in exactly one place, behind exactly that gate, and nowhere else.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '..');
const CLAIM = /face[- ]match(?:ed|es|ing)?\b|faces? (?:were|was|are|is) (?:matched|compared)|matched (?:against|to) your (?:profile|selfie)/i;

/** Source text with comments removed, so a code note about the switch is not a claim to a person. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.|\.spec\./.test(name) && !path.includes('__tests__')) out.push(path);
  }
  return out;
}

/** Every user-facing "face matched" claim in a client app, as `file: line text`. */
function claims(): string[] {
  const found: string[] = [];
  for (const app of ['mobile', 'web', 'admin']) {
    for (const file of sourceFiles(join(ROOT, app, 'src'))) {
      // The served legal texts are the API's own words, snapshotted (legal:sync); the V1b batch owns them.
      if (file.endsWith(join('web', 'src', 'legal', 'generated.ts'))) continue;
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line) => {
        if (CLAIM.test(line)) found.push(`${relative(ROOT, file)}: ${line.trim()}`);
      });
    }
  }
  return found;
}

const CARD = readFileSync(join(process.cwd(), 'src', 'components', 'onboarding', 'DocumentUploadCard.tsx'), 'utf8');
const CHECKLIST = readFileSync(join(process.cwd(), 'src', 'components', 'onboarding', 'DocumentChecklist.tsx'), 'utf8');

describe('no client says a face was matched while face-matching is off', () => {
  it('the phone, the website and the admin console carry exactly one such sentence: the document card line', () => {
    expect(claims()).toEqual(['mobile/src/components/onboarding/DocumentUploadCard.tsx: Face-matched against your profile selfie']);
  });

  it('the card shows that line only under its faceMatched prop, which defaults to false', () => {
    expect(CARD).toMatch(/\{faceMatched \? \(\s*<T[^>]*>\s*Face-matched against your profile selfie\s*<\/T>\s*\) : null\}/);
    expect(CARD).toMatch(/faceMatched = false,/);
  });

  it('the checklist sets faceMatched only from the server’s own faceMatchDocTypes list', () => {
    expect(CHECKLIST).toMatch(/const faceMatched = faceMatchedDocTypes\(status\);/);
    const props = CHECKLIST.match(/faceMatched=\{[^}]*\}/g) ?? [];
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) expect(prop).toBe('faceMatched={faceMatched.has(docType)}');
  });

  it('face-matching off: the server sends an empty list (or nothing) and no document is named', () => {
    for (const status of [{ faceMatchDocTypes: [] }, {}, null, undefined, { checklist: ['national_id'] }]) {
      expect(faceMatchedDocTypes(status as never).size).toBe(0);
    }
  });
});
