import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { AccountService } from '../modules/user/account.service';
import { lockActiveOrderCustomer } from '../modules/order/order-creation-authority';

let app: FastifyInstance;
const userIds: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function makeCustomer() {
  const user = await app.prisma.user.create({
    data: {
      phone: `+59282${nanoid(7)}`,
      firstName: 'Order',
      lastName: 'Authority',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      status: 'ACTIVE',
      isPhoneVerified: true,
    },
    select: { id: true, tenantId: true },
  });
  userIds.push(user.id);
  return user;
}

function createOrder(
  customer: { id: string; tenantId: string },
  afterLock?: () => void,
  releaseAfterLock?: Promise<void>,
) {
  return app.prisma.$transaction(async (tx) => {
    await lockActiveOrderCustomer(tx, customer.id, customer.tenantId);
    afterLock?.();
    if (releaseAfterLock) await releaseAfterLock;
    return tx.order.create({
      data: {
        tenantId: customer.tenantId,
        orderNumber: `AUTH-${nanoid(12)}`,
        orderType: 'COURIER',
        customerId: customer.id,
        status: 'PENDING',
        fulfillment: 'DELIVERY',
        pickupAddress: '1 Authority St',
        pickupLat: 6.8,
        pickupLng: -58.15,
        deliveryAddress: '2 Serialization Ave',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        deliveryFee: 500,
        totalAmount: 500,
        paymentMethod: 'CASH',
      },
    });
  });
}

function proxyTransactionClient(
  tx: any,
  intercept: (target: any, property: PropertyKey) => unknown,
) {
  return new Proxy(tx, {
    get(target, property) {
      const intercepted = intercept(target, property);
      if (intercepted !== undefined) return intercepted;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function interceptNextTransaction(wrap: (tx: any) => any) {
  const transaction = app.prisma.$transaction.bind(app.prisma) as (...args: any[]) => any;
  return vi.spyOn(app.prisma, '$transaction').mockImplementationOnce(((operation: any, options?: any) => {
    if (typeof operation !== 'function') return transaction(operation, options);
    return transaction((tx: any) => operation(wrap(tx)), options);
  }) as never);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('customer order creation authority', () => {
  it('fails closed when the locked customer no longer belongs to the expected tenant', async () => {
    const customer = await makeCustomer();

    await expect(app.prisma.$transaction(async (tx) => {
      await lockActiveOrderCustomer(tx, customer.id, 'different-tenant');
      return tx.order.create({
        data: {
          tenantId: customer.tenantId,
          orderNumber: `AUTH-${nanoid(12)}`,
          orderType: 'COURIER',
          customerId: customer.id,
          deliveryAddress: 'must not commit',
          deliveryLat: 0,
          deliveryLng: 0,
          subtotalBase: 0,
          subtotalMarkup: 0,
          subtotalCustomer: 0,
          deliveryFee: 0,
          totalAmount: 0,
          paymentMethod: 'CASH',
        },
      });
    })).rejects.toMatchObject({ code: 'CUSTOMER_TENANT_CHANGED' });

    expect(await app.prisma.order.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it('lets an already-locked creation commit first, then deletion sees and refuses the active order', async () => {
    const customer = await makeCustomer();
    const creationLocked = deferred();
    const releaseCreation = deferred();
    const creation = createOrder(customer, creationLocked.resolve, releaseCreation.promise);
    await creationLocked.promise;

    const deletionLockAttempted = deferred();
    const transactionSpy = interceptNextTransaction((tx) => proxyTransactionClient(
      tx,
      (target, property) => property === '$queryRaw'
        ? (...args: any[]) => {
            deletionLockAttempted.resolve();
            return target.$queryRaw(...args);
          }
        : undefined,
    ));
    const deletion = new AccountService(app).deleteAccount(customer.id);
    await deletionLockAttempted.promise;

    const outcomes = Promise.allSettled([creation, deletion]);
    releaseCreation.resolve();
    const [creationResult, deletionResult] = await outcomes;
    transactionSpy.mockRestore();

    expect(creationResult.status).toBe('fulfilled');
    expect(deletionResult).toMatchObject({ status: 'rejected', reason: { code: 'ACTIVE_ORDERS' } });
    if (creationResult.status !== 'fulfilled') throw creationResult.reason;
    const order = creationResult.value;
    expect(order.customerId).toBe(customer.id);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } }))
      .toMatchObject({ status: 'ACTIVE' });
  });

  it('cannot commit an order after deletion deactivates the customer under the same lock', async () => {
    const customer = await makeCustomer();
    const deactivationStaged = deferred();
    const releaseDeletion = deferred();
    const transactionSpy = interceptNextTransaction((tx) => proxyTransactionClient(
      tx,
      (target, property) => property === 'user'
        ? new Proxy(target.user, {
            get(delegate, delegateProperty) {
              const value = Reflect.get(delegate, delegateProperty, delegate);
              if (delegateProperty !== 'update') {
                return typeof value === 'function' ? value.bind(delegate) : value;
              }
              return async (args: any) => {
                const updated = await value.call(delegate, args);
                if (args?.data?.status === 'DEACTIVATED') {
                  deactivationStaged.resolve();
                  await releaseDeletion.promise;
                }
                return updated;
              };
            },
          })
        : undefined,
    ));

    const deletion = new AccountService(app).deleteAccount(customer.id);
    await deactivationStaged.promise;
    transactionSpy.mockRestore();

    const creation = createOrder(customer);
    const outcomes = Promise.allSettled([deletion, creation]);
    releaseDeletion.resolve();

    const [deletionResult, creationResult] = await outcomes;
    expect(deletionResult).toMatchObject({ status: 'fulfilled', value: { deleted: true } });
    expect(creationResult).toMatchObject({ status: 'rejected', reason: { code: 'ACCOUNT_INACTIVE' } });
    expect(await app.prisma.order.count({ where: { customerId: customer.id } })).toBe(0);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: customer.id } }))
      .toMatchObject({ status: 'DEACTIVATED', firstName: 'Deleted' });
  });
});
