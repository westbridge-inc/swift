import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { orderStatusLabel, orderSubtitle } from './orderStatus';

// ---------------------------------------------------------------------------
// THE STATUS LINE.
//
// Home's old map had six entries and two defects.
//
// `READY: 'Ready for pickup'` was never a status — the Prisma enum value is
// READY_FOR_PICKUP — so the key could not match and the label was dead the day
// it was typed. Nothing caught it, because a Record<string,string> accepts any
// key and a missing one just falls through to the default.
//
// And the map had no idea what KIND of order it described. A taxi ride is born
// PENDING with no vendor, so a passenger in a moving car was told "Waiting for
// the store".
//
// The first test below reads the enum out of schema.prisma. That is the point:
// a label map typed by hand against an enum that lives somewhere else drifts
// silently, and the only way to notice is to go and look.
// ---------------------------------------------------------------------------

/** The real OrderStatus values, read from the schema rather than retyped. */
function enumValues(name: string): string[] {
  const schema = readFileSync(
    join(process.cwd(), '../../apps/api/prisma/schema.prisma'),
    'utf8',
  );
  const block = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!block) throw new Error(`enum ${name} not found in schema.prisma`);
  return block[1]!
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
}

describe('every order status has words', () => {
  it('no status anywhere in the enum falls through to the fallback', () => {
    const statuses = enumValues('OrderStatus');
    const kinds = enumValues('OrderType');

    expect(statuses.length).toBeGreaterThan(10); // sanity: we really read it

    // A vertical legitimately never reaches some statuses — a taxi has no
    // PREPARING — so only flag a status that NO vertical can describe.
    const unlabelled = statuses.filter((status) =>
      kinds.every((kind) => orderStatusLabel(status, kind) === 'In progress'),
    );

    expect(
      unlabelled,
      'These statuses render as the bare fallback for every order type — the ' +
        'person waiting is told nothing.',
    ).toEqual([]);
  });

  it('the label file knows exactly the verticals the schema has', () => {
    // `OrderKind` is hand-written next to an enum that lives in another package.
    // If a vertical is added there and not here, every one of its orders quietly
    // borrows another vertical's words — which is this file's original bug, one
    // level up. Comparing the two is the only way to notice.
    const declared = readFileSync(join(process.cwd(), 'src/lib/orderStatus.ts'), 'utf8')
      .match(/export type OrderKind =([^;]+);/)?.[1] ?? '';
    const listed = [...declared.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    expect(listed, 'OrderKind has drifted from the OrderType enum').toEqual(enumValues('OrderType').sort());

    // KNOWN GAP, recorded here because it is invisible from the label layer.
    // Services have NO OrderType member: a barbershop appointment is stored as
    // `orderType: 'FOOD_DELIVERY'` with `vendor.vendorType: 'SERVICE'`, so the
    // words "Waiting for the store" are correctly derived from data that is
    // itself wrong. Teaching this file a services vocabulary would paper over
    // that — every other consumer of orderType still reads a haircut as a food
    // delivery. The fix is a schema decision (add the member and backfill, or
    // make vendorType the declared discriminator), so it is pinned, not patched:
    // this fails the day SERVICE is added, which is the day the words are owed.
    expect(listed).not.toContain('SERVICE');
  });

  it('READY_FOR_PICKUP is the real key — READY never was', () => {
    expect(orderStatusLabel('READY_FOR_PICKUP', 'FOOD_DELIVERY')).toBe('Ready for pickup');
    // The old map's key. It must NOT be mapped, or the same typo comes back
    // wearing a test as cover.
    expect(orderStatusLabel('READY', 'FOOD_DELIVERY')).toBe('In progress');
  });
});

describe('a ride is not a delivery', () => {
  it('a taxi is never "waiting for the store" — there is no store', () => {
    expect(orderStatusLabel('PENDING', 'TAXI')).toBe('Finding you a driver');
    expect(orderStatusLabel('PENDING', 'TAXI')).not.toMatch(/store/i);
  });

  it('a parcel is not waiting for a store either', () => {
    expect(orderStatusLabel('PENDING', 'COURIER')).not.toMatch(/store/i);
  });

  it('food still is, because for food it is true', () => {
    expect(orderStatusLabel('PENDING', 'FOOD_DELIVERY')).toBe('Waiting for the store');
    expect(orderStatusLabel('PENDING', 'GROCERY_DELIVERY')).toBe('Waiting for the store');
  });

  it('an unknown status admits it rather than guessing', () => {
    expect(orderStatusLabel('SOMETHING_NEW', 'TAXI')).toBe('In progress');
    expect(orderStatusLabel(null)).toBe('In progress');
    expect(orderStatusLabel(undefined)).toBe('In progress');
  });
});

// ---------------------------------------------------------------------------
// ONE VOCABULARY.
//
// Everything above proves the AUTHORITY is complete. None of it could catch a
// SECOND copy — and there was one. `OrdersHistoryScreen` kept its own
// status→label map carrying the identical `READY` typo this file was written to
// kill, plus a fallback that printed the status back at the customer. The
// activity list showed a live order as literally "READY_FOR_PICKUP", in a pill,
// while Home two taps away said "Ready for pickup". Found by opening the app.
//
// A fix that lands on the authority never reaches a fork. So the fork is what
// these test.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const AUTHORITY = 'lib/orderStatus.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — the standing hazard-matching rule. The
 *  comments in these files necessarily quote the patterns being banned. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const files = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);

