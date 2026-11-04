import { describe, expect, it } from 'vitest';
import { urlAlphabet } from 'nanoid';
import { isOwnSelfiePointer } from '../modules/verification/signup-selfie';
import { sealedPhotoParts } from '../providers/storage/sealed-photo';
import { parsePublicPhotoKey } from '../utils/public-photo-deletion';

// A stored file's name is 16 characters of nanoid's alphabet, then an extension. Every reader of that name must take the
// writer's whole alphabet in every position, the first included: a name starting with - or _ is 2 in 64 of them. The
// names here are chosen, one for each character the writer can put first, so nothing is left to a random draw.

const USER = 'cmw1userid0000000000000000';
const name = (first: string, ext: string) => `${first}${'a'.repeat(15)}${ext}`;

describe('every first character the writer can issue', () => {
  it('the alphabet is the one the writer draws from', () => {
    expect(urlAlphabet).toHaveLength(64);
    expect([...urlAlphabet]).toEqual(expect.arrayContaining(['-', '_']));
  });

  it.each([...urlAlphabet])('%s: a selfie, sealed or plain, stored or local, is the applicant\'s own', (first) => {
    for (const ext of ['.enc', '.jpg', '.png', '.webp']) {
      expect(isOwnSelfiePointer(USER, `avatars/${USER}/${name(first, ext)}`), ext).toBe(true);
      expect(isOwnSelfiePointer(USER, `/uploads/avatars/${USER}/${name(first, ext)}`), ext).toBe(true);
    }
  });

  it.each([...urlAlphabet])('%s: the other exported readers take it too', (first) => {
    expect(sealedPhotoParts(`avatars/${USER}/${name(first, '.enc')}`)).toMatchObject({ file: name(first, '.enc') });
    expect(parsePublicPhotoKey(`items/${USER}/${name(first, '.jpg')}`)).toMatchObject({ file: name(first, '.jpg') });
  });
});

describe('the path stays exact: only the applicant\'s own folder, only one plain name', () => {
  it.each([
    ['climbing out', `avatars/${USER}/../${USER}/x.jpg`],
    ['climbing out, name first', `avatars/${USER}/..`],
    ['a dash and a climb', `avatars/${USER}/-..jpg`],
    ['an underscore and a climb', `avatars/${USER}/_..jpg`],
    ['a climb inside a name', `avatars/${USER}/a..b.jpg`],
    ['a hidden file', `avatars/${USER}/.hidden`],
    ['a dot alone', `avatars/${USER}/.`],
    ['a folder below', `avatars/${USER}/sub/x.jpg`],
    ['an empty name', `avatars/${USER}/`],
    ['a backslash', `avatars/${USER}/a\\b.jpg`],
    ['a space', `avatars/${USER}/a b.jpg`],
    ['a percent escape', `avatars/${USER}/%2e%2e.jpg`],
    ['a query', `avatars/${USER}/x.jpg?y=1`],
    ['a line break', `avatars/${USER}/x.jpg\n`],
    ['a NUL', `avatars/${USER}/x\0.jpg`],
    ['another person', `avatars/someone-else/${name('-', '.enc')}`],
    ['another folder', `verification/${USER}/${name('-', '.enc')}`],
    ['a stray leading slash', `/avatars/${USER}/${name('-', '.enc')}`],
    ['a web address', `https://cdn.test/avatars/${USER}/${name('-', '.enc')}`],
  ])('%s is refused', (_what, pointer) => {
    expect(isOwnSelfiePointer(USER, pointer)).toBe(false);
  });

  it('no photo is nobody\'s', () => {
    expect(isOwnSelfiePointer(USER, null)).toBe(false);
    expect(isOwnSelfiePointer(USER, undefined)).toBe(false);
    expect(isOwnSelfiePointer(USER, '')).toBe(false);
  });
});
