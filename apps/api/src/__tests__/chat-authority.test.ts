import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { NotificationService } from '../modules/notification/notification.service';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { chatRoutes } from '../modules/chat/chat.routes';
import { SECRET_REDACTION } from '../modules/chat/secret-guard';
import { deactivateRoom, isServerIssuedMediaId, resolveRoomAuthority, serializeChatMessage } from '../modules/chat/chat-authority';
import { chatGuardCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-004] Live handover secrets never cross ANY chat boundary, and only the
// order's CURRENT participants, inside the order's tenant, may use an OPEN room.
//
// A taxi order with a live ride PIN and pickup code, its customer and driver,
// a room, and LEGACY rows seeded raw (a PIN in the text, a code in a media
// URL) as if written before the guard existed. Then: every read surface
// scrubs them (history, the room list preview, the room-create response); a
// client-supplied media URL is refused and only a server-issued id — minted by
// the room's own upload route — is stored and emitted as a signed URL; a
// closed room refuses writes and closes exactly once; a driver reassigned off
// the order loses the room on every surface and the new driver gains it; a
// caller bound to another tenant cannot see the room; a live PIN typed into
// chat is redacted AND rotated.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RIDE_PIN = '481902';
const PICKUP_CODE = '7351';
const userIds: string[] = [];
let customerToken: string;
let driverToken: string;
let driver2Token: string;
let customerId: string;
let driverUserId: string;
let driver2UserId: string;
let driverId: string;
let driver2Id: string;
let orderId: string;
let roomId: string;
let legacyTextId: string;
let legacyMediaId: string;
const phoneBase = 592_770_000_000 + Math.floor(Math.random() * 100_000_000);
let seq = 0;

async function makeUser(first: string, roles: Array<'CUSTOMER' | 'DRIVER'>, tenantId = 'swift-default') {
  seq += 1;
  const u = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: first, lastName: 'Auth', roles, activeRole: roles[0]!, isPhoneVerified: true, tenantId, ...(roles.includes('CUSTOMER') && { customer: { create: {} } }) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'chat-auth', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

const inject = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1/chat${url}`, headers: { authorization: `Bearer ${token}` }, payload });
const count = async (surface: string, outcome: string) => (await chatGuardCounter.get()).values.find((v) => v.labels['surface'] === surface && v.labels['outcome'] === outcome)?.value ?? 0;

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----chat${nanoid(8)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
// a minimal PNG header the image sniffer accepts
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.ready();
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);

  const customer = await makeUser('Customer', ['CUSTOMER']);
  const driver = await makeUser('Driver', ['DRIVER']);
  const driver2 = await makeUser('Second', ['DRIVER']);
  customerId = customer.id; customerToken = customer.token;
  driverUserId = driver.id; driverToken = driver.token;
  driver2UserId = driver2.id; driver2Token = driver2.token;
  const vehicle = () => ({ vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver', licensePlate: `HC ${nanoid(4).toUpperCase()}`, driverLicenseUrl: 'https://example.invalid/licence.jpg', vehicleInsuranceUrl: 'https://example.invalid/insurance.jpg' });
  const d1 = await app.prisma.driver.create({ data: { userId: driver.id, ...vehicle() } });
  const d2 = await app.prisma.driver.create({ data: { userId: driver2.id, ...vehicle() } });
  driverId = d1.id; driver2Id = d2.id;

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `CA-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.id, driverId: d1.id, status: 'DRIVER_EN_ROUTE',
      pickupLat: 6.8, pickupLng: -58.15, pickupAddress: 'pickup', deliveryAddress: 'dropoff', deliveryLat: 6.82, deliveryLng: -58.17,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH', ridePin: RIDE_PIN, pickupCode: PICKUP_CODE,
    },
  });
  orderId = order.id;
  const room = await app.prisma.chatRoom.create({ data: { orderId: order.id, participants: { create: [{ userId: customer.id, role: 'customer' }, { userId: driver.id, role: 'driver' }] } } });
  roomId = room.id;
  // legacy rows, written raw before the guard existed
  legacyTextId = (await app.prisma.chatMessage.create({ data: { chatRoomId: roomId, senderId: customer.id, message: `my pin is ${RIDE_PIN} see you`, messageType: 'text' } })).id;
  legacyMediaId = (await app.prisma.chatMessage.create({ data: { chatRoomId: roomId, senderId: driver.id, message: 'photo', messageType: 'image', mediaUrl: `https://cdn.example/pickup-${PICKUP_CODE}.jpg` } })).id;
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.chatMessage.deleteMany({ where: { chatRoomId: roomId } }).catch(() => {});
    await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: roomId } }).catch(() => {});
    await app.prisma.chatRoom.deleteMany({ where: { id: roomId } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: orderId } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: [driverId, driver2Id] } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:chat-authority');
  await app.close();
});

