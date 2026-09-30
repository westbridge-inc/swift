import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { QR_TEMPLATES, renderTemplatePdf, type QrTemplateId } from '../modules/qr/qr-assets.service';

// Use pdf-parse's installed renderer dependency, without adding a dependency or
// reaching into PDFParse's private state, to read actual PDF glyph positions.
const fromParser = createRequire(require.resolve('pdf-parse'));
const mm = 72 / 25.4;
const names = ["Maggie's Roti & Curry Shop — Regent Street", 'Café Ñandú'];
const url = 'https://swiftgy.com/s/BCDFGHJKMN';

function panelImage(source: PNG, template: QrTemplateId, panel: number, factor: number): PNG {
  const panelsAcross = template === 'sticker' ? 2 : 1;
  const panelsDown = template === 'tabletent' ? 2 : 1;
  const width = Math.floor(source.width / panelsAcross);
  const height = Math.floor(source.height / panelsDown);
  const startX = panelsAcross === 2 ? panel * width : 0;
  const startY = panelsDown === 2 ? panel * height : 0;
  // jsQR's adaptive threshold has trouble with huge modules. Normalize actual
  // printed panels to a phone-sized image, then test a second smaller image.
  const scale = Math.min(1, 600 / width) * factor;
  const result = new PNG({ width: Math.floor(width * scale), height: Math.floor(height * scale) });
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const src = ((startY + Math.floor(y / scale)) * source.width + startX + Math.floor(x / scale)) * 4;
      source.data.copy(result.data, (y * result.width + x) * 4, src, src + 4);
    }
  }
  return result;
}

describe('actual final PDFs: scan and branding bounds', () => {
  for (const [nameIndex, vendorName] of names.entries()) {
    for (const template of Object.keys(QR_TEMPLATES) as QrTemplateId[]) {
      it(`${template}: ${vendorName}`, async () => {
        // Match the bare /s/:code URL emitted by the printable-asset route.
        const shortUrl = url;
        const pdf = await renderTemplatePdf(template, { vendorName, vendorType: 'RESTAURANT', shortUrl });
        const parser = new PDFParse({ data: new Uint8Array(pdf) });
        const copies = template === 'sticker' || template === 'tabletent' ? 2 : 1;
        try {
          const text = await parser.getText();
          const normalized = text.text.replace(/\s+/g, ' ');
          expect(text.total).toBe(1);
          expect(normalized.split(vendorName)).toHaveLength(copies + 1);
          expect(normalized.split('powered by Swift')).toHaveLength(copies + 1);
          const screenshots = await parser.getScreenshot({ scale: 2, imageDataUrl: false });
          expect(screenshots.pages).toHaveLength(1);
          const raster = Buffer.from(screenshots.pages[0]!.data);
          const png = PNG.sync.read(raster);
          for (let panel = 0; panel < copies; panel++) {
            for (const factor of [1, 0.6]) {
              const image = panelImage(png, template, panel, factor);
              expect(jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data,
                `${template} panel ${panel + 1} scale ${factor}`).toBe(shortUrl);
            }
          }
          // Optional local review artifacts; the ordinary CI test stays in memory.
          const proofDir = process.env['QR_PRINT_PROOF_DIR'];
          if (proofDir) {
            mkdirSync(proofDir, { recursive: true });
            writeFileSync(`${proofDir}/${template}-${nameIndex}.pdf`, pdf);
            writeFileSync(`${proofDir}/${template}-${nameIndex}.png`, raster);
          }
        } finally {
          await parser.destroy();
        }

        const { getDocument } = await import(fromParser.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
        const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
        try {
          const page = await doc.getPage(1);
          const content = await page.getTextContent();
          const spec = QR_TEMPLATES[template];
          const trimRight = (spec.trimWmm + 3) * mm;
          const trimTop = (spec.trimHmm + 3) * mm;
          const pageWidth = (spec.trimWmm + 6) * mm;
          const pageHeight = (spec.trimHmm + 6) * mm;
          const panelText: string[][] = Array.from({ length: copies }, () => []);
          let words = 0;
          for (const item of content.items) {
            if (!('str' in item) || !item.str.trim()) continue;
            words++;
            const [a, b, c, d, x, y] = item.transform;
            const panel = template === 'sticker' ? Number(x > pageWidth / 2)
              : template === 'tabletent' ? Number(y > pageHeight / 2) : 0;
            panelText[panel]!.push(item.str);
            // Each cut sticker and folded table-tent face owns its own branding.
            const left = template === 'sticker' && panel === 1 ? pageWidth / 2 + 2 * mm : 3 * mm;
            const right = template === 'sticker' && panel === 0 ? pageWidth / 2 - 2 * mm : trimRight;
            const bottom = template === 'tabletent' && panel === 1 ? pageHeight / 2 : 3 * mm;
            const top = template === 'tabletent' && panel === 0 ? pageHeight / 2 : trimTop;
            const font = content.styles[item.fontName];
            const size = Math.hypot(c, d);
            const corners = [0, item.width].flatMap(u => [font.descent * item.height, font.ascent * item.height].map(v => ({
              x: x + a / size * u + c / size * v,
              y: y + b / size * u + d / size * v,
            })));
            for (const corner of corners) {
              expect(corner.x, `${item.str}: panel left`).toBeGreaterThanOrEqual(left);
              expect(corner.x, `${item.str}: panel right`).toBeLessThanOrEqual(right);
              expect(corner.y, `${item.str}: panel bottom`).toBeGreaterThanOrEqual(bottom);
              expect(corner.y, `${item.str}: panel top`).toBeLessThanOrEqual(top);
            }
          }
          expect(words).toBeGreaterThanOrEqual(copies * 4);
          for (const text of panelText) {
            const normalized = text.join(' ').replace(/\s+/g, ' ');
            expect(normalized).toContain(vendorName);
            expect(normalized).toContain('powered by Swift');
          }
        } finally {
          await doc.destroy();
        }
      });
    }
  }
});
