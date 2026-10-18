/**
 * [COORD 18 Oct, option S] Every place a PERSON's own rating figure is shown (to them, or their star to others)
 * reads the one partition, whole groups of 5 (rating-groups.ts), never the live stat row or the legacy mean,
 * which move with each single rating. Ranking and dispatch keep their own math (not display).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODULES = join(__dirname, '..', 'modules');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== '__tests__') walk(full, out); } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};
const sources = walk(MODULES).map((file) => ({ file: file.slice(MODULES.length + 1), text: readFileSync(file, 'utf8') }));
const read = (file: string) => sources.find((s) => s.file === file)!.text;

/** Routes that show a person's own figure, or a mover's/provider's star to a customer. */
const DISPLAY_ROUTES = ['rider/rider.routes.ts', 'driver/driver.routes.ts', 'rides/rides.routes.ts', 'services/services.routes.ts', 'user/customer.routes.ts'];

describe('[option S] no person rating is displayed from a live figure', () => {
  it('the display routes never return a legacy live mean or count of a rider, driver or provider', () => {
    const live = /\b(rider|driver|provider|ride\.driver)\.(averageRating|totalRatings)\b/;
    for (const file of DISPLAY_ROUTES) {
      expect(read(file).split('\n').filter((l) => live.test(l)), file).toEqual([]);
      expect(read(file), file).toMatch(/shownRating(For|sFor|Totals)\(/);
    }
  });

  it('the live star mapper is used for stores only, plus the passenger star a DRIVER sees (not the rated person viewing it)', () => {
    const uses = sources.flatMap(({ file, text }) => [...text.matchAll(/ratingSurfaces\([^,]+,\s*'([A-Z_]+)'/g)].map((m) => `${file}:${m[1]}`));
    const people = uses.filter((u) => !u.endsWith(':VENDOR'));
    expect(people.sort()).toEqual(['driver/driver.routes.ts:CUSTOMER', 'driver/driver.routes.ts:CUSTOMER']);
    expect(uses.length).toBeGreaterThan(3); // the scan is not blind
  });

  it("a person's own row never goes back whole: every spread or return of it carries the whole-groups totals", () => {
    const own: Array<[string, string]> = [['rider/rider.routes.ts', 'rider'], ['driver/driver.routes.ts', 'driver'], ['services/services.routes.ts', 'provider']];
    let seen = 0;
    for (const [file, name] of own) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        // An internal call that never reaches the person (the vehicle re-review reads the row's vehicle fields).
        if (/requireFreshVehicleReview\(/.test(line)) return;
        if (new RegExp(`\\.\\.\\.${name}\\b`).test(line) || /data: updated\b/.test(line)) {
          seen += 1;
          expect(/shownRatingTotals\(|withShownTotals\(/.test(lines.slice(i, i + 3).join('\n')), `${file}:${i + 1}`).toBe(true);
        }
      });
    }
    expect(seen).toBeGreaterThanOrEqual(5); // the scan is not blind (profile reads and the provider upsert)
    // The rows a mover gets back from an update (profile, vehicle photo, go online/offline) are wrapped.
    expect([...read('rider/rider.routes.ts').matchAll(/data: await withShownTotals\(app\.prisma, updated, 'RIDER'/g)]).toHaveLength(2);
    expect([...read('driver/driver.routes.ts').matchAll(/data: await withShownTotals\(app\.prisma, updated, 'DRIVER'/g)]).toHaveLength(3);
    const auth = read('auth/auth.service.ts');
    expect(auth).toContain("if (user.rider) Object.assign(user.rider, await shownRatingTotals(this.app.prisma, 'RIDER', user.id));");
    expect(auth).toContain("if (user.driver) Object.assign(user.driver, await shownRatingTotals(this.app.prisma, 'DRIVER', user.id));");
  });

  it('no whole rider/driver/provider row is pulled in by a relation outside staff views, unless its live totals are omitted or replaced', () => {
    const whole = /\b(driver|rider|serviceProvider)\s*:\s*(\{\s*(include|omit)\b|true\b)/g;
    const found = sources.filter(({ file }) => !file.startsWith('admin/')).flatMap(({ file, text }) => [...text.matchAll(whole)].map((m) => {
      const at = text.slice(m.index, m.index + 160);
      return { file, ok: /omit: \{ averageRating: true, totalRatings: true \}/.test(at) || file === 'auth/auth.service.ts' };
    }));
    expect(found.length).toBeGreaterThanOrEqual(3); // the scan is not blind (sign-in rider + driver, the accept reply)
    expect(found.filter((f) => !f.ok)).toEqual([]);
  });

  it('the driver row an accepting driver is answered with (claim and re-ask) omits the live totals', () => {
    expect(read('dispatch/dispatch.service.ts')).toContain("driver: { omit: { averageRating: true, totalRatings: true }, include: { user: { select: { firstName: true } } } },");
  });

  it('ranking still reads the true mean: only the DISPLAY of a provider star comes from the groups', () => {
    expect(read('services/services.routes.ts')).toContain('|| rankMean.get(b.id)! - rankMean.get(a.id)!');
  });

  it('a person standing view is built from the groups', () => {
    const standing = read('rating/rating-standing.ts');
    expect(standing).toContain("if (role !== 'VENDOR') return personStandingView(prisma, role, subjectId);");
    expect(standing).toMatch(/groupRatings\(rows\)/);
  });
});
