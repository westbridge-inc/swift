import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { swiftDesignVariables as tokens } from '@/lib/design-tokens';

// ---------------------------------------------------------------------------
// [W7] The pages a person reaches from outside the app — a parcel's tracking
// link, a shared trip, the return from MMG — draw in Swift's own colours from
// the design tokens, never a hand-typed hex that drifts from the brand.
// ---------------------------------------------------------------------------

const SRC = join(__dirname);
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('[W7] trust pages use the design tokens', () => {
  it.each(['app/track', 'app/trip', 'app/pay/mmg', 'components/tile-map.tsx'])('%s holds no hand-typed colour', (where) => {
    const path = join(SRC, where);
    const files = statSync(path).isDirectory() ? sources(path) : [path];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/);
    }
  });

  it('the MMG return page is drawn in the tokens’ colours', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const { GET } = await import('@/app/pay/mmg/[...path]/route');
    const response = await GET(new Request('https://example.test/pay/mmg/success'), { params: Promise.resolve({ path: ['success'] }) });
    const html = await response.text();
    for (const token of ['--swift-canvas', '--swift-ink', '--swift-red'] as const) expect(html).toContain(String(tokens[token]));
    vi.unstubAllGlobals();
  });
});
