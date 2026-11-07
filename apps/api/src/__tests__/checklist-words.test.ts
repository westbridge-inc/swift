/**
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (c), COORD (d) delegated] The checklist words the server owns.
 *
 *  - (d) The restaurant licence carries the GRA's own name, "GRA Food Restaurant Licence": the registry row a category
 *    gate's refusal reads is named so on a fresh seed AND on a row an older seed named from the code.
 *  - (c) "Bicycle" means a pedal bike: the bicycle keeps the national ID and no motor documents; anything with a motor
 *    is a motorbike, with a motorbike's documents. No certificate of fitness is asked of a motorbike.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registryCode, seedDocRegistry } from '../modules/verification/doc-registry';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { VEHICLE_CLASSES } from '../config/vehicle-classes';

let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'checklist-words-test');

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('[CHECKLIST-LEGAL (d)] GRA Food Restaurant Licence', () => {
  it('the registry row is named with the GRA\'s own name, on a fresh seed and over an older seed\'s name', async () => {
    await system(async () => {
      const code = registryCode('GY', 'gra_restaurant_licence');
      await seedDocRegistry(app.prisma);
      expect((await app.prisma.docType.findUniqueOrThrow({ where: { code }, select: { displayName: true } })).displayName).toBe('GRA Food Restaurant Licence');
      // what staging and production hold today (the earlier seed named it from the code)
      await app.prisma.docType.update({ where: { code }, data: { displayName: 'GRA Restaurant Licence' } });
      await seedDocRegistry(app.prisma);
      expect((await app.prisma.docType.findUniqueOrThrow({ where: { code }, select: { displayName: true } })).displayName).toBe('GRA Food Restaurant Licence');
      // no other row is renamed by it
      const other = await app.prisma.docType.findUniqueOrThrow({ where: { code: registryCode('GY', 'business_registration') }, select: { displayName: true } });
      expect(other.displayName).toBe('Business Registration');
    });
  }, 180_000); // two full registry seeds
});

describe('[CHECKLIST-LEGAL (c)] a bicycle is a pedal bike', () => {
  it('a bicycle rider shows the national ID and no motor document; a motorbike shows licence, registration and insurance, never a fitness certificate', () => {
    expect(VEHICLE_CLASSES.BICYCLE.docProfiles).toEqual(['MOVER_NO_LICENCE']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_NO_LICENCE']).toEqual(['national_id']);
    expect(VEHICLE_CLASSES.MOTORCYCLE.docProfiles).toEqual(['MOVER_MOTOR']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_MOTOR']).toEqual(['drivers_licence', 'vehicle_registration', 'vehicle_insurance']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['MOVER_MOTOR']).not.toContain('fitness_cert');
  });
});
