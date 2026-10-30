import { apiFetch } from './auth';

/** The server's switches the web reads before offering a door. Advertising is
 *  off at launch; anything but a literal `true` reads as off.
 *  (Its own module, CI perf #2220: the Switch app sheet in every shell's first load needs only this, not the
 *  advertiser and notification reads of lib/partner-api.) */
export async function getCapabilities(): Promise<{ adsEnabled: boolean }> {
  const r = await apiFetch('/api/v1/public/capabilities');
  return { adsEnabled: r.data?.adsEnabled === true };
}
