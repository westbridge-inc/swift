import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

const prisma = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  await prisma.$connect();
  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
