import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRoutes } from '../modules/chat/chat.routes';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { registerErrorHandler } from '../middleware/error-handler';

const effects = vi.hoisted(() => ({ notify: vi.fn(), emit: vi.fn() }));
vi.mock('../modules/notification/notification.service', () => ({
  NotificationService: class { send = effects.notify; },
}));
vi.mock('../providers/storage/storage-provider', () => ({
  getStorageProvider: () => ({ getSignedUrl: async () => 'https://media.invalid/signed-image' }),
}));

let app: FastifyInstance;
const db = {
  chatRoom: { findUnique: vi.fn() },
  order: { findUnique: vi.fn(), updateMany: vi.fn() },
  chatRoomParticipant: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  chatMessage: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  contentReport: { findUnique: vi.fn(), create: vi.fn() },
  userBlock: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
};
const order = () => ({
  tenantId: 'tenant-a', customerId: 'sender', rider: { userId: 'recipient' }, driver: null,
  status: 'EN_ROUTE_DELIVERY', ridePin: null, pickupCode: '481902',
});

beforeEach(async () => {
  vi.resetAllMocks();
  db.chatRoom.findUnique.mockResolvedValue({ id: 'room', orderId: 'order', serviceJobId: null, isActive: true });
  db.order.findUnique.mockResolvedValue(order());
  db.chatRoomParticipant.findMany.mockResolvedValue([{ id: 'p1', userId: 'sender' }, { id: 'p2', userId: 'recipient' }]);
  db.chatRoomParticipant.deleteMany.mockResolvedValue({ count: 1 });
  db.chatRoomParticipant.createMany.mockResolvedValue({ count: 1 });
  db.userBlock.findFirst.mockResolvedValue(null);
  db.chatMessage.findMany.mockResolvedValue([]);
  db.chatMessage.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'existing-message' ? { id: where.id, chatRoomId: 'room' } : null);
  db.chatMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    ({ id: 'created-message', ...data, mediaUrl: data['mediaUrl'] ?? null, createdAt: new Date() }));
  db.contentReport.findUnique.mockResolvedValue(null);
  db.contentReport.create.mockResolvedValue({ id: 'report', status: 'PENDING', createdAt: new Date() });
  db.user.findUnique.mockResolvedValue({ firstName: 'Sender' });
  effects.notify.mockResolvedValue('notification');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('prisma', db as unknown as FastifyInstance['prisma']);
  app.decorate('io', { to: () => ({ emit: effects.emit }) } as unknown as FastifyInstance['io']);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    request.user = { userId: request.headers['x-user'] ?? 'sender', role: 'CUSTOMER' } as FastifyRequest['user'];
    request.tenantId = String(request.headers['x-tenant'] ?? 'tenant-a');
  });
  await app.register(chatRoutes, { prefix: '/chat' });
  await app.register(moderationRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const send = (message: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/chat/rooms/room/messages', payload: { message, ...extra } });
const report = (targetId = 'existing-message', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/reports', headers, payload: { targetType: 'CHAT_MESSAGE', targetId, reason: 'HARASSMENT' } });

describe('chat content admission before persistence and delivery', () => {
  it.each([
    'you are a skunt', 'FUCK', 'fúck', 'fu\u200bck',
    'call 6001000', 'call +592 (600) 1000', 'call ６００１０００',
    'call 15927163534', 'call 71635340',
    'https://outside.example/path', 'www.outside.example', 'outside.example/path',
    'https://swiftgy.com.evil.example/contact', 'https://swiftgy.com@evil.example/contact',
    'https://evil.example@swiftgy.com/contact', 'https://swiftgy.com/contact?next=outside',
    'http://swiftgy.com/contact', '481902 https://outside.example',
  ])('refuses prohibited content without any message side effect: %s', async (message) => {
    const response = await send(message);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'CHAT_CONTENT_NOT_ALLOWED' } });
    expect(response.body).not.toContain(message);
    expect(db.chatMessage.create).not.toHaveBeenCalled();
    expect(effects.emit).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
  });

  it.each([
    'shipment at the blue gate', 'gate 4321', 'total is $2,500',
    'date 2026-10-05', 'order SW-260715-001QDB',
    'support +592 716 3534', 'support 7163534', 'https://swiftgy.com/contact',
    '.'.repeat(2000),
  ])('preserves allowed text and normal delivery: %s', async (message) => {
    const response = await send(message);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.message).toBe(message);
    expect(db.chatMessage.create).toHaveBeenCalledOnce();
    expect(effects.emit).toHaveBeenCalledOnce();
    expect(effects.notify).toHaveBeenCalledWith(expect.objectContaining({ body: message.substring(0, 100) }));
  });

  it('filters text even with an image type and a valid server-issued attachment', async () => {
    const response = await send('you are a skunt', { messageType: 'image', mediaId: 'chat/room/abcdefgh.png' });
    expect(response.statusCode).toBe(400);
    expect(db.chatMessage.create).not.toHaveBeenCalled();
  });

  it('keeps valid attachments and existing secret redaction usable', async () => {
    const response = await send('pickup 481902', { messageType: 'image', mediaId: 'chat/room/abcdefgh.png' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.mediaUrl).toBe('https://media.invalid/signed-image');
    expect(response.json().data.message).not.toContain('481902');
    expect(response.json().warning).toBeTruthy();
    expect(JSON.stringify(effects.emit.mock.calls)).not.toContain('481902');
    expect(JSON.stringify(effects.notify.mock.calls)).not.toContain('481902');
  });

  it('retains the soft nudge for an overture without prohibited content', async () => {
    const response = await send('whatsapp me instead');
    expect(response.statusCode).toBe(200);
    expect(response.json().warning).toContain('Keep it in the app');
  });
});

