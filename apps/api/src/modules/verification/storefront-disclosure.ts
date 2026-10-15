import { readFeePause } from '../billing/mmg-pause';
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
import { createHash } from 'node:crypto';
import { getKeyProvider } from '../../providers/storage/envelope';
import { unpackAndDecrypt } from './extraction-ledger';
import { BUCKET_OF, IDENTITY_DOC_TYPES, LICENCE_DISCLOSURE_TYPES } from './doc-registry';
import { vendorTenantForCaller } from '../vendor/vendor-visibility';
import { inoperableSubscriptionWhere } from '../subscription/operate-gate';
import { getTenantId } from '../../plugins/tenant-context';
import { safePublicPhone } from '../../utils/vendor-public-phone';

type Db = Prisma.TransactionClient | PrismaClient;

export type DisclosureSource = 'RECORD' | 'PROPRIETOR' | 'SELF_DECLARED' | 'ACCOUNT' | 'PUBLISHED' | 'PLATFORM';
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

type DisclosurePurpose = 'PUBLIC_STOREFRONT' | 'VENDOR_ACTIVATION';
type RecordSource = { id: string; tenantId: string; accountId: string; subjectId: string | null; docType: string; submissionId: string };

/** Only declared non-PII BUSINESS fields enter this reader. Neither purpose
 * needs PERSONAL values: a valid licence's on-file fact is sufficient. */
async function readFields(db: Db, record: RecordSource, codes: readonly string[], purpose: DisclosurePurpose): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!codes.length) return out;
  const runs = await db.extractionRun.findMany({
    where: { tenantId: record.tenantId, submissionId: record.submissionId,
      submission: { userId: record.accountId, docType: record.docType, subjectId: record.subjectId, purgedAt: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, wrappedDek: true, fields: {
      where: { tenantId: record.tenantId, submissionId: record.submissionId, fieldCode: { in: [...codes] } },
      select: { runId: true, fieldCode: true, valueCt: true },
    } },
  });
  const kp = getKeyProvider();
  for (const run of runs) {
    const fields = run.fields.filter(f => f.runId === run.id && f.valueCt && !out.has(f.fieldCode));
    if (!fields.length || !run.wrappedDek || !kp) continue;
    const dek = await kp.unwrapDek(Buffer.from(run.wrappedDek));
    const opened: string[] = [];
    for (const f of fields) {
      if (f.valueCt && !out.has(f.fieldCode)) { out.set(f.fieldCode, unpackAndDecrypt(Buffer.from(f.valueCt), dek).toString('utf8')); opened.push(f.fieldCode); }
    }
    // [row 107] Every decrypt of document evidence leaves one audit row on the
    // document's own trail (the custody narrative reads it): which fields, for
    // which purpose — never the values.
    if (opened.length) {
      await db.auditLog.create({ data: {
        userId: null, action: 'DISCLOSURE_FIELDS_DECRYPTED', entity: 'VerificationDocument', entityId: record.submissionId,
        changes: { purpose, docType: record.docType, recordId: record.id, fields: opened },
      } });
    }
  }
  return out;
}

/** The registry law: the block gates go-live only once the country's BUSINESS-bucket types are active. */
export async function disclosureGateEngaged(db: Db, countryCode: string): Promise<boolean> {
  const active = await db.docType.count({ where: { countryCode, isActive: true, bucket: 'BUSINESS' } });
  return active > 0;
}

const DISCLOSURE_VENDOR_SELECT = {
  id: true, tenantId: true, name: true, addressLine1: true, addressLine2: true, publicPhone: true,
  owner: { select: { userId: true, user: { select: {
    tenantId: true, countryCode: true, firstName: true, lastName: true, phone: true, isPhoneVerified: true,
  } } } },
} satisfies Prisma.VendorSelect;
type DisclosureVendor = Prisma.VendorGetPayload<{ select: typeof DISCLOSURE_VENDOR_SELECT }>;

/** The direct-link shell may be closed, pending or suspended. Private supplier
 * details have their own current eligibility read before owner/evidence access. */
