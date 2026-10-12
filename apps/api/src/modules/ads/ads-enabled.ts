/** Advertising is closed at launch; only an explicit server opt-in opens it. */
export function adsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['ADS_ENABLED'] === '1';
}
