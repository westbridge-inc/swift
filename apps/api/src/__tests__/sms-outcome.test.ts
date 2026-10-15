import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { smsAccepted, SMS_REF_HANDOFF_SUPPRESSED, SMS_REF_NOT_ALLOWLISTED, SMS_REF_REVIEW_SUPPRESSED } from '../providers/notifications/sms-outcome';
import { guardNonProductionSms } from '../providers/notifications/sms-recipient-allowlist';
import { sealSms, sendOnBehalfOf } from '../providers/notifications/review-seal';

// ---------------------------------------------------------------------------
// [AUD-L8b-008] A text send that RESOLVED is not a text that left Swift.
// The non-production recipient list, the store-review seal and a hand-off
// ledger each answer with their own ref and never call the provider. Only a
// provider's own ref is a text the provider accepted. The wrappers' real
// answers are checked here, so a renamed ref cannot quietly turn back into
// "texted".
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const REVIEW = `sms-outcome-review-${nanoid(6).toLowerCase()}`;
const provider = () => ({ sendSms: vi.fn(async () => ({ ref: `SM${nanoid(10)}` })) });

beforeAll(async () => {
  await prisma.$connect();
  await prisma.tenant.create({ data: { id: REVIEW, name: 'SMS outcome review fiction', slug: REVIEW, isActive: true, kind: 'REVIEW' } });
});
afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: REVIEW } }).catch(() => {});
  await prisma.$disconnect();
});

describe('smsAccepted', () => {
  it('a provider’s own reference is a text accepted', () => {
    expect(smsAccepted({ ref: 'SM0123456789abcdef' })).toBe(true);
    expect(smsAccepted({ ref: 'dev_sms_7' })).toBe(true);
  });
  it('the held-back answers, and no answer at all, are not', () => {
    for (const ref of [SMS_REF_NOT_ALLOWLISTED, SMS_REF_REVIEW_SUPPRESSED, SMS_REF_HANDOFF_SUPPRESSED, '']) expect(smsAccepted({ ref }), ref).toBe(false);
    for (const v of [undefined, null, {}, 'SM123', { ref: 42 }]) expect(smsAccepted(v)).toBe(false);
  });
});

describe('the wrappers’ real answers are not texts that left', () => {
  it('the non-production recipient list: an unlisted number resolves without reaching the provider', async () => {
    const inner = provider();
    const held = await guardNonProductionSms(inner, { NODE_ENV: 'test', SMS_RECIPIENT_ALLOWLIST: '+5926000001' }).sendSms('+5926000002', 'x');
    expect(inner.sendSms).not.toHaveBeenCalled();
    expect(smsAccepted(held)).toBe(false);
    const listed = await guardNonProductionSms(inner, { NODE_ENV: 'test', SMS_RECIPIENT_ALLOWLIST: '+5926000001' }).sendSms('+5926000001', 'x');
    expect(inner.sendSms).toHaveBeenCalledTimes(1);
    expect(smsAccepted(listed)).toBe(true);
  });

  it('the store-review seal: the fiction’s text resolves without reaching the provider', async () => {
    const inner = provider();
    const sealed = await sendOnBehalfOf(REVIEW, () => sealSms(inner).sendSms('+5926000003', 'x'));
    expect(inner.sendSms).not.toHaveBeenCalled();
    expect(smsAccepted(sealed)).toBe(false);
  });
});
