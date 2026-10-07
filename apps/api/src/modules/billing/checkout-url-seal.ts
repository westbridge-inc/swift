import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { AppError } from '../../utils/errors';

/**
 * [MMG checkout F6] The MMG page a checkout hands out, at rest. Whoever holds
 * that URL can open and fund the checkout, so it is never stored in the clear.
 * No new cryptography: the platform's envelope helper, exactly as card-vault.ts
 * seals a card token — a fresh AES-256-GCM data key per checkout, the URL
 * encrypted under it (iv(12) | authTag(16) | ciphertext), and the data key
 * WRAPPED by the master key (MASTER_KEK). The row keeps only the sealed blob
 * and the wrapped key; mmg_checkout_intents_sealed_check refuses a bare key.
 *
 * Opened only to answer the partner who may pay it, never logged, never in
 * an observation. With no master key there is no checkout at all: a URL that
 * cannot be sealed is never written down.
 */
export interface SealedCheckoutUrl {
  checkoutUrlSealed: Uint8Array<ArrayBuffer>;
  checkoutUrlDek: Uint8Array<ArrayBuffer>;
}

function keys() {
  const provider = getKeyProvider();
  if (!provider) throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The MMG checkout could not be started right now. Try again in a minute.');
  return provider;
}

export async function sealCheckoutUrl(url: string): Promise<SealedCheckoutUrl> {
  if (!url) throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The MMG checkout could not be started right now. Try again in a minute.');
  const provider = keys();
  const dek = generateDek();
  try {
    const { ciphertext, iv, authTag } = encryptBuffer(Buffer.from(url, 'utf8'), dek);
    return {
      // `Uint8Array.from` copies into a plain ArrayBuffer: the shape Prisma's Bytes columns accept.
      checkoutUrlSealed: Uint8Array.from(Buffer.concat([iv, authTag, ciphertext])),
      checkoutUrlDek: Uint8Array.from(await provider.wrapDek(dek)),
    };
  } finally {
    dek.fill(0);
  }
}

export async function openCheckoutUrl(row: { checkoutUrlSealed: Uint8Array; checkoutUrlDek: Uint8Array }): Promise<string> {
  const provider = keys();
  const dek = await provider.unwrapDek(Buffer.from(row.checkoutUrlDek));
  try {
    const blob = Buffer.from(row.checkoutUrlSealed);
    return decryptBuffer(blob.subarray(28), dek, blob.subarray(0, 12), blob.subarray(12, 28)).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
