import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENUM_LABELS, label, statusTone, ratingText, type EnumName } from '@/lib/labels';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] STATUSES IN PLAIN WORDS — FOR EVERY VALUE.
//
// The console printed enums as-is (PENDING_APPROVAL, MOBILE_MONEY, …). One map
// now holds the words. A new value added to one of these Prisma enums would
// fall through to a generic rendering, so this file reads the enums from
// apps/api/prisma/schema.prisma and fails until the new value has words.
// ---------------------------------------------------------------------------

/** Every Prisma enum the console shows, and where it shows it. */
const SHOWN: Record<EnumName, string> = {
  UserRole: 'users list (role), user detail (roles), ⌘K search',
  UserStatus: 'users list and detail, store owner card, mover detail',
  VendorStatus: 'vendors list and detail, sibling stores, user detail',
  VendorType: 'vendors list and detail',
  VendorTier: 'vendor detail (registration)',
  OrderStatus: 'orders list and detail, recent orders, live feed, live map',
  OrderType: 'orders list and detail, user detail, ⌘K search',
  RideClass: 'order detail, drivers list, mover detail, live map',
  FulfillmentType: 'orders list and detail',
  PaymentMethod: 'recent orders, custody, finance payment mix',
  PaymentStatus: 'orders list and detail',
  RiderType: 'riders list, mover detail',
  VehicleType: 'mover detail',
  SubscriptionStatus: 'subscriptions, vendor and mover detail',
  SubscriptionType: 'subscriptions, dashboard revenue breakdown',
  BillingEventType: 'subscription billing trail',
  EarningType: 'mover detail earnings',
  ClaimStatus: 'claims',
  ReturnStatus: 'returns',
  CustodyRecoveryState: 'custody recovery',
  ReportReason: 'moderation',
  ReportTargetType: 'moderation',
  ReportStatus: 'moderation',
  DiscountType: 'promos',
  DiscoveryCategoryKind: 'discovery',
  DiscoveryCategoryVertical: 'discovery',
  DiscoveryCategoryStatus: 'discovery',
  VerificationDocumentStatus: 'Review Center',
  CoverageClass: 'Review Center insurance check',
  SupportCategory: 'support',
  SupportStatus: 'support',
  SupportResolution: 'support',
  CashSettlementStatus: 'finance cash ledger',
  AdvertiserStatus: 'ads review',
  AdCreativeStatus: 'ads review',
};

function prismaEnums(): Map<string, string[]> {
  const schema = readFileSync(join(process.cwd(), '..', 'api', 'prisma', 'schema.prisma'), 'utf8');
  const enums = new Map<string, string[]>();
  for (const m of schema.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    const values = m[2]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line && !line.startsWith('@@'))
      .map((line) => line.split(/\s+/)[0]!);
    enums.set(m[1]!, values);
  }
  return enums;
}

describe('[MC-PR1] labels cover every value of every Prisma enum the console shows', () => {
  const enums = prismaEnums();

  it('reads the schema (a parse that finds nothing is not a pass)', () => {
    expect(enums.size).toBeGreaterThan(100);
    expect(enums.get('VendorStatus')).toEqual(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'CLOSED']);
  });

  it('the label map and the list of shown enums are the same set', () => {
    expect(Object.keys(ENUM_LABELS).sort()).toEqual(Object.keys(SHOWN).sort());
  });

  for (const name of Object.keys(SHOWN) as EnumName[]) {
    it(`${name}: every schema value has words, and no label names a value the schema lacks`, () => {
      const values = enums.get(name);
      expect(values, `${name} is not an enum in schema.prisma`).toBeTruthy();
      const words = ENUM_LABELS[name] as Record<string, string>;
      const missing = values!.filter((v) => !words[v]);
      expect(missing, `${name} values with no plain-words label`).toEqual([]);
      const extra = Object.keys(words).filter((k) => !values!.includes(k));
      expect(extra, `${name} labels for values the schema does not have`).toEqual([]);
      for (const v of values!) {
        expect(words[v], `${name}.${v}`).not.toMatch(/_/);
        expect(words[v], `${name}.${v}`).not.toBe(v);
      }
    });
  }
});

describe('[MC-PR1] label()', () => {
  it('gives the plain words', () => {
    expect(label('VendorStatus', 'PENDING_APPROVAL')).toBe('Waiting for approval');
    expect(label('PaymentMethod', 'MOBILE_MONEY')).toBe('MMG');
  });

  it('never prints a raw enum, even for a value it does not know yet', () => {
    expect(label('VendorStatus', 'SOMETHING_NEW')).toBe('Something new');
    expect(label('VendorStatus', null)).toBe('—');
    expect(label('VendorStatus', undefined)).toBe('—');
  });

  it('gives a tone for a status, neutral when unknown', () => {
    expect(statusTone('VendorStatus', 'ACTIVE')).toBe('good');
    expect(statusTone('VendorStatus', 'PENDING_APPROVAL')).toBe('warn');
    expect(statusTone('VendorStatus', 'SUSPENDED')).toBe('bad');
    expect(statusTone('VendorStatus', 'SOMETHING_NEW')).toBe('neutral');
  });
});

describe('[MC-PR1] a store with no ratings is "New", never 5.0', () => {
  it('the schema default (5.0 with zero ratings) reads New', () => {
    expect(ratingText(5, 0)).toBe('New');
    expect(ratingText(null, 0)).toBe('New');
    expect(ratingText(5, undefined)).toBe('New');
    expect(ratingText(5, null)).toBe('New');
  });

  it('a rated store shows its average and how many ratings', () => {
    expect(ratingText(4.56, 12)).toBe('4.6 · 12 ratings');
    expect(ratingText(5, 1)).toBe('5.0 · 1 rating');
  });
});