describe('there is one status vocabulary', () => {
  const statuses = new Set(enumValues('OrderStatus'));

  /** A status key mapped to PROSE. Tone tokens ('warning', 'info') are a
   *  legitimate second map — those are this-screen concerns, not words. Prose
   *  is a label, and labels have exactly one owner. */
  function proseMappings(text: string): string[] {
    const hits: string[] = [];
    for (const m of text.matchAll(/\b([A-Z][A-Z_]{3,})\s*:\s*'([^']+)'/g)) {
      const [, key, value] = m;
      if (!statuses.has(key!)) continue;
      const isProse = /\s/.test(value!) || /^[A-Z][a-z]/.test(value!);
      if (isProse) hits.push(`${key}: '${value}'`);
    }
    return hits;
  }

  it('no screen keeps its own status→words map', () => {
    const forks = files
      .filter((f) => rel(f) !== AUTHORITY)
      .map((f) => ({ file: rel(f), hits: proseMappings(code(f)) }))
      .filter((r) => r.hits.length >= 3);

    expect(
      forks.map((r) => `${r.file} → ${r.hits.join(', ')}`),
      'A second status vocabulary drifts from the first the day either is edited, ' +
        'and the customer sees two different words for one order. Take the words ' +
        `from ${AUTHORITY}; keep only what is genuinely this screen's own (tone, icon).`,
    ).toEqual([]);
  });

  it('the scan can actually see a fork (guards the guard)', () => {
    // If the detector could not recognise the map that was really there, the
    // assertion above would be decoration. This is the deleted map, verbatim.
    const removed = `
      PENDING: 'Pending',
      ACCEPTED: 'Accepted',
      READY: 'Ready',
    `;
    expect(proseMappings(removed).length).toBeGreaterThanOrEqual(2);
    // ...and it must not fire on the tone map that legitimately replaced it.
    expect(proseMappings(`PENDING: 'warning', ACCEPTED: 'warning', PICKED_UP: 'info',`)).toEqual([]);
  });

  /**
   * Screens that render a raw `.status` as a label, for a vocabulary this file
   * does NOT own. Each is the same defect — an internal enum shown to a person —
   * but the fix needs that vocabulary's own authority, and none exists yet.
   * Recorded rather than silently relabelled with order words, which would be
   * wrong words confidently applied. Audited from both sides below, so an entry
   * cannot outlive the leak that justified it.
   */
  const OTHER_VOCABULARIES: Array<{ file: string; reason: string }> = [
    {
      file: 'modules/advertiser/screens/AdvertiserHomeScreen.tsx',
      reason: 'CAMPAIGN_STATUS — campaign lifecycle, not OrderStatus; needs its own label authority',
    },
    {
      file: 'modules/advertiser/screens/CampaignDetailScreen.tsx',
      reason: 'CAMPAIGN_STATUS — same vocabulary as the advertiser home screen above',
    },
    {
      file: 'modules/services/screens/ServiceJobsScreen.tsx',
      reason: 'service JOB status — a booking lifecycle, distinct from an order lifecycle',
    },
  ];

  it('no screen renders the raw ORDER enum when it has no label for a status', () => {
    // `?? { label: o.status }` is how the enum reached the pill. A status is an
    // internal identifier; showing it is the UI admitting it has no words while
    // presenting them as words.
    const exempt = new Set(OTHER_VOCABULARIES.map((o) => o.file));
    const leaks = files
      .filter((f) => /label:\s*\w+\.status\b/.test(code(f)))
      .map(rel)
      .filter((f) => !exempt.has(f));
    expect(
      leaks,
      'An unknown status must fall back to honest wording from the authority, ' +
        'never to its own enum name.',
    ).toEqual([]);
  });

  it('every recorded leak is still a leak', () => {
    // The exemptions are a debt register, not a mute button: when one of these
    // gains a real label authority its entry must go, and this fails until it
    // does.
    for (const { file } of OTHER_VOCABULARIES) {
      const full = join(SRC, file);
      expect(files.includes(full), `${file} is recorded but no longer exists`).toBe(true);
      expect(
        /label:\s*\w+\.status\b/.test(code(full)),
        `${file} no longer renders a raw status — remove it from OTHER_VOCABULARIES`,
      ).toBe(true);
    }
  });

  it('the activity list takes its words from the authority', () => {
    // The concrete screen this was found on, named so the fix cannot be quietly
    // reverted into a local map again.
    const history = code(join(SRC, 'modules/orders/screens/OrdersHistoryScreen.tsx'));
    expect(history).toMatch(/from\s+'[^']*lib\/orderStatus'/);
    expect(history).toMatch(/orderStatusLabel\(/);
  });
});

describe('the subtitle never leads with a separator', () => {
  it('an order with no vendor shows just its number', () => {
    // A taxi and a parcel have no vendor. This used to render " · #ORD-0042".
    expect(orderSubtitle(null, 'ORD-0042')).toBe('#ORD-0042');
    expect(orderSubtitle(undefined, 'ORD-0042')).toBe('#ORD-0042');
  });

  it('joins the two when both are there', () => {
    expect(orderSubtitle("Mauby's Snackette", 'ORD-0042')).toBe("Mauby's Snackette · #ORD-0042");
  });

  it('is empty rather than a lone dot when it knows nothing', () => {
    expect(orderSubtitle(null, null)).toBe('');
  });
});
