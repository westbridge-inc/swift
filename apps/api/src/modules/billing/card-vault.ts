import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { AppError } from '../../utils/errors';

/**
 * [PT-1 · C9] The provider's vault token at rest. No new cryptography: this is
 * the envelope helper the verification documents already use
 * (providers/storage/envelope.ts) — a fresh AES-256-GCM data key per card,
 * the token encrypted under it, and the data key wrapped by the master KEK.
 * The row stores iv(12) | authTag(16) | ciphertext and the WRAPPED key only.
 *
 * Unlike the safety escrow, a card token is never stored under an unwrapped
 * key: with no master KEK configured there is no enrolment at all (and the
 * payment_instruments_sealed_check constraint refuses a bare 32-byte key).
 * Production already refuses to boot without MASTER_KEK.
 *
 * The token is opened only at the instant of a charge, and nothing that
 * holds it is ever logged or put in a DTO.
 */
export interface SealedVaultToken {
  vaultTokenSealed: Uint8Array<ArrayBuffer>;
  vaultTokenDek: Uint8Array<ArrayBuffer>;
}

function keys() {
  const provider = getKeyProvider();
  if (!provider) throw new AppError(503, 'CARD_VAULT_UNAVAILABLE', 'Saving cards is not available right now.');
  return provider;
}

export async function sealVaultToken(token: string): Promise<SealedVaultToken> {
  if (!token) throw new AppError(502, 'CARD_VAULT_TOKEN_MISSING', 'The card provider returned no card reference.');
  const provider = keys();
  const dek = generateDek();
  try {
    const { ciphertext, iv, authTag } = encryptBuffer(Buffer.from(token, 'utf8'), dek);
    return {
      // `Uint8Array.from` copies into a plain ArrayBuffer: the shape Prisma's Bytes columns accept.
      vaultTokenSealed: Uint8Array.from(Buffer.concat([iv, authTag, ciphertext])),
      vaultTokenDek: Uint8Array.from(await provider.wrapDek(dek)),
    };
  } finally {
    dek.fill(0);
  }
}

export async function openVaultToken(row: { vaultTokenSealed: Uint8Array; vaultTokenDek: Uint8Array }): Promise<string> {
  const provider = keys();
  const dek = await provider.unwrapDek(Buffer.from(row.vaultTokenDek));
  try {
    const blob = Buffer.from(row.vaultTokenSealed);
    return decryptBuffer(blob.subarray(28), dek, blob.subarray(0, 12), blob.subarray(12, 28)).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
