import { describe, it, expect } from 'vitest';
import { errorMessage } from './apiError';

describe('errorMessage', () => {
  it('prefers the API error message', () => {
    expect(errorMessage({ response: { data: { error: { message: 'This offer has expired' } } } }))
      .toBe('This offer has expired');
  });

  it('explains a timeout', () => {
    expect(errorMessage({ code: 'ECONNABORTED' })).toMatch(/timed out/i);
  });

  it('explains an offline network error', () => {
    expect(errorMessage({ message: 'Network Error' })).toMatch(/offline/i);
  });

  it('falls back for an unknown error', () => {
    expect(errorMessage({})).toMatch(/went wrong/i);
    expect(errorMessage(null, 'custom fallback')).toBe('custom fallback');
  });
});
