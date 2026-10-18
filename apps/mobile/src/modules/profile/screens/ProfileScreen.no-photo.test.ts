import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [Owner 16 Oct: customers take no photos · REVIEW-F #1837 S2-1/S3-1] The customer Profile tab (CustomerStack
// only) never asks a customer for a picture: no trust fact or "next" step names a selfie or photo, and the
// avatar's chip is an edit control, not a camera (Personal data has no picture action for a customer).
// The ID on file is not a halo fact either: the caption counts facts as "Verified n of m", and an ID only on
// file is never called verified (owner 8 Oct).
const src = readFileSync(join(__dirname, 'ProfileScreen.tsx'), 'utf8');
const facts = /const facts:[\s\S]*?\];/.exec(src)?.[0] ?? '';

describe('[no customer photo] the customer Profile screen', () => {
  it('has trust facts, and none of them is about a selfie, a photo or an ID on file', () => {
    expect(facts).toMatch(/Phone verified/);
    expect(facts).not.toMatch(/selfie|photo|picture|camera|ID on file/i);
    expect(src).not.toMatch(/selfieCapturedAt|add a selfie|Selfie on file/);
  });
  it('the avatar chip is an edit control, never a camera or a photo action', () => {
    expect(src).not.toMatch(/name="camera"/);
    expect(src).not.toMatch(/accessibilityLabel="[^"]*(photo|selfie|picture)/i);
    expect(src).toMatch(/accessibilityLabel="Edit your personal data"/);
  });
});
