import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { NotificationService } from '../modules/notification/notification.service';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { chatRoutes } from '../modules/chat/chat.routes';
import { redactOrderSecrets, SECRET_REDACTION } from '../modules/chat/secret-guard';

// ---------------------------------------------------------------------------
// [F-027-12] The handover secret must never travel over chat.
//
// Chat's doctrine is detection-never-censorship, and the order's pickup/ride
// code is the ONE exception — it is not content to moderate, it is the proof
// that the driver physically met the customer. The room contains the driver
// and message text is copied verbatim into the other participants' PUSH
// bodies, so an unguarded room both defeats the control and puts the secret on
// a lock screen.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let userId: string;
let otherId: string;
let roomId: string;
let orderId: string;

const RIDE_PIN = '481902';
const PICKUP_CODE = '7351';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.ready();

  const mk = async (n: string) =>
    app.prisma.user.create({
      data: {
        phone: `+59263${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: n, lastName: 'Guard',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true,
      },
    });
  const customer = await mk('Customer');
  const driver = await mk('Driver');
  userId = customer.id;
  otherId = driver.id;
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: customer.id, token, refreshToken: nanoid(48),
      deviceId: 'chat-guard', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SG-${nanoid(8)}`,
      orderType: 'TAXI' as never,
      customerId: customer.id,
      status: 'DRIVER_EN_ROUTE' as never,
      pickupLat: 6.8, pickupLng: -58.15,
      pickupAddress: 'pickup', deliveryAddress: 'dropoff',
      deliveryLat: 6.82, deliveryLng: -58.17,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH' as never,
      ridePin: RIDE_PIN,
      pickupCode: PICKUP_CODE,
    },
  });
  orderId = order.id;

  const room = await app.prisma.chatRoom.create({
    data: {
      orderId: order.id,
      participants: { create: [{ userId: customer.id, role: 'CUSTOMER' }, { userId: driver.id, role: 'DRIVER' }] },
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  if (roomId) {
    await app.prisma.chatMessage.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoom.deleteMany({ where: { id: roomId } });
  }
  if (orderId) await app.prisma.order.deleteMany({ where: { id: orderId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await app.close();
});

const send = (message: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/chat/rooms/${roomId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { message, messageType: 'text' },
  });

describe('redactOrderSecrets', () => {
  const secrets = { ridePin: RIDE_PIN, pickupCode: PICKUP_CODE };

  it('removes the bare code', () => {
    const out = redactOrderSecrets(`my code is ${RIDE_PIN}`, secrets);
    expect(out.redacted).toBe(true);
    expect(out.text).not.toContain(RIDE_PIN);
    expect(out.text).toContain(SECRET_REDACTION);
  });

  it('removes a code split by spaces, dashes or dots — obfuscation defeats the control just as well', () => {
    for (const disguise of ['4 8 1 9 0 2', '481-902', '48.19.02', '481 - 902']) {
      const out = redactOrderSecrets(`its ${disguise} ok`, secrets);
      expect(out.redacted, disguise).toBe(true);
      expect(out.text, disguise).toContain(SECRET_REDACTION);
    }
  });

  it('removes the shorter pickup code too', () => {
    const out = redactOrderSecrets(`collection code ${PICKUP_CODE}`, secrets);
    expect(out.redacted).toBe(true);
    expect(out.text).not.toContain(PICKUP_CODE);
  });

  it('leaves a code that is part of a LONGER number alone', () => {
    // A phone number or an order total that happens to contain the digits is
    // not the secret being disclosed.
    const out = redactOrderSecrets('call 5924819021 later', secrets);
    expect(out.redacted).toBe(false);
    expect(out.text).toBe('call 5924819021 later');
  });

  it('leaves ordinary chat untouched', () => {
    for (const ordinary of ["I'm at the blue gate", 'total was $2,500 right?', 'apt 5, second floor']) {
      const out = redactOrderSecrets(ordinary, secrets);
      expect(out.redacted, ordinary).toBe(false);
      expect(out.text, ordinary).toBe(ordinary);
    }
  });

  it('an order with no codes yet redacts nothing', () => {
    const out = redactOrderSecrets(`is it ${RIDE_PIN}?`, { ridePin: null, pickupCode: null });
    expect(out.redacted).toBe(false);
  });

  it('a 1–2 digit "code" is never used as a matcher — it would redact ordinary numbers', () => {
    const out = redactOrderSecrets('there are 2 bags and 5 boxes', { ridePin: '2', pickupCode: '5' });
    expect(out.redacted).toBe(false);
    expect(out.text).toBe('there are 2 bags and 5 boxes');
  });

  it('is not vulnerable to catastrophic backtracking on adversarial input', () => {
    const started = process.hrtime.bigint();
    redactOrderSecrets('4'.repeat(4000) + 'x', secrets);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(500);
  });
});

describe('the send path never stores, broadcasts or pushes a live code', () => {
  it('the stored row, the socket payload and the push body are all redacted, and the sender is told why', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const emitSpy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (_event: string, payload: Record<string, unknown>) => { emitted.push({ room, ...payload }); },
    })) as never);
    const sendSpy = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notif-id');
    try {
      const res = await send(`hey the code is ${RIDE_PIN}, mark it done`);
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // 1. the sender is told plainly, not silently mangled
      expect(body.warning).toContain('removed the pickup code');

      // 2. the stored row — message history is its own disclosure channel
      const row = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.message).not.toContain(RIDE_PIN);
      expect(row.message).toContain(SECRET_REDACTION);

      // 3. the socket broadcast
      expect(emitted).toHaveLength(1);
      expect(String(emitted[0]!['message'])).not.toContain(RIDE_PIN);

      // 4. the PUSH body — the lock screen the invariant names
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const pushed = sendSpy.mock.calls[0]![0] as { body: string; userId: string };
      expect(pushed.userId).toBe(otherId);
      expect(pushed.body).not.toContain(RIDE_PIN);
    } finally {
      emitSpy.mockRestore();
      sendSpy.mockRestore();
    }
  });

  it('an ordinary message is untouched and carries no warning', async () => {
    const sendSpy = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notif-id');
    try {
      const res = await send('I am outside in the yellow car');
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBeUndefined();
      const row = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: res.json().data.id } });
      expect(row.message).toBe('I am outside in the yellow car');
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('the redaction warning wins over the off-platform nudge — it is the one they need to read', async () => {
    const sendSpy = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notif-id');
    try {
      const res = await send(`whatsapp me, code ${PICKUP_CODE}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toContain('removed the pickup code');
      const row = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: res.json().data.id } });
      expect(row.message).not.toContain(PICKUP_CODE);
      expect(row.offPlatformFlag).toBe(true); // still detected, still a risk signal
    } finally {
      sendSpy.mockRestore();
    }
  });
});
