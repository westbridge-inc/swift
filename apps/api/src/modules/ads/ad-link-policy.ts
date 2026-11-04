import { isIP } from 'node:net';

// [ADS-ON · 4 Oct ruling, audit MASTER-005] What an ad may open, judged from the link alone: no network,
// no allow-list. Ads may always link inside Swift. An outside link is https on a public name; never a URL
// shortener, an address or a file download. App store links go only to apps.apple.com and
// play.google.com, one app at a time. The domain's human approval and the redirect check sit on top
// (ad-link.service.ts): this file decides what is even worth asking a person about.

export const AD_LINK_MAX_LENGTH = 500;

export type AdLinkRefusal =
  | 'LINK_MISSING'
  | 'LINK_MALFORMED'
  | 'HTTPS_REQUIRED'
  | 'CREDENTIALS_FORBIDDEN'
  | 'PORT_FORBIDDEN'
  | 'IP_OR_LOCAL_HOST'
  | 'PUNYCODE_HOST'
  | 'URL_SHORTENER'
  | 'FILE_DOWNLOAD'
  | 'APP_STORE_PATH'
  | 'NOT_A_SWIFT_LINK';

export type AdLinkVerdict =
  | { ok: true; kind: 'NONE' }
  | { ok: true; kind: 'INSIDE_SWIFT'; value: string }
  | { ok: true; kind: 'EXTERNAL'; value: string; host: string }
  | { ok: true; kind: 'APP_STORE'; value: string; host: string }
  | { ok: false; reason: AdLinkRefusal };

/** What the advertiser reads when a link is refused. */
export const AD_LINK_REFUSAL_WORDS: Record<AdLinkRefusal, string> = {
  LINK_MISSING: 'Add the link, or leave the ad without one.',
  LINK_MALFORMED: 'That link is not a full web address. Use one like https://your-site.gy/offer.',
  HTTPS_REQUIRED: 'An ad link must start with https://.',
  CREDENTIALS_FORBIDDEN: 'An ad link cannot carry a user name or password.',
  PORT_FORBIDDEN: 'An ad link cannot name a port.',
  IP_OR_LOCAL_HOST: 'An ad link must use a public website name, not a number or a local name.',
  PUNYCODE_HOST: 'An ad link must use a plain website name.',
  URL_SHORTENER: 'An ad link cannot be a shortened link. Use the full address of your page.',
  FILE_DOWNLOAD: 'An ad link cannot download a file. Link to a page instead.',
  APP_STORE_PATH: 'An app store link must open one app, on apps.apple.com or play.google.com.',
  NOT_A_SWIFT_LINK: 'A link inside Swift must open a store.',
};

/** General-purpose shorteners: where they land is whatever the owner of the short link says today. */
const URL_SHORTENERS = new Set([
  'adf.ly', 'bit.do', 'bit.ly', 'bitly.com', 'bl.ink', 'buff.ly', 'clck.ru', 'cutt.ly', 'dub.sh', 'goo.gl', 'is.gd', 'lnkd.in',
  'ow.ly', 'qr.ae', 'rb.gy', 'rebrand.ly', 's.id', 'short.io', 'shorte.st', 'shorturl.at', 'snip.ly', 'soo.gd', 't.co', 't.ly',
  'tiny.cc', 'tiny.one', 'tinyurl.com', 'trib.al', 'urlz.fr', 'v.gd',
]);

const DOWNLOAD_EXTENSION = /\.(7z|aab|apk|apks|appimage|bat|bin|cmd|deb|dmg|exe|gz|img|ipa|iso|jar|msi|msix|pkg|ps1|rar|rpm|scr|sh|tar|torrent|vbs|xapk|zip)$/i;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa'] as const;
const PUBLIC_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

// The two shapes the app's link parser opens (mobile lib/deepLinkParse.ts): a store and a printed short code.
const SWIFT_STORE = /^swift:\/\/store\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SWIFT_SHORT = /^swift:\/\/s\/[23456789bcdfghjkmnpqrstvwxyz]{10}$/i;

