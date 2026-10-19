import { describe, expect, it } from 'vitest';
import { EXPECTED_PRINCIPAL_HEADER, SessionChangedError, expectedPrincipalOf, refuseUnexpectedPrincipal } from './expected-principal';

const req = (method: string, value?: string | string[]) => ({
  method,
  headers: value === undefined ? {} : { [EXPECTED_PRINCIPAL_HEADER]: value },
});

describe('[Row 225] expectedPrincipalOf', () => {
  it('reads one declared account; no header or an empty one declares nothing; a repeated header matches no one', () => {
    expect(expectedPrincipalOf(req('POST', 'user-a'))).toBe('user-a');
    expect(expectedPrincipalOf(req('POST', '  user-a '))).toBe('user-a');
    expect(expectedPrincipalOf(req('POST'))).toBeUndefined();
    expect(expectedPrincipalOf(req('POST', ''))).toBeUndefined();
    expect(expectedPrincipalOf(req('POST', '   '))).toBeUndefined();
    expect(expectedPrincipalOf(req('POST', ['user-a', 'user-a']))).toBeNull();
  });
});

describe('[Row 225] refuseUnexpectedPrincipal', () => {
  it('refuses every state-changing method whose session is not the declared account — another account or a guest', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(() => refuseUnexpectedPrincipal(req(method, 'user-a'), 'user-b')).toThrow(SessionChangedError);
      expect(() => refuseUnexpectedPrincipal(req(method, 'user-a'), null)).toThrow(SessionChangedError);
      expect(() => refuseUnexpectedPrincipal(req(method, ['user-a', 'user-a']), 'user-a')).toThrow(SessionChangedError);
    }
  });

  it('is a 409 SESSION_CHANGED that says nothing was saved', () => {
    try {
      refuseUnexpectedPrincipal(req('PUT', 'user-a'), 'user-b');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: 'SESSION_CHANGED' });
      expect((error as Error).message).toMatch(/Nothing was saved/);
    }
  });

  it('lets through the declared account, any request that declares nothing, and every read', () => {
    expect(() => refuseUnexpectedPrincipal(req('POST', 'user-a'), 'user-a')).not.toThrow();
    expect(() => refuseUnexpectedPrincipal(req('POST'), 'user-b')).not.toThrow();
    expect(() => refuseUnexpectedPrincipal(req('POST'), null)).not.toThrow();
    expect(() => refuseUnexpectedPrincipal(req('DELETE', ''), 'user-b')).not.toThrow();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(() => refuseUnexpectedPrincipal(req(method, 'user-a'), 'user-b')).not.toThrow();
    }
  });
});
