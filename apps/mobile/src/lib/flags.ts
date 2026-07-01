/** ISO 3166-1 alpha-2 country code → flag emoji (a pair of regional-indicator
 *  symbols). iOS renders these natively. Falls back to a white flag. */
export function flagEmoji(code?: string | null): string {
  if (!code || code.length !== 2) return '🏳️';
  return code.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}
