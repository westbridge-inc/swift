import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { afterAll } from 'vitest';

const seeded = new Map<PrismaClient, string[]>();
afterAll(async () => {
  for (const [db, keys] of seeded) await db.encryptedObject.deleteMany({ where: { fileKey: { in: keys } } });
});

/** Explicit per-subject metadata for tests whose processor is a stub. These
 * fixtures do not claim storage/encryption integration; byte/render suites use
 * the real upload route. Keep sandbox verdict markers in the safe basename. */
export async function ownedVerificationFixture(db: PrismaClient, userId: string, marker = 'manual'): Promise<string> {
  const label = marker.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 160);
  const fileKey = `/uploads/verification/${userId}/${nanoid(16)}-${label}.enc`;
  await db.encryptedObject.create({ data: {
    fileKey, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2),
    wrappedDek: Buffer.alloc(60, 3), mimeType: 'image/jpeg', sizeBytes: 1,
    sha256: createHash('sha256').update(fileKey).digest('hex'),
  } });
  seeded.set(db, [...(seeded.get(db) ?? []), fileKey]);
  return fileKey;
}

/** Model the server-owned pointer produced by POST /auth/selfie. */
export async function signupSelfieFixture(db: PrismaClient, userId: string): Promise<string> {
  const avatar = `/uploads/avatars/${userId}/${nanoid(16)}.jpg`;
  await db.user.update({ where: { id: userId }, data: { avatar, selfieCapturedAt: new Date() } });
  return avatar;
}
