import { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { createGolden } from './gold-7-helpers';

function trackingMethods(h: ReturnType<typeof createGolden>) {
  return [h.app.prisma.alertDelivery.create, h.app.prisma.alertDelivery.createMany,
    h.app.prisma.notification.create, h.app.prisma.notification.createMany];
}

it('default close disposes resources and restores tracking on refused purge without changing any fixture or peer row', async () => {
  const h = createGolden('+5920978', 'gold7-refused-close');
  const peer = new PrismaClient();
  const users: string[] = [];
  const notices: string[] = [];
  const alerts: string[] = [];
  const disconnect = vi.spyOn(PrismaClient.prototype, '$disconnect');
  let onClose = 0;
  try {
    await h.start(async (app) => {
      app.addHook('onClose', async () => { onClose++; });
    });
    expect(trackingMethods(h).every(vi.isMockFunction)).toBe(true);
    const actor = await h.actor(); users.push(actor.userId);
    const ownedNotice = await h.sys(() => h.app.prisma.notification.create({ data: {
      userId: actor.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Owned notice', body: 'Fixture only',
    } })); notices.push(ownedNotice.id);
    const peerNotice = await peer.notification.create({ data: {
      userId: actor.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Peer notice', body: 'Fixture only',
    } }); notices.push(peerNotice.id);
    const ownedAlert = await h.sys(() => h.app.prisma.alertDelivery.create({ data: {
      kind: 'ADMIN_OPS', subjectId: actor.userId, recipientId: actor.userId,
    } })); alerts.push(ownedAlert.id);
    const peerAlert = await peer.alertDelivery.create({ data: {
      kind: 'ADMIN_OPS', subjectId: actor.userId, recipientId: actor.userId,
    } }); alerts.push(peerAlert.id);
    const snapshot = async () => ({
      users: await peer.user.findMany({ where: { id: { in: users } } }),
      customers: await peer.customer.findMany({ where: { userId: { in: users } } }),
      sessions: await peer.session.findMany({ where: { userId: { in: users } }, orderBy: { id: 'asc' } }),
      addresses: await peer.address.findMany({ where: { userId: { in: users } }, orderBy: { id: 'asc' } }),
      notices: await peer.notification.findMany({ where: { id: { in: notices } }, orderBy: { id: 'asc' } }),
      alerts: await peer.alertDelivery.findMany({ where: { id: { in: alerts } }, orderBy: { id: 'asc' } }),
    });
    const before = await snapshot();
    const socketClose = vi.spyOn(h.app.io, 'close');
    try {
      await expect(h.close()).rejects.toThrow(/untracked notifications block fixture user cleanup/);
      expect(onClose, 'Fastify must finish shutdown after refusing purge').toBe(1);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(socketClose).toHaveBeenCalledOnce();
      expect(h.app.redis.status).toBe('end');
      expect(trackingMethods(h).some(vi.isMockFunction)).toBe(false);
      expect(await snapshot()).toEqual(before);
    } finally { socketClose.mockRestore(); }
  } finally {
    // These rows were inserted by this test; no relationship grants ownership.
    try {
      try { await h.dispose(); } finally { disconnect.mockRestore(); }
    } finally {
      try {
        await peer.$transaction(async (tx) => {
          await tx.notification.deleteMany({ where: { id: { in: notices } } });
          await tx.alertDelivery.deleteMany({ where: { id: { in: alerts } } });
          await tx.address.deleteMany({ where: { userId: { in: users } } });
          await tx.session.deleteMany({ where: { userId: { in: users } } });
          await tx.customer.deleteMany({ where: { userId: { in: users } } });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
      } finally { await peer.$disconnect(); }
    }
  }
});

it('explicit retained close allows a successful retry after the peer removes its blocking row', async () => {
  const h = createGolden('+5920978', 'gold7-close-retry');
  const peer = new PrismaClient();
  const notices: string[] = [];
  const originals: unknown[] = [];
  let closed = false;
  let onClose = 0;
  try {
    await h.start(async (app) => {
      originals.push(...trackingMethods(h));
      app.addHook('onClose', async () => { onClose++; });
    });
    const actor = await h.actor();
    const notice = await peer.notification.create({ data: {
      userId: actor.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Peer blocker', body: 'Fixture only',
    } }); notices.push(notice.id);
    const before = await peer.user.findUniqueOrThrow({ where: { id: actor.userId } });
    await expect(h.close({ retainForRetry: true })).rejects.toThrow(/untracked notifications block fixture user cleanup/);
    expect(onClose).toBe(0);
    expect(h.app.redis.status).toBe('ready');
    expect(trackingMethods(h).every(vi.isMockFunction)).toBe(true);
    expect(await peer.user.findUnique({ where: { id: actor.userId } })).toEqual(before);
    expect(await peer.notification.findUnique({ where: { id: notice.id } })).toEqual(notice);
    expect((await h.call('GET', '/api/v1/customer/profile', actor.token)).statusCode).toBe(200);
    await peer.notification.delete({ where: { id: notice.id } });
    // Retention applies only to refusal: a successful explicit retry disposes.
    await h.close({ retainForRetry: true }); closed = true;
    expect(onClose).toBe(1);
    expect(h.app.redis.status).toBe('end');
    expect(trackingMethods(h)).toEqual(originals);
    expect(await peer.user.findUnique({ where: { id: actor.userId } })).toBeNull();
    await h.dispose();
    expect(onClose, 'terminal disposal must be idempotent').toBe(1);
  } finally {
    try {
      await peer.notification.deleteMany({ where: { id: { in: notices } } });
      if (!closed && h.app) await h.close();
    } finally {
      try { await h.dispose(); } finally { await peer.$disconnect(); }
    }
  }
});

it.each([false, true])('preserves the original cleanup error when terminal disposal also fails: %s', async (failDisposal) => {
  const h = createGolden('+5920978', 'gold7-close-error');
  const cleanupError = new Error('original cleanup failure');
  const disposalError = new Error('terminal disposal failure');
  const originals: unknown[] = [];
  try {
    await h.start(async () => { originals.push(...trackingMethods(h)); });
    const preflight = vi.spyOn(h.app.prisma.user, 'findMany').mockRejectedValueOnce(cleanupError);
    const realClose = h.app.close.bind(h.app);
    const closing = vi.spyOn(h.app, 'close').mockImplementation((async () => {
      await realClose();
      if (failDisposal) throw disposalError;
    }) as unknown as typeof h.app.close);
    try {
      if (failDisposal) {
        await expect(h.close()).rejects.toMatchObject({ cause: cleanupError, errors: [cleanupError, disposalError] });
      } else {
        await expect(h.close()).rejects.toBe(cleanupError);
      }
      expect(closing).toHaveBeenCalledOnce();
      expect(h.app.redis.status).toBe('end');
      expect(trackingMethods(h)).toEqual(originals);
    } finally { preflight.mockRestore(); closing.mockRestore(); }
  } finally {
    if (failDisposal) await expect(h.dispose()).rejects.toBe(disposalError);
    else await h.dispose();
  }
});
