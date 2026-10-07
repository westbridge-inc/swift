import Fastify from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { chatRoutes } from '../../modules/chat/chat.routes';
import { registerErrorHandler } from '../../middleware/error-handler';

export async function chatFixture() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(chatRoutes, { prefix: '/api/v1/chat' }); await app.ready();
  const users: string[] = []; const drivers: string[] = [];
  const base = 592_730_000_000 + Math.floor(Math.random() * 100_000_000);
  async function person(mover: boolean) {
    const role = mover ? 'MOVER' as const : 'CUSTOMER' as const;
    const user = await app.prisma.user.create({ data: { phone: `+${base + users.length}`, firstName: 'ChatFixture', lastName: 'Account', roles: [role], activeRole: role, isPhoneVerified: true, ...(!mover && { customer: { create: {} } }) } });
    users.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role, jti: nanoid() });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chat-revocation', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    if (!mover) return { userId: user.id, token, driverId: null };
    const driver = await app.prisma.driver.create({ data: { userId: user.id, vehicleMake: 'Fixture', vehicleModel: 'Car', vehicleYear: 2020, vehicleColor: 'Grey', licensePlate: nanoid(10), driverLicenseUrl: 'https://example.invalid/document', vehicleInsuranceUrl: 'https://example.invalid/document' } });
    drivers.push(driver.id); return { userId: user.id, token, driverId: driver.id };
  }
  const customer = await person(false); const oldMover = await person(true); const newMover = await person(true);
  const order = await app.prisma.order.create({ data: { orderNumber: `CR-${nanoid()}`, customerId: customer.userId, driverId: oldMover.driverId, orderType: 'TAXI', status: 'DRIVER_EN_ROUTE', pickupLat: 6.8, pickupLng: -58.15, deliveryLat: 6.82, deliveryLng: -58.17, subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, totalAmount: 1500, deliveryFee: 0, paymentMethod: 'CASH' } });
  const room = await app.prisma.chatRoom.create({ data: { orderId: order.id, participants: { create: [{ userId: customer.userId, role: 'customer' }, { userId: oldMover.userId, role: 'driver' }] } } });
  const message = await app.prisma.chatMessage.create({ data: { chatRoomId: room.id, senderId: customer.userId, message: 'private history fixture' } });
  const inject = (method: 'GET' | 'POST', path: string, token: string, payload?: Record<string, unknown>) => app.inject({ method, url: '/api/v1/chat'+path, headers: { authorization: `Bearer ${token}` }, payload });
  const reset = async () => {
    await app.prisma.order.update({ where: { id: order.id }, data: { driverId: oldMover.driverId } });
    await app.prisma.chatRoom.update({ where: { id: room.id }, data: { isActive: true } });
  };
  const revoke = () => app.prisma.order.update({ where: { id: order.id }, data: { driverId: newMover.driverId } });
  const close = async () => {
    await runWithoutTenant(async () => {
      await app.prisma.chatMessage.deleteMany({ where: { chatRoomId: room.id } });
      await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: room.id } });
      await app.prisma.chatRoom.delete({ where: { id: room.id } });
      await app.prisma.order.delete({ where: { id: order.id } });
      await app.prisma.driver.deleteMany({ where: { id: { in: drivers } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    }, 'test-cleanup:l05-chat');
    await app.close();
  };
  return { app, customer, oldMover, newMover, order, room, message, inject, reset, revoke, close };
}