export async function compilePublicStorefrontDisclosure(db: Db, vendorId: string, now = new Date()): Promise<DisclosureBlock | null> {
  const vendor = await db.vendor.findFirst({
    where: { id: vendorId, ...vendorTenantForCaller(), status: { in: ['ACTIVE', 'CLOSED'] },
      isVerified: true, subscription: { isNot: inoperableSubscriptionWhere(await readFeePause(db), now) },
      owner: { user: { status: 'ACTIVE' } } },
    select: DISCLOSURE_VENDOR_SELECT,
  });
  if (!vendor || vendor.owner.user.tenantId !== vendor.tenantId) return null;
  return compileDisclosure(db, vendor, 'PUBLIC_STOREFRONT', now);
}

/** Internal activation computes completeness before a store is approved. It
 * must name the exact payer and tenant already resolved by the decision path;
 * public lifecycle conditions would strand this transition. */
export async function compileActivationDisclosure(
  db: Db, vendorId: string, authority: { accountId: string; tenantId: string }, now = new Date(),
): Promise<DisclosureBlock> {
  const callerTenant = getTenantId();
  const vendor = authority.accountId && authority.tenantId && (!callerTenant || callerTenant === authority.tenantId)
    ? await db.vendor.findFirst({
      where: { id: vendorId, tenantId: authority.tenantId,
        owner: { userId: authority.accountId, user: { tenantId: authority.tenantId } } },
      select: DISCLOSURE_VENDOR_SELECT,
    }) : null;
  if (!vendor) return { complete: false, missing: ['vendor'], legalName: null, address: null, contact: null, licences: [], operator: platformOperator(), compiledAt: now.toISOString() };
  return compileDisclosure(db, vendor, 'VENDOR_ACTIVATION', now);
}

/** [row 107] The PUBLIC block holds only published values, so it is cached per
 *  store: a decrypt (and its one audit row) happens on a cache miss, never on
 *  every page view. The key is a digest of everything the block is compiled
 *  from — the store's disclosure fields, its owner's, the VALID records (with
 *  their last change), the field registry and the platform operator — so any
 *  change to them is a miss at once; the TTL bounds anything not in the key
 *  (a re-extraction of an unchanged record). Eligibility is NOT cached: the
 *  caller's visibility read runs on every request before this. */
export const PUBLIC_DISCLOSURE_TTL_MS = 10 * 60_000;
const publicDisclosureCache = new Map<string, { at: number; key: string; block: DisclosureBlock }>();
export function resetPublicDisclosureCacheForTests(): void { publicDisclosureCache.clear(); }

