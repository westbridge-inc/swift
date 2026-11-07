import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as phoneLabels from '../../../mobile/src/components/onboarding/docLabels';
import * as phonePresentation from '../../../mobile/src/components/onboarding/documentChecklistPresentation';
import * as phoneConsent from '../../../mobile/src/components/onboarding/documentConsentRecord';
import * as phoneOwnName from '../../../mobile/src/lib/ownNameCopy';
import { DOCUMENT_CONSENT_TEXT as PHONE_CONSENT_TEXT } from '../../../mobile/src/lib/uploadConsentCopy';
import * as web from './store-documents';
import { mockApi } from '@/test/test-utils';
import { submitStoreDocument } from './store-documents-api';

// ---------------------------------------------------------------------------
// [OPEN-EARLY PR-2 · owner 31 Oct 2026] Phone ⇄ web parity for a store's Documents. Partners sign up on swiftgy.com
// before the apps are out, so the website shows the phone's store checklist: the same document names, the same list
// rules, the same words for every state, the same consent tick and the same body to the API. The phone files are read
// here as they are on disk; a word changed on one side only fails this test.
// ---------------------------------------------------------------------------

const MOBILE = join(process.cwd(), '..', 'mobile', 'src');
const WEB = join(process.cwd(), 'src');
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');
/** Phone JSX text as a person reads it: HTML entities decoded, whitespace collapsed. */
const asRead = (s: string) => s.replace(/&apos;/g, "'").replace(/\s+/g, ' ');

const PHONE_CHECKLIST = asRead(read(MOBILE, 'components/onboarding/DocumentChecklist.tsx'));
const PHONE_CARD = read(MOBILE, 'components/onboarding/DocumentUploadCard.tsx');
const PHONE_OWN_NAME = read(MOBILE, 'components/onboarding/OwnNameCard.tsx');
const PHONE_VAT_ROW = read(MOBILE, 'modules/vendor/VatDocumentRow.tsx');
const PHONE_ACCOUNT = read(MOBILE, 'modules/vendor/screens/VendorAccountScreen.tsx');
const PHONE_LABELS = read(MOBILE, 'components/onboarding/docLabels.ts');

afterEach(() => vi.unstubAllGlobals());

