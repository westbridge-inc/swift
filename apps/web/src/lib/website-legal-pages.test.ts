import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATOR } from '@/legal/generated';
import { site } from '@/site.config';

// ---------------------------------------------------------------------------
// [Owner's legal research, Part 4 "Other pages" · owner 15 Oct 2026] The website's own policy pages, as the
// research words them, with the operator's facts from the ONE source the Terms use (legal/operator.ts via the
// legal:sync snapshot). Sentences the code does not do yet are not published: the delivery page's "customers
// with an ID on file do not receive strikes" (they can) and P5's "a person checks it" (a customer ID goes on
// file automatically) stay out.
// ---------------------------------------------------------------------------

const page = (...p: string[]) => readFileSync(join(process.cwd(), 'src', 'app', ...p), 'utf8').replace(/\s+/g, ' ');
const REFUNDS = page('legal', 'refunds', 'page.tsx');
const DELIVERY = page('legal', 'delivery', 'page.tsx');
const DELETION = page('(marketing)', 'account', 'delete', 'page.tsx');
const CONTACT = page('(marketing)', 'contact', 'page.tsx');

describe('company facts come from the legal texts’ operator', () => {
  it('name, registration no., address, phone, e-mail and the owner’s hours', () => {
    expect(site).toMatchObject({
      legalEntityName: OPERATOR.name, registrationNo: '17703', phone: '+592 716 3534', supportEmail: 'support@swiftgy.com',
      address: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana',
      supportHours: 'Monday to Saturday, 8:00–20:00 Guyana time (in-app Help & Support). In an emergency use SOS or call Police 911, Fire 912, Ambulance 913.',
    });
  });

  it('contact: the registration no. twice, the real hours, no "Inc.."', () => {
    expect(CONTACT).toContain('Registration no. {site.registrationNo}');
    expect(CONTACT).toContain('(registration no.{\' \'} {site.registrationNo}).');
    expect(CONTACT).toContain('{site.supportHours}');
    expect(CONTACT).not.toMatch(/Business hours/);
    expect(CONTACT).not.toMatch(/\{site\.legalEntityName\}<\/b>\./);
  });
});

describe('refunds (research E5, ¶12, ¶13, ¶15)', () => {
  it.each([
    'These rules do not affect your rights under the Consumer Affairs Act 2011 to return goods or get a refund from the business.',
    'We reply within 2 business days; the business must refund within 72 hours of our contact.',
    'refunds the extra or mistaken charge in full, within 14 days, to the method you paid with',
    'within 14 days, to the account you paid from, records the refund, and then deletes your account.',
  ])('%s', (text) => expect(REFUNDS).toContain(text));

  it('no advertising sentence while ads are off', () => {
    expect(REFUNDS).not.toMatch(/advertising/i);
  });
});

describe('delivery (research E3)', () => {
  it('the fee figures', () => {
    expect(DELIVERY).toContain('GYD 500 for the first 3 km, then GYD 100 per km; express is 1.5 times the standard fee.');
  });

  it('held: no sentence the strike code contradicts', () => {
    expect(DELIVERY).not.toMatch(/do not receive strikes|a person on our team checks it/);
  });
});

describe('account deletion (research C12, A4; owner C8)', () => {
  it.each([
    'Swift is operated by {site.legalEntityName} (registration no. {site.registrationNo}). You can delete',
    'We complete verified requests within one month.',
    "Data Protection Act 2023 will give you the right, once in force, to access your data",
    'Swift honours these rights now.',
    "If a rider still holds a customer&apos;s cash from an order, the rider&apos;s account deletion waits until our operations team records it resolved, or for at most 90 days; the cash record is kept as part of the order record. A customer&apos;s own deletion is never blocked by this.",
  ])('%s', (text) => expect(DELETION).toContain(text));
});
