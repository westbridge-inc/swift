/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026 ~16:05Z] "I trade under my own name" — the declaration that takes the
 * place of a business registration, ONLY where Guyana law makes registration unnecessary.
 *
 * The law (Business Names (Registration) Act, Cap. 90:05 — CONFIRMED, read in the GCCI copy of the L.R.O.
 * text, owner/LEGAL-RESEARCH-VERIFICATION-DOCS-20261006.md [S18]):
 *   s.3  "… shall be registered …"
 *     (b) "every individual having a place of business in Guyana and carrying on business under a business
 *          name which does not consist of his true surname without any addition other than his true forenames
 *          or the initials thereof;"
 *     (c) "every individual … who … has either before or after the commencement of this Act changed his name,
 *          except in the case of a woman in consequence of marriage;"
 *   s.2  "'initials' includes any recognised abbreviation of a forename".
 * So ONE person whose store's name is their true surname — with nothing added but their true first names or
 * their initials — and who has not changed their name (a woman's change on marriage excepted, s.3(c)) need not register. Anything
 * else (a trading name, a partnership, a company) keeps the business registration requirement. Penalty for a
 * business that should have registered and did not: s.9 (GYD 1,000 a day, research D7).
 *
 * How Swift applies it:
 *  - The machine check below only REFUSES what clearly is not an own name (a word that is neither the
 *    account's surname nor one of its first names or their initials). It never approves anything.
 *  - The person who signs ticks the words below (consent ledger, versioned and hashed) and Swift files them as
 *    the `own_name_declaration` document, which a person on our team reviews against the owner's ID: the
 *    store's name must be the owner's TRUE surname (with only first names or initials) as printed on the ID.
 *  - A store trading under its owner's own name cannot be renamed in the app (the reviewed name is the basis).
 *  - A company never uses this path (a company's certificate of incorporation is its registration).
 */
import PDFDocument from 'pdfkit';
import type { ConsentDocumentType } from '../legal/consent.service';
import { OWN_NAME_DOC_TYPE } from '../verification/doc-registry';

/** The ledger row and the filed document carry the registry's one code (DOC-INV-2: no literal outside the registry). */
export const OWN_NAME_CONSENT_TYPE: ConsentDocumentType = OWN_NAME_DOC_TYPE;
export const OWN_NAME_DECLARATION_VERSION = 'v1';

/** The exact words. A change is a new version — a version is a promise about specific words. */
export const OWN_NAME_DECLARATION_V1 = `I TRADE UNDER MY OWN NAME (v1)

I declare that:
1. I run this store myself, as one person (not a partnership or a company).
2. The store's name is my true surname, with nothing added except my true first names or their initials.
3. I have not changed my name, except where I am a woman whose name changed because of marriage.
4. Under the Business Names (Registration) Act, Cap. 90:05, section 3, I therefore do not need to register a business name.
5. If I trade under any other name, I will register it with the Deeds and Commercial Registries Authority (DCRA) and upload the certificate to Swift before I use it.`;

/** The stores that can trade under an own name: the ones whose checklist asks for a business registration. */
export const OWN_NAME_VENDOR_TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE'] as const;

const words = (s: string): string[] => s
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[’']/g, '')
  .split(/[^\p{L}\p{N}]+/u)
  .filter(Boolean);

/**
 * Could `storeName` be this person's own name? True only when the name contains the account's surname and every
 * other word is one of the account's first names or the initial of one. A false here is a firm "no"; a true is
 * only "a person may check it" (a recognised abbreviation such as "Wm" is left to the reviewer: it is refused here,
 * and the person can type the full first name or its initial).
 */
export function storeNameIsOwnName(storeName: string, firstName: string, lastName: string): boolean {
  const name = words(storeName);
  const surname = words(lastName);
  const forenames = new Set(words(firstName));
  if (name.length === 0 || surname.length === 0) return false;
  // The surname must appear whole and in order (a double-barrelled surname counts as one).
  const at = name.findIndex((_, i) => surname.every((w, j) => name[i + j] === w));
  if (at < 0) return false;
  const rest = [...name.slice(0, at), ...name.slice(at + surname.length)];
  const initials = new Set([...forenames].map((f) => f[0]!));
  return rest.every((w) => forenames.has(w) || (w.length === 1 && initials.has(w)));
}

export interface OwnNameFacts { storeName: string; legalName: string; signedAt: Date }

/** Render the signed declaration: the words, then the facts, then the signature line. */
export function renderOwnNamePdf(facts: OwnNameFacts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(14).text('Swift — I trade under my own name', { underline: true });
    doc.moveDown();
    doc.fontSize(10).text(OWN_NAME_DECLARATION_V1);
    doc.moveDown();
    doc.fontSize(11).text('Declared facts', { underline: true });
    doc.fontSize(10)
      .text(`Store name: ${facts.storeName}`)
      .text(`Signed by (name on the account): ${facts.legalName}`)
      .text(`Signed at: ${facts.signedAt.toISOString()}`)
      .text(`Declaration version: ${OWN_NAME_DECLARATION_VERSION}`)
      .moveDown()
      .text('For the reviewer: compare the store name with the owner’s ID. Approve only when it is the owner’s true surname, with nothing added except their true first names or initials.');
    doc.end();
  });
}