describe('[R048-004] every read surface scrubs a legacy raw row', () => {
  it('history: the legacy PIN text is redacted and the legacy raw media URL is hidden — and counted by surface', async () => {
    const before = await count('history', 'redacted');
    const res = await inject('GET', `/rooms/${roomId}/messages`, driverToken);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; message: string; mediaUrl: string | null }>;
    const text = rows.find((r) => r.id === legacyTextId)!;
    expect(text.message).not.toContain(RIDE_PIN);
    expect(text.message).toContain(SECRET_REDACTION);
    const media = rows.find((r) => r.id === legacyMediaId)!;
    expect(media.mediaUrl).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(PICKUP_CODE);
    expect(await count('history', 'redacted')).toBeGreaterThan(before);
  });

  it('room list: the lastMessage preview is serialized, never a stored row', async () => {
    // make the raw legacy media row the newest one, so it IS the preview
    await app.prisma.chatMessage.update({ where: { id: legacyMediaId }, data: { createdAt: new Date(Date.now() + 1000), message: `code ${PICKUP_CODE} inside` } });
    const res = await inject('GET', '/rooms?as=driver', driverToken);
    expect(res.statusCode).toBe(200);
    const room = (res.json().data as Array<{ id: string; lastMessage: { message: string; mediaUrl: string | null } | null }>).find((r) => r.id === roomId)!;
    expect(room.lastMessage).not.toBeNull();
    expect(room.lastMessage!.message).not.toContain(PICKUP_CODE);
    expect(room.lastMessage!.mediaUrl).toBeNull();
  });

  it('room create/open: the included messages are serialized too, and the caller’s tenant must be the order’s', async () => {
    const res = await inject('POST', '/rooms', customerToken, { orderId });
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json().data.messages);
    expect(body).not.toContain(RIDE_PIN);
    expect(body).not.toContain(PICKUP_CODE);
    // a customer bound to ANOTHER tenant, even if named on an order, does not find it
    const foreignTenant = `tenant-ca-${nanoid(6).toLowerCase()}`;
    // isActive: FALSE deliberately. Tenant.isActive defaults to true, and the
    // public storefront resolver refuses to guess when TWO tenants are active
    // (503 PUBLIC_TENANT_UNRESOLVED). Vitest runs files in parallel, so a
    // second active tenant living for the length of this test made
    // public-storefronts and preview-drafts fail in CI — a test breaking other
    // tests, not a product defect. Inactive is all this fixture needs: it
    // exists to be a DIFFERENT tenant, never to serve anything.
    await app.prisma.tenant.create({ data: { id: foreignTenant, name: 'Elsewhere', slug: foreignTenant, isActive: false } });
    // created as system work: the async context still carries the last request's tenant, and the scoping extension
    // would stamp it over the foreign one (the same enterWith leak that bit cleanup elsewhere)
    const stranger = await runWithoutTenant(() => makeUser('Stranger', ['CUSTOMER'], foreignTenant), 'test-fixture:chat-authority');
    const res2 = await inject('POST', '/rooms', stranger.token, { orderId });
    const strangerStatus = res2.statusCode;
    // (the tenant-scoping extension already hides the order from a caller bound to another tenant, so the route's own
    //  tenant check is defence in depth behind it — the 404 is the invariant, whichever layer answered)
    await runWithoutTenant(async () => {
      // NEVER an id that could be undefined: Prisma treats `where: { userId: undefined }`
      // as "no filter" and deleteMany then empties the table.
      if (stranger.id) {
        await app.prisma.session.deleteMany({ where: { userId: stranger.id } }).catch(() => undefined);
        await app.prisma.user.deleteMany({ where: { id: stranger.id } }).catch(() => undefined);
      }
      await app.prisma.tenant.delete({ where: { id: foreignTenant } }).catch(() => undefined);
    }, 'test-cleanup:chat-authority');
    // asserted AFTER the tenant is gone, so a failure here cannot leave one behind
    expect(strangerStatus).toBe(404);
  });
});

