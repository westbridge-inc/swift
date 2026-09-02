import { createHash } from 'node:crypto';
import { isProduction } from './runtime-mode';

/**
 * [M-37] The document / statement signing keyring.
 *
 * Three readers (`statement.ts`, `providers/storage/envelope.ts`,
 * `providers/storage/storage-provider.ts`) each did
 * `process.env.STORAGE_SIGNING_SECRET ?? 'dev-signing-secret'`. The boot
 * guard refuses a production boot without a real value, but the runtime read
 * itself fell OPEN: any process that reached the signer without the variable
 * — a worker started with a different environment, a path the guard never
 * covered — signed with a secret published in this public repository, and
 * anyone who read the source could forge a statement or document link.
 *
 * Now the keyring is resolved in one place and production NEVER falls open:
 * an unset, default or short secret throws where it is read. Development and
 * test may use the default, and say so. A previous key may be kept during a
 * rotation so links minted before the rotation still verify until they
 * expire; every key carries a stable id so a token can name the key that
 * signed it and a verifier can refuse a key it does not hold.
 */
export const DEV_SIGNING_SECRET = 'dev-signing-secret';
export const MIN_SIGNING_SECRET_LENGTH = 32;

export interface SigningKey {
  /** A stable, non-secret identifier for the key: the first 8 hex of its SHA-256. */
  kid: string;
  secret: string;
}

export interface SigningKeyring {
  current: SigningKey;
  /** The key being rotated OUT: verification-only, never used to sign. */
  previous: SigningKey | null;
}

export function signingKeyId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

function assertManaged(name: string, value: string): void {
  if (value === DEV_SIGNING_SECRET || value.length < MIN_SIGNING_SECRET_LENGTH) {
    throw new Error(
      `FATAL: ${name} must be a managed secret of at least ${MIN_SIGNING_SECRET_LENGTH} characters in production — ` +
      'the repository default can never sign anything a production service accepts.',
    );
  }
}

/** The keyring for this process. Throws in production rather than falling open. */
export function storageSigningKeys(env: Record<string, string | undefined> = process.env): SigningKeyring {
  const current = env['STORAGE_SIGNING_SECRET'];
  const previous = env['STORAGE_SIGNING_SECRET_PREVIOUS'];
  if (isProduction(env)) {
    if (!current) {
      throw new Error(
        'FATAL: STORAGE_SIGNING_SECRET is required in production — the document and statement links are signed with it, ' +
        'and the repository default can never sign anything a production service accepts.',
      );
    }
    assertManaged('STORAGE_SIGNING_SECRET', current);
    if (previous !== undefined && previous !== '') assertManaged('STORAGE_SIGNING_SECRET_PREVIOUS', previous);
  }
  const secret = current && current.length > 0 ? current : DEV_SIGNING_SECRET;
  return {
    current: { kid: signingKeyId(secret), secret },
    previous: previous && previous.length > 0 ? { kid: signingKeyId(previous), secret: previous } : null,
  };
}

/** The key a token names, if this process holds it; the current key when the
 *  token predates key ids. A key id nobody holds verifies nothing. */
export function signingKeyFor(kid: string | undefined, keyring: SigningKeyring): SigningKey | null {
  if (kid === undefined) return keyring.current;
  if (kid === keyring.current.kid) return keyring.current;
  if (keyring.previous && kid === keyring.previous.kid) return keyring.previous;
  return null;
}
