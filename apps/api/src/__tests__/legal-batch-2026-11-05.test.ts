// [2026-11-05 legal wording batch · DRAFT until a Guyana attorney reads it] What the served words must say, and what
// they must never say. Numbers in the words are read from the code that applies them, so the two cannot drift.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHILD_SAFETY, DRIVER_AGREEMENT, LEGAL_VERSION, MARKETING_CONSENT, PRIVACY, TERMS, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus } from '../modules/legal/reaccept';
import { LIVE_RETENTION_DAYS } from '../modules/algo/decisions';
import { TRACE_TTL_S } from '../modules/dispatch/gps-plausibility';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { ORDER_HOLD_DEFAULT_MIN } from '../modules/order/hold-minutes';
import { FREE_CANCEL_WINDOW_MIN } from '../modules/order/cancel-policy';
import { RETENTION_DEFAULTS } from '../modules/compliance/retention.service';
import type { UserRole } from '@prisma/client';

const ROOT = resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');
const DOCS: Array<[string, string]> = [
  ['Terms', TERMS], ['Privacy', PRIVACY], ['Mover Agreement', DRIVER_AGREEMENT], ['Business Agreement', VENDOR_AGREEMENT],
  ['Child Safety', CHILD_SAFETY], ['Marketing', MARKETING_CONSENT],
];
const section = (doc: string, heading: RegExp) => {
  const start = doc.search(heading);
  expect(start, String(heading)).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('<h2>', start + 4);
  return doc.slice(start, next === -1 ? undefined : next);
};
const HELP = () => section(DRIVER_AGREEMENT, /<h2>7\. If a customer does not pay at the door<\/h2>/);
/** The location bullet of Privacy section 1. */
const LOCATION = () => /<li><b>Location:<\/b>[\s\S]*?<\/li>/.exec(PRIVACY)?.[0] ?? '';

describe('[owner 5 Nov] words the legal texts never use', () => {
  it.each(DOCS)('%s: no theft, damages, our riders or own network', (_name, doc) => {
    expect(doc).not.toMatch(/\b(theft|thief|stolen|stole|damages|our riders|our drivers|own network)\b/i);
  });
  it.each(DOCS)('%s: a guarantee is only ever the customer\'s statutory one', (_name, doc) => {
    expect(doc.replace(/your statutory guarantees/g, '')).not.toMatch(/guarantee/i);
  });
  it('insurance appears only as the partner\'s own duty; the one sentence about Swift denies it', () => {
    const allowed = [
      /are responsible for their goods, services, vehicles, licences, insurance and tax affairs/,
      /for movers, licence, insurance and related documents/,
      /your own national insurance, tax and statutory obligations/,
      /vehicle registration, and insurance appropriate to carrying passengers where you drive passengers/,
      /a roadworthy vehicle of the class you registered, insured where the law requires it/,
      /Insurance and liability/,
      /You are responsible for insuring yourself, your vehicle and your carriage of passengers or goods as the law and your insurer require/,
      /it does not insure your work/,
      /Taxi drivers must hold insurance covering passengers carried for hire/,
      /Anyone delivering by motor vehicle must hold insurance that permits use for hire or reward/,
    ];
    const sentences = DOCS.flatMap(([, doc]) => doc.split(/(?<=[.;:])\s+|<\/?(?:p|li|h2)>/)).filter((s) => /insur/i.test(s));
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.filter((s) => !allowed.some((a) => a.test(s)))).toEqual([]);
  });
});

describe('[COORD 5 Nov 15:18Z] Mover Agreement: help when a customer does not pay at the door', () => {
  it('sits straight after section 6, and the sections after it run on', () => {
    expect(DRIVER_AGREEMENT.match(/<h2>\d+\.[^<]*<\/h2>/g)).toEqual([
      '<h2>1. You are an independent operator</h2>', '<h2>2. What you pay Swift — and what you keep</h2>', '<h2>3. Verification and documents</h2>',
      '<h2>4. Your vehicle and your conduct</h2>', '<h2>5. Jobs, cancellations and the strike system</h2>', '<h2>6. Cash, PINs and handovers</h2>',
      '<h2>7. If a customer does not pay at the door</h2>', '<h2>8. Safety</h2>', '<h2>9. Insurance and liability</h2>', '<h2>10. Ending this Agreement</h2>', '<h2>11. General</h2>',
    ]);
  });
  it('is the approved wording, word for word', () => {
    expect(HELP()).toContain("<p>What a customer owes for an order or a fare is the customer's debt, not Swift's. If you lose money this way, record it in the app. A person at Swift will look at what happened. Swift may choose to help, from its own money, one order at a time, and it decides each case for itself. You do not have a right to this help and Swift does not promise it. It is not part of what your weekly fee pays for. Help on one order does not mean help on another. Swift charges nothing for it. Swift may suspend this help for you after a review, and you can ask for that decision to be reviewed.</p>");
  });
  it('names no amount, no right, no fund, and nothing about police or payment deadlines', () => {
    const words = HELP().replace(/<[^>]+>/g, ' ');
    expect(words).not.toMatch(/\b(GY\$|GYD|\d{2,}|up to|maximum|limit)\b/i);
    expect(words).not.toMatch(/\b(insur\w*|cover\w*|claims?|polic(y|ies)|premiums?|protect\w*|funds?|reserve|guarantee\w*|entitled|will pay|police|report|authorities|within \d)\b/i);
  });
  it('the Terms still say Swift never holds, collects or transmits Order money', () => {
    expect(TERMS).toContain('Swift never holds, collects or transmits Order money');
  });
});

