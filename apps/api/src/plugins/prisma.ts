import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

// order_status_logs is the immutable event trail behind cash disputes and claims
// (schema: "append-only by convention"). This makes it append-only in FACT: the
// only permitted operation is create. Any update / delete / upsert — from any
// route, job, or a future careless caller — throws here at ONE interception point,
// so recorded evidence can never be altered or selectively erased. Deleting the
// parent Order still cascades its logs at the DB level; that path is intentional
// (the whole order and all its evidence go together) and is not intercepted here.
const IMMUTABLE = 'order_status_logs is append-only (immutable audit evidence); update/delete is not permitted';
const denyMutation = async (): Promise<never> => {
  throw new Error(IMMUTABLE);
};

const prisma = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
}).$extends({
  name: 'orderStatusLogAppendOnly',
  query: {
    orderStatusLog: {
      update: denyMutation,
      updateMany: denyMutation,
      upsert: denyMutation,
      delete: denyMutation,
      deleteMany: denyMutation,
    },
  },
});

// $extends changes the client's TS type but not its runtime surface (create,
// findMany, $transaction, $connect, $disconnect all remain). Consumers only need
// the PrismaClient shape, so we expose it as such — one cast at the composition
// root avoids threading the extended type through ~15 service constructors.
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  await prisma.$connect();
  app.decorate('prisma', prisma as unknown as PrismaClient);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
