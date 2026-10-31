import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as phoneConsent from '../../../mobile/src/components/onboarding/documentConsentRecord';
import * as phonePresentation from '../../../mobile/src/components/onboarding/documentChecklistPresentation';
import * as web from './store-documents';
import { POLICE_NEEDS_OWN_CONSENT, submitPoliceClearance, submitStoreDocument, withdrawPoliceClearance } from './store-documents-api';
import { submitVerificationDocument } from './mover-api';
import { mockApi } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [WEB-POLICE · owner 31 Oct 2026, 15:14Z] Phone ⇄ web parity for the police clearance. Partners sign up on swiftgy.com
// before the apps are out, so a Services business (for home-visit bookings) and a taxi driver (police-cleared, never a
// gate) can send one on the website — the phone's way: its OWN consent (DPA s.9(1)(a): a criminal record), in the API's
// words, its own box unticked for everyone, the same body, the same withdrawal. The phone and API files are read here
// as they are on disk; a rule or a word changed on one side only fails this test. Synthetic values only.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PHONE_CARD = read('mobile/src/components/onboarding/DocumentUploadCard.tsx');
const PHONE_CHECKLIST = read('mobile/src/components/onboarding/DocumentChecklist.tsx');
const PHONE_HOOK = read('mobile/src/hooks/verification.ts');
const PHONE_API = read('mobile/src/services/api.ts');
const API_CONSENT = read('api/src/modules/verification/police-clearance-consent.ts');
const API_ROUTES = read('api/src/modules/verification/verification.routes.ts');
const API_CONFIG = read('api/src/modules/ops/platform-config.ts');
const WEB_CARD = read('web/src/app/dashboard/documents/document-card.tsx');
const WEB_STORE_LIST = read('web/src/app/dashboard/documents/checklist.tsx');
const WEB_PORTAL = read('web/src/app/portal/documents/page.tsx');

/** The API's words for a checklist, as GET /verification/status sends them (police-clearance-consent.ts), synthetic days. */
const words = (kind: 'taxi' | 'home') => ({
  tick: 'police_clearance_v1', kind, version: `${kind}-v1-31d`,
  text: kind === 'taxi' ? 'Optional. I choose to upload my police clearance. (synthetic words)' : "Needed because I will visit customers' homes. I choose to upload my police clearance. (synthetic words)",
  withdrawConfirm: 'Swift stops using your police clearance now and deletes it. (synthetic words)',
});

afterEach(() => vi.unstubAllGlobals());

