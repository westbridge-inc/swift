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
