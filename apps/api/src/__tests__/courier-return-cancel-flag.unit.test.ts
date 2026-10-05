import { describe, expect, it } from 'vitest';
import { customerRoutes } from '../modules/user/customer.routes';
import {
  foodDelivery,
  hostRoutes,
  orderStore,
  prismaDouble,
  recordingIo,
  recordingRedis,
  type Row,
} from './helpers/service-vertical-doubles';

// ---------------------------------------------------------------------------
// [E17 · DS202 D3] A parcel on its way back to its sender is in the mover's
// custody exactly like the forward leg, and a returned one is closed. The
// locked cancel path refuses both, so the order screen must not offer a
// Cancel that can only fail. Driven through the real customer route.
// ---------------------------------------------------------------------------

async function customerHost(rows: Row[]) {
  const store = orderStore(rows);
  const prisma = prismaDouble(store, {
    customer: { findUnique: async () => ({ id: 'cust-1', userId: 'user-customer', referralCode: 'REF1' }) },
    vendor: { findMany: async () => [] },
    item: { findMany: async () => [] },
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    countryConfig: { findUnique: async () => null },
    rating: { findMany: async () => [] },
  });
  return hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
}

const asCustomer = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-customer', role: 'CUSTOMER' }, ...extra });
type Detail = { success: boolean; data: Row };

describe('[E17] the order screen never offers a Cancel the return leg would refuse', () => {
  it.each(['RETURNING', 'RETURNED'] as const)('a courier parcel in %s offers no Cancel', async (status) => {
    const h = await customerHost([foodDelivery('parcel-1', { orderType: 'COURIER', status })]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'parcel-1' } }))) as Detail;
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ id: 'parcel-1', status, canCancel: false });
  });

  it('control — a parcel still waiting for its rider can be cancelled', async () => {
    const h = await customerHost([foodDelivery('parcel-2', { orderType: 'COURIER', status: 'PENDING' })]);
    const res = (await h.call('get /orders/:id', asCustomer({ params: { id: 'parcel-2' } }))) as Detail;
    expect(res.data).toMatchObject({ id: 'parcel-2', canCancel: true });
  });
});
