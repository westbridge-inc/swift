import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_CONSENT_TICK, SENSITIVE_DOC_TYPES, documentConsentGivenLine, documentConsentOnRecord, policeClearanceWordsFrom } from './documentConsentRecord';

// ---------------------------------------------------------------------------
// [DOC-CONSENT] Reading the server's `documentConsent`: only the person's own grant to THESE words counts, and
// anything else reads as "not on record" (the box then starts empty, as before).
// ---------------------------------------------------------------------------

const SRC = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');
const API = (...p: string[]) => readFileSync(join(process.cwd(), '..', 'api', 'src', ...p), 'utf8');

describe('documentConsentOnRecord', () => {
  it('a grant to these words is on record, with its time', () => {
    expect(documentConsentOnRecord({ documentConsent: { tick: 'document_v1', given: true, givenAt: '2026-10-25T16:18:58.000Z' } }))
      .toEqual({ given: true, givenAt: '2026-10-25T16:18:58.000Z' });
    expect(documentConsentOnRecord({ documentConsent: { tick: 'document_v1', given: true, givenAt: 'not a date' } }))
      .toEqual({ given: true, givenAt: null });
  });

  it('anything else is not on record: an older API, not given, other words, a loose truthy value, junk', () => {
    for (const status of [
      undefined, null, 'status', 7, {}, { documentConsent: null }, { documentConsent: 'given' }, { documentConsent: true },
      { documentConsent: { tick: 'document_v1', given: false, givenAt: null } },
      { documentConsent: { tick: 'document_v1', given: 'true', givenAt: '2026-10-25T16:18:58.000Z' } },
      { documentConsent: { tick: 'document_v1', given: 1 } },
      { documentConsent: { tick: 'document_v2', given: true, givenAt: '2026-10-25T16:18:58.000Z' } },
      { documentConsent: { tick: 'customer_id_v1', given: true, givenAt: '2026-10-25T16:18:58.000Z' } },
      { documentConsent: { given: true, givenAt: '2026-10-25T16:18:58.000Z' } },
    ]) {
      expect(documentConsentOnRecord(status), JSON.stringify(status)).toEqual({ given: false, givenAt: null });
    }
  });

  describe('in Guyana time, whatever zone the phone is set to (like the other partner dates)', () => {
    // [DOC-CONSENT S4 · REVIEW-F] A phone set far from Guyana (UTC+14 here) read the day in its own zone.
    let zone: string | undefined;
    beforeAll(() => { zone = process.env['TZ']; process.env['TZ'] = 'Pacific/Kiritimati'; });
    afterAll(() => { if (zone === undefined) delete process.env['TZ']; else process.env['TZ'] = zone; });
    it('late evening in Georgetown is still that day', () => {
      expect(new Date('2026-10-26T02:30:00.000Z').getDate(), 'the phone\'s own zone is ahead of Guyana').toBe(26);
      expect(documentConsentGivenLine('2026-10-26T02:30:00.000Z')).toBe('You ticked this on 25 Oct 2026.');
      expect(documentConsentGivenLine('2026-10-25T04:00:00.000Z')).toBe('You ticked this on 25 Oct 2026.');
    });
  });

  it('says the tick is the person\'s own', () => {
    expect(documentConsentGivenLine('2026-10-25T16:18:58.000Z')).toBe('You ticked this on 25 Oct 2026.');
    expect(documentConsentGivenLine(null)).toBe('You ticked this before.');
  });

  it('a police clearance is the sensitive one; licences and papers are not', () => {
    expect(SENSITIVE_DOC_TYPES.has('police_clearance')).toBe(true);
    for (const d of ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'hire_car_driver_licence', 'national_id']) {
      expect(SENSITIVE_DOC_TYPES.has(d), d).toBe(false);
    }
  });

  it('one tick name across the phone and the API: what the uploads send, what the API records and reads back', () => {
    expect(DOCUMENT_CONSENT_TICK).toBe('document_v1');
    expect(SRC('hooks', 'verification.ts')).toContain(`consentTick: '${DOCUMENT_CONSENT_TICK}'`);
    expect(API('modules', 'verification', 'upload-consent.ts')).toMatch(new RegExp(`${DOCUMENT_CONSENT_TICK}: \\{`));
    expect(API('modules', 'verification', 'document-consent-record.ts')).toContain(`const TICK = '${DOCUMENT_CONSENT_TICK}' as const;`);
  });
});

describe('[POLICE-CLEARANCE CONSENT] policeClearanceWordsFrom', () => {
  const words = { tick: 'police_clearance_v1', version: 'home-v1-30d', text: 'Needed because I will visit customers\' homes.', withdrawConfirm: 'Swift deletes it.' };
  it('reads the API\'s words and nothing else', () => {
    expect(policeClearanceWordsFrom({ policeClearanceConsent: { ...words, kind: 'home' } })).toEqual(words);
  });
  it('anything else is no words (an older API, another tick, empty or oversized fields)', () => {
    for (const status of [
      undefined, null, {}, { policeClearanceConsent: null }, { policeClearanceConsent: 'x' },
      { policeClearanceConsent: { ...words, tick: 'document_v1' } }, { policeClearanceConsent: { ...words, version: '' } },
      { policeClearanceConsent: { ...words, version: 'v'.repeat(41) } }, { policeClearanceConsent: { ...words, text: '' } },
      { policeClearanceConsent: { ...words, text: 'w'.repeat(2001) } }, { policeClearanceConsent: { ...words, withdrawConfirm: '' } },
    ]) {
      expect(policeClearanceWordsFrom(status), JSON.stringify(status)?.slice(0, 80)).toBeNull();
    }
  });
});
