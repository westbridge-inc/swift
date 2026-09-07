/**
 * [DOC-1 §3.2/§3.6 · P3-2] The unregistered trader's self-declaration — the document that
 * puts a store on the UNREGISTERED tier. Versioned words (a published legal document, hashed),
 * a consent-ledger row for the signature, and a rendered PDF filed as a BUSINESS-bucket
 * document so the reviewer sees exactly what was signed. Never typed by a reviewer.
 */
import PDFDocument from 'pdfkit';
import type { ConsentDocumentType } from '../legal/consent.service';

export const DECLARATION_CONSENT_TYPE: ConsentDocumentType = 'unregistered_trader_declaration';
export const DECLARATION_VERSION = 'v1';

/** The exact words. A change is a new version — a version is a promise about specific words. */
export const UNREGISTERED_TRADER_DECLARATION_V1 = `UNREGISTERED TRADER SELF-DECLARATION (v1)

I declare that:
1. I am the person whose identity Swift has verified, and I trade in my own name.
2. My business is not registered with the Deeds and Commercial Registries Authority (DCRA) as a business name or a company.
3. The trading name, activity and address I have given are true, and I will update them if they change.
4. I understand that as an unregistered seller my store is capped (orders per day, sales per week), is not eligible for promoted placement, and cannot list goods that need a licence I do not hold.
5. I understand that these limits lift automatically once a valid business registration certificate is on file with Swift.
6. If I sell prepared food, I hold and will keep a valid Food Handler's Permit; Swift never waives it.
7. I am responsible for the goods I sell and for the taxes that apply to me. Swift provides software and does not sell my goods.

This declaration is valid for 365 days from signing and is kept as a record of my onboarding.`;

export const ACTIVITY_CLASSES = ['home_cook', 'snackette', 'market_stall', 'roadside_vendor', 'home_shop', 'other'] as const;
export type ActivityClass = (typeof ACTIVITY_CLASSES)[number];

export interface DeclarationFacts {
  tradingName: string;
  activityClass: ActivityClass;
  declaredAddress: string;
  legalName: string;
  signedAt: Date;
  storeName: string;
}

/** Render the signed declaration as a small PDF: the words, then the facts, then the signature line. */
export function renderDeclarationPdf(facts: DeclarationFacts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(14).text('Swift — Unregistered Trader Self-Declaration', { underline: true });
    doc.moveDown();
    doc.fontSize(10).text(UNREGISTERED_TRADER_DECLARATION_V1);
    doc.moveDown();
    doc.fontSize(11).text('Declared facts', { underline: true });
    doc.fontSize(10)
      .text(`Store: ${facts.storeName}`)
      .text(`Trading name: ${facts.tradingName}`)
      .text(`Activity: ${facts.activityClass}`)
      .text(`Declared address: ${facts.declaredAddress}`)
      .text(`Signed by (verified legal name): ${facts.legalName}`)
      .text(`Signed at: ${facts.signedAt.toISOString()}`)
      .text(`Attestation version: ${DECLARATION_VERSION}`);
    doc.end();
  });
}
