import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectImage, sniffImageType, stripImageMetadataStrict } from '../utils/images';

// ---------------------------------------------------------------------------
// [ORDER-FLOW L2 · copy run #2 COUR-01] The journeys' photo fixture must be a
// photo the storage seam accepts.
//
// The seam (#1722, providers/storage/storage-provider.ts) sniffs the bytes,
// walks every PNG chunk to strip metadata — refusing a photo it cannot walk —
// and then reads the result with the real decoder. The runner's fixture was a
// "smallest PNG" whose IDAT declared 11 bytes and carried 12: the decoder
// tolerated it, the chunk walk did not, so every courier pickup and drop-off
// photo the journeys uploaded was refused 400 IMAGE_UNREADABLE and COUR-01
// failed on the harness, not on the product.
//
// Graded through the seam's own three steps, in its order, on the exact bytes
// the runner sends (FIXTURE_PNG and every uniquePng). Imported by path, like
// livetest-guard.test.ts (scripts/ is outside rootDir).
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
let client: { FIXTURE_PNG: Buffer };
let roster: { uniquePng: (label: string) => Buffer };

beforeAll(async () => {
  client = await import(pathToFileURL(join(ROOT, 'scripts/livetest/client.ts')).href);
  roster = await import(pathToFileURL(join(ROOT, 'scripts/livetest/roster.ts')).href);
});

/** The storage seam's checks, in its order: sniff, strict strip, decoder. */
async function seamAccepts(bytes: Buffer): Promise<Buffer> {
  const sniffed = sniffImageType(bytes);
  expect(sniffed, 'the bytes sniff as a PNG').toBe('image/png');
  const stored = stripImageMetadataStrict(bytes, 'image/png');
  expect(stored, 'the metadata strip can walk every chunk (null = 400 IMAGE_UNREADABLE)').not.toBeNull();
  await expect(inspectImage(stored!, 'image/png')).resolves.toMatchObject({ format: 'png', width: 1, height: 1 });
  return stored!;
}

describe('the journeys photo fixture is a photo the storage seam accepts', () => {
  it('FIXTURE_PNG passes the sniff, the strict strip and the decoder', async () => {
    await seamAccepts(client.FIXTURE_PNG);
  });

  it('every uniquePng passes too, its label is metadata the strip removes, and two calls never share bytes', async () => {
    const a = roster.uniquePng('cour01-pickup');
    const b = roster.uniquePng('cour01-pickup');
    expect(a.equals(b), 'two uploads of one label still differ (random suffix)').toBe(false);
    const stored = await seamAccepts(a);
    await seamAccepts(b);
    expect(stored.equals(client.FIXTURE_PNG), 'what is stored is the plain image, label stripped').toBe(true);
  });
});
