import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { classifyAdLink } from './ad-link-policy';

// [ADS-ON · 4 Oct ruling] The server walks an ad link's redirects and refuses if they leave the approved
// domain. Swift's server fetches an address an advertiser chose, so the walk is built not to be a way into
// Swift's own network: https only, every hop judged BEFORE it is opened, the name resolved through a lookup
// that refuses any private address at the moment the socket connects (a name cannot pass a check and then
// answer differently), headers only, no body read, a wall clock on every hop.

export const MAX_AD_LINK_REDIRECTS = 5;
const HOP_DEADLINE_MS = 6_000;

export interface AdLinkHop {
  status: number;
  location: string | null;
  contentType: string | null;
  contentDisposition: string | null;
}

export type AdLinkCheckFailure =
  | 'LEFT_APPROVED_DOMAIN'
  | 'INSECURE_REDIRECT'
  | 'BAD_REDIRECT'
  | 'TOO_MANY_REDIRECTS'
  | 'FILE_DOWNLOAD'
  | 'PAGE_GONE'
  | 'PRIVATE_ADDRESS'
  | 'SITE_ERROR'
  | 'UNREACHABLE';

/** `hard`: the link itself is wrong. Soft: the site did not answer properly just now, which can pass by itself. */
export type AdLinkCheck = { ok: true; hops: number } | { ok: false; hard: boolean; reason: AdLinkCheckFailure };

export const AD_LINK_CHECK_WORDS: Record<AdLinkCheckFailure, string> = {
  LEFT_APPROVED_DOMAIN: 'it redirects away from the approved website',
  INSECURE_REDIRECT: 'it redirects to an address that is not safe',
  BAD_REDIRECT: 'its redirect does not lead anywhere',
  TOO_MANY_REDIRECTS: 'it redirects too many times',
  FILE_DOWNLOAD: 'it downloads a file instead of opening a page',
  PAGE_GONE: 'the page no longer exists',
  PRIVATE_ADDRESS: 'the website is not on a public address',
  SITE_ERROR: 'the website answered with an error',
  UNREACHABLE: 'the website did not answer',
};

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
// IPv6 is the other way round: only global unicast is public, less the ranges inside it that tunnel to IPv4 (6to4,
// Teredo) or are documentation. Everything else stays blocked: mapped, compatible, translated, site-local, the rest.
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** Anything that is not provably a public address is blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  return !GLOBAL_IPV6.check(address, 'ipv6') || BLOCKED.check(address, 'ipv6');
}

type LookupAnswer = Array<{ address: string; family: number }>;
type CodedError = Error & { code?: string };
type Resolver = (hostname: string, options: dns.LookupAllOptions, cb: (err: CodedError | null, answers: LookupAnswer) => void) => void;

/** The socket's own name lookup: every answer must be public, or none is used. */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: (err: CodedError | null, address?: string | LookupAnswer, family?: number) => void,
  resolver: Resolver = dns.lookup as unknown as Resolver,
): void {
  resolver(hostname, { all: true }, (err, answers) => {
    if (err) { callback(err); return; }
    if (answers.length === 0 || answers.some((a) => isBlockedAddress(a.address))) {
      callback(Object.assign(new Error('The name resolves to an address the link check does not open.'), { code: 'AD_LINK_PRIVATE_ADDRESS' }));
      return;
    }
    if (options.all) { callback(null, answers); return; }
    const first = answers[0] as { address: string; family: number };
    callback(null, first.address, first.family);
  });
}

/** One request: status and headers only, never the body. */
export function httpsHop(url: string): Promise<AdLinkHop> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      agent: false,
      lookup: publicOnlyLookup as never,
      headers: { 'user-agent': 'SwiftAdLinkCheck/1.0', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    }, (res) => {
      clearTimeout(deadline);
      const { location, 'content-type': contentType, 'content-disposition': contentDisposition } = res.headers;
      res.destroy();
      resolve({ status: res.statusCode ?? 0, location: location ?? null, contentType: contentType ?? null, contentDisposition: contentDisposition ?? null });
    });
    const deadline = setTimeout(() => req.destroy(new Error('The website took too long to answer.')), HOP_DEADLINE_MS);
    req.on('error', (err) => { clearTimeout(deadline); reject(err); });
    req.end();
  });
}

