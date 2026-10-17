import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TabBar } from './customer-shell';
import { SectionHead } from './order-ui';

// PERF #5 (15 Oct): every page with the customer frame asked the server to
// FULLY render pages in the background (`prefetch={true}`), including the
// dynamic Market and browse pages, each a server render that also calls the
// API. Home alone fired 14 background page loads. Links now use the default:
// a static page is still prefetched in full, a dynamic page only down to its
// loading screen, so a tap still shows the next screen at once.

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('customer links never force a full background render (PERF #5)', () => {
  it('the phone dock prefetches by default, not in full', () => {
    render(<TabBar activeTab="home" marketVisible cartCount={0} />);
    const links = within(screen.getByRole('navigation', { name: 'Swift tabs' })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/market', '/cart', '/account']);
    for (const link of links) expect(link.getAttribute('data-prefetch'), link.getAttribute('href') ?? '').toBeNull();
  });

  it('a section "See all" link prefetches by default, not in full', () => {
    render(<SectionHead id="t" title="Restaurants open now" seeAll={{ href: '/order/browse?type=RESTAURANT' }} />);
    expect(screen.getByRole('link', { name: 'See all' }).getAttribute('data-prefetch')).toBeNull();
  });

  it('no web source file asks for a full prefetch', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => /prefetch=\{\s*true\s*\}|prefetch\s*=\s*["']true["']/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