describe('[row 658] the weekly fee is payable in the app or on swiftgy.com', () => {
  it.each([['Mover', DRIVER_AGREEMENT], ['Business', VENDOR_AGREEMENT]])('%s section 2', (_name, doc) => {
    const fee = /<p>You pay Swift a flat weekly subscription[\s\S]*?<\/p>/.exec(doc)?.[0];
    expect(fee).toContain("payable in the Swift app or on swiftgy.com through MMG's checkout, by card where the app offers it, or directly to Westbridge Inc., in person by cash or cheque, or by bank transfer. A cheque counts only once it has cleared. A payment counts once Swift records it. You get a receipt for every payment. Never pay the weekly fee through an agent or anyone else.");
    expect(fee).toContain('If you pay twice or pay too much through MMG, Swift may return');
    expect(fee).toContain('within 14 days, to the account you paid from or, if you paid in person, by a way you and Swift agree, records the refund');
    // [REVIEW-G18 S3-2 + S4-3] the rise and the cut are told apart where the change is first named; a cut never reaches a week paid or charged.
    expect(fee).toContain('Swift may change the weekly fee. If it goes up, we will tell you in the app at least 14 days before the change, and the new fee applies from your first weekly fee due after that date.');
    expect(fee).toContain('If it goes down, the lower fee applies from your next weekly fee not yet paid or charged, with a notice in the app.');
    expect(fee).not.toMatch(/We will tell you in the app at least 14 days before the change\./);
  });
});

describe('Terms section 4: a taxi fare by MMG at drop-off', () => {
  it('says the driver may take it directly', () => {
    expect(section(TERMS, /<h2>4\. /)).toContain("You pay a taxi fare to the driver at drop-off, in cash or, where the driver offers it, directly into the driver's own MMG account under MMG's terms.");
  });
});

describe('Business Agreement', () => {
  it('section 3 names the own-name declaration beside the business registration', () => {
    expect(section(VENDOR_AGREEMENT, /<h2>3\. /)).toContain("business registration (or, if your store's name is your own name, the short declaration you sign in the app)");
  });
  it('section 6 no longer rests on a process that is not written down', () => {
    expect(section(VENDOR_AGREEMENT, /<h2>6\. /)).toContain("where a customer cancels lawfully after paying your MMG, or Swift's review of a dispute decides for the customer, you refund the customer directly and promptly.");
  });
});

describe('Privacy: MMG references', () => {
  it('section 2 says what an order keeps, and every field it names exists', () => {
    const s2 = section(PRIVACY, /<h2>2\. /);
    expect(s2).not.toMatch(/we only record/i);
    expect(s2).toContain("If you pay a business through MMG, that payment happens in MMG's own flow under MMG's terms. Your order keeps the record of it: what you tell us about the payment, including any MMG reference you enter; the reference and amount the business records when it confirms your payment, and who recorded it; and the reference of any refund the business records.");
    const schema = read('apps/api/prisma/schema.prisma');
    for (const field of ['customerPaymentRef', 'customerMmgClaim', 'mmgAttestedRef', 'mmgAttestedAmount', 'mmgAttestedById', 'mmgRefundRef']) expect(schema).toContain(field);
  });
  it('section 1 points to it', () => {
    expect(section(PRIVACY, /<h2>1\. /)).toContain('If you pay by MMG, your order also keeps the payment references section 2 describes.');
  });
  it('section 6 and everything that repeats it read the same', () => {
    const words = 'disputes, payments Swift has decided to make, tax and legal obligations';
    expect(section(PRIVACY, /<h2>6\. /)).toContain(`for the period required for ${words}`);
    expect(read('apps/web/src/lib/account-deletion-words.ts')).toContain(`For the period the law requires for ${words}.`);
    expect(read('apps/api/src/modules/user/account-erasure-register.ts').match(/disputes, payments Swift has decided to make, tax and legal duties \(Privacy Policy §6\)/g)).toHaveLength(2);
  });
});

