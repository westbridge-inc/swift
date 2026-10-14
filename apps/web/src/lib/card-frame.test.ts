import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBrowserContentSecurityPolicy, DEVELOPMENT_BROWSER_API_ORIGIN, RELEASE_BROWSER_API_ORIGIN, STAGING_BROWSER_API_ORIGIN,
} from './browser-api-origin';
import { CARD_FRAME_SANDBOX, cardFrameEnabled, cardFrameSrc } from './card-frame';

// [CARD embed] The bank's card page inside the weekly-fee page. The site frames ONE thing,
// Swift's own API card page, only when the build turns it on; off, nothing changes.
afterEach(() => { vi.unstubAllEnvs(); });

const directives = (csp: string) => csp.split('; ');
/** The production policy exactly as it was before the card page could be embedded. */
const BEFORE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${RELEASE_BROWSER_API_ORIGIN} ${RELEASE_BROWSER_API_ORIGIN.replace('https://', 'wss://')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

describe('the site policy while the embedded card page is off', () => {
  it('is exactly what it was', () => {
    expect(buildBrowserContentSecurityPolicy('production')).toBe(BEFORE);
    expect(buildBrowserContentSecurityPolicy('production', 'production', {})).toBe(BEFORE);
    expect(buildBrowserContentSecurityPolicy('production', 'production', { cardFrame: false })).toBe(BEFORE);
  });
});

describe('the site policy when the build turns the embedded card page on', () => {
  it.each([
    ['production', 'production', RELEASE_BROWSER_API_ORIGIN],
    ['production', 'staging', STAGING_BROWSER_API_ORIGIN],
    ['development', 'production', DEVELOPMENT_BROWSER_API_ORIGIN],
  ] as const)('%s/%s gains only frame-src, naming the site itself and the API origin', (mode, channel, api) => {
    const off = directives(buildBrowserContentSecurityPolicy(mode, channel));
    const on = directives(buildBrowserContentSecurityPolicy(mode, channel, { cardFrame: true }));
    expect(on.filter((d) => !off.includes(d))).toEqual([`frame-src 'self' ${api}`]);
    expect(off.filter((d) => !on.includes(d))).toEqual([]);
    const frame = on.find((d) => d.startsWith('frame-src '))!;
    expect(frame).not.toMatch(/\*|ptranz| https:(\s|$)|http:(\s|$)/);
    expect(on).toContain("frame-ancestors 'none'");
  });
});

describe('the build switch', () => {
  async function config(env: Record<string, string | undefined>) {
    vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    const { default: createNextConfig } = await import('../../next.config');
    const built = createNextConfig(PHASE_PRODUCTION_BUILD);
    const rules = await built.headers!();
    const csp = rules.find((rule) => rule.source === '/(.*)')!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    return { csp, env: built.env ?? {} };
  }
  it('unset (every build today): the policy and the client bundle are unchanged', async () => {
    const off = await config({ SWIFT_WEB_CARD_FRAME: undefined });
    expect(off.csp).toBe(BEFORE);
    expect(off.env).toEqual({ NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN });
    expect((await config({ SWIFT_WEB_CARD_FRAME: 'true' })).csp).toBe(BEFORE);
  });
  it('SWIFT_WEB_CARD_FRAME=1: frame-src names the API origin, and the page is told it may embed', async () => {
    const on = await config({ SWIFT_WEB_CARD_FRAME: '1' });
    expect(on.csp).toBe(buildBrowserContentSecurityPolicy('production', 'production', { cardFrame: true }));
    expect(on.env).toEqual({ NEXT_PUBLIC_API_URL: RELEASE_BROWSER_API_ORIGIN, NEXT_PUBLIC_CARD_FRAME: '1' });
  });
  it('the page reads the same switch', () => {
    expect(cardFrameEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_CARD_FRAME', '1');
    expect(cardFrameEnabled()).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_CARD_FRAME', 'yes');
    expect(cardFrameEnabled()).toBe(false);
  });
});

describe('which card page the site frames', () => {
  const api = 'https://api.example.test';
  it('only a page on the API origin — the one origin the policy lets it frame', () => {
    expect(cardFrameSrc(`${api}/api/v1/billing/card/pay/ptz_0123`, api)).toBe(`${api}/api/v1/billing/card/pay/ptz_0123`);
    expect(cardFrameSrc('https://staging.ptranz.com/hpp', api)).toBeNull();
    expect(cardFrameSrc('https://api.example.test.evil.example/x', api)).toBeNull();
    expect(cardFrameSrc('http://api.example.test/x', api)).toBeNull();
    expect(cardFrameSrc('https://user:pw@api.example.test/x', api)).toBeNull();
    expect(cardFrameSrc('javascript:alert(1)', api)).toBeNull();
    expect(cardFrameSrc('not a url', api)).toBeNull();
  });
  it('the frame sandbox is the card page’s own set, and never lets the frame move this page without a tap', () => {
    expect(CARD_FRAME_SANDBOX.split(' ').sort()).toEqual(['allow-forms', 'allow-popups', 'allow-same-origin', 'allow-scripts', 'allow-top-navigation-by-user-activation']);
  });
});

describe('the frame listens to nothing and hosts nothing of Swift’s own', () => {
  const code = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('card-page-frame.tsx: one sandboxed frame, no field, no message handler, no reading the frame', () => {
    const frame = code('src/components/card-page-frame.tsx');
    expect(frame.match(/<iframe\b/g)).toHaveLength(1);
    expect(frame).toContain('sandbox={CARD_FRAME_SANDBOX}');
    expect(frame).toContain('referrerPolicy="no-referrer"');
    expect(frame).not.toMatch(/<(?:input|textarea|select|form)\b|contentEditable|addEventListener|onmessage|onMessage|postMessage|contentWindow|contentDocument|srcDoc/);
  });
  it('card-pay.tsx frames only through CardPageFrame, only when switched on, else opens the page in this tab', () => {
    const pay = code('src/components/card-pay.tsx');
    expect(pay).not.toMatch(/<iframe\b|addEventListener\('message'|onmessage|postMessage/);
    expect(pay).toContain('const src = cardFrameEnabled() ? cardFrameSrc(url, BROWSER_API_ORIGIN) : null;');
    expect(pay).toContain('if (!src) { window.location.assign(url); return; }');
  });
});
