import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U73] A rider's or driver's screens never show the server's code.
// The active job header read "rider en route pickup" / "ride in progress";
// the job history pill, the weekly-fee pill, the claims list and the earnings
// list turned any value they had not been taught into the code with spaces;
// the expiring-document banner said "Your drivers license expires ..."; the
// handover door said "Payment not confirmed (mobile money pending)".
// Every value of each server enum is read from the API's schema. The job
// status words live in lib/orderStatus, the phone's one status vocabulary.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ View: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, font: token, fontSize: token, radius: token, space: token, withAlpha: () => '', elevation: token };
});
vi.mock('../../kit', () => ({ T: () => null, TonePill: (props: unknown) => props }));

import { moverStatusLabel } from '../../lib/orderStatus';
import { JobStatusPill } from './shared';
import { claimStatus, evidenceLine, reasonLabel } from './claims-view';
import { earningLabel } from './earner-data';
import { doorGuidanceFor } from '../../lib/handoverAuthority';

const schema = readFileSync(join(__dirname, '../../../../api/prisma/schema.prisma'), 'utf8');
function enumValues(name: string): string[] {
  const body = schema.match(new RegExp(`\\benum ${name} \\{([\\s\\S]*?)\\}`))?.[1];
  expect(body, `enum ${name} in the API schema`).toBeTruthy();
  return body!.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);
}
// Words: never the code, never an underscore, never the code with spaces.
const words = (out: string, code: string) => {
  expect(out, code).not.toBe(code);
  expect(out, code).not.toContain('_');
  if (code.includes('_')) expect(out.toLowerCase(), `${code} is not the code with spaces`).not.toBe(code.toLowerCase().replace(/_/g, ' '));
  expect(out.trim(), code).not.toBe('');
};

describe('[UI-SWEEP U73] job statuses read in words for riders and drivers', () => {
  it('every order status the server can send has a word', () => {
    const statuses = enumValues('OrderStatus');
    expect(statuses.length).toBeGreaterThan(15);
    for (const s of statuses) {
      const out = moverStatusLabel(s);
      expect(out, s).not.toBe('In progress');
      expect(out, s).not.toContain('_');
      expect(out, s).not.toBe(s);
    }
    expect(moverStatusLabel('RIDER_EN_ROUTE_PICKUP')).toBe('On the way to the pickup');
    expect(moverStatusLabel('RIDE_IN_PROGRESS')).toBe('Trip in progress');
  });

  it('a status the phone has not been taught reads "In progress"', () => {
    expect(moverStatusLabel('SOMETHING_NEW')).toBe('In progress');
    expect(moverStatusLabel(null)).toBe('In progress');
  });

  it('the job history pill uses those words, never the code with spaces', () => {
    for (const s of enumValues('OrderStatus')) {
      expect(String((JobStatusPill({ status: s }) as any).props.label), s).toBe(moverStatusLabel(s));
    }
    expect((JobStatusPill({ status: 'RIDER_ARRIVED_PICKUP' }) as any).props.label).toBe('At the pickup');
    expect((JobStatusPill({ status: 'SOMETHING_NEW' }) as any).props.label).toBe('In progress');
  });
});

describe('[UI-SWEEP U73] claims, earnings and the handover door in words', () => {
  it('every claim status has words; an unknown one is neutral', () => {
    for (const s of enumValues('ClaimStatus')) words(claimStatus(s).label, s);
    expect(claimStatus('SOMETHING_NEW').label).toBe('Being processed');
  });

  it('an unknown evidence item or reason is named neutrally, never by its code', () => {
    expect(evidenceLine({ key: 'new_proof_kind', present: true, required: false }).label).toBe('Other evidence');
    expect(reasonLabel('new_reason_kind')).toBe('Other reason');
    expect(reasonLabel('no_show')).toBe('Customer did not show');
  });

  it('an unknown kind of earning is "Other earning"', () => {
    expect(earningLabel('SOME_NEW_KIND')).toBe('Other earning');
    expect(earningLabel('RESCUE_INCENTIVE')).toBe('Rescue bonus from Swift');
  });

  it('the payment-not-confirmed door carries no code', () => {
    const g = doorGuidanceFor('MOBILE_MONEY_PENDING');
    expect(g.headline).not.toMatch(/mobile money pending|\(/i);
    expect(g.headline).toContain('Ask the store to confirm the payment');
  });
});

describe('[UI-SWEEP U73] the screens use the words', () => {
  const src = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  it('the active job header names the status in words', () => {
    const active = src('screens/ActiveJobScreen.tsx');
    expect(active).toMatch(/\{moverStatusLabel\(job\.status\)\}/);
    expect(active).not.toMatch(/String\(job\.status[^)]*\)\.replace\(/);
  });

  it('the weekly-fee pill falls back to the Billing words', () => {
    expect(src('screens/EarningsScreen.tsx')).toMatch(/label: subscriptionWords\(status\)/);
  });

  it('the expiring-document banner names the document', () => {
    const home = src('screens/MoverHomeScreen.tsx');
    expect(home).toMatch(/Your \{docLabel\(expiringDoc\.docType\)\} expires/);
  });

  it('no rider or driver screen turns a code into text by swapping underscores', () => {
    for (const p of ['screens/ActiveJobScreen.tsx', 'screens/EarningsScreen.tsx', 'screens/MoverHomeScreen.tsx', 'shared.tsx', 'claims-view.ts', 'earner-data.ts', '../../lib/handoverAuthority.ts']) {
      expect(src(p), p).not.toMatch(/\.replace\(\/_\/g, ' '\)/);
    }
  });
});