describe('[R048-004] media is server-issued', () => {
  it('a client-supplied mediaUrl is refused at ingress, a foreign media id is refused, and nothing is stored', async () => {
    const before = await app.prisma.chatMessage.count({ where: { chatRoomId: roomId } });
    const url = await inject('POST', `/rooms/${roomId}/messages`, driverToken, { message: 'look', messageType: 'image', mediaUrl: `https://evil.example/${RIDE_PIN}.png` });
    expect(url.statusCode).toBe(400);
    expect(url.json().error.code).toBe('MEDIA_URL_NOT_ACCEPTED');
    const foreign = await inject('POST', `/rooms/${roomId}/messages`, driverToken, { message: 'look', messageType: 'image', mediaId: 'chat/other-room/abcdefghij.png' });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('MEDIA_ID_INVALID');
    expect(await app.prisma.chatMessage.count({ where: { chatRoomId: roomId } })).toBe(before);
    expect(isServerIssuedMediaId(`chat/${roomId}/abcdefghij.png`, roomId)).toBe(true);
    expect(isServerIssuedMediaId(`/uploads/chat/${roomId}/abcdefghij.png`, roomId)).toBe(true);
    expect(isServerIssuedMediaId(`https://x/chat/${roomId}/abcdefghij.png`, roomId)).toBe(false);
  });

  it('the room’s own upload route mints the id; the message stores it and every egress emits a SIGNED url, never the key', async () => {
    const { payload, contentType } = multipartBody('photo.png', 'image/png', PNG);
    const up = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/media`, headers: { authorization: `Bearer ${driverToken}`, 'content-type': contentType }, payload });
    expect(up.statusCode).toBe(200);
    const mediaId = up.json().data.mediaId as string;
    expect(isServerIssuedMediaId(mediaId, roomId)).toBe(true);
    const sent = await inject('POST', `/rooms/${roomId}/messages`, driverToken, { message: 'here', messageType: 'image', mediaId });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.mediaUrl).not.toBe(mediaId);
    expect(typeof sent.json().data.mediaUrl).toBe('string');
    const stored = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.json().data.id } });
    expect(stored.mediaUrl).toBe(mediaId);
    const hist = await inject('GET', `/rooms/${roomId}/messages`, customerToken);
    const row = (hist.json().data as Array<{ id: string; mediaUrl: string | null }>).find((r) => r.id === stored.id)!;
    expect(row.mediaUrl).not.toBeNull();
    expect(row.mediaUrl).not.toBe(mediaId);
    // a bad upload is refused
    const bad = multipartBody('x.txt', 'text/plain', Buffer.from('not an image'));
    const rej = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/media`, headers: { authorization: `Bearer ${driverToken}`, 'content-type': bad.contentType }, payload: bad.payload });
    expect(rej.statusCode).toBe(400);
  });
});

