import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SESSION_CREDENTIAL_DIGEST_RE,
  SessionCredentialError,
  digestSessionArgs,
  digestSessionData,
  digestSessionWhere,
  sessionCredentialDigest,
} from './session-credential';

const d = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('[FABLE-AUTH-1] sessionCredentialDigest', () => {
  it('is SHA-256 hex, deterministic, and the exact shape the CHECK constraints accept', () => {
    expect(sessionCredentialDigest('eyJ.abc.def')).toBe(d('eyJ.abc.def'));
    expect(sessionCredentialDigest('x')).toBe(sessionCredentialDigest('x'));
    expect(sessionCredentialDigest('x')).toMatch(SESSION_CREDENTIAL_DIGEST_RE);
    expect(SESSION_CREDENTIAL_DIGEST_RE.test('eyJhbGciOiJIUzI1NiJ9.e30.abc')).toBe(false);
    expect(SESSION_CREDENTIAL_DIGEST_RE.test(d('x').toUpperCase())).toBe(false);
  });
});

describe('[FABLE-AUTH-1] where: every credential field is digested, only for equality', () => {
  it('top-level strings, equals / in / notIn / not, and null pass-throughs', () => {
    expect(digestSessionWhere({ token: 'a', userId: 'u' })).toEqual({ token: d('a'), userId: 'u' });
    expect(digestSessionWhere({ refreshToken: { equals: 'r' } })).toEqual({ refreshToken: { equals: d('r') } });
    expect(digestSessionWhere({ token: { in: ['a', 'b'] }, previousRefreshToken: { notIn: ['c'] } }))
      .toEqual({ token: { in: [d('a'), d('b')] }, previousRefreshToken: { notIn: [d('c')] } });
    expect(digestSessionWhere({ previousRefreshToken: { not: 'p' } })).toEqual({ previousRefreshToken: { not: d('p') } });
    expect(digestSessionWhere({ previousRefreshToken: null })).toEqual({ previousRefreshToken: null });
    expect(digestSessionWhere({ previousRefreshToken: { not: null } })).toEqual({ previousRefreshToken: { not: null } });
    expect(digestSessionWhere({ previousRefreshToken: { equals: null } })).toEqual({ previousRefreshToken: { equals: null } });
  });

  it('through AND / OR / NOT at any depth, leaving every other field and relation filter alone', () => {
    expect(digestSessionWhere({
      OR: [{ refreshToken: 'r' }, { previousRefreshToken: 'r' }],
      AND: { NOT: [{ token: 'a' }], expiresAt: { gt: 1 } },
      user: { phone: { startsWith: '+592' } },
    })).toEqual({
      OR: [{ refreshToken: d('r') }, { previousRefreshToken: d('r') }],
      AND: { NOT: [{ token: d('a') }], expiresAt: { gt: 1 } },
      user: { phone: { startsWith: '+592' } },
    });
  });

  it('refuses a prefix, substring, ordering or case-insensitive filter on a credential', () => {
    for (const filter of [
      { token: { startsWith: 'eyJ' } },
      { token: { contains: 'a' } },
      { refreshToken: { endsWith: 'a' } },
      { refreshToken: { lt: 'a' } },
      { token: { equals: 'a', mode: 'insensitive' } },
      { OR: [{ previousRefreshToken: { search: 'a' } }] },
    ]) {
      expect(() => digestSessionWhere(filter)).toThrow(SessionCredentialError);
      expect(() => digestSessionWhere(filter)).toThrow(/equality/);
    }
  });
});

describe('[FABLE-AUTH-1] data: every credential written is digested, never empty', () => {
  it('create data, update data with set, createMany lists, and a null previous credential', () => {
    expect(digestSessionData({ userId: 'u', token: 'a', refreshToken: 'r' }))
      .toEqual({ userId: 'u', token: d('a'), refreshToken: d('r') });
    expect(digestSessionData({ token: { set: 'a' }, previousRefreshToken: { set: null }, rotatedAt: 1 }))
      .toEqual({ token: { set: d('a') }, previousRefreshToken: { set: null }, rotatedAt: 1 });
    expect(digestSessionData([{ token: 'a', refreshToken: 'r' }, { token: 'b', refreshToken: 's' }]))
      .toEqual([{ token: d('a'), refreshToken: d('r') }, { token: d('b'), refreshToken: d('s') }]);
    expect(digestSessionData({ previousRefreshToken: null, expiresAt: 2 })).toEqual({ previousRefreshToken: null, expiresAt: 2 });
  });

  it('refuses an empty credential: sha256("") must never be a stored login', () => {
    expect(() => digestSessionData({ token: '' })).toThrow(/empty credential/);
    expect(() => digestSessionData({ refreshToken: { set: '' } })).toThrow(/empty credential/);
  });

  it('digests each argument slot an operation can carry: where, cursor, data, create, update', () => {
    expect(digestSessionArgs({
      where: { token: 'a' },
      cursor: { refreshToken: 'r' },
      data: { token: 'b' },
      create: { token: 'c', refreshToken: 'd' },
      update: { previousRefreshToken: 'e' },
      select: { id: true },
    })).toEqual({
      where: { token: d('a') },
      cursor: { refreshToken: d('r') },
      data: { token: d('b') },
      create: { token: d('c'), refreshToken: d('d') },
      update: { previousRefreshToken: d('e') },
      select: { id: true },
    });
  });
});

describe('[Row 231] sessionCredentialMatches: the one constant-time check for a row read by id', () => {
  it('matches the stored digest of the presented credential, and nothing else', async () => {
    const { sessionCredentialMatches } = await import('./session-credential');
    expect(sessionCredentialMatches(d('r'), 'r')).toBe(true);
    expect(sessionCredentialMatches(d('r'), 's')).toBe(false);
    // a stolen digest presented as the credential is digested again: no match
    expect(sessionCredentialMatches(d('r'), d('r'))).toBe(false);
    // a plaintext-shaped stored value (a pre-migration row) is never a match, even for its own plaintext
    expect(sessionCredentialMatches('r', 'r')).toBe(false);
    expect(sessionCredentialMatches(null, 'r')).toBe(false);
    expect(sessionCredentialMatches(undefined, 'r')).toBe(false);
    expect(sessionCredentialMatches(d(''), '')).toBe(false);
  });
});
