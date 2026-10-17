import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [ADMIN-TRUTH] TEXT GATE: every console read handles its own failure.
//
// Fourteen screens once called useQuery and never read the query's error, so a
// 403 or a 500 rendered as zeros or as "nothing to do" (Compliance printed
// "Nobody is operating outside the rules" while it could see nobody). This gate
// reads every non-test source file under apps/admin/src and finds each call of
// a TanStack read hook. A call passes only when its result is bound and its
// error is read in the same file:
//   const q = useQuery(...)            → q.error or q.isError appears
//   const { error, ... } = useQuery()  → error (or isError, or its rename) is used
// Any other shape (an unbound call, a hook returned from a custom hook, a
// useQueries array) fails unless it is listed in EXEMPT with its reason. Show
// the failure with the shared component: components/mc/QueryFailed.tsx.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const HOOK = /\b(useQuery|useInfiniteQuery|useSuspenseQuery|useSuspenseInfiniteQuery|useQueries)\s*[<(]/g;

/**
 * "<file relative to src>:<hook>#<nth call of any read hook in that file, from 1>" → why that read may
 * ignore its error. Keep it empty if you can; every entry must still match a real call.
 */
const EXEMPT: Record<string, string> = {};

interface ReadCall { file: string; hook: string; nth: number; line: number; handled: boolean; why: string }

/** Grades every read-hook call in one source text (the self-test below drives it directly). */
function grade(file: string, source: string): ReadCall[] {
  const calls: ReadCall[] = [];
  let nth = 0;
  for (const m of source.matchAll(HOOK)) {
    nth += 1;
    const at = m.index ?? 0;
    const hook = m[1]!;
    const line = source.slice(0, at).split('\n').length;
    const before = source.slice(0, at);
    const binding = before.match(/const\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*$/);
    let handled = false;
    let why = 'the result is not bound to a name, so its error cannot be read';
    if (binding && hook !== 'useQueries') {
      const b = binding[1]!;
      if (b.startsWith('{')) {
        const names = b.slice(1, -1).split(',').map((part) => part.split(':').map((s) => s.trim()))
          .filter(([key]) => key === 'error' || key === 'isError').map(([key, alias]) => alias || key!);
        handled = names.some((n) => (source.match(new RegExp(`\\b${n}\\b`, 'g')) ?? []).length > 1);
        why = names.length ? `destructures ${names.join('/')} but never uses it` : 'destructures neither error nor isError';
      } else {
        handled = new RegExp(`\\b${b.replace(/\$/g, '\\$')}\\.(error|isError)\\b`).test(source);
        why = `never reads ${b}.error or ${b}.isError`;
      }
    }
    calls.push({ file, hook, nth, line, handled, why });
  }
  return calls;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' || entry.name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const ALL = sources(SRC).flatMap((path) => grade(relative(SRC, path), readFileSync(path, 'utf8')));
const keyOf = (c: ReadCall) => `${c.file}:${c.hook}#${c.nth}`;

describe('[ADMIN-TRUTH] every console read handles its failure', () => {
  it('finds the console reads (the census is not vacuous)', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(50);
    expect(ALL.some((c) => c.file === 'app/compliance/page.tsx')).toBe(true);
  });

  it('every useQuery result has its error read (or an explicit, justified exemption)', () => {
    const offenders = ALL.filter((c) => !c.handled && !EXEMPT[keyOf(c)])
      .map((c) => `${c.file}:${c.line} ${c.hook} — ${c.why}. Show it with <QueryFailed> (components/mc/QueryFailed.tsx).`);
    expect(offenders).toEqual([]);
  });

  it('every exemption names a real, still-unhandled call and says why', () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      const call = ALL.find((c) => keyOf(c) === key);
      expect(call, `stale exemption ${key}`).toBeTruthy();
      expect(call!.handled, `${key} now handles its error: drop the exemption`).toBe(false);
    }
  });

  it('bites: the shapes that hid failures are refused, the handled shapes pass', () => {
    const verdict = (src: string) => grade('x.tsx', src).map((c) => c.handled);
    // The compliance shape: bound, data read, error never read.
    expect(verdict(`const q = useQuery({ queryKey: ['c'] }); const d = q.data;`)).toEqual([false]);
    // The finance/audit shape: destructured without the error.
    expect(verdict(`const { data, isLoading } = useQuery({ queryKey: ['r'] });`)).toEqual([false]);
    // Destructured but never used.
    expect(verdict(`const { data, error } = useQuery({ queryKey: ['r'] });`)).toEqual([false]);
    // Unbound and array forms.
    expect(verdict(`useQuery({ queryKey: ['r'] });`)).toEqual([false]);
    expect(verdict(`const qs = useQueries({ queries: [] }); qs.error;`)).toEqual([false]);
    // Handled shapes.
    expect(verdict(`const q = useQuery<T>({}); if (q.isError) return null;`)).toEqual([true]);
    expect(verdict(`const { data, error: failed } = useQuery({}); show(failed);`)).toEqual([true]);
    expect(verdict(`const list = useInfiniteQuery({}); list.error;`)).toEqual([true]);
    // An import line is not a call.
    expect(verdict(`import { useQuery, useMutation } from '@tanstack/react-query';`)).toEqual([]);
  });
});
