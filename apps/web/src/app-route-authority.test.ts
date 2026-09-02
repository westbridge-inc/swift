import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = process.cwd();
const APP_ROOT = join(WEB_ROOT, 'src/app');
const NEXT_DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'] as const;

function source(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf8');
}

function appRouteCollisions(
  directory: string = APP_ROOT,
  collisions: string[] = [],
): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));

  const hasPage = NEXT_DEFAULT_PAGE_EXTENSIONS.some((extension) =>
    names.has(`page.${extension}`),
  );
  const hasRoute = NEXT_DEFAULT_PAGE_EXTENSIONS.some((extension) =>
    names.has(`route.${extension}`),
  );

  if (hasPage && hasRoute) {
    collisions.push(relative(WEB_ROOT, directory).split(sep).join('/'));
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      appRouteCollisions(join(directory, entry.name), collisions);
    }
  }

  return collisions;
}

describe('public-web App Router route authority', () => {
  it('keeps the guard bound to the configured Next extensions', () => {
    expect(
      source('next.config.ts'),
      'update this guard in the same change if next.config overrides pageExtensions',
    ).not.toMatch(/\bpageExtensions\s*:/);
  });

  it('has one terminal authority per segment and retains the static legal pages', () => {
    expect(appRouteCollisions().sort()).toEqual([]);

    const privacyPage = source('src/app/legal/privacy/page.tsx');
    const termsPage = source('src/app/legal/terms/page.tsx');
    const sitemap = source('src/app/sitemap.ts');
    const navigation = source('src/components/site.tsx');

    expect(privacyPage).toContain(
      "import { LegalDocument, legalMetadata } from '@/components/legal-document';",
    );
    expect(privacyPage).toContain(
      "import { PRIVACY_BODY } from '@/legal/generated';",
    );
    expect(privacyPage).toContain('html={PRIVACY_BODY}');
    expect(privacyPage).toContain("'/legal/privacy'");

    expect(termsPage).toContain(
      "import { LegalDocument, legalMetadata } from '@/components/legal-document';",
    );
    expect(termsPage).toContain(
      "import { TERMS_BODY } from '@/legal/generated';",
    );
    expect(termsPage).toContain('html={TERMS_BODY}');
    expect(termsPage).toContain("'/legal/terms'");

    expect(sitemap.match(/path: '\/legal\/privacy'/g)).toHaveLength(1);
    expect(sitemap.match(/path: '\/legal\/terms'/g)).toHaveLength(1);
    expect(navigation.match(/href="\/legal\/privacy"/g)).toHaveLength(1);
    expect(navigation.match(/href="\/legal\/terms"/g)).toHaveLength(1);

    expect(
      existsSync(join(APP_ROOT, 'legal/privacy/route.ts')),
    ).toBe(false);
    expect(
      existsSync(join(APP_ROOT, 'legal/terms/route.ts')),
    ).toBe(false);
  });
});