describe('Privacy: what location is kept, measured at the code', () => {
  it('says live location runs while online or on a job, and stops offline', () => {
    expect(LOCATION()).toContain('For movers, live location while online or on a job');
    expect(LOCATION()).toContain('stops when you go offline');
  });
  it('never says a flat "no history": it lists what is kept', () => {
    expect(LOCATION()).not.toMatch(/no location history|do not keep a trail/i);
    expect(LOCATION()).toContain('We do not keep a lasting record of where a mover has been. We keep only:');
  });
  it('the trail: the hours in the words are the hours in the code, counted from the last position', () => {
    expect(TRACE_TTL_S).toBe(3 * 60 * 60);
    expect(LOCATION()).toContain('a short trail of your recent positions, used to work out a job\'s distance and to check for false positions, and deleted 3 hours after your last position');
    expect(read('apps/api/src/modules/dispatch/gps-plausibility.ts')).toMatch(/await redis\.expire\(key, TRACE_TTL_S\)/);
  });
  it('the route: only the distance is frozen', () => {
    expect(LOCATION()).toContain("a job's distance, never its route");
    expect(read('apps/api/src/modules/dispatch/route-match.ts')).toMatch(/routePolyline: null,/);
  });
  it('a flagged position: the days in the words are the retention in the code', () => {
    expect(LIVE_RETENTION_DAYS).toBe(400);
    expect(LOCATION()).toContain('positions that look false, kept for up to 400 days so a person can review them');
  });
  it('job steps and SOS are named', () => {
    expect(LOCATION()).toContain("a single position with the order's record at certain steps of a job, or when a problem is recorded on it, such as arrival, pickup, handover or a failed delivery");
    expect(LOCATION()).toContain('while an SOS is open on a trip, the positions added to that safety record');
  });
});

