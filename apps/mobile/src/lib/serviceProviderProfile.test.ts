import { describe, expect, it } from 'vitest';
import { unwrapOptionalServiceProviderProfile } from './serviceProviderProfile';

describe('unwrapOptionalServiceProviderProfile', () => {
  it('treats only a definitive 404 as the start-onboarding state', async () => {
    await expect(unwrapOptionalServiceProviderProfile(Promise.reject({ response: { status: 404 } })))
      .resolves.toBeNull();
  });

  it('keeps auth, transport, and server failures visible', async () => {
    for (const failure of [
      { response: { status: 401 } },
      { response: { status: 503 } },
      new Error('network down'),
    ]) {
      await expect(unwrapOptionalServiceProviderProfile(Promise.reject(failure))).rejects.toBe(failure);
    }
  });

  it('unwraps the canonical API envelope', async () => {
    await expect(unwrapOptionalServiceProviderProfile(Promise.resolve({ data: { data: { id: 'provider-1' } } })))
      .resolves.toEqual({ id: 'provider-1' });
  });
});
