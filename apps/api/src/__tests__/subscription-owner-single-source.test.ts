import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// [BILL-PRO PR0] "Who pays this subscription" is answered in ONE module,
// modules/subscription/subscription-owner.ts. A new kind of owner is then added
// in one place, and no billing, notice, checkout, erasure or tenant path can be
// left with an old three-owner copy that drops the new owner's money.
// This source scan is the CI gate (the operate-gate-unification pattern): an
// inline copy of the rule anywhere else in the API source fails the build.

const API = join(__dirname, '..', '..');
const ROOTS = [join(API, 'src'), join(API, 'scripts'), join(API, 'prisma')];
const MODULE = join('src', 'modules', 'subscription', 'subscription-owner.ts');

const COPIES: Array<{ name: string; pattern: RegExp }> = [
  // TypeScript: the payer chain, as `rider?.userId ?? driver?.userId ...`
  // (with or without a receiver, optional chaining or a vendor tail).
  { name: 'payer chain (rider ?? driver)', pattern: /rider\??\.userId\s*\?\?\s*[\w?.]*?driver\??\.userId/ },
  // TypeScript: the same chain over the loaded owner user records.
  { name: 'owner user chain', pattern: /rider\??\.user\s*\?\?\s*[\w?.]*?driver\??\.user\b/ },
  // TypeScript: the owner-tenant chain over the loaded owner users.
  { name: 'owner tenant chain', pattern: /rider\??\.user\??\.tenantId\s*\?\?\s*[\w?.]*?driver\??\.user\??\.tenantId/ },
  // SQL: the three owner tables joined onto a subscription.
  { name: 'SQL 3-way owner join', pattern: /LEFT\s+JOIN\s+"?riders"?[\s\S]{0,300}?LEFT\s+JOIN\s+"?drivers"?[\s\S]{0,300}?LEFT\s+JOIN\s+"?vendors"?/i },
  // SQL: the payer column picked from the joined owners.
  { name: 'SQL payer COALESCE', pattern: /COALESCE\(\s*r\."userId"\s*,\s*d\."userId"/ },
  // Prisma: "every subscription this person pays" (rider, driver, store owner). [REVIEW-X #2191 S3-1]
  // An order's participant filter starts with the customer and is not this rule.
  { name: 'Prisma paid-by filter', pattern: /OR:\s*\[\s*\{\s*rider:\s*\{\s*userId\b[\s\S]{0,120}?\{\s*driver:\s*\{\s*userId\b[\s\S]{0,120}?\{\s*vendor:\s*\{\s*owner:\s*\{\s*userId/ },
  // Prisma: the one-owner tenant scope.
  { name: 'Prisma one-owner tenant scope', pattern: /vendor:\s*\{\s*tenantId\s*\},\s*riderId:\s*null,\s*driverId:\s*null/ },
  // Prisma: the owner relations a payer read loads, written out instead of PAYER_INCLUDE. [BILL-PRO PR2]
  // A hand-written copy is how a read silently forgets the pro.
  { name: 'Prisma owner include', pattern: /rider:\s*\{\s*select:\s*\{\s*userId:\s*true\s*\}\s*\},\s*driver:\s*\{\s*select:\s*\{\s*userId:\s*true\s*\}\s*\},\s*vendor:\s*\{\s*select:\s*\{\s*(?:id:\s*true,\s*)?owner:/ },
];

/** Shapes that look like the rule but are not a subscription's owner. Each must still match (no stale entry). */
const NOT_A_SUBSCRIPTION: Array<{ file: string; name: string; why: string }> = [
  { file: join('src', 'modules', 'rating', 'rating.service.ts'), name: 'Prisma owner include', why: "an order's participants (who may rate it)" },
];

function sources(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['__tests__', 'node_modules', 'migrations'].includes(name) ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

describe('one subscription payer resolver (source-scan gate)', () => {
  const files = ROOTS.flatMap(sources);

  it('scans the API source tree', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.map((f) => relative(API, f))).toContain(MODULE);
  });

  it('no inline copy of the subscription-owner rule exists outside subscription-owner.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(API, file);
      if (rel === MODULE) continue;
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of COPIES) {
        if (!pattern.test(text)) continue;
        if (NOT_A_SUBSCRIPTION.some((x) => x.file === rel && x.name === name)) continue;
        offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every listed look-alike still has the shape it is listed for', () => {
    for (const { file, name } of NOT_A_SUBSCRIPTION) {
      const pattern = COPIES.find((c) => c.name === name)!.pattern;
      expect(pattern.test(readFileSync(join(API, file), 'utf8')), `${file}: ${name}`).toBe(true);
    }
  });

  it('the module itself still holds every rule (the gate is not scanning nothing)', () => {
    const text = readFileSync(join(API, MODULE), 'utf8');
    for (const { name, pattern } of COPIES) expect(pattern.test(text), name).toBe(true);
  });

  it('the gate patterns recognise the shapes they exist to stop', () => {
    const hit = (src: string) => COPIES.filter(({ pattern }) => pattern.test(src)).map(({ name }) => name);
    expect(hit('const id = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;')).toEqual(['payer chain (rider ?? driver)']);
    expect(hit('const mover = sub.rider?.userId ?? sub.driver?.userId;')).toEqual(['payer chain (rider ?? driver)']);
    expect(hit('const person = sub?.rider?.user ?? sub?.driver?.user;')).toEqual(['owner user chain']);
    expect(hit('return sub.vendor?.tenantId ?? sub.rider?.user.tenantId ?? sub.driver?.user.tenantId;')).toEqual(['owner tenant chain']);
    expect(hit('FROM subscriptions s LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"\n LEFT JOIN vendors v ON v.id=s."vendorId"'))
      .toEqual(['SQL 3-way owner join']);
    expect(hit('JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId")')).toEqual(['SQL payer COALESCE']);
    expect(hit("{ vendor: { tenantId }, riderId: null, driverId: null },")).toEqual(['Prisma one-owner tenant scope']);
    expect(hit('include: {\n  rider: { select: { userId: true } },\n  driver: { select: { userId: true } },\n  vendor: { select: { id: true, owner: { select: { userId: true } } } },\n}')).toEqual(['Prisma owner include']);
    expect(hit('select: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { owner: { select: { userId: true } } } } }')).toEqual(['Prisma owner include']);
    // A mover-only include is not the payer read.
    expect(hit('include: { rider: { select: { userId: true } }, driver: { select: { userId: true } } }')).toEqual([]);
    expect(hit('where: { OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }] },')).toEqual(['Prisma paid-by filter']);
    expect(hit('OR: [\n  { rider: { userId: { in: memberIds } } },\n  { driver: { userId: { in: memberIds } } },\n  { vendor: { owner: { userId: { in: memberIds } } } },\n]')).toEqual(['Prisma paid-by filter']);
    // An order's participants (customer first) and a mover-only filter are not the payer rule.
    expect(hit('OR: [{ customerId: userId }, { rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }]')).toEqual([]);
    expect(hit('where: { OR: [{ rider: { userId: payer.userId } }, { driver: { userId: payer.userId } }] }')).toEqual([]);
    // A mover-only lookup (riders + drivers, no store) is not the three-owner rule.
    expect(hit('LEFT JOIN "riders" r ON r."id" = s."riderId"\n LEFT JOIN "drivers" d ON d."id" = s."driverId"\n WHERE r."userId" = $1')).toEqual([]);
    // An order's counterparty is not a subscription payer.
    expect(hit("const counterpartyUserId = raisedBy === 'passenger' ? ride.driver?.userId ?? null : ride.customerId;")).toEqual([]);
  });
});
