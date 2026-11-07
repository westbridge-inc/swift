import type { PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { assertNameNotReserved } from '../../lib/fixture-filter';
import { OWN_NAME_VENDOR_TYPES, storeNameIsOwnName } from '../vendor/own-name';

/** The details of a store, as sign-up (POST /partner/become) and add-a-branch (POST /vendor/stores) take them. */
export const businessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  vendorType: z.enum(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']),
  phone: z.string().trim().min(5).max(30),
  addressLine1: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // [ROLE-DOCS · owner 21 Oct 2026] The sign-up's first question: does the store trade under the owner's OWN name
  // (no business registration needed: Business Names (Registration) Act s.3) or a business name? Absent = a business
  // name, as every older client. OWN_NAME is only checked here; the owner signs the declaration after the store exists.
  nameBasis: z.enum(['OWN_NAME', 'REGISTERED']).optional(),
});

/** The weekly-fee tick as a client sends it (Row 628): the words' version and the fee it showed. */
export const weeklyFeeAckSchema = z.object({
  version: z.string().trim().min(1).max(20),
  amount: z.number().int().positive(),
  currencyCode: z.string().trim().length(3),
}).strict();

/**
 * A store's name, checked before the store exists: [MC-PR3] "TEST-" names belong to test accounts only, and
 * [ROLE-DOCS] an own-name store is refused when its name clearly is not the owner's own name.
 */
export async function assertStoreNameAllowed(
  prisma: PrismaClient, userId: string, business: Pick<z.infer<typeof businessSchema>, 'name' | 'vendorType' | 'nameBasis'>,
): Promise<void> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true, firstName: true, lastName: true } });
  assertNameNotReserved(business.name, me?.phone);
  if (business.nameBasis !== 'OWN_NAME') return;
  if (!(OWN_NAME_VENDOR_TYPES as readonly string[]).includes(business.vendorType)) {
    throw new AppError(400, 'OWN_NAME_NOT_APPLICABLE', 'A service business is not asked for a business registration, so it needs no own-name declaration.');
  }
  if (!me || !storeNameIsOwnName(business.name, me.firstName, me.lastName)) {
    throw new AppError(400, 'OWN_NAME_MISMATCH', `“${business.name}” is not just your surname with your first names or initials, so the law asks you to register it as a business name.`);
  }
}
