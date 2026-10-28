import { describe, expect, it, vi } from 'vitest';
import { Prisma, type Order } from '@prisma/client';
import { NO_SHOW_REASON, noShowCustomerNotice, noShowRefusal, recordNoShowInTransaction, repeatNoShowCustomers } from '../modules/booking/appointment-no-show';

// ---------------------------------------------------------------------------
// [BOOK-FU2 · owner B3] "Customer didn't come": the rules without a database. The routes are proved on real Postgres
// in appointment-no-show.test.ts; the Terms and Privacy words in legal-appointment-rules.test.ts.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-02T15:00:00.000Z');
const base = {
  id: 'o1', fulfillment: 'APPOINTMENT', status: 'ACCEPTED', appointmentSlot: new Date(NOW.getTime() - 60_000),
  paymentMethod: 'CASH', paymentStatus: 'PENDING',
} as unknown as Order;
const code = (o: Partial<Order>) => noShowRefusal({ ...base, ...o } as Order, NOW)?.code ?? null;

describe('who may record it, and when', () => {
  it('an accepted appointment whose time has started: allowed (from its first minute)', () => {
    expect(code({})).toBeNull();
    expect(code({ appointmentSlot: NOW })).toBeNull();
  });
  it('before its time: refused', () => {
    expect(code({ appointmentSlot: new Date(NOW.getTime() + 60_000) })).toBe('APPOINTMENT_NOT_STARTED');
    expect(code({ appointmentSlot: null })).toBe('APPOINTMENT_NOT_STARTED');
  });
  it('anything but an accepted appointment: refused', () => {
    for (const status of ['PENDING', 'COMPLETED', 'CANCELLED', 'REFUNDED'] as const) expect(code({ status }), status).toBe('NO_SHOW_NOT_OPEN');
    expect(code({ fulfillment: 'DELIVERY' })).toBe('NOT_AN_APPOINTMENT');
  });
  it('no money moves: a booking already paid by MMG is refused; an unpaid MMG one is not', () => {
    expect(code({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' })).toBe('NO_SHOW_PAID_MMG');
    expect(code({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toBe('NO_SHOW_PAID_MMG');
    expect(code({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toBeNull();
  });
});

describe('on the locked row, inside the close', () => {
  const tx = (booking: { id: string } | null) => {
    const create = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => booking);
    return { create, findFirst, tx: { booking: { findFirst }, appointmentNoShow: { create } } as unknown as Prisma.TransactionClient };
  };

  it('writes exactly the booking, when and who; the booking is the order\'s booking at the order\'s time', async () => {
    const t = tx({ id: 'bk9' });
    await expect(recordNoShowInTransaction(t.tx, base, 'staff1', NOW)).resolves.toEqual({ bookingId: 'bk9' });
    expect(t.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1', slotStart: base.appointmentSlot }, orderBy: { createdAt: 'desc' } }));
    expect(t.create).toHaveBeenCalledWith({ data: { orderId: 'o1', bookingId: 'bk9', recordedAt: NOW, recordedByUserId: 'staff1' } });
  });

  it('a move that committed first (the locked row is in the future now) refuses the whole close: nothing written', async () => {
    const t = tx({ id: 'bk9' });
    await expect(recordNoShowInTransaction(t.tx, { ...base, appointmentSlot: new Date(NOW.getTime() + 3_600_000) } as Order, 'staff1', NOW))
      .rejects.toMatchObject({ code: 'APPOINTMENT_NOT_STARTED' });
    expect(t.create).not.toHaveBeenCalled();
  });

  it('no booking at the order\'s time: refused, nothing written', async () => {
    const t = tx(null);
    await expect(recordNoShowInTransaction(t.tx, base, 'staff1', NOW)).rejects.toMatchObject({ code: 'NO_BOOKING' });
    expect(t.create).not.toHaveBeenCalled();
  });
});

describe('the record and the words', () => {
  it('the table holds only which booking, when and who (Privacy section 6), on its order', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'AppointmentNoShow')!;
    const scalars = model.fields.filter((f) => f.kind === 'scalar').map((f) => f.name).sort();
    expect(scalars).toEqual(['bookingId', 'id', 'orderId', 'recordedAt', 'recordedByUserId', 'tenantId']);
    expect(model.fields.find((f) => f.name === 'orderId')?.isUnique).toBe(true);
  });

  it('the reason is a sentence (every build shows it as written), and the notice names no fee and no strike', () => {
    expect(NO_SHOW_REASON).not.toMatch(/^[A-Z0-9_]+$/);
    const { title, body } = noShowCustomerNotice('SW-1');
    expect(title).toBe('Appointment closed');
    expect(body).toContain('SW-1');
    expect(body).toContain('There is no fee and no strike.');
  });
});

describe('the review: repeated cases only', () => {
  it('counts per customer through the order, keeps those with at least two, most first', async () => {
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const rows = [
      { recordedAt: at(1), order: { customerId: 'a' } },
      { recordedAt: at(2), order: { customerId: 'b' } },
      { recordedAt: at(3), order: { customerId: 'a' } },
      { recordedAt: at(4), order: { customerId: 'c' } },
      { recordedAt: at(5), order: { customerId: 'b' } },
      { recordedAt: at(6), order: { customerId: 'a' } },
    ];
    const prisma = { appointmentNoShow: { findMany: vi.fn(async () => rows) } } as never;
    expect(await repeatNoShowCustomers(prisma)).toEqual([
      { customerId: 'a', missedAppointments: 3, lastRecordedAt: at(1) },
      { customerId: 'b', missedAppointments: 2, lastRecordedAt: at(2) },
    ]);
  });
});
