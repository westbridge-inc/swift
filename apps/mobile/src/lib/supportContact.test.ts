import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SUPPORT_CONTACT } from './supportContact';

// The support contact lives in ONE place the app reads (owner ruling 11 Oct:
// the public business line answers WhatsApp and calls, and the website lists
// the same number). These checks keep the app's copy, links and the website
// from drifting apart.

const SRC = join(__dirname, '..');
const digits = (v: string) => v.replace(/\D/g, '');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the support contact', () => {
  it('builds every link from the one number', () => {
    expect(SUPPORT_CONTACT.phoneE164).toBe('+5927163534');
    expect(digits(SUPPORT_CONTACT.phoneDisplay)).toBe(digits(SUPPORT_CONTACT.phoneE164));
    expect(SUPPORT_CONTACT.callUrl).toBe('tel:+5927163534');
    expect(SUPPORT_CONTACT.whatsappUrl).toBe('https://wa.me/5927163534');
    expect(SUPPORT_CONTACT.email).toBe('support@swiftgy.com');
  });

  it('is the number and inbox the website publishes', () => {
    const site = readFileSync(join(SRC, '../../web/src/site.config.ts'), 'utf8');
    const phone = site.match(/^\s*phone: '([^']+)'/m)?.[1];
    const email = site.match(/^\s*supportEmail: '([^']+)'/m)?.[1];
    expect(phone, 'the website config has no phone').toBeTruthy();
    expect(digits(phone!)).toBe(digits(SUPPORT_CONTACT.phoneE164));
    expect(email).toBe(SUPPORT_CONTACT.email);
  });

  it('is written nowhere else in the app source', () => {
    const owner = join(SRC, 'lib/supportContact.ts');
    const strays = sourceFiles(SRC)
      .filter((file) => file !== owner)
      .filter((file) => /7163534|716 3534|support@swiftgy\.com/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(strays).toEqual([]);
  });
});
