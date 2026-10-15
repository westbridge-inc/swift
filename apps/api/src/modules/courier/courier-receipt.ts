import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { AppError } from '../../utils/errors';

/** A creation answer contains a bearer link. Use the existing envelope key
 * provider so replay never requires a plaintext bearer in CheckoutReceipt. */
const sealedSchema = z.object({ version: z.literal(1), ciphertext: z.string(), iv: z.string(), authTag: z.string(), wrappedKey: z.string() });
const unavailable = () => new AppError(503, 'COURIER_RETRY_UNAVAILABLE', 'Courier requests are temporarily unavailable. Please try again.');

export function courierReceiptKey(header: string | string[] | undefined): string | null {
  if (header === undefined) return null; // Installed clients need no new header.
  if (typeof header !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(header)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Use a valid request key and try again.');
  }
  return `courier-create:${header}`;
}

export async function sealCourierAnswer(answer: unknown, context: string): Promise<Prisma.InputJsonValue> {
  const keys = getKeyProvider(); if (!keys) throw unavailable();
  const dek = generateDek();
  try {
    const sealed = encryptBuffer(Buffer.from(JSON.stringify({ context, answer })), dek);
    return { version: 1, ciphertext: sealed.ciphertext.toString('base64'), iv: sealed.iv.toString('base64'), authTag: sealed.authTag.toString('base64'), wrappedKey: (await keys.wrapDek(dek)).toString('base64') };
  } finally { dek.fill(0); }
}

export async function openCourierAnswer(result: Prisma.JsonValue, context: string): Promise<unknown> {
  const keys = getKeyProvider(); if (!keys) throw unavailable();
  const sealed = sealedSchema.parse(result);
  const dek = await keys.unwrapDek(Buffer.from(sealed.wrappedKey, 'base64'));
  try {
    const decoded = JSON.parse(decryptBuffer(Buffer.from(sealed.ciphertext, 'base64'), dek, Buffer.from(sealed.iv, 'base64'), Buffer.from(sealed.authTag, 'base64')).toString('utf8'));
    if (decoded.context !== context) throw unavailable();
    return decoded.answer;
  } finally { dek.fill(0); }
}