describe('[WEB-POLICE] the clearance’s own consent is the phone’s and the API’s', () => {
  it('the words are read by the phone’s own reader, and its tick is the API’s', () => {
    expect(web.policeClearanceWordsFrom).toBe(phoneConsent.policeClearanceWordsFrom);
    expect(web.policeWithdrawOutcome).toBe(phoneConsent.policeWithdrawOutcome);
    expect(web.POLICE_CLEARANCE_TICK).toBe(phoneConsent.POLICE_CLEARANCE_TICK);
    expect(API_CONSENT).toContain(`export const POLICE_CLEARANCE_TICK = '${web.POLICE_CLEARANCE_TICK}' as const;`);
    // The status carries the words beside the checklist; the words' opening sentences are the API's.
    expect(API_ROUTES).toContain('return { success: true, data: { ...status, documentConsent, policeClearanceConsent } };');
    expect(API_CONSENT).toContain('`Optional. I choose to upload my police clearance. ${record}');
    expect(API_CONSENT).toContain("`Needed because I will visit customers' homes. I choose to upload my police clearance. ${record}");
    expect(web.policeClearanceWordsFrom({ policeClearanceConsent: words('home') })).toEqual({
      tick: 'police_clearance_v1', version: 'home-v1-31d', text: words('home').text, withdrawConfirm: words('home').withdrawConfirm,
    });
    // Anything else is "no words": the website then takes no clearance at all.
    expect(web.policeClearanceWordsFrom({})).toBeNull();
    expect(web.policeClearanceWordsFrom({ policeClearanceConsent: { ...words('taxi'), tick: 'document_v1' } })).toBeNull();
  });

  it('the card’s words for its own box and its withdrawal are the phone card’s', () => {
    for (const w of [web.POLICE_TICK_BELOW, web.POLICE_WITHDRAW_LINK, web.POLICE_WITHDRAW_TITLE, web.POLICE_WITHDRAW_FAILED]) expect(PHONE_CARD, w).toContain(w);
    expect(PHONE_CARD).toContain("(ownTick ? 'Tick the box below to upload' : 'Tick the box above to upload')");
    expect(web.documentCardView({ consented: false, ownTick: true }).caption).toBe('Tick the box below to upload');
    expect(web.documentCardView({ consented: false }).caption).toBe('Tick the box above to upload');
    // The withdrawal's outcome in the phone's words, from the API's answer.
    expect(web.policeWithdrawOutcome({ withdrawn: 1, keptForLegalHold: 0, deletionPending: 0 }).message).toBe('It is deleted. Swift keeps only a note that it was withdrawn.');
  });

  it('the own box follows the phone’s rules: never ticked for anyone, emptied after each upload and on new words; it alone opens the card', () => {
    for (const rule of [
      'const [policeTicked, setPoliceTicked] = useState(false);',
      'const ownTick = policeConsent !== null;',
      'const wordsVersion = policeConsent?.version ?? null;',
      'useEffect(() => { setPoliceTicked(false); }, [wordsVersion]);',
      'const canUpload = ownTick ? policeTicked : consented;',
    ]) {
      expect(PHONE_CARD, rule).toContain(rule);
      expect(WEB_CARD, rule).toContain(rule);
    }
    expect(PHONE_CARD).toContain('{ onSuccess: () => setPoliceTicked(false) }');
    expect(WEB_CARD).toContain('onSuccess: () => { setPoliceTicked(false); onSent(); }');
    // The box shows while the clearance is not approved and current; the withdrawal while one is on file.
    expect(PHONE_CARD).toContain('{policeConsent && !approved ? (');
    expect(WEB_CARD).toContain('{policeConsent && !view.locked && (');
    expect(PHONE_CARD).toContain('{policeConsent && status ? (');
    expect(WEB_CARD).toContain('{policeConsent && doc && (');
    // Only the police clearance has the words, on the phone and on both web pages.
    expect(PHONE_CHECKLIST).toContain("const policeConsentFor = (docType: string) => (docType === 'police_clearance' ? policeWords : null);");
    expect(WEB_STORE_LIST).toContain('policeConsent={docType === POLICE_CLEARANCE_DOC ? policeWords : null}');
    expect(WEB_PORTAL).toContain('policeConsent={policeWords}');
  });

  it('the badge wording is the phone’s hint, and promises no badge a screen does not show', () => {
    expect(web.optionalDocHint).toBe(phonePresentation.optionalDocHint);
    expect(web.optionalDocHint('police_clearance')).toBe('Optional. If Swift approves a current one, your account is recorded as police-cleared.');
    expect(WEB_PORTAL).toContain('optionalHint={optionalDocHint(POLICE_CLEARANCE_DOC)}');
  });
});

describe('[WEB-POLICE] who is offered one: the API’s lists', () => {
  it('a Services business (optional) and a taxi driver (optional); never a delivery rider, never another store', () => {
    expect(API_CONFIG).toContain("SERVICE_OPTIONAL: ['police_clearance'],");
    expect(API_CONFIG).toContain("MOVER_TAXI_EXTRA_OPTIONAL: ['police_clearance'],");
    for (const list of ['RESTAURANT', 'SUPERMARKET', 'STORE', 'MOVER', 'MOVER_MOTOR', 'MOVER_NO_LICENCE']) {
      const line = new RegExp(`^\\s+${list}: \\[(.*)\\],$`, 'm').exec(API_CONFIG)?.[1];
      expect(line, list).toBeDefined();
      expect(line, list).not.toContain('police_clearance');
    }
    expect([...web.POLICE_CLEARANCE_STORE_TYPES]).toEqual(['SERVICE']);
    // The API's own kinds: a mover's is the taxi words, a Services business's the home-visit words.
    expect(API_CONSENT).toContain("if (role === 'MOVER') return 'taxi';");
    expect(API_CONSENT).toContain("if (role === 'SERVICE' || role === 'SERVICE_PROVIDER') return 'home';");
    // The rider page offers it on a taxi's checklist only, and the store page to a Services business only.
    expect(WEB_PORTAL).toContain('isTaxiChecklist(d.checklist ?? []) && optionalDocTypes(d).includes(POLICE_CLEARANCE_DOC)');
    expect(WEB_STORE_LIST).toContain('const offersPolice = POLICE_CLEARANCE_STORE_TYPES.has(vendorType);');
  });
});

