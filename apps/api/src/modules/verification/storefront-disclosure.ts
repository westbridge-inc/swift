/**
 * [DOC-1 Part XIX · DOC-INV-27 · P19] The storefront disclosure compiler.
 *
 * The ECT Act supplier-information block is a COMPILED artifact, never hand-written
 * prose: every legally required element is sourced from a VALID document record (its
 * submission's extracted fields), or from a fallback the spec names and LABELS
 * (PROPRIETOR = the verified proprietor's name "trading as …" for an unregistered
 * business; SELF_DECLARED = the address the vendor typed; ACCOUNT = the verified account
 * contact; PLATFORM = the operator block from configuration). A required element with no
 * source leaves the block INCOMPLETE — it never falls back to self-reported text for a
 * legal fact. Nothing is stored: the block is derived on every read, so a lapsed licence
 * disappears from the storefront the moment its record leaves VALID.
 *
 * The go-live gate (a vendor cannot activate with an incomplete block) engages by the
 * registry law — when the country's BUSINESS-bucket document types are ACTIVE — so it
 * cannot dark every storefront before the registry is live.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { getKeyProvider } from '../../providers/storage/envelope';
import { unpackAndDecrypt } from './extraction-ledger';
import { BUCKET_OF, IDENTITY_DOC_TYPES, LICENCE_DISCLOSURE_TYPES } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

export type DisclosureSource = 'RECORD' | 'PROPRIETOR' | 'SELF_DECLARED' | 'ACCOUNT' | 'PLATFORM';
export interface DisclosureElement { value: string; source: DisclosureSource; docType?: string; recordId?: string }
export interface DisclosureBlock {
  complete: boolean;
  /** The required elements with no lawful source — named, so the vendor and the reviewer know what to fix. */
  missing: string[];
  legalName: DisclosureElement | null;
  address: DisclosureElement | null;
  contact: DisclosureElement | null;
  licences: DisclosureElement[];
  operator: { legalName: string; registeredAddress: string; supportEmail: string } | null;
  compiledAt: string;
}

/** The fields the compiler reads, by element — declared in the registry when extraction lands; absent until then. */
const NAME_FIELDS = ['business_name', 'company_name', 'legal_name'];
const ADDRESS_FIELDS = ['principal_place', 'premises_address', 'registered_address'];
// The document types this compiler reads are REGISTRY text (DOC-INV-2): IDENTITY_DOC_TYPES, LICENCE_DISCLOSURE_TYPES.

export function platformOperator(env: Record<string, string | undefined> = process.env): DisclosureBlock['operator'] {
  const legalName = env['PLATFORM_LEGAL_NAME']?.trim();
  const registeredAddress = env['PLATFORM_REGISTERED_ADDRESS']?.trim();
  const supportEmail = env['SUPPORT_EMAIL']?.trim();
  return legalName && registeredAddress && supportEmail ? { legalName, registeredAddress, supportEmail } : null;
}

/** Decrypt the named fields of a VALID record's submission — absent when never extracted or the KEK is gone. */
async function readFields(db: Db, submissionId: string, codes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const runs = await db.extractionRun.findMany({ where: { submissionId }, orderBy: { startedAt: 'desc' }, select: { wrappedDek: true, fields: { where: { fieldCode: { in: [...codes] } }, select: { fieldCode: true, valueCt: true } } } });
  const kp = getKeyProvider();
  for (const run of runs) {
    if (!run.wrappedDek || !kp) continue;
    const dek = await kp.unwrapDek(Buffer.from(run.wrappedDek));
    for (const f of run.fields) {
      if (f.valueCt && !out.has(f.fieldCode)) out.set(f.fieldCode, unpackAndDecrypt(Buffer.from(f.valueCt), dek).toString('utf8'));
    }
  }
  return out;
}

/** The registry law: the block gates go-live only once the country's BUSINESS-bucket types are active. */
export async function disclosureGateEngaged(db: Db, countryCode: string): Promise<boolean> {
  const active = await db.docType.count({ where: { countryCode, isActive: true, bucket: 'BUSINESS' } });
  return active > 0;
}

export async function compileStorefrontDisclosure(db: Db, vendorId: string, now = new Date()): Promise<DisclosureBlock> {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { name: true, addressLine1: true, addressLine2: true, owner: { select: { userId: true, user: { select: { firstName: true, lastName: true, phone: true, isPhoneVerified: true } } } } },
  });
  const missing: string[] = [];
  if (!vendor) return { complete: false, missing: ['vendor'], legalName: null, address: null, contact: null, licences: [], operator: platformOperator(), compiledAt: now.toISOString() };
  const accountId = vendor.owner.userId;
  const records = await db.documentRecord.findMany({
    where: { accountId, status: 'VALID', OR: [{ expiresOn: null }, { expiresOn: { gt: now } }], submission: { purgedAt: null } },
    select: { id: true, docType: true, submissionId: true },
  });
  const business = records.filter((r) => BUCKET_OF[r.docType] === 'BUSINESS');
  const identity = records.find((r) => IDENTITY_DOC_TYPES.includes(r.docType));

  // Legal / registered name: a VALID business record's read name; else the verified proprietor "trading as".
  let legalName: DisclosureElement | null = null;
  for (const r of business) {
    const f = await readFields(db, r.submissionId, NAME_FIELDS);
    const v = NAME_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { legalName = { value: v.trim(), source: 'RECORD', docType: r.docType, recordId: r.id }; break; }
  }
  if (!legalName && identity) {
    const proprietor = `${vendor.owner.user.firstName} ${vendor.owner.user.lastName}`.trim();
    if (proprietor) legalName = { value: `${proprietor} trading as ${vendor.name}`, source: 'PROPRIETOR', docType: identity.docType, recordId: identity.id };
  }
  if (!legalName) missing.push('legalName');

  // Principal geographic address: a business record's read address; else the self-declared address, labelled.
  let address: DisclosureElement | null = null;
  for (const r of business) {
    const f = await readFields(db, r.submissionId, ADDRESS_FIELDS);
    const v = ADDRESS_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { address = { value: v.trim(), source: 'RECORD', docType: r.docType, recordId: r.id }; break; }
  }
  if (!address) {
    const declared = [vendor.addressLine1, vendor.addressLine2].filter((x) => x && x.trim()).join(', ');
    if (declared) address = { value: declared, source: 'SELF_DECLARED' };
  }
  if (!address) missing.push('address');

  // Electronic contact: the verified account contact — none is blocking.
  const contact: DisclosureElement | null = vendor.owner.user.isPhoneVerified && vendor.owner.user.phone
    ? { value: vendor.owner.user.phone, source: 'ACCOUNT' } : null;
  if (!contact) missing.push('contact');

  // Licence disclosures: every VALID licence-class record, with its number when read.
  const licences: DisclosureElement[] = [];
  for (const r of records.filter((x) => LICENCE_DISCLOSURE_TYPES.includes(x.docType))) {
    const f = await readFields(db, r.submissionId, ['licence_number', 'certificate_number', 'permit_number']);
    const number = [...f.values()].find((x) => x && x.trim());
    licences.push({ value: number ? number.trim() : 'on file', source: 'RECORD', docType: r.docType, recordId: r.id });
  }

  const operator = platformOperator();
  if (!operator) missing.push('operator');

  return { complete: missing.length === 0, missing, legalName, address, contact, licences, operator, compiledAt: now.toISOString() };
}
