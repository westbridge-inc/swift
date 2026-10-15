import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_REVIEW_PROMISE, faceMatchedDocTypes } from '../components/onboarding/documentChecklistPresentation';

// ---------------------------------------------------------------------------
// [GUARDRAILS §4 · §8 · counsel packet, Part 1 "Documents and identity checks"] Face-matching is OFF
// (FD-D5; owner 13 Oct: automated identity decisions stay off) — identity checks are made by people.
// No screen may tell a person their face was matched. Since #1429 (1 Oct) the document card's
// "Face-matched against your profile selfie" showed only behind the server's (empty) faceMatchDocTypes;
// the owner's legal research (G4, in-app ¶17) removes the sentence altogether and says what happens
// instead. This census pins that across the phone app, the website and the admin console.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '..');
// [Review S4-2 on #1732] widened: "matched your face/selfie" forms and "(face|selfie) … match" in either order.
const CLAIM = /face[- ]match(?:ed|es|ing)?\b|faces? (?:were|was|are|is) (?:matched|compared)|matched (?:against|to) your (?:profile|selfie)|match(?:ed|es|ing)? your (?:face|selfie)|\b(?:face|selfie)\b[^.\n]{0,40}\bmatch/i;
/** The one sentence that may speak of a selfie not matching: the liveness check's FAIL outcome, which the
 *  server returns only when a person (or, if it is ever switched on, face-matching) decided it. Pinned below. */
const LIVENESS_FAIL_LINE = 'mobile/src/modules/safety/screens/LivenessCheckScreen.tsx: That selfie didn’t match your profile photo.';
/** A reviewer's own rejection reason in the admin console: a PERSON decided the face does not match (identity
 *  checks are human-only). It is a choice the reviewer makes, never a claim that a machine matched a face. */
const REVIEWER_REASON_LINE = "admin/src/lib/rejection-reasons.ts: { code: 'FACE_MISMATCH', label: 'The face does not match' },";

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

describe('no client says a face was matched (legal research G4, in-app ¶17)', () => {
  it('the phone, the website and the admin console carry no such sentence (but the liveness FAIL line and a reviewer’s own reason)', () => {
    expect(claims().sort()).toEqual([LIVENESS_FAIL_LINE, REVIEWER_REASON_LINE].sort());
  });

  it('[review S4-2 on #1732] the liveness mismatch line shows only on the server’s FAIL outcome', () => {
    const screen = readFileSync(join(ROOT, 'mobile', 'src', 'modules', 'safety', 'screens', 'LivenessCheckScreen.tsx'), 'utf8');
    expect(screen).toMatch(/const mismatched = result\?\.outcome === 'FAIL';/);
    expect(screen).toMatch(/\{mismatched \? \(\s*<View[^>]*>\s*<T variant="label">\s*That selfie didn’t match your profile photo\./);
  });

  it('the document card has no face-match line and no prop that could show one', () => {
    expect(CARD).not.toMatch(/Face-matched|faceMatched/);
  });

  it('the checklist says what really happens: a person checks, and expiry dates are re-checked daily', () => {
    expect(DOCUMENT_REVIEW_PROMISE).toBe('A person on our team checks your documents and re-checks expiry dates daily.');
    expect(CHECKLIST).toMatch(/\{DOCUMENT_REVIEW_PROMISE\}/);
    expect(CHECKLIST).not.toMatch(/faceMatched/);
    // The promise is true only while the daily sweep exists: the API schedules it every day at 06:00.
    expect(readFileSync(join(ROOT, 'api', 'src', 'jobs', 'queue.ts'), 'utf8')).toMatch(/Verification document expiry sweep \+ reminders: daily at 06:00/);
  });

  it('face-matching off: the server sends an empty list (or nothing) and no document is named', () => {
    for (const status of [{ faceMatchDocTypes: [] }, {}, null, undefined, { checklist: ['national_id'] }]) {
      expect(faceMatchedDocTypes(status as never).size).toBe(0);
    }
  });
});
