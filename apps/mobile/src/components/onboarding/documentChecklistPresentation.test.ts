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