describe('[brief 5 Nov] what this batch must not change', () => {
  it('authorities: still only where the law requires it', () => {
    expect(section(PRIVACY, /<h2>5\. /)).toContain('We share data with authorities only where the law requires it, and we document every such demand.');
  });
  it('nothing is written for the store-backed promise or pay-after', () => {
    for (const [, doc] of DOCS) expect(doc).not.toMatch(/pay[- ]after|pay after delivery|Swift's promise|Swift pays the store/i);
  });
});

describe('[5 Nov read] what ships now, in the words', () => {
  it('the one-minute hold and the one-minute free cancel', () => {
    expect(ORDER_HOLD_DEFAULT_MIN).toBe(1);
    expect(FREE_CANCEL_WINDOW_MIN).toBe(1);
    expect(section(TERMS, /<h2>5\. /)).toContain('A store order or a parcel is held for one minute after you place it, and you can cancel it free in that minute.');
    expect(section(TERMS, /<h2>7\. /)).toContain('for one minute after a driver, rider or provider accepts it');
  });
  it('the order limit in the words is the limit in the code, and the second figure stays out of them', () => {
    const limit = (ALGO_DEFAULTS['velocity.limits'] as Record<string, { max: number; perSeconds: number; clusterMax?: number }>)['order.place']!;
    expect(limit).toMatchObject({ max: 6, perSeconds: 3600 });
    expect(section(TERMS, /<h2>5\. /)).toContain('You can place at most 6 store orders and parcels in an hour; after that the app asks you to wait, and accounts that appear to belong to one person share a limit.');
    expect(TERMS).not.toMatch(/\b12 (store )?orders\b/);
  });
  it('no rider near: refused before it is placed; no rider in time: cancelled and told', () => {
    expect(section(TERMS, /<h2>5\. /)).toContain('A parcel is refused before it is booked when no rider is online near the pickup.');
    expect(section(TERMS, /<h2>7\. /)).toContain('If no rider can be found in time, the Order is cancelled and you are told.');
    expect(read('apps/web/src/app/legal/delivery/page.tsx')).toMatch(/A parcel is refused before it is booked if no rider is online\s+near the pickup\./);
    expect(read('apps/api/src/modules/dispatch/delivery-capacity.ts')).toContain('No riders are online near your pickup right now');
  });
  it('the taxi waiting cap', () => {
    expect(section(TERMS, /<h2>4\. /)).toContain('The waiting charge is never more than GY$1,800 for a ride.');
  });
  it('in person, on every door that names how the fee is paid', () => {
    expect(section(VENDOR_AGREEMENT, /<h2>12\. /)).toContain('or directly to Westbridge Inc., in person by cash or cheque, or by bank transfer. A cheque counts only once it has cleared. A payment counts once Swift records it. Never pay the weekly fee through an agent or anyone else.');
    expect(VENDOR_AGREEMENT).not.toMatch(/only through MMG/);
    const refunds = read('apps/web/src/app/legal/refunds/page.tsx');
    expect(refunds).toMatch(/directly to \{site\.legalEntityName\}, in person by cash or cheque, or by bank transfer; a cheque counts once it clears,\s+and a payment counts once \{site\.tradeName\} records it\./);
    expect(refunds).toMatch(/if you paid in person, by a way you and \{site\.tradeName\} agree/);
    expect(PRIVACY).toContain('if you pay in person, how you paid, the reference and the receipt');
  });
  it('branches pay per branch', () => {
    expect(section(VENDOR_AGREEMENT, /<h2>2\. /)).toContain('Each branch of your business is its own store and pays its own weekly fee');
  });
  it('states no rider cash limit, either way', () => {
    for (const [, doc] of DOCS) expect(doc).not.toMatch(/cash (limit|cap|float)|float limit/i);
  });
  it('no opening-soon or pilot words in any versioned text', () => {
    for (const [, doc] of DOCS) expect(doc).not.toMatch(/\b(pilot|opening soon|launching soon|coming soon|pre-launch)\b/i);
  });
  it('the chat, ticket and safety clocks are the registry\'s', () => {
    const days = (k: string) => RETENTION_DEFAULTS.find((r) => r.dataClass === k)!.retainDays;
    expect([days('chat.order_messages'), days('support_tickets.resolved'), days('safety.records')]).toEqual([365, 1095, 2555]);
    const s6 = section(PRIVACY, /<h2>6\. /);
    expect(s6).not.toMatch(/retained with its order's record/);
    expect(s6).toContain('Order and job chat is deleted one year after the order or job ended');
    expect(s6).toContain('Resolved Help &amp; Support tickets are deleted 3 years after they are resolved, and closed safety records 7 years after they close');
  });
  it('deletion on the website: the words name it and the doors exist', () => {
    expect(section(TERMS, /<h2>17\. /)).toContain('or on swiftgy.com');
    expect(section(DRIVER_AGREEMENT, /<h2>10\. /)).toContain('delete your account in the app or on swiftgy.com');
    for (const f of ['apps/web/src/app/portal/account/delete/page.tsx', 'apps/web/src/app/dashboard/settings/delete-account/page.tsx']) expect(read(f)).toContain('DeleteAccountFlow');
  });
  it('a closure request stops the fee, as the website says', () => {
    expect(section(VENDOR_AGREEMENT, /<h2>10\. /)).toContain('From your request your store takes no new orders and no new weekly fee falls due');
    expect(read('apps/web/src/lib/account-deletion-words.ts')).toContain('no new weekly fee is charged or falls due while your request is open');
  });
  it('household insecticide is allowed, pesticides are not', () => {
    expect(section(TERMS, /<h2>8\. /)).toContain('agricultural and garden pesticides and controlled chemicals (sealed household insecticide sold by a store is allowed)');
    expect(read('apps/api/src/modules/compliance/prohibited-items.ts')).toContain('HOUSEHOLD_INSECTICIDE_EXEMPTIONS');
  });
  it('the company is named from one place', () => {
    for (const doc of [TERMS, PRIVACY]) expect(doc).toContain('Westbridge Inc. (trading as Swift), registration no. 17703, Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana');
  });
});

describe('classification', () => {
  it('2026-11-05 is material, and classed once', () => {
    expect(LEGAL_VERSION).toBe('2026-11-05');
    expect(MATERIAL_CHANGES.filter((c) => c.version === '2026-11-05')).toHaveLength(1);
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-05');
  });
  it('anyone on an older version is asked, with the summary, and never by continued use', () => {
    const status = acceptanceStatus({ tosVersion: '2026-11-04', roles: ['CUSTOMER'] as UserRole[] });
    expect(status.needsAcceptance).toBe(true);
    expect(status.summary).toEqual(MATERIAL_CHANGES.find((c) => c.version === '2026-11-05')!.summary);
    expect(acceptanceStatus({ tosVersion: '2026-11-05', roles: ['CUSTOMER'] as UserRole[] }).needsAcceptance).toBe(false);
  });
  it('the summary a person reads keeps the same rules', () => {
    const words = MATERIAL_CHANGES.find((c) => c.version === '2026-11-05')!.summary.join(' ');
    expect(words).not.toMatch(/\b(insur\w*|cover\w*|claims?|polic(y|ies)|premiums?|protect\w*|funds?|reserve|guarantee\w*|entitled|will pay|theft|damages|our riders|own network)\b/i);
    expect(words).toContain('you do not have a right to this help');
  });
});
