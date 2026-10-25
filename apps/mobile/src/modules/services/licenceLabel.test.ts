import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { licenceLabel } from './licenceLabel';

// ---------------------------------------------------------------------------
// [R7 · GUARDRAILS §7(4) · owner 15 Oct 2026] "Verified", "licensed" and the
// like appear only where a person on our team checked a current document; a
// licence reads "Licence on file, checked on [date]"; nobody is ever shown as
// "background-checked". Phone parts ship in build 12.
// ---------------------------------------------------------------------------

const src = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('[R7] a licence label says who checked it and when', () => {
  it('"Licence on file, checked on [date]" from the day a person checked it, in Guyana time', () => {
    expect(licenceLabel('2026-10-12T15:30:00.000Z')).toBe('Licence on file, checked on 12 Oct 2026');
    // 02:00Z on the 13th is still the 12th in Georgetown (UTC-4) — whatever the device's own time zone says.
    const before = process.env['TZ'];
    process.env['TZ'] = 'Asia/Tokyo';
    try {
      expect(licenceLabel('2026-10-13T02:00:00.000Z')).toBe('Licence on file, checked on 12 Oct 2026');
    } finally {
      if (before === undefined) delete process.env['TZ']; else process.env['TZ'] = before;
    }
  });

  it('no date, no label — never a licence or "Certified" badge nobody checked', () => {
    expect(licenceLabel(null)).toBeNull();
    expect(licenceLabel(undefined)).toBeNull();
    expect(licenceLabel('not a date')).toBeNull();
  });

  it('the services browse shows the dated licence label, and no "Certified qualification" badge', () => {
    const screen = strip(src('src/modules/services/screens/ServicesScreen.tsx'));
    expect(screen).toContain('<TonePill label={licenceLabel(p.licenceCheckedOn)!} tone="neutral" />');
    expect(screen).not.toContain('Certified qualification');
  });

  it('[REVIEW-F #2053 S3-1] the partner’s own dashboard shows the same dated licence label, never a "Certified" pill', () => {
    const screen = strip(src('src/modules/services/screens/ServiceProviderScreen.tsx'));
    expect(screen).toContain('<TonePill label={licenceLabel(provider.licenceCheckedOn)!} tone="neutral" />');
    expect(screen).not.toContain('label="Certified"');
  });

  it('the profile counts steps done; it never calls a selfie or a first order "Verified"', () => {
    const profile = strip(src('src/modules/profile/screens/ProfileScreen.tsx'));
    expect(profile).toContain('done — next: ${nextFact.next}');
    expect(profile).toContain("'Account complete'");
    expect(profile).not.toMatch(/`Verified \$\{/);
    expect(profile).not.toContain('Verified — account complete');
  });

  it('no customer or partner screen says "background-checked", "vetted" or "licensed (Certified)"', () => {
    const files = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    })(join(process.cwd(), 'src'));
    const hits = files.filter((f) => /background[- ]check|\bvetted\b|licensed \(Certified\)/i.test(strip(readFileSync(f, 'utf8'))));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
