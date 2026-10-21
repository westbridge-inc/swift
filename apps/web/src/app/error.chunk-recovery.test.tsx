import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RouteError from './error';
import StorefrontError from './(app)/store/[slug]/error';

// ---------------------------------------------------------------------------
// [PERF #7] When a page's code fails to arrive, the error screen used to offer
// "Try again", which re-rendered the page and hit the same kept failure: the
// visitor was stuck until they reloaded by hand. Now the screen reloads once
// by itself; a second failure within a minute shows the screen, and "Try
// again" reloads the page. A real error still re-renders (reset), as before.
// ---------------------------------------------------------------------------

const chunkLost = () => Object.assign(new Error('Loading chunk 4410 failed.\n(error: https://example.test/_next/static/chunks/4410.js)'), { name: 'ChunkLoadError' });
const STAMP = 'swift.chunk-reload';
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = vi.fn();
  vi.spyOn(window.location, 'reload').mockImplementation(() => { reload(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); window.sessionStorage.clear(); });

describe('the app error screen', () => {
  it('a page whose code failed to arrive reloads once by itself', () => {
    const reset = vi.fn();
    render(<RouteError error={chunkLost()} reset={reset} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem(STAMP))).toBeGreaterThan(0);
    expect(screen.getByText('Loading the page again…')).toBeTruthy();
    expect(screen.queryByText('Something went wrong on this page')).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it('a second failure within a minute shows the screen, and Try again reloads the page (not a re-render)', () => {
    window.sessionStorage.setItem(STAMP, String(Date.now() - 10_000));
    const reset = vi.fn();
    render(<RouteError error={chunkLost()} reset={reset} />);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('a real error never reloads: Try again re-renders, as before', () => {
    const reset = vi.fn();
    render(<RouteError error={new TypeError('x is not a function')} reset={reset} />);
    expect(screen.getByText('Something went wrong on this page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the store page error screen', () => {
  it('menu code that failed to arrive reloads once by itself', () => {
    const reset = vi.fn();
    render(<StorefrontError error={chunkLost()} reset={reset} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Swift could not load this store right now')).toBeNull();
  });

  it('a second failure within a minute: "Try this store again" reloads the page', () => {
    window.sessionStorage.setItem(STAMP, String(Date.now() - 10_000));
    const reset = vi.fn();
    render(<StorefrontError error={chunkLost()} reset={reset} />);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try this store again' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('a real error: "Try this store again" re-renders, as before', () => {
    const reset = vi.fn();
    render(<StorefrontError error={new Error('menu read failed')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try this store again' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('every on-demand import tries twice', () => {
  const SRC = join(__dirname, '..');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

  it('no React.lazy outside lib/chunk-retry: each goes through lazyRetry', () => {
    const bare = sources(SRC)
      .filter((path) => !path.endsWith(join('lib', 'chunk-retry.ts')))
      .filter((path) => /(^|[^\w.])lazy\(\s*\(\)\s*=>\s*import\(/m.test(readFileSync(path, 'utf8')) || /React\.lazy\(/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(SRC.length + 1));
    expect(bare).toEqual([]);
  });

  it('the census finds the on-demand imports it guards (it is not looking at nothing)', () => {
    const guarded = sources(SRC).filter((path) => /lazyRetry\(\s*\(\)\s*=>\s*import\(/.test(readFileSync(path, 'utf8')));
    expect(guarded.length).toBeGreaterThanOrEqual(9);
  });
});
