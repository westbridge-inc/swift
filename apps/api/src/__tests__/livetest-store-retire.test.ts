import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [DS258, DS265 F1] The journey runner's heal sweep suspends ACTIVE stores it
// minted itself and left live. A name match alone could suspend a real
// merchant who happened to pick the same name, so every condition must hold:
// the journey store name, a fictional +5920 owner phone (never a real
// subscriber), a TEST- owner first name, and not a seeded demo store.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '../../../..');
const load = async () => import(pathToFileURL(join(ROOT, 'scripts/livetest/store-retire.ts')).href);

const minted = { name: 'TEST-vend01', owner: { user: { phone: '+5920123456', firstName: 'TEST-vend01' } } };

describe('the heal sweep retires only stores the journeys minted themselves', () => {
  it('a leftover journey store is retired', async () => {
    const { isJourneyMintedStore } = await load();
    expect(isJourneyMintedStore(minted)).toBe(true);
    expect(isJourneyMintedStore({ ...minted, name: 'TEST-admin01', owner: { user: { phone: '+5920654321', firstName: 'TEST-admin01' } } })).toBe(true);
  });

  it('a real merchant with the same store name is never retired (a real subscriber number)', async () => {
    const { isJourneyMintedStore } = await load();
    expect(isJourneyMintedStore({ ...minted, owner: { user: { phone: '+5926000001', firstName: 'TEST-vend01' } } })).toBe(false);
  });

  it('a store owned by a non-journey account is never retired, even on a fictional number', async () => {
    const { isJourneyMintedStore } = await load();
    expect(isJourneyMintedStore({ ...minted, owner: { user: { phone: '+5920123456', firstName: 'Ravi' } } })).toBe(false);
  });

  it('only the exact journey names match; seeded demo stores never do', async () => {
    const { isJourneyMintedStore, NEVER_RETIRE_STORE_NAMES } = await load();
    expect(isJourneyMintedStore({ ...minted, name: 'TEST-vend01 ' })).toBe(false);
    expect(isJourneyMintedStore({ ...minted, name: 'test-vend01' })).toBe(false);
    for (const name of NEVER_RETIRE_STORE_NAMES) expect(isJourneyMintedStore({ ...minted, name })).toBe(false);
  });

  it('the seeded allowlist wins even if the journey name list is ever widened to include a seeded name', async () => {
    const { isJourneyMintedStore, FRESH_STORE_NAMES } = await load();
    FRESH_STORE_NAMES.add('TEST-Kitchen-One');
    try {
      expect(isJourneyMintedStore({ ...minted, name: 'TEST-Kitchen-One' })).toBe(false);
    } finally {
      FRESH_STORE_NAMES.delete('TEST-Kitchen-One');
    }
  });

  it('a row with no owner information is never retired', async () => {
    const { isJourneyMintedStore } = await load();
    expect(isJourneyMintedStore({ name: 'TEST-vend01' })).toBe(false);
  });
});
