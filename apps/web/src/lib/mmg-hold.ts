/**
 * [owner 30 Oct 2026 · "do what's best for MMG"] The website's words for how long a new MMG pay link waits before it
 * goes live. The hours are the server's (`mmgPayUrlHoldHours` on the driver profile): the cool-off (24 h by default);
 * the 1-hour first hold is for a store's first MMG number only. Nothing is computed
 * here; an older server that sends no hours gets the old words, which promise no number of hours.
 */
export function holdHoursText(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function payLinkHoldLine(hours: unknown, liveUrl: string | null): string {
  if (typeof hours === 'number' && Number.isFinite(hours) && hours >= 1) {
    return liveUrl
      ? `This replaces ${liveUrl} in about ${holdHoursText(hours)}. Until then every payment still goes to it.`
      : `It goes live in about ${holdHoursText(hours)}. Until then nobody can pay you through it.`;
  }
  return `This replaces ${liveUrl ?? 'no current link'} after a short safety delay.`;
}
