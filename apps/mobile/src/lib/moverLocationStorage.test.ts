import { describe, expect, it, vi } from 'vitest';
import {
  createMoverLocationDurableStorage,
  MOVER_LOCATION_MIGRATION_MARKER_KEY,
  MOVER_LOCATION_SESSION_MMKV_KEY,
} from './moverLocationStorage';

function harness(legacyValue: string | null = null) {
  const values = new Map<string, string>();
  let legacy = legacyValue;
  const initialize = vi.fn().mockResolvedValue(undefined);
  const getValue = vi.fn(async (key: string) => values.get(key) ?? null);
  const setValue = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const removeValue = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const readLegacy = vi.fn(async () => legacy);
  const deleteLegacy = vi.fn(async () => {
    legacy = null;
  });
  const storage = createMoverLocationDurableStorage({
    initialize,
    getValue,
    setValue,
    removeValue,
    readLegacy,
    deleteLegacy,
  });
  return {
    values,
    storage,
    initialize,
    getValue,
    setValue,
    removeValue,
    readLegacy,
    deleteLegacy,
  };
}

describe('mover location encrypted-MMKV storage', () => {
  it('migrates the legacy SecureStore record once before returning authority', async () => {
    const h = harness('{"kind":"DRIVER","startedAt":1,"userId":"a"}');

    await expect(h.storage.read()).resolves.toContain('"userId":"a"');
    expect(h.values.get(MOVER_LOCATION_SESSION_MMKV_KEY)).toContain('"userId":"a"');
    expect(h.values.get(MOVER_LOCATION_MIGRATION_MARKER_KEY)).toBe('1');
    expect(h.deleteLegacy).toHaveBeenCalledOnce();

    await h.storage.write('checkpoint-1');
    await h.storage.write('checkpoint-2');
    expect(h.readLegacy).toHaveBeenCalledOnce();
    expect(h.deleteLegacy).toHaveBeenCalledOnce();
    expect(h.values.get(MOVER_LOCATION_SESSION_MMKV_KEY)).toBe('checkpoint-2');
  });

  it('fails closed and retries when legacy deletion interrupts migration', async () => {
    const h = harness('legacy-authority');
    h.deleteLegacy.mockRejectedValueOnce(new Error('SecureStore delete failed'));

    await expect(h.storage.read()).rejects.toThrow('SecureStore delete failed');
    expect(h.values.get(MOVER_LOCATION_MIGRATION_MARKER_KEY)).toBeUndefined();

    await expect(h.storage.read()).resolves.toBe('legacy-authority');
    expect(h.values.get(MOVER_LOCATION_MIGRATION_MARKER_KEY)).toBe('1');
    expect(h.deleteLegacy).toHaveBeenCalledTimes(2);
  });

  it('surfaces encrypted-MMKV checkpoint and delete failures', async () => {
    const h = harness();
    await h.storage.read();
    h.setValue.mockRejectedValueOnce(new Error('MMKV write failed'));
    await expect(h.storage.write('checkpoint')).rejects.toThrow('MMKV write failed');

    h.removeValue.mockRejectedValueOnce(new Error('MMKV delete failed'));
    await expect(h.storage.delete()).rejects.toThrow('MMKV delete failed');
  });
});