const DOWNLOAD_TYPES = new RegExp(`^(${[
  'binary/octet-stream',
  ...[
    'octet-stream', 'vnd\\.android\\.package-archive', 'java-archive',
    'x-msdownload', 'x-msi', 'x-msdos-program', 'x-dosexec', 'vnd\\.microsoft\\.portable-executable', 'x-executable', 'x-sh',
    'x-apple-diskimage', 'x-iso9660-image', 'x-debian-package', 'vnd\\.debian\\.binary-package', 'x-rpm',
    'zip', 'gzip', 'x-gzip', 'x-tar', 'x-bzip2', 'x-7z-compressed', 'x-rar-compressed', 'vnd\\.rar',
  ].map((type) => `application/${type}`),
].join('|')})\\s*(;|$)`, 'i');

function nextHop(from: string, location: string, approvedHost: string): { url: string } | { failure: AdLinkCheckFailure } {
  let absolute: string;
  try {
    absolute = new URL(location, from).href;
  } catch {
    return { failure: 'BAD_REDIRECT' };
  }
  const verdict = classifyAdLink('URL', absolute);
  if (verdict.ok) {
    if (verdict.kind === 'EXTERNAL' || verdict.kind === 'APP_STORE') {
      return verdict.host === approvedHost ? { url: verdict.value } : { failure: 'LEFT_APPROVED_DOMAIN' };
    }
    return { failure: 'BAD_REDIRECT' };
  }
  if (verdict.reason === 'FILE_DOWNLOAD') return { failure: 'FILE_DOWNLOAD' };
  if (verdict.reason === 'LINK_MALFORMED') return { failure: 'BAD_REDIRECT' };
  if (verdict.reason === 'HTTPS_REQUIRED' || verdict.reason === 'PORT_FORBIDDEN' || verdict.reason === 'CREDENTIALS_FORBIDDEN') return { failure: 'INSECURE_REDIRECT' };
  return { failure: 'LEFT_APPROVED_DOMAIN' };
}

/** Walk one link, once. `approvedHost` is the host key classifyAdLink gave it. */
export async function checkAdLink(url: string, approvedHost: string, deps: { hop?: (url: string) => Promise<AdLinkHop> } = {}): Promise<AdLinkCheck> {
  const hop = deps.hop ?? httpsHop;
  const hard = (reason: AdLinkCheckFailure): AdLinkCheck => ({ ok: false, hard: true, reason });
  const soft = (reason: AdLinkCheckFailure): AdLinkCheck => ({ ok: false, hard: false, reason });
  let current = url;
  for (let hops = 0; ; hops += 1) {
    let answer: AdLinkHop;
    try {
      answer = await hop(current);
    } catch (err) {
      return (err as CodedError).code === 'AD_LINK_PRIVATE_ADDRESS' ? hard('PRIVATE_ADDRESS') : soft('UNREACHABLE');
    }
    if (answer.status >= 300 && answer.status < 400) {
      if (!answer.location) return hard('BAD_REDIRECT');
      if (hops === MAX_AD_LINK_REDIRECTS) return hard('TOO_MANY_REDIRECTS');
      const next = nextHop(current, answer.location, approvedHost);
      if ('failure' in next) return hard(next.failure);
      current = next.url;
      continue;
    }
    if (answer.status === 404 || answer.status === 410) return hard('PAGE_GONE');
    if (answer.status < 200 || answer.status >= 300) return soft('SITE_ERROR');
    if (/^\s*attachment/i.test(answer.contentDisposition ?? '') || DOWNLOAD_TYPES.test(answer.contentType ?? '')) return hard('FILE_DOWNLOAD');
    return { ok: true, hops };
  }
}