describe('[WEB-POLICE] the same body as the phone, and never under the list’s tick', () => {
  it('files a clearance with exactly the phone’s fields: its own tick and the words’ version, given by its own box', async () => {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    mockApi(({ url, init }) => {
      sent.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return { status: 201, body: { success: true, data: {} } };
    });
    await submitPoliceClearance({ role: 'SERVICE', fileUrl: 'verification/u1/synthetic.enc', consent: { tick: 'police_clearance_v1', version: 'home-v1-31d' } });
    await submitPoliceClearance({ role: 'MOVER', fileUrl: 'verification/u1/synthetic-2.enc', consent: { tick: 'police_clearance_v1', version: 'taxi-v1-31d' } });
    expect(sent).toEqual([
      { path: '/api/v1/verification/documents', body: {
        role: 'SERVICE', docType: 'police_clearance', fileUrl: 'verification/u1/synthetic.enc', consent: true, privacyNoticeVersion: 'web-v1',
        consentTick: 'police_clearance_v1', consentVersion: 'home-v1-31d', consentVia: 'checkbox',
      } },
      { path: '/api/v1/verification/documents', body: {
        role: 'MOVER', docType: 'police_clearance', fileUrl: 'verification/u1/synthetic-2.enc', consent: true, privacyNoticeVersion: 'web-v1',
        consentTick: 'police_clearance_v1', consentVersion: 'taxi-v1-31d', consentVia: 'checkbox',
      } },
    ]);
    // The phone's: the card sends the words' tick and version, its own box is the consent ('checkbox'), the hook files them.
    expect(PHONE_CARD).toContain('...(policeConsent ? { consent: { tick: policeConsent.tick, version: policeConsent.version } } : {}),');
    expect(PHONE_CARD).toContain("const pick = ownTick\n    ? () => choosePhoto('checkbox')");
    expect(PHONE_HOOK).toContain("...(consent ? { consentTick: consent.tick, consentVersion: consent.version } : { consentTick: 'document_v1' }),");
    for (const field of ['role,', 'docType,', 'fileUrl: uploaded.url,', 'consent: true,', 'privacyNoticeVersion: PRIVACY_NOTICE_VERSION,', 'consentVia']) {
      expect(PHONE_HOOK, field).toContain(field);
    }
    // The API refuses words that changed, by this version.
    expect(API_ROUTES).toContain('if (body.consentVersion !== policeWords.version) {');
  });

  it('a clearance is never sent without its own tick and a version', async () => {
    const fetched = mockApi(() => ({ status: 201, body: { success: true, data: {} } }));
    await expect(submitPoliceClearance({ role: 'SERVICE', fileUrl: 'f', consent: { tick: 'document_v1', version: 'home-v1-31d' } as never })).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    await expect(submitPoliceClearance({ role: 'SERVICE', fileUrl: 'f', consent: { tick: 'police_clearance_v1', version: '' } })).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    await expect(submitPoliceClearance({ role: 'MOVER', fileUrl: 'f', consent: undefined as never })).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('the list’s document tick can never file a police clearance, on the store page or the rider page', async () => {
    const fetched = mockApi(() => ({ status: 201, body: { success: true, data: {} } }));
    await expect(submitStoreDocument({ role: 'SERVICE', docType: 'police_clearance', fileUrl: 'f', consentVia: 'checkbox' })).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    await expect(submitStoreDocument({ role: 'SERVICE', docType: 'police_clearance', fileUrl: 'f', consentVia: 'record' })).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    await expect(submitVerificationDocument('police_clearance', 'f')).rejects.toThrow(POLICE_NEEDS_OWN_CONSENT);
    expect(fetched).not.toHaveBeenCalled();
    // Any other document still files under the list's tick.
    await submitStoreDocument({ role: 'SERVICE', docType: 'owner_national_id', fileUrl: 'f', consentVia: 'checkbox' });
    await submitVerificationDocument('drivers_licence', 'f');
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('the withdrawal is the phone’s call', async () => {
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    mockApi(({ method, url, init }) => {
      sent.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
      return { body: { success: true, data: { withdrawn: 1, keptForLegalHold: 0, deletionPending: 0 } } };
    });
    expect(await withdrawPoliceClearance('MOVER')).toEqual({ withdrawn: 1, keptForLegalHold: 0, deletionPending: 0 });
    expect(sent).toEqual([{ method: 'POST', path: '/api/v1/verification/police-clearance/withdraw', body: { role: 'MOVER' } }]);
    expect(PHONE_API).toContain("api.post('/verification/police-clearance/withdraw', { role }, capturedAuthConfig(session)),");
    expect(API_ROUTES).toContain("app.post('/police-clearance/withdraw', auth, async (request) => {");
  });
});
