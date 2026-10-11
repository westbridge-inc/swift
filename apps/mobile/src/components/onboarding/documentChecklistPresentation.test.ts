import { describe, expect, it } from 'vitest';
import { emptyChecklistCopy, faceMatchedDocTypes } from './documentChecklistPresentation';

describe('empty verification checklist', () => {
  it('explains a service policy hold without claiming approval or a 24-hour review', () => {
    expect(emptyChecklistCopy({ categoryUnavailable: true })).toEqual({
      title: 'Service checks pending',
      body: 'This service is unavailable while its required checks are prepared. You cannot receive requests yet.',
    });
  });

  it('does not call any other empty checklist complete', () => {
    expect(emptyChecklistCopy({})).toEqual({
      title: 'Verification steps unavailable',
      body: 'We cannot confirm your requirements right now. Try again later.',
    });
  });
});

describe('the face-match line follows the server', () => {
  it('names exactly the documents the server lists', () => {
    expect([...faceMatchedDocTypes({ faceMatchDocTypes: ['owner_national_id'] })]).toEqual(['owner_national_id']);
    expect([...faceMatchedDocTypes({ faceMatchDocTypes: ['national_id', 'owner_national_id'] })]).toEqual(['national_id', 'owner_national_id']);
  });

  it('names none while the server lists none, says nothing, or says something that is not a list of document types', () => {
    for (const status of [
      { faceMatchDocTypes: [] },
      {},
      null,
      undefined,
      { faceMatchDocTypes: true },
      { faceMatchDocTypes: 'owner_national_id' },
      { faceMatchDocTypes: { owner_national_id: true } },
      { faceMatchDocTypes: [1, null, '', { docType: 'owner_national_id' }] },
    ]) {
      expect(faceMatchedDocTypes(status as never).size, JSON.stringify(status)).toBe(0);
    }
  });
});

// [REPLACE-PENDING · owner request 8 Oct 2026] a document waiting for review can be replaced, and says so once replaced.
describe('a document waiting for review', () => {
  it('offers to replace it, and says "Replaced — waiting for review" after', async () => {
    const { pendingDocumentLabel } = await import('./documentChecklistPresentation');
    expect(pendingDocumentLabel(false, '2026-10-08T12:00:00.000Z')).toBe('Submitted 8 Oct — in review · tap to replace');
    expect(pendingDocumentLabel(false, null)).toBe('In review · tap to replace');
    expect(pendingDocumentLabel(true, '2026-10-08T12:00:00.000Z')).toBe('Replaced — waiting for review · tap to replace again');
  });

  it('the card stays tappable while waiting (asks first), and only an approved document is locked', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const card = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentUploadCard.tsx'), 'utf8');
    expect(card).toMatch(/<Pressable disabled=\{approved \|\| upload\.isPending\} onPress=\{pending \? confirmReplace : pick\}>/);
    expect(card).toMatch(/Replace this document\?/);
    const list = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentChecklist.tsx'), 'utf8');
    expect(list).toMatch(/replaced=\{doc\?\.replaced === true\}/);
  });
});
