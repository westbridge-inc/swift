import { Component, Suspense, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RETRY_DELAY_MS, isChunkLoadError, lazyRetry, mayReloadForChunk, reloadForChunk, retryImport } from './chunk-retry';

// ---------------------------------------------------------------------------
// [PERF #7] A page's on-demand code can fail to arrive once (a dropped request
// on a phone network, or a deploy that replaced the files). The import tries
// once more; only a load failure is retried, never a real error in the code.
// ---------------------------------------------------------------------------

const chunkLost = (id = '1563') => Object.assign(new Error(`Loading chunk ${id} failed.\n(error: https://example.test/_next/static/chunks/${id}.js)`), { name: 'ChunkLoadError' });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('isChunkLoadError', () => {
  it('knows a load failure in every shape browsers and the bundler give it', () => {
    expect(isChunkLoadError(chunkLost())).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 77 failed.'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('Loading CSS chunk 12 failed.'), { code: 'CSS_CHUNK_LOAD_FAILED' }))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x.test/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
  });

  it("the bundler's own marks count whatever the message says", () => {
    expect(isChunkLoadError(Object.assign(new Error('timeout'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('stylesheet missing'), { code: 'CSS_CHUNK_LOAD_FAILED' }))).toBe(true);
  });

  it('a real error in the code is not one', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
    expect(isChunkLoadError(new Error('Request failed with status 500'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed.')).toBe(false);
  });
});

describe('retryImport', () => {
  it('a chunk that fails once arrives on the second try, after a short pause', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(chunkLost()).mockResolvedValueOnce('module');
    const settled = vi.fn();
    retryImport(load)().then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAY_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledWith('module');
  });

  it('tries exactly twice: a second failure reaches the page', async () => {
    const load = vi.fn().mockRejectedValueOnce(chunkLost('1')).mockRejectedValueOnce(chunkLost('2'));
    await expect(retryImport(load, 0)()).rejects.toThrow('Loading chunk 2 failed.');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a real error in the code is not retried', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    const load = vi.fn().mockRejectedValue(bug);
    await expect(retryImport(load, 0)()).rejects.toBe(bug);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a chunk that arrives first time is loaded once', async () => {
    const load = vi.fn().mockResolvedValue('module');
    await expect(retryImport(load, 0)()).resolves.toBe('module');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p>Something went wrong</p> : this.props.children; }
}

describe('lazyRetry', () => {
  it('draws the component when its code fails once, never the error screen', async () => {
    vi.useFakeTimers();
    const Panel = () => <p>Pin panel</p>;
    const load = vi.fn().mockRejectedValueOnce(chunkLost()).mockResolvedValueOnce({ default: Panel });
    const Lazy = lazyRetry(load);
    render(<Boundary><Suspense fallback={<p>Loading</p>}><Lazy /></Suspense></Boundary>);
    expect(screen.getByText('Loading')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAY_MS); });
    expect(screen.getByText('Pin panel')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('reloading once for a page whose code failed', () => {
  it('a load failure may reload when no reload happened in the last minute', () => {
    expect(mayReloadForChunk(chunkLost(), 1_000_000)).toBe(true);
    window.sessionStorage.setItem('swift.chunk-reload', String(1_000_000 - 61_000));
    expect(mayReloadForChunk(chunkLost(), 1_000_000)).toBe(true);
  });

  it('a second failure within a minute does not reload again (no loop)', () => {
    window.sessionStorage.setItem('swift.chunk-reload', String(1_000_000 - 10_000));
    expect(mayReloadForChunk(chunkLost(), 1_000_000)).toBe(false);
  });

  it('a real error never reloads the page', () => {
    expect(mayReloadForChunk(new TypeError('x is not a function'), 1_000_000)).toBe(false);
  });

  it('without page storage it never reloads by itself (it could not tell a loop)', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(mayReloadForChunk(chunkLost(), 1_000_000)).toBe(false);
  });

  it('reloadForChunk remembers when, then reloads', () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    reloadForChunk(5_000_000);
    expect(window.sessionStorage.getItem('swift.chunk-reload')).toBe('5000000');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
