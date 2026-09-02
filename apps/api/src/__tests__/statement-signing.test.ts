import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { DEV_SIGNING_SECRET, signingKeyFor, signingKeyId, storageSigningKeys } from '../utils/signing-keys';
import {
  MAX_STATEMENT_TTL_SECONDS,
  mintStatementPath,
  signStatementToken,
  signStatementTokenV3,
  verifyStatementSignature,
  type StatementLinkQuery,
} from '../modules/order/statement';

// ---------------------------------------------------------------------------
// [M-37] The statement / document signing keyring never falls open.
//
// The secret defaulted to a string published in this public repository, so a
// production process that reached the signer without the variable signed
// links anyone could forge. Now: production throws where the key is read;
// tokens name the key that signed them; a previous key verifies during a
// rotation and nothing else does; links are short-lived by construction.
// ---------------------------------------------------------------------------

const STRONG = 'a-managed-secret-of-at-least-thirty-two-characters';
const PREVIOUS = 'the-key-being-rotated-out-also-thirty-two-plus';
const prod = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', STORAGE_SIGNING_SECRET: STRONG, ...extra });
const dev = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'development', ...extra });

function parseLink(path: string): StatementLinkQuery {
  const q = new URLSearchParams(path.split('?')[1]);
  return {
    v: q.get('v') as StatementLinkQuery['v'],
    k: q.get('k') ?? undefined,
    kind: q.get('kind') as StatementLinkQuery['kind'],
    actor: q.get('actor')!,
    from: q.get('from')!,
    to: q.get('to')!,
    expires: Number(q.get('expires')),
    sig: q.get('sig')!,
  };
}

const period = { from: new Date('2026-08-01T00:00:00.000Z'), to: new Date('2026-08-31T23:59:59.000Z') };

describe('the keyring', () => {
  it('production refuses an unset, default or short secret — it never falls open', () => {
    expect(() => storageSigningKeys(prod({ STORAGE_SIGNING_SECRET: undefined }))).toThrow(/required in production/);
    expect(() => storageSigningKeys(prod({ STORAGE_SIGNING_SECRET: DEV_SIGNING_SECRET }))).toThrow(/managed secret/);
    expect(() => storageSigningKeys(prod({ STORAGE_SIGNING_SECRET: 'short' }))).toThrow(/at least 32/);
    expect(() => storageSigningKeys(prod({ STORAGE_SIGNING_SECRET_PREVIOUS: 'weak-previous' }))).toThrow(/STORAGE_SIGNING_SECRET_PREVIOUS/);
  });

  it('development may use the repository default, and says which key that is', () => {
    const ring = storageSigningKeys(dev());
    expect(ring.current.secret).toBe(DEV_SIGNING_SECRET);
    expect(ring.current.kid).toBe(signingKeyId(DEV_SIGNING_SECRET));
    expect(ring.previous).toBeNull();
  });

  it('a key id resolves to the current key, the previous key during a rotation, and nothing otherwise', () => {
    const ring = storageSigningKeys(prod({ STORAGE_SIGNING_SECRET_PREVIOUS: PREVIOUS }));
    expect(signingKeyFor(ring.current.kid, ring)?.secret).toBe(STRONG);
    expect(signingKeyFor(ring.previous!.kid, ring)?.secret).toBe(PREVIOUS);
    expect(signingKeyFor(signingKeyId(DEV_SIGNING_SECRET), ring)).toBeNull();
    expect(signingKeyFor('deadbeef', ring)).toBeNull();
    expect(signingKeyFor(undefined, ring)?.secret).toBe(STRONG); // a token minted before key ids: the current key
  });
});

