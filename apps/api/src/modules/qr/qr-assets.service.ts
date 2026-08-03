import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { color } from '@swift/ui';
import type { VendorType } from '@prisma/client';
import { publicWebBase } from './qr-codes';

type Pdf = InstanceType<typeof PDFDocument>;

// ---------------------------------------------------------------------------
// QR asset generation (spec 4.4/4.5/16) — the print pack vendors fall in love
// with. The QR inside every PDF is drawn as VECTOR rectangles straight from
// the module matrix (crisp at any print size, no raster ceiling); PNGs render
// at explicit pixel sizes for digital use. Brand comes from @swift/ui tokens —
// the single source of truth; no invented hexes anywhere. Dark modules are ink
// on a white plate only (contrast enforced by test), EC level H, quiet zone
// ≥ 4 modules built into every render.
// ---------------------------------------------------------------------------

const MM_TO_PT = 72 / 25.4;
const BLEED_MM = 3;
const QUIET_MODULES = 4;

const INK = color.text.primary;
const MAROON = color.brand[500];
const PAPER = color.surface.subtle;
const WHITE = color.white;
const MUTED = color.text.secondary;

const FONT_DIR = path.resolve(__dirname, '../../../assets/fonts');
export const FONTS = {
  display: path.join(FONT_DIR, 'BricolageGrotesque_800ExtraBold.ttf'),
  displayMed: path.join(FONT_DIR, 'BricolageGrotesque_700Bold.ttf'),
  body: path.join(FONT_DIR, 'HankenGrotesk_400Regular.ttf'),
  bodySemi: path.join(FONT_DIR, 'HankenGrotesk_600SemiBold.ttf'),
} as const;

export type QrTemplateId = 'card' | 'tabletent' | 'sticker' | 'flyer' | 'decal' | 'poster';

/** Physical spec per template: trim size and the MINIMUM code size the
 *  scan-distance rule demands (Part 16) — layouts must meet it at trim. */
export const QR_TEMPLATES: Record<QrTemplateId, { trimWmm: number; trimHmm: number; codeMm: number }> = {
  card: { trimWmm: 88.9, trimHmm: 50.8, codeMm: 30 }, // 3.5×2 in counter card
  tabletent: { trimWmm: 148, trimHmm: 210, codeMm: 52 }, // A5, folded horizontally
  sticker: { trimWmm: 210, trimHmm: 148, codeMm: 62 }, // A5-landscape sheet: circle + square
  flyer: { trimWmm: 148, trimHmm: 210, codeMm: 52 }, // A5 bag insert
  decal: { trimWmm: 210, trimHmm: 297, codeMm: 122 }, // A4 window
  poster: { trimWmm: 297, trimHmm: 420, codeMm: 262 }, // A3 wall
};

/** Copy system (Part 14): headline / action / promise / footer. */
export function templateCopy(vendorName: string, vendorType: VendorType) {
  const promise =
    vendorType === 'RESTAURANT' ? 'Delivery or pickup — pay cash or MMG'
    : vendorType === 'SUPERMARKET' ? 'Groceries to your door — cash or MMG'
    : vendorType === 'STORE' ? `Shop ${vendorName} from home — delivery or pickup`
    : `Book ${vendorName} on Swift`;
  return {
    headline: `${vendorName} is on Swift`,
    action: vendorType === 'SERVICE' ? 'Scan to book' : 'Scan to order',
    promise,
    footer: publicWebBase().replace(/^https?:\/\//, ''),
  };
}

/** WCAG relative-luminance contrast — the scannability guard (≥ 4.5:1). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    const chan = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const [a, b] = [lum(hexA), lum(hexB)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Module colors are FIXED v1: ink on white. Reject anything that fails the
 *  contrast law rather than rendering a pretty code that doesn't scan. */
export function assertScannableStyle(dark: string, light: string): void {
  const ratio = contrastRatio(dark, light);
  if (ratio < 4.5) throw new Error(`QR style rejected: contrast ${ratio.toFixed(2)} < 4.5:1`);
}

export async function renderQrPng(url: string, widthPx: number): Promise<Buffer> {
  assertScannableStyle(INK, WHITE);
  return QRCode.toBuffer(url, {
    errorCorrectionLevel: 'H',
    margin: QUIET_MODULES,
    width: widthPx,
    color: { dark: INK, light: WHITE },
  });
}

export async function renderQrSvg(url: string, widthPx = 320): Promise<string> {
  assertScannableStyle(INK, WHITE);
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: QUIET_MODULES,
    width: widthPx,
    color: { dark: INK, light: WHITE },
  });
}

