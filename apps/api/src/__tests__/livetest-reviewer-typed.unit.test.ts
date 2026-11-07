import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CERTIFICATE_YEAR_DOC_TYPES, ISSUE_DATE_DOC_TYPES, OWN_NAME_DOC_TYPE, REGISTRATION_DOC_TYPES, REGISTRATION_KINDS,
} from '../modules/verification/doc-registry';
import { REVIEWER_TYPED_NUMBER_DOC_TYPES, reviewerTypedFields } from '../modules/verification/identity-signal-policy';

// ---------------------------------------------------------------------------
// [AUTH-FIX PR2 · journeys roster] The journey provisioner (scripts/livetest/provision.ts approveDoc)
// approves each partner document through the admin console's approve route, which insists on what a
// reviewer must TYPE for the type (`required`: reviewerTypedFields). Its copy knew the ID / licence
// number and the police clearance date only. ROLE-DOCS (21 Oct) and R15/R16 added a business
// registration's kind (and year), a certificate's year and the own-name check, so on a fresh database
// the API refused the store's documents (400 REGISTRATION_KIND_REQUIRED and the like, correctly), no
// store activated, and every store journey failed. CI never runs the journeys: this holds the
// provisioner's typed body to every field the API asks for, with a value the API accepts.
// ---------------------------------------------------------------------------

const PROVISION = join(__dirname, '../../../../scripts/livetest/provision.ts');
let reviewerTypedBody: (docType: string, docId: string) => Record<string, unknown>;

beforeAll(async () => {
  ({ reviewerTypedBody } = await import(pathToFileURL(PROVISION).href));
});

/** Every type the reviewer must type something for. */
const TYPED_DOC_TYPES = [...new Set([
  ...REVIEWER_TYPED_NUMBER_DOC_TYPES, ...ISSUE_DATE_DOC_TYPES, ...CERTIFICATE_YEAR_DOC_TYPES, ...REGISTRATION_DOC_TYPES, OWN_NAME_DOC_TYPE,
])].sort();

describe('[journeys roster] the provisioner types what the reviewer must type, for every type', () => {
  it('the list is not vacuous: it holds the store registration, a January certificate and the own-name declaration', () => {
    expect(TYPED_DOC_TYPES).toEqual(expect.arrayContaining(['business_registration', 'gra_restaurant_licence', OWN_NAME_DOC_TYPE, 'police_clearance']));
    for (const docType of TYPED_DOC_TYPES) expect(reviewerTypedFields(docType).length, docType).toBeGreaterThan(0);
  });

  it('for every typed type, approveDoc\'s body carries each field reviewerTypedFields names', () => {
    const missing = TYPED_DOC_TYPES.flatMap((docType) => {
      const body = reviewerTypedBody(docType, 'cmsyntheticdoc000001');
      return reviewerTypedFields(docType).filter((field) => body[field] === undefined).map((field) => `${docType}.${field}`);
    });
    expect(missing).toEqual([]);
  });

  it('each value is one the API accepts', () => {
    const year = new Date(Date.now() - 4 * 3_600_000).getUTCFullYear(); // the year in Guyana (UTC-4)
    for (const docType of TYPED_DOC_TYPES) {
      const body = reviewerTypedBody(docType, 'cmsyntheticdoc000001');
      if (body['documentNumber'] !== undefined) expect(String(body['documentNumber']).length, docType).toBeGreaterThanOrEqual(4);
      if (body['issuedOn'] !== undefined) expect(String(body['issuedOn']), docType).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (body['certificateYear'] !== undefined) expect(body['certificateYear'], docType).toBe(year);
      if (body['registrationKind'] !== undefined) expect(REGISTRATION_KINDS as readonly unknown[], docType).toContain(body['registrationKind']);
      if (body['ownNameConfirmed'] !== undefined) expect(body['ownNameConfirmed'], docType).toBe(true);
    }
  });
});