async function compileDisclosure(db: Db, vendor: DisclosureVendor, purpose: DisclosurePurpose, now: Date): Promise<DisclosureBlock> {
  const missing: string[] = [];
  const accountId = vendor.owner.userId;
  const records = (await db.documentRecord.findMany({
    where: { tenantId: vendor.tenantId, accountId, status: 'VALID', OR: [{ expiresOn: null }, { expiresOn: { gt: now } }],
      submission: { userId: accountId, purgedAt: null } },
    select: { id: true, tenantId: true, accountId: true, subjectId: true, docType: true, submissionId: true, updatedAt: true,
      submission: { select: { docType: true, subjectId: true } } },
  })).filter(r => r.docType === r.submission.docType && r.subjectId === r.submission.subjectId);
  // The historical map cannot declassify a runtime PERSONAL type. Unknown
  // types/fields, and either PERSONAL classification, never reach unwrap.
  const candidates = records.filter((r) => BUCKET_OF[r.docType] === 'BUSINESS');
  const registry = candidates.length ? await db.docType.findMany({
    where: { countryCode: vendor.owner.user.countryCode, legacyCode: { in: candidates.map(r => r.docType) }, bucket: 'BUSINESS' },
    select: { legacyCode: true, fields: { where: { isPii: false }, select: { fieldCode: true } } },
  }) : [];
  const publicFields = new Map(registry.map(r => [r.legacyCode, new Set(r.fields.map(f => f.fieldCode))]));
  const cacheKey = purpose === 'PUBLIC_STOREFRONT'
    ? createHash('sha256').update(JSON.stringify([vendor, records.map(r => [r.id, r.docType, r.submissionId, r.subjectId, r.updatedAt]), registry, platformOperator()])).digest('hex')
    : null;
  if (cacheKey) {
    const hit = publicDisclosureCache.get(vendor.id);
    if (hit && hit.key === cacheKey && now.getTime() - hit.at < PUBLIC_DISCLOSURE_TTL_MS) return structuredClone(hit.block);
  }
  const business = candidates.filter(r => publicFields.has(r.docType));
  const fieldsFor = (r: RecordSource, codes: readonly string[]) => readFields(db, r, codes.filter(c => publicFields.get(r.docType)?.has(c)), purpose);
  const provenance = (r: RecordSource) => ({ docType: r.docType, ...(purpose === 'VENDOR_ACTIVATION' ? { recordId: r.id } : {}) });
  const identity = records.find((r) => IDENTITY_DOC_TYPES.includes(r.docType));

  // Legal / registered name: a VALID business record's read name; else the verified proprietor "trading as".
  let legalName: DisclosureElement | null = null;
  for (const r of business) {
    const f = await fieldsFor(r, NAME_FIELDS);
    const v = NAME_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { legalName = { value: v.trim(), source: 'RECORD', ...provenance(r) }; break; }
  }
  if (!legalName && identity) {
    const proprietor = `${vendor.owner.user.firstName} ${vendor.owner.user.lastName}`.trim();
    if (proprietor) legalName = { value: `${proprietor} trading as ${vendor.name}`, source: 'PROPRIETOR', ...provenance(identity) };
  }
  if (!legalName) missing.push('legalName');

  // Principal geographic address: a business record's read address; else the self-declared address, labelled.
  let address: DisclosureElement | null = null;
  for (const r of business) {
    const f = await fieldsFor(r, ADDRESS_FIELDS);
    const v = ADDRESS_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { address = { value: v.trim(), source: 'RECORD', ...provenance(r) }; break; }
  }
  if (!address) {
    const declared = [vendor.addressLine1, vendor.addressLine2].filter((x) => x && x.trim()).join(', ');
    if (declared) address = { value: declared, source: 'SELF_DECLARED' };
  }
  if (!address) missing.push('address');

  // Electronic contact. The requirement is met by the owner's VERIFIED account
  // contact, but that number is private: [row 107] the public block shows only
  // the contact the store itself PUBLISHED (none → withheld; the platform
  // operator block below is always reachable). Activation sees the account
  // contact, for completeness only.
  const accountContact = vendor.owner.user.isPhoneVerified && vendor.owner.user.phone ? vendor.owner.user.phone : null;
  if (!accountContact) missing.push('contact');
  const published = safePublicPhone(vendor.publicPhone);
  const contact: DisclosureElement | null = purpose === 'PUBLIC_STOREFRONT'
    ? (published ? { value: published, source: 'PUBLISHED' } : null)
    : (accountContact ? { value: accountContact, source: 'ACCOUNT' } : null);

  // PERSONAL licences truthfully disclose only their on-file fact. Their
  // numbers are not required for completeness in either caller, so neither
  // caller needs a PERSONAL read or an associated privileged audit capability.
  const licences: DisclosureElement[] = [];
  for (const r of records.filter((x) => LICENCE_DISCLOSURE_TYPES.includes(x.docType))) {
    const f = await fieldsFor(r, ['licence_number', 'certificate_number', 'permit_number']);
    const number = [...f.values()].find((x) => x && x.trim());
    licences.push({ value: number ? number.trim() : 'on file', source: 'RECORD', ...provenance(r) });
  }

  const operator = platformOperator();
  if (!operator) missing.push('operator');

  const block: DisclosureBlock = { complete: missing.length === 0, missing, legalName, address, contact, licences, operator, compiledAt: now.toISOString() };
  if (cacheKey) {
    publicDisclosureCache.set(vendor.id, { at: now.getTime(), key: cacheKey, block: structuredClone(block) });
    if (publicDisclosureCache.size > 5000) publicDisclosureCache.delete(publicDisclosureCache.keys().next().value!);
  }
  return block;
}
