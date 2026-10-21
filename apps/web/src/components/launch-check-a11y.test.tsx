import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { swiftDesignVariables } from '@/lib/design-tokens';
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

  it('every soft-pink panel turns its grey text into the panel grey, so no page has to remember', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const rule = css.match(/\.bg-\\\[var\\\(--swift-subtle\\\)\\\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/--swift-muted:\s*var\(--swift-muted-on-subtle\);/);
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
