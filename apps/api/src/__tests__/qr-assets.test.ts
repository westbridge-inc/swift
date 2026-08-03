import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import {
  QR_TEMPLATES,
  contrastRatio,
  qrMatrix,
  renderQrPng,
  renderQrSvg,
  renderTemplatePdf,
  templateCopy,
  assertScannableStyle,
  type QrTemplateId,
} from '../modules/qr/qr-assets.service';

// ---------------------------------------------------------------------------
// QR-N, the CI decode harness: a QR that renders but doesn't decode is a P0,
// full stop. Every template's code renders at its exact print pixel size
// (codeMm @ 300 DPI) and must decode char-for-char — then again at 60% scale
// to catch tight-margin regressions. The vector path the PDFs draw is proven
// by rasterizing the SAME exported matrix mapping. PDFs themselves are checked
// for structure: page geometry (trim + 2×3mm bleed), embedded brand fonts.
// ---------------------------------------------------------------------------

const URL = 'https://swift.gy/s/BCDFGHJKMN';
const MM_TO_PX_300DPI = 300 / 25.4;
const MM_TO_PT = 72 / 25.4;

function decodePng(buffer: Buffer): string | null {
  const png = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data ?? null;
}

/** Nearest-neighbor downscale — deliberately crude; if the code survives this
 *  it survives a phone camera. */
function downscale(buffer: Buffer, factor: number): Buffer {
  const src = PNG.sync.read(buffer);
  const w = Math.floor(src.width * factor);
  const h = Math.floor(src.height * factor);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(src.width - 1, Math.round(x / factor));
      const sy = Math.min(src.height - 1, Math.round(y / factor));
      const si = (sy * src.width + sx) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = src.data[si + 3]!;
    }
  }
  return PNG.sync.write(out);
}

describe('decode harness — every template size, 100% and 60%', () => {
  for (const [template, spec] of Object.entries(QR_TEMPLATES)) {
    it(`${template}: ${spec.codeMm}mm code decodes at print resolution and at 60%`, async () => {
      const px = Math.round(spec.codeMm * MM_TO_PX_300DPI);
      const png = await renderQrPng(URL, px);
      expect(decodePng(png)).toBe(URL);
      expect(decodePng(downscale(png, 0.6))).toBe(URL);
    });
  }

  it('digital sizes 1024 and 4096 decode', async () => {
    expect(decodePng(await renderQrPng(URL, 1024))).toBe(URL);
    expect(decodePng(await renderQrPng(URL, 4096))).toBe(URL);
  });

  it('the VECTOR matrix mapping the PDFs draw decodes when rasterized 1:1', () => {
    const m = qrMatrix(URL);
    const quiet = 4;
    const scale = 8;
    const total = (m.size + quiet * 2) * scale;
    const png = new PNG({ width: total, height: total });
    png.data.fill(255);
    for (let r = 0; r < m.size; r += 1) {
      for (let c = 0; c < m.size; c += 1) {
        if (!m.get(r, c)) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = (quiet + c) * scale + dx;
            const y = (quiet + r) * scale + dy;
            const i = (y * total + x) * 4;
            png.data[i] = 0x21; png.data[i + 1] = 0x1a; png.data[i + 2] = 0x1a; png.data[i + 3] = 255;
          }
        }
      }
    }
    expect(decodePng(PNG.sync.write(png))).toBe(URL);
  });

  it('svg render contains a real vector code', async () => {
    const svg = await renderQrSvg(URL, 512);
    expect(svg).toContain('<svg');
    expect(svg.length).toBeGreaterThan(1000);
  });
});

describe('print PDFs', () => {
  for (const template of Object.keys(QR_TEMPLATES) as QrTemplateId[]) {
    it(`${template}: valid PDF, correct page geometry (trim + 2×3mm bleed), brand fonts embedded`, async () => {
      const spec = QR_TEMPLATES[template];
      const pdf = await renderTemplatePdf(template, { vendorName: "Auntie's Roti Shop", vendorType: 'RESTAURANT', shortUrl: URL });
      const text = pdf.toString('latin1');
      expect(text.startsWith('%PDF')).toBe(true);
      expect(pdf.length).toBeGreaterThan(5_000);

      const expectW = spec.trimWmm * MM_TO_PT + 6 * MM_TO_PT;
      const expectH = spec.trimHmm * MM_TO_PT + 6 * MM_TO_PT;
      const box = /\/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]/.exec(text);
      expect(box).not.toBeNull();
      expect(Number(box![1])).toBeCloseTo(expectW, 0);
      expect(Number(box![2])).toBeCloseTo(expectH, 0);

      expect(text).toContain('BricolageGrotesque');
      expect(text).toContain('HankenGrotesk');
    });
  }

  it('services vendors get "Scan to book" and their promise line', () => {
    const copy = templateCopy('Singh Electrical', 'SERVICE');
    expect(copy.action).toBe('Scan to book');
    expect(copy.promise).toBe('Book Singh Electrical on Swift');
    expect(templateCopy('Green Bowl', 'RESTAURANT').action).toBe('Scan to order');
    expect(templateCopy('Green Bowl', 'RESTAURANT').promise).toBe('Delivery or pickup — pay cash or MMG');
  });
});

describe('the scannability contrast law', () => {
  it('ink on white passes with huge margin; failing styles are REJECTED', () => {
    expect(contrastRatio('#211A1A', '#FFFFFF')).toBeGreaterThan(4.5);
    expect(() => assertScannableStyle('#211A1A', '#FFFFFF')).not.toThrow();
    // A pretty-but-unscannable pairing must throw, not render.
    expect(() => assertScannableStyle('#C08A8B', '#FBFBF9')).toThrow(/contrast/);
  });
});
