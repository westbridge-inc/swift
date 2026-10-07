import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-01] A yellow car is NOT a requirement for a taxi; the H
// plate stays required. The document checklist is where a driver reads what the
// exterior photo must show, so its label asks for the plate and never a colour.
// Source assertions (the house pattern for component contracts): the card
// imports native modules a Node test cannot load.
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/components/onboarding/DocumentUploadCard.tsx');

function docLabels(): Record<string, string> {
  const src = readFileSync(FILE, 'utf8');
  const block = /const DOC_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('DOC_LABELS not found in DocumentUploadCard.tsx');
  const labels = Object.fromEntries(
    [...block[1]!.matchAll(/^\s*([a-z_]+):\s*(['"])(.*)\2,\s*$/gm)].map((m) => [m[1]!, m[3]!]),
  );
  // a parse that found nothing would make every assertion below vacuous
  if (Object.keys(labels).length < 10) throw new Error('DOC_LABELS parse found too few labels');
  return labels;
}

describe('[owner ruling 2026-10-01] the exterior photo asks for the plate, never a colour', () => {
  // [VERIFY-DOCS · ruling 5, 6 Oct 2026] the one car photo replaces the separate plate photo
  it('reads "Car photo (plate clearly visible)"', () => {
    expect(docLabels()['vehicle_exterior_photo']).toBe('Car photo (plate clearly visible)');
  });

  it('[VERIFY-DOCS · ruling 4] the national ID label accepts the Digital ID card', () => {
    expect(docLabels()['national_id']).toBe('National ID or Digital ID card');
    expect(docLabels()['owner_national_id']).toBe('Owner National ID or Digital ID card');
  });

  it('no document label asks for a colour', () => {
    for (const [docType, label] of Object.entries(docLabels())) {
      expect(label, docType).not.toMatch(/yellow|colou?r/i);
    }
  });
});
