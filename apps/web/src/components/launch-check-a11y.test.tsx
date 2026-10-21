import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { swiftDesignVariables } from '@/lib/design-tokens';
import { VERTICAL_TINT } from '../../../mobile/src/kit/vertical-tint';
import { DataUnavailable } from './data-unavailable';
import { TabBar } from './customer-shell';
import { OrderingContextBar } from './ordering-context-bar';

// ---------------------------------------------------------------------------
// [WEB-LAUNCH-CHECK F2 / F3 / F4] Accessibility fails found on the open site
// before launch (WCAG 2.1 AA):
// F2 grey text on the soft-pink panels (legal footers, /contact cards, partner
//    notes) was 4.32:1; it needs 4.5:1.
// F3 the phone tab bar's inactive labels used the placeholder grey, 3.42:1.
// F4 the delivery/pickup pill's spoken name did not contain the words it shows
//    (it said "as soon as possible" for "ASAP"; voice-control users could not
//    say what they saw).
// ---------------------------------------------------------------------------

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const token = (name: string) => {
  const value = (swiftDesignVariables as Record<string, string>)[name];
  expect(value, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
  return value!;
};

describe('[F2] grey text on the soft-pink panel reads at 4.5:1 or more', () => {
  it('the panel grey meets 4.5:1 on the panel, and stays a grey (lighter than ink)', () => {
    expect(contrast(token('--swift-muted-on-subtle'), token('--swift-subtle'))).toBeGreaterThanOrEqual(4.5);
    expect(luminance(token('--swift-muted-on-subtle'))).toBeGreaterThan(luminance(token('--swift-ink')));
  });

  // [REVIEW-F2 #1962 S3-1] The same pink is also painted as --swift-red-50 (the
  // "Couldn't load" panel, selected options, notices), and the storefront tints
  // (--swift-vertical-bg) are as light. Every tinted panel gets the panel grey.
  const TINTS = ['red-50', 'subtle', 'vertical-bg'];
  const escaped = (t: string) => `.bg-\\[var\\(--swift-${t}\\)\\]`;

  it('the panel grey meets 4.5:1 on every tint a panel can be painted', () => {
    const tints = [token('--swift-red-50'), token('--swift-subtle'), ...Object.values(VERTICAL_TINT).map((t) => t!.bg)];
    for (const bg of tints) expect(contrast(token('--swift-muted-on-subtle'), bg), bg).toBeGreaterThanOrEqual(4.5);
  });

  it('every tint utility class turns grey text into the panel grey', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([sel, , body]) => sel!.includes('.bg-\\[var') && /--swift-muted:\s*var\(--swift-muted-on-subtle\)/.test(body!));
    const selectors = (rule?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.trim());
    for (const t of TINTS) expect(selectors, t).toContain(escaped(t).replace(/\\\\/g, '\\'));
  });

  it('every stylesheet block that paints a tint (not just on hover) turns its grey text into the panel grey', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.css') ? [join(dir, n)] : []));
    const missing: string[] = [];
    for (const file of files(join(process.cwd(), 'src'))) {
      for (const [, selector, body] of readFileSync(file, 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(^|;|\s)background(-color)?:\s*var\(--swift-(red-50|subtle|vertical-bg)\)/.test(body!) || /:(hover|active|focus)/.test(selector!)) continue;
        if (!/--swift-muted:\s*var\(--swift-muted-on-subtle\)/.test(body!)) missing.push(`${file.split('/src/')[1]} ${selector!.replace(/\/\*[\s\S]*?\*\//g, '').trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the "Couldn\'t load" panel paints a covered tint, so its grey error detail reads at 4.5:1', () => {
    render(<DataUnavailable what="your orders" error={new Error('Network request failed')} />);
    const detail = screen.getByText('Network request failed');
    expect(detail.className).toContain('text-[var(--swift-muted)]');
    const panel = detail.closest('[role="status"]')!;
    expect(TINTS.some((t) => panel.className.split(/\s+/).includes(`bg-[var(--swift-${t})]`)), panel.className).toBe(true);
  });

  it('the neutral status pill (grey on the line colour) reads at 4.5:1', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const body = css.match(/\.sw-status-neutral\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/background:\s*var\(--swift-border\)/);
    const fg = body.match(/(?:^|;)\s*color:\s*var\((--swift-[a-z-]+)\)/)?.[1] ?? '';
    expect(contrast(token(fg), token('--swift-border')), fg).toBeGreaterThanOrEqual(4.5);
  });

  it('the plain grey still meets 4.5:1 on the white card and the page', () => {
    for (const bg of ['--swift-card', '--swift-canvas', '--swift-sunken']) expect(contrast(token('--swift-muted'), token(bg)), bg).toBeGreaterThanOrEqual(4.5);
  });
});

describe('[F3] the phone tab bar labels are readable text, not placeholder grey', () => {
  it('an inactive tab label uses the 4.5:1 grey', () => {
    render(<TabBar activeTab="home" marketVisible cartCount={0} />);
    const nav = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') !== 'page');
    expect(nav.length).toBeGreaterThan(0);
    for (const link of nav) {
      expect(link.className, link.textContent ?? '').toContain('text-[var(--swift-muted)]');
      expect(link.className, link.textContent ?? '').not.toContain('--swift-muted-soft');
    }
    expect(contrast(token('--swift-muted'), token('--swift-card'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('[F4] the delivery/pickup pill is named by the words it shows', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

  const cases: [string, Parameters<typeof OrderingContextBar>[0]][] = [
    ['the full bar', {}],
    ['Home, with an address', { inline: true, deliverTo: '12 Main St' }],
    ['Home, no address yet', { inline: true }],
  ];
  const words = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  it.each(cases)('%s: no separate spoken name; the name starts with the words the pill shows', (_label, props) => {
    render(<OrderingContextBar {...props} />);
    let name = '';
    const trigger = screen.getByRole('button', { name: (n) => { if (/Change delivery or pickup/.test(n)) { name = n; return true; } return false; } });
    expect(trigger.getAttribute('aria-label')).toBeNull();
    // Words hidden on a phone stay in the name (visually hidden, never display:none).
    for (const el of trigger.querySelectorAll('span')) expect(el.className.split(/\s+/), el.textContent ?? '').not.toContain('hidden');
    const shown = [...trigger.querySelectorAll('span')].filter((el) => !el.className.split(/\s+/).includes('sr-only') || el.className.includes('wide:not-sr-only')).map((el) => el.textContent ?? '').join(' ');
    expect(words(shown)).not.toBe('');
    expect(words(name).startsWith(words(shown)), `name "${name}" vs shown "${shown}"`).toBe(true);
  });

  it('says ASAP as shown (not "as soon as possible")', () => {
    render(<OrderingContextBar inline deliverTo="12 Main St" />);
    expect(screen.getByRole('button', { name: /^Delivery 12 Main St ASAP ?\. Change delivery or pickup$/ })).toBeTruthy();
  });
});
