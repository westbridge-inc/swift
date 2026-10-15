/**
 * [R18] The background-location disclosure's words, in one place.
 *
 * They are what the mover agrees to, so the server keeps them as a consent
 * document (apps/api partner/location-consent.ts LOCATION_BG_CONSENT_V1) and
 * the mover's yes is recorded in the consent ledger against them.
 * backgroundLocationCopy.test.ts holds the two copies equal: changing these
 * words needs a new consent version on the server.
 */
export const BG_DISCLOSURE = {
  title: 'Swift needs your location in the background',
  body: 'While you are online, Swift collects your location even when the app is closed or not in use — so jobs can reach you, and so the customer can watch their delivery move.',
  lines: [
    'Where you are, while you are online',
    'Sent only to Swift and kept with our hosting provider, as the Privacy Policy explains — never sold, never shared with advertisers',
    'Stops the moment you go offline',
  ],
  caption: 'You can go online either way. Without background access Swift tracks you only while the app is on screen.',
  allow: 'Allow background location',
  decline: 'Only while app is open',
} as const;

/** The disclosure as one text, line by line, then its two buttons. */
export const BG_DISCLOSURE_TEXT = [
  BG_DISCLOSURE.title,
  BG_DISCLOSURE.body,
  ...BG_DISCLOSURE.lines,
  BG_DISCLOSURE.caption,
  `[${BG_DISCLOSURE.allow}] [${BG_DISCLOSURE.decline}]`,
].join('\n');