describe('[OPEN-EARLY PR-2] the website names every store document as the phone does', () => {
  // Every name the phone knows (its DOC_LABELS table, read from the file), and the fallback for any other code.
  const phoneTable = [...PHONE_LABELS.matchAll(/^\s+([a-z_]+): (['"])(.+?)\2,$/gm)].map((m) => [m[1]!, m[3]!.replace(/\\'/g, "'")] as const);

  it('the phone table is read (a store’s documents among it)', () => {
    const codes = phoneTable.map(([code]) => code);
    for (const store of ['owner_national_id', 'business_registration', 'tin_certificate', 'food_handler_cert', 'storefront_photo', 'own_name_declaration', 'food_handler_attestation']) {
      expect(codes).toContain(store);
    }
  });

  it.each(phoneTable)('%s reads “%s” on the website, word for word', (code, label) => {
    expect(web.docLabel(code)).toBe(label);
    expect(web.docLabel(code)).toBe(phoneLabels.docLabel(code));
  });

  it('a code neither knows is spelled out the same way on both', () => {
    expect(web.docLabel('gra_trade_licence')).toBe('Gra Trade Licence');
    expect(web.docLabel('gra_trade_licence')).toBe(phoneLabels.docLabel('gra_trade_licence'));
  });

  it('the Documents page names documents only through the phone’s table', () => {
    for (const file of ['app/dashboard/documents/checklist.tsx', 'app/dashboard/documents/document-card.tsx']) {
      const src = read(WEB, file);
      expect(src).toMatch(/docLabel\(docType\)/);
      expect(src).toMatch(/from '@\/lib\/store-documents'/);
    }
    expect(read(WEB, 'lib/store-documents.ts')).toMatch(/export \{ docLabel \} from '\.\.\/\.\.\/\.\.\/mobile\/src\/components\/onboarding\/docLabels';/);
  });
});

describe('[OPEN-EARLY PR-2] the same list rules as the phone', () => {
  it('the optional list, its hint, the empty answers, the waiting words and the review promise are the phone’s own', () => {
    expect(web.optionalDocTypes).toBe(phonePresentation.optionalDocTypes);
    expect(web.optionalDocHint).toBe(phonePresentation.optionalDocHint);
    expect(web.emptyChecklistCopy).toBe(phonePresentation.emptyChecklistCopy);
    expect(web.pendingDocumentLabel).toBe(phonePresentation.pendingDocumentLabel);
    expect(web.DOCUMENT_REVIEW_PROMISE).toBe(phonePresentation.DOCUMENT_REVIEW_PROMISE);
    expect(web.documentConsentOnRecord).toBe(phoneConsent.documentConsentOnRecord);
    expect(web.documentConsentGivenLine).toBe(phoneConsent.documentConsentGivenLine);
    expect(web.ownNameApplies).toBe(phoneOwnName.ownNameApplies);
  });

  it('the store types are the phone’s (and the API’s store roles)', () => {
    expect([...web.STORE_DOCUMENT_ROLES].sort()).toEqual(['RESTAURANT', 'SERVICE', 'STORE', 'SUPERMARKET']);
    const routes = read(join(process.cwd(), '..', 'api', 'src'), 'modules/verification/verification.routes.ts');
    expect(routes).toMatch(/z\.enum\(\['MOVER', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER'\]\)/);
    // The phone draws the own-name declaration and the food handlers step by these codes.
    expect(PHONE_CHECKLIST).toContain(`const OWN_NAME_DOC = '${web.OWN_NAME_DOC}';`);
    expect(web.FOOD_HANDLERS_DOC).toBe('food_handler_attestation');
  });

  it('the newest document wins a row as on the phone: a renewal waiting, else the current approval, else the newest', () => {
    const now = new Date('2026-10-31T12:00:00.000Z');
    const row = (id: string, status: string, createdAt: string, expiresAt: string | null = null) => ({ id, docType: 'business_registration', status, createdAt, expiresAt, reviewNote: null });
    const approved = row('a', 'APPROVED', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    const renewal = row('b', 'PENDING', '2026-10-30T00:00:00.000Z');
    const rejected = row('c', 'REJECTED', '2026-10-31T00:00:00.000Z');
    expect(web.latestDocument([approved, rejected, renewal], 'business_registration', now)?.id).toBe('b');
    expect(web.latestDocument([approved, rejected], 'business_registration', now)?.id).toBe('a');
    const lapsed = row('d', 'APPROVED', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(web.latestDocument([lapsed, rejected], 'business_registration', now)?.id).toBe('c');
    expect(web.latestDocument([], 'business_registration', now)).toBeUndefined();
    // The same precedence, in the phone's own words.
    expect(PHONE_CHECKLIST).toContain("docs.find((d) => d.status === 'PENDING') ?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date())) ?? docs[0]");
  });
});

describe('[OPEN-EARLY PR-2] every state reads in the phone’s words', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  const in10 = new Date(now.getTime() + 10 * 86_400_000 - 3_600_000).toISOString();
  const in1 = new Date(now.getTime() + 86_400_000 - 3_600_000).toISOString();
  const far = '2028-03-05T00:00:00.000Z';
  const view = (i: Partial<web.DocumentCardInput>) => web.documentCardView({ consented: true, ...i }, now);

  it.each([
    ['no tick yet', { consented: false }, 'Tick the box above to upload'],
    ['a refused upload', { uploadError: 'That document type is not on this checklist.' }, 'That document type is not on this checklist.'],
    ['approved with an expiry', { status: 'APPROVED', expiresAt: far }, 'Approved — valid until 5 Mar 2028'],
    ['approved with no expiry', { status: 'APPROVED' }, 'Approved'],
    ['inside the renewal window', { status: 'APPROVED', expiresAt: in10 }, 'Expires in 10 days — tap to upload the renewal'],
    ['one day left', { status: 'APPROVED', expiresAt: in1 }, 'Expires in 1 day — tap to upload the renewal'],
    ['expired', { status: 'EXPIRED' }, 'Expired — upload the renewal to keep operating'],
    ['expired, optional', { status: 'EXPIRED', optional: true }, 'Expired — optional, upload a new one any time'],
    ['waiting', { status: 'PENDING' }, 'In review · tap to replace'],
    ['waiting, replaced', { status: 'PENDING', replaced: true }, 'Replaced — waiting for review · tap to replace again'],
    ['rejected with the reviewer’s note', { status: 'REJECTED', reviewNote: 'The photo is blurred' }, 'Rejected: The photo is blurred — tap to re-upload'],
    ['rejected', { status: 'REJECTED' }, 'Rejected — tap to re-upload'],
    ['optional, not sent', { optional: true }, 'Optional'],
    ['the next step', { isNext: true }, 'Recommended next step'],
    ['not sent', {}, 'Get started'],
  ] as const)('%s: “%s”', (_name, input, caption) => {
    expect(view(input as Partial<web.DocumentCardInput>).caption).toBe(caption);
  });

  it('each caption is written in the phone’s card', () => {
    for (const words of [
      "'Tick the box above to upload'", '`Approved — valid until ${documentExpiryDay(expiresAt)}`', "'Approved'",
      '`Expires in ${daysLeft} day${daysLeft === 1 ? \'\' : \'s\'} — tap to upload the renewal`',
      "'Expired — optional, upload a new one any time'", "'Expired — upload the renewal to keep operating'",
      '`Rejected: ${reviewNote} — tap to re-upload`', "'Rejected — tap to re-upload'", "'Optional'", "'Recommended next step'", "'Get started'",
      "'Upload failed — tap to try again'", "const RENEWAL_WINDOW_DAYS = 30;",
    ]) expect(PHONE_CARD, words).toContain(words);
    expect(web.RENEWAL_WINDOW_DAYS).toBe(30);
    expect(web.uploadErrorWords(new Error(''))).toBe('Upload failed — tap to try again');
  });

  it('the badges: the phone’s four, plus “Expiring soon” inside the renewal window; an approved, current document is locked', () => {
    expect(view({ status: 'APPROVED', expiresAt: far })).toMatchObject({ badge: { label: 'Approved' }, locked: true });
    expect(view({ status: 'APPROVED' })).toMatchObject({ badge: { label: 'Approved' }, locked: true });
    expect(view({ status: 'APPROVED', expiresAt: in10 })).toMatchObject({ badge: { label: 'Expiring soon' }, locked: false });
    expect(view({ status: 'EXPIRED' })).toMatchObject({ badge: { label: 'Expired' }, locked: false });
    expect(view({ status: 'REJECTED' })).toMatchObject({ badge: { label: 'Rejected' }, locked: false });
    expect(view({ status: 'PENDING', replaced: true })).toMatchObject({ badge: { label: 'In review' }, locked: false, pending: true });
    expect(view({}).badge).toBeNull();
    for (const label of ['Approved', 'Expired', 'Rejected', 'In review']) expect(PHONE_CARD).toContain(`<Badge label="${label}"`);
  });

  it('the checklist, replace, uploading, photo and footnote words are the phone’s', () => {
    for (const words of [web.REQUIRED_HEADING, web.REQUIRED_INTRO, web.OPTIONAL_HEADING, web.OPTIONAL_INTRO, web.DOCUMENTS_FOOTNOTE,
      'All submitted — in review', 'approved', 'I trade under my own name', 'Checked by a person on our team.',
      'Signed — a person on our team is checking it against your ID.', 'Your own-name declaration was not accepted.']) {
      expect(PHONE_CHECKLIST, words).toContain(words);
    }
    for (const words of [web.REPLACE_TITLE, web.REPLACE_BODY, web.STILL_UPLOADING, web.DOCUMENT_PHOTO_HINT]) expect(PHONE_CARD, words).toContain(words);
  });

  it('the own-name card says what the phone’s says', () => {
    for (const words of ['Sign: I trade under my own name', 'No business name? Trade under your own name', 'I use a registered business name instead',
      "My store's name is my own name", 'Sign the declaration', 'Couldn’t sign the declaration. Try again.']) {
      expect(PHONE_OWN_NAME, words).toContain(words);
    }
    const card = asRead(read(WEB, 'app/dashboard/documents/own-name-card.tsx'));
    for (const words of ['Sign: I trade under my own name', 'No business name? Trade under your own name', 'I use a registered business name instead',
      "My store's name is my own name", 'Sign the declaration']) {
      expect(card, words).toContain(words);
    }
    expect(web.OWN_NAME_DECLARATION_V1).toBe(phoneOwnName.OWN_NAME_DECLARATION_V1);
    expect(web.OWN_NAME_TICK).toBe(phoneOwnName.OWN_NAME_TICK);
    expect(web.OWN_NAME_HINT).toBe(phoneOwnName.OWN_NAME_HINT);
    // The signed words are the server's (vendor/own-name.ts), as the phone's own test holds them.
    const server = read(join(process.cwd(), '..', 'api', 'src'), 'modules/vendor/own-name.ts');
    for (const line of phoneOwnName.OWN_NAME_DECLARATION_V1.split('\n').filter(Boolean)) expect(server).toContain(line);
  });

  it('the VAT certificate row’s status words are the phone’s', () => {
    for (const [status, cert, word] of [['APPROVED', null, 'Approved'], ['PENDING', 'PENDING', 'In review'], ['PENDING', null, 'Not submitted'],
      ['REJECTED', null, 'Not approved'], ['REVOKED', null, 'Withdrawn'], ['NONE', null, 'Not submitted']] as const) {
      expect(web.vatDocumentStatusWord(status, cert)).toBe(word);
    }
    for (const line of ["case 'APPROVED': return 'Approved';", "case 'PENDING': return certificateStatus === 'PENDING' ? 'In review' : 'Not submitted';",
      "case 'REJECTED': return 'Not approved';", "case 'REVOKED': return 'Withdrawn';", "default: return 'Not submitted';"]) {
      expect(PHONE_VAT_ROW, line).toContain(line);
      expect(read(WEB, 'lib/store-documents.ts'), line).toContain(line);
    }
  });
});

describe('[OPEN-EARLY PR-2] the same consent and the same body as the phone', () => {
  it('the tick’s words are the phone’s and the API’s document_v1 words', () => {
    expect(web.DOCUMENT_CONSENT_TEXT).toBe(PHONE_CONSENT_TEXT);
    const api = read(join(process.cwd(), '..', 'api', 'src'), 'modules/verification/upload-consent.ts');
    expect(/document_v1: \{[\s\S]*?text: '([^']+)'/.exec(api)?.[1]).toBe(web.DOCUMENT_CONSENT_TEXT);
    expect(web.DOCUMENT_CONSENT_TICK).toBe('document_v1');
  });

  it('files a document with exactly the phone’s fields', async () => {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    mockApi(({ url, init }) => {
      sent.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return { status: 201, body: { success: true, data: {} } };
    });
    await submitStoreDocument({ role: 'SUPERMARKET', docType: 'business_registration', fileUrl: 'verification/u1/file-1.enc', consentVia: 'record' });
    expect(sent).toEqual([{ path: '/api/v1/verification/documents', body: {
      role: 'SUPERMARKET', docType: 'business_registration', fileUrl: 'verification/u1/file-1.enc', consent: true,
      privacyNoticeVersion: 'web-v1', consentTick: 'document_v1', consentVia: 'record',
    } }]);
    // The phone's body has the same fields (hooks/verification useUploadDocument → verificationApi.submitDocument).
    const hook = read(MOBILE, 'hooks/verification.ts');
    for (const field of ['role,', 'docType,', 'fileUrl: uploaded.url,', 'consent: true,', 'privacyNoticeVersion: PRIVACY_NOTICE_VERSION,', "consentTick: 'document_v1'", 'consentVia']) {
      expect(hook, field).toContain(field);
    }
  });

  it('only the store’s owner sees its documents, on the phone and on the website', () => {
    expect(PHONE_ACCOUNT).toMatch(/\{isOwner && store\?\.vendorType \? <VendorDocumentsSection /);
    expect(read(WEB, 'app/dashboard/documents/page.tsx')).toMatch(/role !== 'OWNER' \?/);
    expect(read(WEB, 'app/dashboard/dashboard-shell.tsx')).toMatch(/role === 'OWNER' \? \[\{ href: '\/dashboard\/documents'/);
  });
});
