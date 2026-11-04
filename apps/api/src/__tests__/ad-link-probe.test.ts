import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { checkAdLink, httpsHop, isBlockedAddress, publicOnlyLookup, type AdLinkHop } from '../modules/ads/ad-link-probe';

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

  // [REVIEW-G9 B1] An extensionless path is judged by what the server says it is. S3's default type is the first row.
  it.each([
    'binary/octet-stream', 'BINARY/OCTET-STREAM', 'application/octet-stream; charset=binary',
    'application/x-msdos-program', 'application/vnd.microsoft.portable-executable', 'application/x-dosexec',
    'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/x-bzip2',
    'application/x-debian-package', 'application/vnd.debian.binary-package', 'application/x-rpm', 'application/vnd.rar', 'application/x-iso9660-image',
  ])('/download served as %s is a file, not a page', async (contentType) => {
    const { hop } = hops({ 'https://example.gy/download': { ...page, contentType } });
    expect(await checkAdLink('https://example.gy/download', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'FILE_DOWNLOAD' });
  });

  it.each(['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'TEXT/HTML'])('%s is a page', async (contentType) => {
    const { hop } = hops({ 'https://example.gy/download': { ...page, contentType } });
    expect(await checkAdLink('https://example.gy/download', 'example.gy', { hop })).toEqual({ ok: true, hops: 0 });
  });

  it('a redirect to a file dressed up is refused without opening it', async () => {
    const { hop, seen } = hops({ 'https://example.gy/start': to('/app.apk;v=1') });
    expect(await checkAdLink('https://example.gy/start', 'example.gy', { hop })).toEqual({ ok: false, hard: true, reason: 'FILE_DOWNLOAD' });
    expect(seen).toEqual(['https://example.gy/start']);
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

  it('no answer at all is a refusal, not a crash', async () => {
    const r = await run([], false);
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

// [REVIEW-G9 B2] The suites above fake the hop. These two go through the real socket path: a fake can never show
// that the guard is wired to the connection, or that a silent website is ever let go of.
describe('the real request', () => {
  const listening = async (onSocket: (socket: net.Socket) => void) => {
    const server = net.createServer(onSocket);
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', () => ready()); });
    return { server, port: (server.address() as net.AddressInfo).port };
  };

  it('a name that resolves to a private address never reaches a socket', async () => {
    let connections = 0;
    const { server, port } = await listening((socket) => { connections += 1; socket.destroy(); });
    const answer = await httpsHop(`https://localhost:${port}/`).catch((err: Error & { code?: string }) => err.code);
    server.close();
    expect(answer).toBe('AD_LINK_PRIVATE_ADDRESS');
    expect(connections).toBe(0);
  });

  it('a website that accepts the connection and then says nothing is let go of at the deadline', async () => {
    const open: net.Socket[] = [];
    const { server, port } = await listening((socket) => { open.push(socket); socket.on('error', () => {}); });
    const started = Date.now();
    const outcome = await Promise.race([
      httpsHop(`https://127.0.0.1:${port}/`).then(() => 'answered', () => 'dropped'),
      new Promise((resolve) => { setTimeout(() => resolve('still hanging'), 9_000); }),
    ]);
    for (const socket of open) socket.destroy();
    server.close();
    expect(outcome).toBe('dropped');
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);
});
