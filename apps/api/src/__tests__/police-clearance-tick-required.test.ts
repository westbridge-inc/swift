import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POLICE_CLEARANCE_CONSENT_REQUIRED, POLICE_CLEARANCE_TICK, policeClearanceTickMissing,
} from '../modules/verification/police-clearance-consent';

// ---------------------------------------------------------------------------
// [WEB-POLICE · COORD 31 Oct 2026, option (a)] A police clearance (a criminal record: sensitive data, DPA s.9(1)(a)) is
// never filed with NO consent tick at all. The tick each client in use sends stays accepted:
//  - the website and the launch OTA: the clearance's own tick (police_clearance_v1, with the words' version);
//  - build 12 / Android vc8, in the stores' review: the generic document tick (document_v1) — their JS has no police
//    words, so refusing it would refuse every police clearance from the store builds and from staging under review.
// Follow-up, option (b): after the launch OTA is live and a minimum-app-version gate retires build 12's JS, require
// police_clearance_v1 for a police clearance. Service-free: the rule itself, and where the route applies it.
// ---------------------------------------------------------------------------

const ROUTES = readFileSync(join(process.cwd(), 'src/modules/verification/verification.routes.ts'), 'utf8');
const CONSENT = readFileSync(join(process.cwd(), 'src/modules/verification/police-clearance-consent.ts'), 'utf8');

/** Build 12's body for a police clearance, as its JS sends it (mobile hooks/verification useUploadDocument at the
 *  store cut f71b89db: every document with the document tick, no version, no consentVia). Synthetic file reference. */
const BUILD_12_BODY = {
  role: 'MOVER', docType: 'police_clearance', fileUrl: 'verification/user-1/synthetic.enc', consent: true, privacyNoticeVersion: 'v1',
  consentTick: 'document_v1',
} as const;

describe('[WEB-POLICE (a)] a police clearance is never filed without a consent tick', () => {
  it('no tick (absent, null or empty) is refused for a police clearance', () => {
    const noTick: { docType: string; consentTick?: string } = { ...BUILD_12_BODY };
    delete noTick.consentTick;
    expect(policeClearanceTickMissing(noTick)).toBe(true);
    expect(policeClearanceTickMissing({ ...noTick, consentTick: null })).toBe(true);
    expect(policeClearanceTickMissing({ ...noTick, consentTick: '' })).toBe(true);
  });

  it('build 12’s exact body is still accepted (the store builds and staging under review keep working)', () => {
    expect(policeClearanceTickMissing(BUILD_12_BODY)).toBe(false);
  });

  it('the clearance’s own tick (website, launch OTA) is accepted', () => {
    expect(policeClearanceTickMissing({ ...BUILD_12_BODY, consentTick: POLICE_CLEARANCE_TICK })).toBe(false);
    expect(POLICE_CLEARANCE_TICK).toBe('police_clearance_v1');
  });

  it('every other document is unaffected, with or without a tick (older clients keep filing them)', () => {
    for (const docType of ['national_id', 'drivers_licence', 'owner_national_id', 'business_registration']) {
      expect(policeClearanceTickMissing({ docType }), docType).toBe(false);
      expect(policeClearanceTickMissing({ docType, consentTick: 'document_v1' }), docType).toBe(false);
    }
  });
});

describe('[WEB-POLICE (a)] where POST /verification/documents applies it', () => {
  const handler = ROUTES.slice(ROUTES.indexOf("app.post('/documents', auth,"), ROUTES.indexOf("app.post('/upload',"));

  it('first, before the police words are read and before anything is stored, as a 400 with a stable code', () => {
    expect(handler).toContain("app.post('/documents', auth,");
    const refusal = handler.indexOf('if (policeClearanceTickMissing(body)) {');
    expect(refusal).toBeGreaterThan(handler.indexOf('const body = submitDocumentSchema.parse(request.body);'));
    expect(refusal).toBeLessThan(handler.indexOf('policeClearanceConsentFor('));
    expect(refusal).toBeLessThan(handler.indexOf('verification.submitDocument('));
    expect(handler).toContain('throw new AppError(400, POLICE_CLEARANCE_CONSENT_REQUIRED, POLICE_CLEARANCE_CONSENT_REQUIRED_MESSAGE);');
    expect(POLICE_CLEARANCE_CONSENT_REQUIRED).toBe('POLICE_CLEARANCE_CONSENT_REQUIRED');
  });

  it('this is the only route that files a document of the client’s choosing (the vendor doors file fixed types)', () => {
    const all = ['verification/verification.routes.ts', 'vendor/vendor.routes.ts'].map((f) => readFileSync(join(process.cwd(), 'src/modules', f), 'utf8'));
    expect(all[0]!.match(/verification\.submitDocument\(/g)).toHaveLength(1);
    for (const call of all[1]!.match(/verification\.submitDocument\([^)]*\)/g) ?? []) expect(call).toMatch(/DECLARATION_DOC_TYPE|VAT_CERTIFICATE_DOC_TYPE|OWN_NAME_DOC_TYPE/);
  });

  it('the follow-up (b) is named where the rule lives', () => {
    expect(CONSENT).toContain('FOLLOW-UP, option (b): once the launch OTA is live and a minimum-app-version gate retires build 12\'s JS, require');
  });
});
