import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * [phone feedback P1] THE GATE THAT KEEPS THE RELOAD FLASH FROM COMING BACK.
 *
 * The owner, on the first TestFlight build: switching from the Cart tab to
 * Home showed a loading spinner, "so it looks buggy even if it loads fast".
 * The cause was one binding, repeated on ten screens:
 * `<RefreshControl refreshing={query.isRefetching} …>`. React Query sets
 * isRefetching for EVERY fetch over cached data: the focus refetch on each tab
 * switch, a foreground refetch, a polling interval, an invalidation. On iOS a
 * programmatic `refreshing={true}` calls the native control's beginRefreshing,
 * which drags the content down behind a spinner and snaps it back when the
 * fetch lands. Content that was on screen the whole time looks as if it
 * reloaded. On the vendor board, which polls its orders, it did so every
 * poll.
 *
 * THE LAW: a pull spinner shows only while a pull the person made is in flight
 * (hooks/usePullToRefresh, lib/pullToRefresh). No `refreshing` prop may read a
 * query fetch flag, directly or through a local alias.
 */

const SRC = join(process.cwd(), 'src');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith('.tsx') && !name.includes('.test.')) out.push(p);
  }
  return out;
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every `<RefreshControl … />` element, as source text, with its file. */
function refreshControls(): Array<{ file: string; element: string; source: string }> {
  const found: Array<{ file: string; element: string; source: string }> = [];
  for (const file of tsxFiles(SRC)) {
    const source = strip(readFileSync(file, 'utf8'));
    const re = /<RefreshControl\b[\s\S]*?\/>/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      found.push({ file: relative(SRC, file), element: m[0], source });
    }
  }
  return found;
}

/** The expression inside `refreshing={…}` (balanced braces). */
function refreshingExpr(element: string): string | null {
  const at = element.indexOf('refreshing={');
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + 'refreshing='.length; i < element.length; i++) {
    if (element[i] === '{') depth++;
    else if (element[i] === '}' && --depth === 0) return element.slice(at + 'refreshing={'.length, i);
  }
  return null;
}

const FLAG_NAMES = 'is(?:Refetching|Fetching|Loading|Pending|FetchingNextPage)';
const FETCH_FLAG = new RegExp(`\\b${FLAG_NAMES}\\b`);

describe('pull spinners follow the pull, never a background refetch', () => {
  const controls = refreshControls();

  it('finds the screens it guards (the scan is not vacuous)', () => {
    // Home, Market, Orders, the vendor board, menu, insights, billing, Swift
    // number, service jobs and three advertiser screens: 12 at the time of writing.
    expect(controls.length).toBeGreaterThanOrEqual(12);
    const files = controls.map((c) => c.file);
    expect(files).toContain(join('modules', 'shop', 'screens', 'HomeScreen.tsx'));
    expect(files).toContain(join('modules', 'orders', 'screens', 'OrdersHistoryScreen.tsx'));
    expect(files).toContain(join('modules', 'vendor', 'screens', 'VendorOps.tsx'));
  });

  it('no refreshing prop reads a query fetch flag, directly or through a local alias', () => {
    const offenders: string[] = [];
    for (const { file, element, source } of controls) {
      const expr = refreshingExpr(element);
      if (expr == null) {
        offenders.push(`${file}: <RefreshControl> without a refreshing prop`);
        continue;
      }
      if (FETCH_FLAG.test(expr)) offenders.push(`${file}: refreshing={${expr.trim()}}`);
      // A bare identifier (`refreshing={refreshing}`) must not be an alias for a fetch flag:
      // a const/let/var declaration (to the end of its statement, across lines), or a
      // destructured rename such as `const { isRefetching: refreshing } = q`.
      const alias = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr)?.[1];
      if (alias) {
        const decl = new RegExp(`(?:const|let|var)\\s+${alias}\\s*=\\s*([\\s\\S]*?);`).exec(source)?.[1] ?? '';
        if (FETCH_FLAG.test(decl)) offenders.push(`${file}: refreshing={${alias}} where ${alias} = ${decl.trim()}`);
        if (new RegExp(`\\b${FLAG_NAMES}\\s*:\\s*${alias}\\b`).test(source)) {
          offenders.push(`${file}: refreshing={${alias}} where ${alias} is a destructured fetch flag`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every screen with a pull spinner drives it through usePullToRefresh', () => {
    const missing = [...new Set(controls.map((c) => c.file))].filter((file) => {
      const source = strip(readFileSync(join(SRC, file), 'utf8'));
      return !source.includes("from '../../../hooks/usePullToRefresh'") || !/usePullToRefresh\(/.test(source);
    });
    expect(missing).toEqual([]);
  });
});
