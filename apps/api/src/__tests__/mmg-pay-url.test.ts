import { describe, expect, it } from 'vitest';
import {
  parseMmgPayUrlAllowedHosts,
  validateMmgPayUrl,
} from '../utils/mmg-pay-url';

describe('MMG direct-pay URL validator', () => {
  const allowed = 'pay.example.com,checkout.example.com';

  it('canonicalizes an explicitly allowlisted public HTTPS destination', () => {
    expect(validateMmgPayUrl(' HTTPS://PAY.EXAMPLE.COM:443/pay/store?ref=abc ', allowed)).toEqual({
      valid: true,
      hostname: 'pay.example.com',
      url: 'https://pay.example.com/pay/store?ref=abc',
    });
  });

  it('fails closed when the authoritative host allowlist is absent or invalid', () => {
    const previous = process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
    delete process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
    try {
      expect(validateMmgPayUrl('https://pay.example.com/pay/store')).toEqual({
        valid: false,
        reason: 'ALLOWLIST_NOT_CONFIGURED',
      });
    } finally {
      if (previous === undefined) delete process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
      else process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = previous;
    }
    expect(validateMmgPayUrl('https://pay.example.com/pay/store', '')).toEqual({
      valid: false,
      reason: 'ALLOWLIST_NOT_CONFIGURED',
    });
    expect(validateMmgPayUrl('https://pay.example.com/pay/store', '*.example.com')).toEqual({
      valid: false,
      reason: 'ALLOWLIST_INVALID',
    });
    expect(parseMmgPayUrlAllowedHosts('https://pay.example.com')).toBeNull();
  });

  it.each([
    ['http://pay.example.com/pay/store', 'HTTPS_REQUIRED'],
    ['https://user:secret@pay.example.com/pay/store', 'CREDENTIALS_FORBIDDEN'],
    ['https://pay.example.com/pay/store#paid', 'FRAGMENT_FORBIDDEN'],
    ['https://pay.example.com:8443/pay/store', 'NON_DEFAULT_PORT'],
    ['https://localhost/pay/store', 'LOCAL_OR_IP_HOST'],
    ['https://merchant.internal/pay/store', 'LOCAL_OR_IP_HOST'],
    ['https://127.0.0.1/pay/store', 'LOCAL_OR_IP_HOST'],
    ['https://[::1]/pay/store', 'LOCAL_OR_IP_HOST'],
    ['https://evil.example/pay/store', 'HOST_NOT_ALLOWED'],
    ['not a URL', 'MALFORMED'],
  ])('rejects %s as %s', (url, reason) => {
    expect(validateMmgPayUrl(url, allowed)).toEqual({ valid: false, reason });
  });
});
