import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// [SPEED 30 Oct · owner] An earner's Earnings screen opens with its figures: Home reads ahead
// the screen's own two first reads (shared definitions), never in a preview or before the kind.
const fx = vi.hoisted(() => ({ idle: [] as Array<{ reads: Array<{ queryKey: unknown[] }>; scope: string }> }));
vi.mock('./mover', () => ({
  moverRead: {
    earningsSummary: (kind: string) => ({ queryKey: ['mover', 'earnings-summary', kind], queryFn: vi.fn() }),
    earningsHistory: (kind: string) => ({ queryKey: ['mover', 'earnings-history', kind], queryFn: vi.fn() }),
  },
}));
vi.mock('./vendorTabPrefetch', () => ({ useIdlePrefetch: (reads: Array<{ queryKey: unknown[] }>, scope: string) => { fx.idle.push({ reads, scope }); } }));
import { earnerReads, useEarnerPrefetch } from './earnerPrefetch';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('[SPEED 30 Oct] Earnings read ahead from Home', () => {
  it('the summary and the history for the earner\'s kind; nothing before the kind is known', () => {
    expect(earnerReads('DRIVER').map((r) => r.queryKey)).toEqual([['mover', 'earnings-summary', 'DRIVER'], ['mover', 'earnings-history', 'DRIVER']]);
    expect(earnerReads(null)).toEqual([]);
  });

  it('nothing in a sample preview; once per kind', () => {
    useEarnerPrefetch({ kind: 'RIDER', preview: true });
    useEarnerPrefetch({ kind: 'RIDER', preview: false });
    expect(fx.idle.map((call) => [call.reads.length, call.scope])).toEqual([[0, 'earner:RIDER'], [2, 'earner:RIDER']]);
  });

  it('the Earnings hooks ask exactly what is read ahead (one definition), and Home starts it', () => {
    const mover = read('./mover.ts');
    expect(mover).toContain('useQuery<T>({ ...moverRead.earningsSummary<T>(kind), enabled: !!kind && !pv });');
    expect(mover).toContain('useQuery<T>({ ...moverRead.earningsHistory<T>(kind), enabled: !!kind && !pv });');
    expect(mover).toContain("earningsSummary: <T = any>(kind: MoverKind | null) => ({ queryKey: ['mover', 'earnings-summary', kind], queryFn: () => unwrap<T>(svc(kind as MoverKind).earningsSummary()) }),");
    expect(mover).toContain("earningsHistory: <T = any>(kind: MoverKind | null) => ({ queryKey: ['mover', 'earnings-history', kind], queryFn: () => unwrap<T>(svc(kind as MoverKind).earnings()) }),");
    expect(read('../modules/mover/screens/MoverHomeScreen.tsx')).toContain('useEarnerPrefetch({ kind, preview: !!preview });');
  });

  it('Earnings from memory says it is checking until Swift answers', () => {
    const screen = read('../modules/mover/screens/EarningsScreen.tsx');
    expect(screen).toContain('const checkingLatest = useCheckingLatest(summaryQ);');
    expect(screen).toMatch(/\{checkingLatest \? <T [^>]*>Checking for the latest…<\/T> : null\}/);
  });
});
