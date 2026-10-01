import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { site } from '@/site.config';

// ---------------------------------------------------------------------------
// [SITE-1.1 Part 3] "Every company fact on swiftgy.com is read from this
// object ... grep for any of them and this file is the only hit." — said in
// site.config.ts, and until now enforced by nobody. The card bank now reads
// these facts too, so a copy that drifts from the one the bank was shown is a
// misstatement, not a typo.
//
// [SITE-1.1 Part 2] IDENTITY LAW: the company speaks as the company. Naming
// the person this law protects in a test would break the law in a public
// repository, so the guard checks its shape instead: the only author, creator
// and publisher is the company, the structured data describes an organisation
// and nobody else, and no public page speaks of a founder.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const CONFIG = join(SRC, 'site.config.ts');

/** Shipped site source: tests, the test kit and the API-authored legal snapshot excluded. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(SRC, 'test')) walk(path);
      } else if (/\.(ts|tsx|js|jsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name) && path !== CONFIG && path !== join(SRC, 'legal', 'generated.ts')) {
        out.push(path);
      }
    }
  };
  walk(SRC);
  return out;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The guarded facts, read from the real config. A missing one is reported by
 *  the first test below, never turned into a pattern. */
const GUARDED = {
  'legal entity name': site.legalEntityName,
  address: site.address,
  phone: site.phone,
  'support e-mail': site.supportEmail,
  'second trade name': (site as Record<string, unknown>)['tradeNameAlt'],
} as const;

const defined = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Each company fact, and the shapes a hand-typed copy of it would take. */
const FACTS: Array<[string, RegExp]> = [
  ...(defined(GUARDED['legal entity name']) ? [['legal entity name', new RegExp(escape(GUARDED['legal entity name'].split(/\s+/)[0]!), 'i')] as [string, RegExp]] : []),
  ...(defined(GUARDED.address) ? [
    ['address', new RegExp(escape(GUARDED.address), 'i')] as [string, RegExp],
    ...GUARDED.address.split(/\s+/).filter((word) => /^[A-Z][a-z]{5,}$/.test(word) && !['Georgetown', 'Guyana', 'Building', 'Street'].includes(word))
      .map((word): [string, RegExp] => [`address (${word})`, new RegExp(`\\b${escape(word)}\\b`)]),
  ] : []),
  ...(defined(GUARDED.phone) ? [['phone', new RegExp(GUARDED.phone.replace(/\D/g, '').slice(-7).replace(/^(\d{3})(\d{4})$/, '$1[\\s.-]?$2'))] as [string, RegExp]] : []),
  ...(defined(GUARDED['support e-mail']) ? [['support e-mail', new RegExp(escape(GUARDED['support e-mail']), 'i')] as [string, RegExp]] : []),
  ...(defined(GUARDED['second trade name']) ? [['second trade name', new RegExp(`\\b${escape(GUARDED['second trade name'])}\\b`)] as [string, RegExp]] : []),
];

describe('[SITE-1.1 Part 3] every company fact lives in site.config.ts and nowhere else', () => {
  it('the guard knows every fact it is guarding', () => {
    for (const [name, value] of Object.entries(GUARDED)) expect(defined(value), `site.config.ts has no ${name}`).toBe(true);
    for (const [name, pattern] of FACTS) expect(readFileSync(CONFIG, 'utf8'), `${name} is in site.config.ts`).toMatch(pattern);
  });

  it('no shipped source file types a company fact by hand', () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const code = readFileSync(file, 'utf8');
      code.split('\n').forEach((line, i) => {
        for (const [name, pattern] of FACTS) {
          if (pattern.test(line)) offenders.push(`${relative(SRC, file).split(sep).join('/')}:${i + 1} — ${name}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('[SITE-1.1 Part 2] the identity law: the company is the only author', () => {
  it('the site metadata names the company as author, creator and publisher', async () => {
    const { metadata } = await import('@/app/layout');
    expect(metadata.authors).toEqual([{ name: site.legalEntityName }]);
    expect(metadata.creator).toBe(site.legalEntityName);
    expect(metadata.publisher).toBe(site.legalEntityName);
  });

  it('the structured data describes an organisation, and no person', async () => {
    const { default: AboutPage } = await import('@/app/(marketing)/about/page');
    const { container } = render(<AboutPage />);
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? '');
    expect(blocks.length).toBeGreaterThan(0);
    for (const json of blocks) {
      const data = JSON.parse(json) as Record<string, unknown>;
      expect(data['@type']).toBe('Organization');
      expect(data['legalName']).toBe(site.legalEntityName);
      expect(json).not.toMatch(/"Person"|founder|"author"|"employee"/i);
    }
  });

  it('no public page or footer speaks of a founder', async () => {
    const pages = [
      '@/app/(marketing)/about/page', '@/app/(marketing)/contact/page', '@/app/(marketing)/welcome/page',
      '@/app/legal/refunds/page', '@/app/legal/delivery/page',
    ];
    const { SiteFooter } = await import('@/components/site');
    const { container } = render(<SiteFooter />);
    expect(container.textContent).not.toMatch(/\bfounders?\b/i);
    for (const path of pages) {
      const { default: Page } = (await import(/* @vite-ignore */ path)) as { default: () => React.ReactNode };
      const view = render(<>{Page()}</>);
      expect(view.container.textContent, path).not.toMatch(/\bfounders?\b/i);
      view.unmount();
    }
  });
});
