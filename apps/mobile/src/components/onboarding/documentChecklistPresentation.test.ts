import { describe, expect, it } from 'vitest';
import { emptyChecklistCopy, faceMatchedDocTypes, optionalDocHint, optionalDocTypes } from './documentChecklistPresentation';

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

  it('the card stays tappable while waiting (asks first); only an approved document, or a missing consent tick (R17), locks it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const card = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentUploadCard.tsx'), 'utf8');
    expect(card).toMatch(/<Pressable disabled=\{approved \|\| upload\.isPending \|\| !consented\} onPress=\{pending \? confirmReplace : pick\}>/);
    expect(card).toMatch(/Replace this document\?/);
    const list = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentChecklist.tsx'), 'utf8');
    // Required AND optional documents both say "Replaced — waiting for review" (a police clearance can be replaced too).
    expect(list.match(/replaced=\{doc\?\.replaced === true\}/g)).toHaveLength(2);
  });
});

describe('[VERIFY-DOCS] optional documents follow the server', () => {
  it('lists exactly the server\'s optional types, after dropping any the checklist already requires', () => {
    expect(optionalDocTypes({ checklist: ['drivers_licence'], optional: ['national_id', 'police_clearance'] })).toEqual(['national_id', 'police_clearance']);
    expect(optionalDocTypes({ checklist: ['national_id'], optional: ['national_id', 'police_clearance'] })).toEqual(['police_clearance']);
    expect(optionalDocTypes({ checklist: [], optional: ['police_clearance', 'police_clearance'] })).toEqual(['police_clearance']);
  });

  it('shows none for an older server (no `optional`) or anything that is not a list of types', () => {
    for (const status of [{}, null, undefined, { optional: true }, { optional: 'police_clearance' }, { optional: [1, null, ''] }]) {
      expect(optionalDocTypes(status as never), JSON.stringify(status)).toEqual([]);
    }
  });

  it('says what the optional police clearance is for, and never that it is required', () => {
    // [VERIFY-DOCS] No screen shows a Police-cleared badge yet: the hint says what really happens, and promises no badge.
    expect(optionalDocHint('police_clearance')).toMatch(/^Optional\. If Swift approves a current one, your account is recorded as police-cleared\./);
    expect(optionalDocHint('police_clearance')).not.toMatch(/badge|profile/i);
    for (const t of ['police_clearance', 'national_id', 'anything']) expect(optionalDocHint(t)).not.toMatch(/required|must/i);
  });
});
