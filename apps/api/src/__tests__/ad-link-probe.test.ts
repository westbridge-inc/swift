import { describe, expect, it } from 'vitest';
import { checkAdLink, isBlockedAddress, publicOnlyLookup, type AdLinkHop } from '../modules/ads/ad-link-probe';

const hops = (table: Record<string, AdLinkHop | Error>) => {
  const seen: string[] = [];
  const hop = async (url: string): Promise<AdLinkHop> => {
    seen.push(url);
    const r = table[url];
    if (!r) throw new Error(`unexpected hop ${url}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { hop, seen };
};
const page: AdLinkHop = { status: 200, location: null, contentType: 'text/html; charset=utf-8', contentDisposition: null };
const to = (location: string, status = 301): AdLinkHop => ({ status, location, contentType: null, contentDisposition: null });

// [ADS-ON · 4 Oct ruling] At approval the server follows the link's redirects and refuses if they leave the approved domain.
describe('checkAdLink: following the redirects of one link', () => {
  it('a page that answers is fine', async () => {
    const { hop } = hops({ 'https://example.gy/a': page });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: true, hops: 0 });
  });

  it('www and back stay on the approved domain, relative redirects included', async () => {
    const { hop, seen } = hops({
      'https://example.gy/a': to('https://www.example.gy/a'),
      'https://www.example.gy/a': to('/b'),
      'https://www.example.gy/b': page,
    });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: true, hops: 2 });
    expect(seen).toHaveLength(3);
  });

  it.each([
    ['https://evil.example/a', 'LEFT_APPROVED_DOMAIN'],
    ['https://example.gy.evil.example/a', 'LEFT_APPROVED_DOMAIN'],
    ['https://shop.example.gy/a', 'LEFT_APPROVED_DOMAIN'],
    ['http://example.gy/a', 'INSECURE_REDIRECT'],
    ['https://example.gy:8443/a', 'INSECURE_REDIRECT'],
    ['https://bit.ly/a', 'LEFT_APPROVED_DOMAIN'],
    ['https://example.gy/a.apk', 'FILE_DOWNLOAD'],
    ['intent://x', 'INSECURE_REDIRECT'],
    ['https://user@example.gy/a', 'INSECURE_REDIRECT'],
  ])('a redirect to %s is refused without opening it: %s', async (location, reason) => {
    const { hop, seen } = hops({ 'https://example.gy/start': to(location) });
    expect(await checkAdLink('https://example.gy/start', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason });
    expect(seen).toEqual(['https://example.gy/start']);
  });

  it('a redirect loop or a long chain is refused', async () => {
    const { hop, seen } = hops({ 'https://example.gy/a': to('https://example.gy/b'), 'https://example.gy/b': to('https://example.gy/a') });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'TOO_MANY_REDIRECTS' });
    expect(seen.length).toBeLessThanOrEqual(6);
  });

  it('a redirect with no target is refused', async () => {
    const { hop } = hops({ 'https://example.gy/a': { status: 302, location: null, contentType: null, contentDisposition: null } });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'BAD_REDIRECT' });
  });

  it.each([
    [{ ...page, contentType: 'application/vnd.android.package-archive' }],
    [{ ...page, contentType: 'application/octet-stream' }],
    [{ ...page, contentType: 'application/x-msdownload' }],
    [{ ...page, contentDisposition: 'attachment; filename="x.pdf"' }],
  ])('a file download is refused: %j', async (answer) => {
    const { hop } = hops({ 'https://example.gy/a': answer });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'FILE_DOWNLOAD' });
  });

  it.each([[404], [410]])('a page that is gone (%i) is a hard failure', async (status) => {
    const { hop } = hops({ 'https://example.gy/a': { ...page, status } });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'PAGE_GONE' });
  });

  it.each([[500], [503], [403], [429]])('a site error (%i) can pass by itself: a soft failure', async (status) => {
    const { hop } = hops({ 'https://example.gy/a': { ...page, status } });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop })).toEqual({ ok: false, hard: false, reason: 'SITE_ERROR' });
  });

  it('no answer is a soft failure; a private address is a hard one', async () => {
    const down = hops({ 'https://example.gy/a': new Error('timeout') });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop: down.hop })).toEqual({ ok: false, hard: false, reason: 'UNREACHABLE' });
    const inner = hops({ 'https://example.gy/a': Object.assign(new Error('blocked'), { code: 'AD_LINK_PRIVATE_ADDRESS' }) });
    expect(await checkAdLink('https://example.gy/a', 'example.gy', { hop: inner.hop })).toEqual({ ok: false, hard: true, reason: 'PRIVATE_ADDRESS' });
  });
});

describe('the probe never reaches inside Swift\'s network', () => {
  it.each([
    '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '64:ff9b::7f00:1', '::127.0.0.1', '::10.0.0.1', '2002:7f00:1::', '2002:a00:1::', '2001:0:7f00:1::', '64:ff9b:1::7f00:1', 'fec0::1',
    '::ffff:0:7f00:1', '192.88.99.1', '2001:db8::1', 'not-an-address',
  ])('%s is blocked', (address) => { expect(isBlockedAddress(address)).toBe(true); });

  it.each(['8.8.8.8', '190.80.1.1', '172.32.0.1', '2606:4700:4700::1111'])('%s is public', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  const run = (answers: Array<{ address: string; family: number }>, all: boolean) => new Promise<{ err: (Error & { code?: string }) | null; a?: unknown; f?: number }>((resolve) => {
    const resolver = (_h: string, _o: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) => cb(null, answers);
    publicOnlyLookup('example.gy', { all }, (err, a, f) => resolve({ err, a, f }), resolver as never);
  });

  it('a name with one private answer among public ones is refused', async () => {
    const r = await run([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], true);
    expect(r.err?.code).toBe('AD_LINK_PRIVATE_ADDRESS');
  });

  it('a public name answers in the shape the socket asked for', async () => {
    const one = await run([{ address: '8.8.8.8', family: 4 }], false);
    expect(one).toEqual({ err: null, a: '8.8.8.8', f: 4 });
    const all = await run([{ address: '8.8.8.8', family: 4 }], true);
    expect(all.err).toBeNull();
    expect(all.a).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });
});