/** The module matrix the vector renderer draws from — exported so the decode
 *  harness can rasterize EXACTLY this mapping and prove it scans. */
export function qrMatrix(url: string): { size: number; get: (row: number, col: number) => boolean } {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'H' });
  return { size: qr.modules.size, get: (row, col) => Boolean(qr.modules.get(row, col)) };
}

/** Vector QR: white plate + ink modules from the matrix, quiet zone included.
 *  sizePt is the FULL plate size (code + quiet zone). */
function drawQrVector(doc: Pdf, url: string, x: number, y: number, sizePt: number): void {
  assertScannableStyle(INK, WHITE);
  const qr = QRCode.create(url, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const total = n + QUIET_MODULES * 2;
  const mod = sizePt / total;
  doc.save();
  doc.rect(x, y, sizePt, sizePt).fill(WHITE);
  doc.fillColor(INK);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.modules.get(r, c)) {
        // Hairline overlap keeps adjacent modules seamless at print resolution.
        doc.rect(x + (QUIET_MODULES + c) * mod, y + (QUIET_MODULES + r) * mod, mod + 0.05, mod + 0.05).fill();
      }
    }
  }
  doc.restore();
}

/** Corner trim marks in the bleed area — hairline, outside the trim box. */
function drawTrimMarks(doc: Pdf, pageW: number, pageH: number, bleed: number): void {
  const len = bleed * 0.7;
  doc.save().lineWidth(0.25).strokeColor(INK);
  const corners: [number, number, 1 | -1, 1 | -1][] = [
    [bleed, bleed, 1, 1],
    [pageW - bleed, bleed, -1, 1],
    [bleed, pageH - bleed, 1, -1],
    [pageW - bleed, pageH - bleed, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    doc.moveTo(cx - dx * bleed, cy).lineTo(cx - dx * (bleed - len), cy).stroke();
    doc.moveTo(cx, cy - dy * bleed).lineTo(cx, cy - dy * (bleed - len)).stroke();
  }
  doc.restore();
}

interface TemplateData {
  vendorName: string;
  vendorType: VendorType;
  shortUrl: string;
}

/** One template panel: paper ground, headline, white QR plate, action line,
 *  promise, maroon footer band with the domain. Scaled by the panel rect. */
function drawPanel(
  doc: Pdf,
  data: TemplateData,
  rect: { x: number; y: number; w: number; h: number },
  codePt: number,
): void {
  const copy = templateCopy(data.vendorName, data.vendorType);
  const cx = rect.x + rect.w / 2;
  const unit = Math.min(rect.w, rect.h);
  const headSize = Math.max(10, unit * 0.055);
  const actionSize = Math.max(9, unit * 0.045);
  const bodySize = Math.max(6.5, unit * 0.03);
  const bandH = Math.max(16, unit * 0.07);

  doc.save();
  doc.rect(rect.x, rect.y, rect.w, rect.h).fill(PAPER);

  // Headline
  doc.font('display').fontSize(headSize).fillColor(INK);
  doc.text(copy.headline, rect.x + rect.w * 0.06, rect.y + rect.h * 0.07, {
    width: rect.w * 0.88,
    align: 'center',
  });

  // QR plate, centered
  const qrY = rect.y + rect.h * 0.07 + headSize * 2.2;
  const plate = Math.min(codePt * (1 + (QUIET_MODULES * 2) / 29), rect.w * 0.8, rect.h * 0.62);
  drawQrVector(doc, data.shortUrl, cx - plate / 2, qrY, plate);

  // Action + promise under the code
  const textY = qrY + plate + unit * 0.025;
  doc.font('displayMed').fontSize(actionSize).fillColor(MAROON);
  doc.text(copy.action, rect.x + rect.w * 0.06, textY, { width: rect.w * 0.88, align: 'center' });
  doc.font('body').fontSize(bodySize).fillColor(MUTED);
  doc.text(copy.promise, rect.x + rect.w * 0.06, textY + actionSize * 1.5, { width: rect.w * 0.88, align: 'center' });

  // Footer band
  doc.rect(rect.x, rect.y + rect.h - bandH, rect.w, bandH).fill(MAROON);
  doc.font('bodySemi').fontSize(bodySize).fillColor(WHITE);
  doc.text(`swift — ${copy.footer}`, rect.x, rect.y + rect.h - bandH / 2 - bodySize / 2, {
    width: rect.w,
    align: 'center',
  });
  doc.restore();
}

/** Sticker sheet: maroon circle badge + square card, one sheet, both codes. */
function drawStickerSheet(doc: Pdf, data: TemplateData, pageW: number, pageH: number, bleed: number, codePt: number): void {
  const copy = templateCopy(data.vendorName, data.vendorType);
  doc.rect(0, 0, pageW, pageH).fill(PAPER);
  const cy = pageH / 2;
  const r = codePt * 0.78;
  const cxCircle = bleed + (pageW - bleed * 2) * 0.28;
  const cxSquare = bleed + (pageW - bleed * 2) * 0.74;

  // Circle sticker: maroon disc, white plate INSIDE keeps the quiet zone law.
  doc.circle(cxCircle, cy, r + codePt * 0.16).fill(MAROON);
  drawQrVector(doc, data.shortUrl, cxCircle - r * 0.82, cy - r * 0.82 - codePt * 0.06, r * 1.64);
  doc.font('bodySemi').fontSize(codePt * 0.075).fillColor(WHITE);
  doc.text(copy.action, cxCircle - r, cy + r * 0.82, { width: r * 2, align: 'center' });

  // Square sticker
  const sq = r * 2.05;
  doc.save().rect(cxSquare - sq / 2, cy - sq / 2, sq, sq).fill(WHITE).restore();
  drawQrVector(doc, data.shortUrl, cxSquare - sq * 0.42, cy - sq / 2 + sq * 0.06, sq * 0.84);
  doc.font('displayMed').fontSize(codePt * 0.08).fillColor(MAROON);
  doc.text(copy.action, cxSquare - sq / 2, cy + sq / 2 - codePt * 0.14, { width: sq, align: 'center' });
}

export async function renderTemplatePdf(template: QrTemplateId, data: TemplateData): Promise<Buffer> {
  const spec = QR_TEMPLATES[template];
  const bleed = BLEED_MM * MM_TO_PT;
  const pageW = spec.trimWmm * MM_TO_PT + bleed * 2;
  const pageH = spec.trimHmm * MM_TO_PT + bleed * 2;
  const codePt = spec.codeMm * MM_TO_PT;

  const doc = new PDFDocument({ size: [pageW, pageH], margin: 0 });
  doc.registerFont('display', FONTS.display);
  doc.registerFont('displayMed', FONTS.displayMed);
  doc.registerFont('body', FONTS.body);
  doc.registerFont('bodySemi', FONTS.bodySemi);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (template === 'sticker') {
    drawStickerSheet(doc, data, pageW, pageH, bleed, codePt);
  } else if (template === 'tabletent') {
    // Two mirrored panels on one A5: print flat, fold horizontally, both
    // sides read upright on the table.
    const half = pageH / 2;
    doc.save();
    doc.rotate(180, { origin: [pageW / 2, half / 2] });
    drawPanel(doc, data, { x: 0, y: 0, w: pageW, h: half }, codePt * 0.82);
    doc.restore();
    drawPanel(doc, data, { x: 0, y: half, w: pageW, h: half }, codePt * 0.82);
    doc.save().lineWidth(0.25).strokeColor(MUTED)
      .moveTo(0, half).lineTo(pageW, half).dash(4, { space: 4 }).stroke().undash().restore();
  } else {
    drawPanel(doc, data, { x: 0, y: 0, w: pageW, h: pageH }, codePt);
  }

  drawTrimMarks(doc, pageW, pageH, bleed);
  doc.end();
  return done;
}

// In-memory render cache: assets are pure functions of (code version, format,
// options) — regenerate/deactivate mints a NEW row, so keys self-invalidate.
const CACHE_MAX = 60;
const cache = new Map<string, Buffer>();

export async function cachedRender(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const hit = cache.get(key);
  if (hit) return hit;
  const buffer = await render();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, buffer);
  return buffer;
}
