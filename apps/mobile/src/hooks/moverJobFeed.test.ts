import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/socket', () => ({ connectSocket: () => {}, getSocket: () => ({}) }));
vi.mock('./mover', () => ({ activeLegsQueryFn: () => null, useActiveJob: () => ({}) }));
vi.mock('../stores/moverPreview', () => ({ useMoverPreview: () => false }));

import { liveJobIdsKey } from './moverJobFeed';

// [PERF partner #1] Source contracts for the wiring (the binder's behaviour is
// driven in lib/moverJobFeed.test.ts): mounted once above every mover screen,
// reading only what the screens already poll, re-reading only the active job.
const strip = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOK = strip(readFileSync(new URL('./moverJobFeed.ts', import.meta.url), 'utf8'));
const MOVER = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const STACK = strip(readFileSync(new URL('../modules/mover/MoverStack.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the live job ids', () => {
  it('are the active job plus a stacked rider’s legs, once each, sorted', () => {
    expect(liveJobIdsKey({ id: 'b' }, { legs: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] })).toBe('a,b,c');
    expect(liveJobIdsKey({ id: 'ride-1' }, null)).toBe('ride-1');
  });

  it('are empty with no job, and skip anything without a string id', () => {
    expect(liveJobIdsKey(null, undefined)).toBe('');
    expect(liveJobIdsKey(undefined, { legs: [{}, { id: 7 }, null, { id: '' }] })).toBe('');
    expect(liveJobIdsKey({ id: 'x' }, { legs: 'not a list' })).toBe('x');
  });
});

describe('the live job feed wiring', () => {
  it('is mounted once, in the location supervisor above every mover screen', () => {
    const supervisor = body(STACK, 'function MoverLocationSupervisor()', 'return null;');
    expect(supervisor).toContain('useMoverJobFeed(kind);');
    expect(STACK.match(/useMoverJobFeed\(/g)).toHaveLength(1);
    expect(STACK).toContain("import { useMoverJobFeed } from '../../hooks/moverJobFeed';");
  });

  it('reads the legs the screens poll through a disabled observer with the same read, so it adds no polling', () => {
    const hook = body(HOOK, 'export function useMoverJobFeed', '\n}\n');
    expect(hook).toContain("queryKey: ['mover', 'active', kind, 'legs'],");
    expect(hook).toContain('queryFn: activeLegsQueryFn,');
    expect(hook).toContain('enabled: false,');
    expect(hook).not.toContain('refetchInterval');
    const jobs = body(MOVER, 'export function useActiveJobs', '\n}\n');
    expect(jobs).toContain("queryKey: ['mover', 'active', kind, 'legs'],");
    expect(jobs).toContain('queryFn: activeLegsQueryFn,');
  });

  it('re-reads only the active job, without cancelling a read in flight, and never in preview', () => {
    const hook = body(HOOK, 'export function useMoverJobFeed', '\n}\n');
    expect(hook).toContain("qc.invalidateQueries({ queryKey: ['mover', 'active', kind] }, { cancelRefetch: false })");
    expect(hook).not.toMatch(/queryKey: \['mover'\]/);
    expect(hook).toContain('if (!kind || pv || !key) return;');
    expect(hook).toContain('return bindMoverJobFeed(getSocket(), key.split(\',\'),');
  });
});
