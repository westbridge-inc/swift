import { SITE_DOMAIN } from '@/site.domain';
import { launch, type LaunchState } from '@/site.config';

/**
 * [Item 7] Where the pre-launch switch applies.
 *
 * The public site is the canonical domain and its www alias. When swiftgy.com
 * is served by the same web container as staging.swiftgy.com (the deploy
 * stack's alias hosts), one build answers both — so the switch cannot be "on
 * for this image" alone: it must also know which site the visitor asked for.
 * Every other host (staging, a preview, a local run) keeps the full
 * marketplace, whatever the switch says, so testing never stops.
 *
 * A request that names no host is treated as the public site: closed is the
 * safe answer when we cannot tell.
 */
export const PUBLIC_SITE_HOSTS: readonly string[] = [SITE_DOMAIN, `www.${SITE_DOMAIN}`];

/** Is this one of the public site's names (the only hosts the switch governs)? */
export function isPublicSiteHost(host: string | null | undefined): boolean {
  const name = siteHost(host);
  return name === '' || PUBLIC_SITE_HOSTS.includes(name);
}

/** Lower-case, without a port or a trailing dot: "Example.COM.:443" → "example.com". */
export function siteHost(host: string | null | undefined): string {
  return (host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** May a customer order on this host, given the public site's switch (lib/launch-switch.ts)? */
export function webOrderingOpen(host: string | null | undefined, state: LaunchState): boolean {
  return !isPublicSiteHost(host) || state === 'live';
}

/** Where the market is, for the front door's headline: "Georgetown, Guyana" → "Georgetown".
 *  A function, so importing this module never reads the launch config. */
export function launchCity(): string {
  return (launch.markets[0] ?? '').split(',')[0]!.trim();
}