describe('[R048-004] a live PIN typed into chat is redacted AND rotated', () => {
  it('the row, the response and the counters show the redaction; the order’s ride PIN is re-issued once', async () => {
    const before = await count('send', 'ride_pin_rotated');
    const res = await inject('POST', `/rooms/${roomId}/messages`, customerToken, { message: `the pin is ${RIDE_PIN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.message).not.toContain(RIDE_PIN);
    expect(res.json().warning).toBeTruthy();
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { ridePin: true, ridePinVerified: true } });
    expect(order.ridePin).not.toBe(RIDE_PIN);
    expect(order.ridePin).toMatch(/^\d{4,8}$/);
    expect(order.ridePinVerified).toBe(false);
    expect(await count('send', 'ride_pin_rotated')).toBe(before + 1);
    // the pickup code alone does not rotate the ride PIN
    const pinNow = order.ridePin;
    const res2 = await inject('POST', `/rooms/${roomId}/messages`, customerToken, { message: `pickup ${PICKUP_CODE}` });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data.message).not.toContain(PICKUP_CODE);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { ridePin: true } })).ridePin).toBe(pinNow);
  });
});

describe('[R048-004] room authority is the order’s CURRENT people', () => {
  it('a driver reassigned off the order loses history, list and send; the new driver gains them; the cache is reconciled', async () => {
    await app.prisma.order.update({ where: { id: orderId }, data: { driverId: driver2Id } });
    const before = await count('access', 'stale_participant_refused');
    const hist = await inject('GET', `/rooms/${roomId}/messages`, driverToken);
    expect(hist.statusCode).toBe(403);
    const send = await inject('POST', `/rooms/${roomId}/messages`, driverToken, { message: 'still here?' });
    expect(send.statusCode).toBe(403);
    expect(await count('access', 'stale_participant_refused')).toBeGreaterThanOrEqual(before + 2);
    const list = await inject('GET', '/rooms?as=driver', driverToken);
    expect((list.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(roomId);
    // the cache now says so too
    const rows = await app.prisma.chatRoomParticipant.findMany({ where: { chatRoomId: roomId }, select: { userId: true } });
    expect(rows.map((r) => r.userId)).not.toContain(driverUserId);
    // the new driver is in
    const hist2 = await inject('GET', `/rooms/${roomId}/messages`, driver2Token);
    expect(hist2.statusCode).toBe(200);
    const send2 = await inject('POST', `/rooms/${roomId}/messages`, driver2Token, { message: 'on my way' });
    expect(send2.statusCode).toBe(200);
    expect((await app.prisma.chatRoomParticipant.findMany({ where: { chatRoomId: roomId }, select: { userId: true } })).map((r) => r.userId)).toContain(driver2UserId);
    // the authority itself names exactly the current people
    const authority = await resolveRoomAuthority(app.prisma, roomId);
    expect([...authority!.participants.keys()].sort()).toEqual([customerId, driver2UserId].sort());
  });

  it('a closed room is read-only, and closing is a compare-and-set that succeeds exactly once', async () => {
    expect(await deactivateRoom(app.prisma, roomId)).toBe(true);
    expect(await deactivateRoom(app.prisma, roomId)).toBe(false);
    const before = await count('access', 'inactive_room_write_refused');
    const send = await inject('POST', `/rooms/${roomId}/messages`, customerToken, { message: 'one more' });
    expect(send.statusCode).toBe(409);
    expect(send.json().error.code).toBe('ROOM_CLOSED');
    expect(await count('access', 'inactive_room_write_refused')).toBe(before + 1);
    const { payload, contentType } = multipartBody('photo.png', 'image/png', PNG);
    const up = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/media`, headers: { authorization: `Bearer ${customerToken}`, 'content-type': contentType }, payload });
    expect(up.statusCode).toBe(409);
    // reading the transcript is still allowed — the record matters most after the fact
    const hist = await inject('GET', `/rooms/${roomId}/messages`, customerToken);
    expect(hist.statusCode).toBe(200);
  });

  it('the serializer is one function: a raw row in, a scrubbed view out, for any surface', async () => {
    const authority = (await resolveRoomAuthority(app.prisma, roomId))!;
    const view = await serializeChatMessage({ id: 'x', chatRoomId: roomId, senderId: customerId, message: `pin ${authority.secrets.ridePin} and ${PICKUP_CODE}`, messageType: 'text', mediaUrl: `https://cdn/${PICKUP_CODE}.jpg`, createdAt: new Date() }, authority, 'preview');
    expect(view.message).not.toContain(authority.secrets.ridePin!);
    expect(view.message).not.toContain(PICKUP_CODE);
    expect(view.mediaUrl).toBeNull();
    expect(view.redacted).toBe(true);
  });
});
