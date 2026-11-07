import { describe, it, expect, vi, beforeEach } from 'vitest';

// [O-1 · REVIEW-F #2092 S4-2] Only a GOOD /calls/config answer is kept for a few minutes. With the
// bridge ON the server sends this app no number, so a cached failure (null = "behave as today")
// would hide every Call button for five minutes after one network blip.
const config = vi.fn();
vi.mock('../services/api', () => ({ callsApi: { config: () => config(), bridge: vi.fn() } }));
vi.mock('../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn() }));

import { loadCallConfig, resetCallConfigForTests } from './useCallParty';

const ON = { data: { data: { enabled: true, callerId: '+15005550006' } } };

describe('[O-1] the call switch, as this app remembers it', () => {
  beforeEach(() => { resetCallConfigForTests(); config.mockReset(); });

  it('a failed read is not remembered: the next screen asks again and gets the switch', async () => {
    config.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(ON);
    expect(await loadCallConfig()).toBeNull();
    expect(await loadCallConfig()).toEqual({ enabled: true, callerId: '+15005550006' });
    expect(config).toHaveBeenCalledTimes(2);
  });

  it('an unreadable answer is not remembered either', async () => {
    config.mockResolvedValueOnce({ data: { data: { nope: 1 } } }).mockResolvedValueOnce(ON);
    expect(await loadCallConfig()).toBeNull();
    expect(await loadCallConfig()).toEqual({ enabled: true, callerId: '+15005550006' });
  });

  it('a good answer is kept for a few minutes, then asked again', async () => {
    config.mockResolvedValue(ON);
    await loadCallConfig();
    await loadCallConfig();
    expect(config).toHaveBeenCalledTimes(1);
    await loadCallConfig(Date.now() + 5 * 60_000 + 1);
    expect(config).toHaveBeenCalledTimes(2);
  });

  it('two screens asking at once share one request', async () => {
    config.mockResolvedValue(ON);
    await Promise.all([loadCallConfig(), loadCallConfig()]);
    expect(config).toHaveBeenCalledTimes(1);
  });
});