describe('statement links', () => {
  it('a minted link is v3, names its key, and verifies under the keyring that minted it', () => {
    const env = prod();
    const { path, expiresInSeconds } = mintStatementPath('rider', 'rider_1', period, 600, env);
    const q = parseLink(path);
    expect(q.v).toBe('3');
    expect(q.k).toBe(storageSigningKeys(env).current.kid);
    expect(expiresInSeconds).toBe(600);
    expect(verifyStatementSignature(q, env)).toBe(true);
    expect(verifyStatementSignature({ ...q, actor: 'rider_2' }, env)).toBe(false);
    expect(verifyStatementSignature({ ...q, expires: q.expires + 1 }, env)).toBe(false);
  });

  it('a link signed with the repository default is refused by a production keyring — the forgery M-37 names', () => {
    const env = prod();
    const forged = mintStatementPath('rider', 'rider_1', period, 600, dev()); // what an attacker with the source can mint
    const q = parseLink(forged.path);
    expect(q.k).toBe(signingKeyId(DEV_SIGNING_SECRET));
    expect(verifyStatementSignature(q, env)).toBe(false);
    // Nor a v2/v1 link built by hand with the default secret.
    const expires = Math.floor(Date.now() / 1000) + 600;
    const v2 = { v: '2' as const, kind: 'rider' as const, actor: 'rider_1', from: period.from.toISOString(), to: period.to.toISOString(), expires, sig: signStatementToken('rider', 'rider_1', period.from.toISOString(), period.to.toISOString(), expires, DEV_SIGNING_SECRET) };
    expect(verifyStatementSignature(v2, env)).toBe(false);
    const v1sig = createHmac('sha256', DEV_SIGNING_SECRET).update(`statement:rider:rider_1:${v2.from}:${v2.to}:${expires}`).digest('hex').slice(0, 32);
    expect(verifyStatementSignature({ ...v2, v: undefined, sig: v1sig }, env)).toBe(false);
  });

  it('rotation: a link minted under the previous key verifies while that key is kept, and not once it is dropped', () => {
    const before = prod({ STORAGE_SIGNING_SECRET: PREVIOUS });
    const { path } = mintStatementPath('vendor', 'vendor_1', period, 600, before);
    const q = parseLink(path);
    const rotating = prod({ STORAGE_SIGNING_SECRET_PREVIOUS: PREVIOUS });
    expect(verifyStatementSignature(q, rotating)).toBe(true);
    const dropped = prod();
    expect(verifyStatementSignature(q, dropped)).toBe(false);
    // The previous key is verification-only: new links come from the current key.
    expect(parseLink(mintStatementPath('vendor', 'vendor_1', period, 600, rotating).path).k).toBe(storageSigningKeys(rotating).current.kid);
  });

  it('a v3 token whose key id was swapped does not verify under either key', () => {
    const env = prod({ STORAGE_SIGNING_SECRET_PREVIOUS: PREVIOUS });
    const ring = storageSigningKeys(env);
    const expires = Math.floor(Date.now() / 1000) + 600;
    const sig = signStatementTokenV3('driver', 'driver_1', period.from.toISOString(), period.to.toISOString(), expires, ring.current);
    const q: StatementLinkQuery = { v: '3', k: ring.previous!.kid, kind: 'driver', actor: 'driver_1', from: period.from.toISOString(), to: period.to.toISOString(), expires, sig };
    expect(verifyStatementSignature(q, env)).toBe(false);
    expect(verifyStatementSignature({ ...q, k: ring.current.kid }, env)).toBe(true);
  });

  it('links are short-lived by construction: a caller asking for a day gets the cap', () => {
    const { expiresInSeconds } = mintStatementPath('rider', 'rider_1', period, 86_400, prod());
    expect(expiresInSeconds).toBe(MAX_STATEMENT_TTL_SECONDS);
    const q = parseLink(mintStatementPath('rider', 'rider_1', period, 86_400, prod()).path);
    expect(q.expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(MAX_STATEMENT_TTL_SECONDS);
  });

  it('v2 and versionless v1 links minted before key ids still verify under the current key (the rolling deployment), and under no other', () => {
    const env = prod();
    const expires = Math.floor(Date.now() / 1000) + 600;
    const from = period.from.toISOString(); const to = period.to.toISOString();
    const v2 = { v: '2' as const, kind: 'rider' as const, actor: 'rider_1', from, to, expires, sig: signStatementToken('rider', 'rider_1', from, to, expires, STRONG) };
    expect(verifyStatementSignature(v2, env)).toBe(true);
    expect(verifyStatementSignature(v2, prod({ STORAGE_SIGNING_SECRET: PREVIOUS, STORAGE_SIGNING_SECRET_PREVIOUS: STRONG }))).toBe(false); // legacy links do not ride the previous key
  });
});