const APPLE_APP_PATH = /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id\d+\/?$/;
const PLAY_PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

function refuse(reason: AdLinkRefusal): AdLinkVerdict {
  return { ok: false, reason };
}

function isLocalOrAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 || host.endsWith('.') || !host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function pathIsDownload(pathname: string): boolean | null {
  try {
    return DOWNLOAD_EXTENSION.test(decodeURIComponent(pathname));
  } catch {
    return null;
  }
}

function classifyAppStore(parsed: URL, host: string): AdLinkVerdict {
  const oneApp = host === 'apps.apple.com'
    ? APPLE_APP_PATH.test(parsed.pathname)
    : parsed.pathname === '/store/apps/details' && PLAY_PACKAGE.test(parsed.searchParams.get('id') ?? '');
  return oneApp ? { ok: true, kind: 'APP_STORE', value: parsed.href, host } : refuse('APP_STORE_PATH');
}

function classifyOutside(value: string): AdLinkVerdict {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse('LINK_MALFORMED');
  }
  if (parsed.protocol !== 'https:') return refuse('HTTPS_REQUIRED');
  if (parsed.username || parsed.password) return refuse('CREDENTIALS_FORBIDDEN');
  if (parsed.port) return refuse('PORT_FORBIDDEN');
  const hostname = parsed.hostname.toLowerCase();
  if (isLocalOrAddress(hostname)) return refuse('IP_OR_LOCAL_HOST');
  if (hostname.split('.').some((label) => label.startsWith('xn--'))) return refuse('PUNYCODE_HOST');
  if (!PUBLIC_NAME.test(hostname)) return refuse('IP_OR_LOCAL_HOST');
  const host = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  if (URL_SHORTENERS.has(host)) return refuse('URL_SHORTENER');
  if (host === 'apps.apple.com' || host === 'play.google.com') return classifyAppStore(parsed, host);
  const download = pathIsDownload(parsed.pathname);
  if (download === null) return refuse('LINK_MALFORMED');
  if (download) return refuse('FILE_DOWNLOAD');
  return { ok: true, kind: 'EXTERNAL', value: parsed.href, host };
}

/** Pure. The returned value is what is stored and opened: the parser's own reading of what was typed. */
export function classifyAdLink(type: 'NONE' | 'URL' | 'DEEPLINK', raw: string | null | undefined): AdLinkVerdict {
  if (type === 'NONE') return { ok: true, kind: 'NONE' };
  const value = (raw ?? '').trim();
  if (!value) return refuse('LINK_MISSING');
  // A backslash, a space or a control character is read differently by different URL parsers: the server
  // must check exactly what the phone will open.
  // eslint-disable-next-line no-control-regex
  if (value.length > AD_LINK_MAX_LENGTH || /[\s\\\u0000-\u001f\u007f]/.test(value)) return refuse('LINK_MALFORMED');
  if (type === 'DEEPLINK') {
    return SWIFT_STORE.test(value) || SWIFT_SHORT.test(value) ? { ok: true, kind: 'INSIDE_SWIFT', value } : refuse('NOT_A_SWIFT_LINK');
  }
  return classifyOutside(value);
}

/** The statusReason a failed link check pauses a campaign with: Swift's pause, lifted only by a passing check. */
export const LINK_PAUSE_PREFIX = 'Swift paused: link check: ';

export interface AdLinkFields {
  destinationType: 'NONE' | 'URL' | 'DEEPLINK';
  destinationValue: string | null;
  destinationApprovedAt: Date | null;
}

/** The serve gate. An ad with a link serves only if a person approved that link, and an outside website is
 *  still on the allow-list at this moment. Nothing that reaches a phone gets past this. */
export function adLinkServable(row: AdLinkFields, approvedHosts: ReadonlySet<string>): boolean {
  const verdict = classifyAdLink(row.destinationType, row.destinationValue);
  if (!verdict.ok) return false;
  if (verdict.kind === 'NONE') return true;
  if (row.destinationApprovedAt === null) return false;
  return verdict.kind === 'EXTERNAL' ? approvedHosts.has(verdict.host) : true;
}
