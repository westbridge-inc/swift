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

  it('ranking still reads the true mean: only the DISPLAY of a provider star comes from the groups', () => {
    expect(read('services/services.routes.ts')).toContain('|| rankMean.get(b.id)! - rankMean.get(a.id)!');
  });

  it('a person standing view is built from the groups', () => {
    const standing = read('rating/rating-standing.ts');
    expect(standing).toContain("if (role !== 'VENDOR') return personStandingView(prisma, role, subjectId);");
    expect(standing).toMatch(/groupRatings\(rows\)/);
  });
});
