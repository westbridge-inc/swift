import { describe, expect, it } from 'vitest';
import { sosPageBody } from '../modules/safety/sos-escalation';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH 5 Nov 2026] The page a responder reads sent them to "the war room", which is no page anyone can open.
// It names the Safety page. It stays free of a person's name and of any location: those are on that page, behind a
// staff sign-in, and this body also goes out as an SMS.
// ---------------------------------------------------------------------------

describe('[FULL-LAUNCH] the SOS page points at the Safety page', () => {
  it('on an order, on a service job, and on neither', () => {
    expect(sosPageBody({ actorRole: 'CUSTOMER', orderId: 'order-1', serviceJobId: null }))
      .toBe('CUSTOMER raised an SOS on order order-1. Open the Safety page in Mission Control now.');
    expect(sosPageBody({ actorRole: 'RIDER', orderId: null, serviceJobId: 'job-1' }))
      .toBe('RIDER raised an SOS on a service job (home visit). Open the Safety page in Mission Control now.');
    expect(sosPageBody({ actorRole: 'DRIVER', orderId: null, serviceJobId: null }))
      .toBe('DRIVER raised an SOS. Open the Safety page in Mission Control now.');
  });

  it('whatever the alert row carries, only the role and the job reach the body', () => {
    const row = {
      actorRole: 'CUSTOMER', orderId: 'order-2', serviceJobId: null,
      triggerNote: 'I am at 12 Camp Street', actorName: 'Sample Name', lat: 6.8125, lng: -58.15, address: '12 Camp Street',
    };
    const body = sosPageBody(row);
    expect(body).not.toMatch(/Camp Street|Sample Name|6\.81|58\.15/);
    expect(body).not.toMatch(/war.room/i);
  });
});