describe('chat report authority', () => {
  it('accepts a current participant report, including closed and blocked conversations', async () => {
    db.chatRoom.findUnique.mockResolvedValue({ id: 'room', orderId: 'order', isActive: false });
    db.order.findUnique.mockResolvedValue({ ...order(), status: 'DELIVERED' });
    db.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    expect((await report()).statusCode).toBe(201);
    expect(db.contentReport.create).toHaveBeenCalledOnce();
  });

  it('rejects a missing message before looking up or creating a report', async () => {
    expect((await report('missing')).statusCode).toBe(404);
    expect(db.contentReport.findUnique).not.toHaveBeenCalled();
    expect(db.contentReport.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'x-user': 'stranger' }, 403],
    [{ 'x-tenant': 'other-tenant' }, 404],
  ] as const)('rejects an unrelated or cross-tenant reporter', async (headers, status) => {
    expect((await report('existing-message', headers)).statusCode).toBe(status);
    expect(db.contentReport.create).not.toHaveBeenCalled();
  });

  it('answers a cross-tenant reporter exactly as it answers a missing message, naming no room', async () => {
    const missing = await report('missing');
    const crossTenant = await report('existing-message', { 'x-tenant': 'other-tenant' });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error).toEqual(missing.json().error);
    expect(crossTenant.body).not.toContain('room');
  });

  it('rejects a reassigned rider and rechecks authority before duplicate success', async () => {
    db.order.findUnique.mockResolvedValue({ ...order(), rider: { userId: 'replacement' } });
    db.contentReport.findUnique.mockResolvedValue({ id: 'old-report', status: 'PENDING' });
    expect((await report('existing-message', { 'x-user': 'recipient' })).statusCode).toBe(403);
    expect(db.contentReport.findUnique).not.toHaveBeenCalled();
    expect(db.contentReport.create).not.toHaveBeenCalled();
  });

  it('keeps authorized duplicate reports idempotent', async () => {
    db.contentReport.findUnique.mockResolvedValue({ id: 'old-report', status: 'PENDING' });
    const response = await report();
    expect(response.statusCode).toBe(200);
    expect(response.json().alreadyReported).toBe(true);
    expect(db.contentReport.create).not.toHaveBeenCalled();
  });
});
