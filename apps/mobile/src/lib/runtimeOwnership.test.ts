import { describe, expect, it, vi } from 'vitest';
import {
  canTeardownRuntime,
  SerializedRuntimeLifecycle,
} from './runtimeOwnership';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const a = { generation: 1, userId: 'account-a' };
const b = { generation: 3, userId: 'account-b' };

describe('process-global runtime ownership', () => {
  it('makes a delayed A teardown a no-op after B owns the runtime', () => {
    expect(canTeardownRuntime(b, a)).toBe(false);
    expect(canTeardownRuntime(b, b)).toBe(true);
    expect(canTeardownRuntime(b)).toBe(true);
  });

  it('serializes an async B install before A late teardown evaluates ownership', async () => {
    const lifecycle = new SerializedRuntimeLifecycle();
    const bInstallGate = deferred();
    const nativeStop = vi.fn();
    let owner: typeof a | null = a;

    const installB = lifecycle.run(async () => {
      await bInstallGate.promise;
      owner = b;
    });
    const staleStopA = lifecycle.run(async () => {
      if (canTeardownRuntime(owner, a)) {
        owner = null;
        nativeStop();
      }
    });

    expect(nativeStop).not.toHaveBeenCalled();
    bInstallGate.resolve();
    await Promise.all([installB, staleStopA]);

    expect(owner).toBe(b);
    expect(nativeStop).not.toHaveBeenCalled();
  });

  it('runs the next serialized operation after its predecessor rejects', async () => {
    const lifecycle = new SerializedRuntimeLifecycle();
    const first = lifecycle.run(async () => {
      throw new Error('native start failed');
    });
    const recovered = vi.fn().mockResolvedValue('account-b-installed');
    const second = lifecycle.run(recovered);

    await expect(first).rejects.toThrow('native start failed');
    await expect(second).resolves.toBe('account-b-installed');
    expect(recovered).toHaveBeenCalledOnce();
  });
});
