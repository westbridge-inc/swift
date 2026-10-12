import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renewalBannerCopy } from './renewal-banner';

// [NO-DEAD-ENDS] Staff are told who can renew a document; only the owner gets the door.

describe('renewalBannerCopy', () => {
  it('the owner keeps the named documents and the Account door', () => {
    expect(renewalBannerCopy(true, ['National ID'])).toBe('Store suspended — National ID needs renewal, so new orders are off. Tap to fix it under Account.');
    expect(renewalBannerCopy(true, [])).toMatch(/Tap to renew it under Account/);
  });
  it('staff and managers are told only the owner can renew, and never sent to a Documents they do not have', () => {
    const said = renewalBannerCopy(false, ['National ID', 'TIN Certificate']);
    expect(said).toMatch(/Only the owner can renew documents/);
    expect(said).not.toMatch(/Tap to/);
    expect(said).not.toMatch(/National ID|TIN Certificate/);
  });
});

describe('the order board uses it', () => {
  it('names failing documents only for the owner, and only the owner’s banner is a door', () => {
    const ops = readFileSync(new URL('./screens/VendorOps.tsx', import.meta.url), 'utf8');
    expect(ops).toContain('const isStoreOwner = myRole === \'OWNER\';');
    expect(ops).toMatch(/const failingDocs: string\[\] = isStoreOwner && store\.isVerified === false/);
    expect(ops).toContain('renewalBannerCopy(isStoreOwner, failingDocs.map((d) => docLabel(d)))');
    expect(ops).toMatch(/<Pressable disabled=\{!isStoreOwner\} onPress=\{\(\) => navigation\?\.navigate\?\.\('Account'\)\}>/);
  });
});
