import { color, radius, shadow, space, typeScale, withAlpha } from '@swift/ui';

// ---------------------------------------------------------------------------
// [CARD-PAGE · owner 27 Oct 2026] Swift's LOOK for the pages the API serves
// around a card payment: the frame page around the bank's card form, its
// ended and missing states, the four return pages and the test simulator.
// "Make it look like the rest of Swift": every value here is the app's own,
// read from packages/ui (the one token authority) — paper and ink, Indian
// Red, the kit's pill buttons (button.tsx), its tone chips (cardSessionTone,
// labels.tsx) and the Swift mark (components/SwiftLogo.tsx). No colour is
// minted here.
//
// What this file may never do (the pages' own policies, card-rail.routes.ts,
// are not touched by it): load anything. Every style is in the page's one
// inline <style> (the policies allow inline style and nothing else); the
// mark and the icons are inline SVG shapes; the fonts are the device's own.
// No script, no image, no font, no address. The app and the web are light
// only (app.config userInterfaceStyle 'light'), so these pages are too, and
// say so: an in-app browser in dark mode must not invert them.
// ---------------------------------------------------------------------------

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const px = (n: number) => `${n}px`;

/** The app's tone for a card state (lib/cardFee cardSessionTone) and its soft tint, as the card section shows it. */
export type CardPageTone = 'success' | 'waiting' | 'error' | 'neutral';
const TONES: Record<CardPageTone, { bg: string; fg: string }> = {
  success: { bg: color.soft.success, fg: color.success },
  waiting: { bg: color.soft.warning, fg: color.warning },
  error: { bg: color.soft.danger, fg: color.error },
  neutral: { bg: color.soft.info, fg: color.info },
};

/** The device's own interface face: nothing is fetched (the app's Bricolage and Hanken are not served here). */
const FACE = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/** The page's one stylesheet, built once from the tokens. */
export const CARD_PAGE_CSS = [
  ':root{color-scheme:only light}',
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  `body{margin:0;min-height:100vh;background:${color.surface.subtle};color:${color.text.primary};font-family:${FACE};font-size:${px(typeScale.body.fontSize)};line-height:${px(typeScale.body.lineHeight)};-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}`,
  // The web's modal width (space 5xl x 10): a phone fills it, a desktop frame centres it.
  `main{max-width:${px(space['5xl'] * 10)};margin:0 auto;padding:${px(space.xl)} ${px(space.lg)} ${px(space['3xl'])};display:flex;flex-direction:column;gap:${px(space.lg)}}`,
  'p{margin:0}',
  'svg{display:block;flex:none}',
  `h1{margin:0;font-size:${px(typeScale.display.fontSize)};line-height:${px(typeScale.display.lineHeight)};font-weight:700;letter-spacing:-0.01em;font-variant-numeric:tabular-nums}`,
  // The mark and wordmark, as the web's SwiftLogo sets them.
  `.brand{display:flex;align-items:center;gap:${px(space.xs)};color:${color.brand[500]};font-size:${px(typeScale.title.fontSize)};line-height:${px(typeScale.title.lineHeight)};font-weight:700;letter-spacing:-0.01em}`,
  // The test label: the app's warning StatePill tint, as a banner (the label is a sentence).
  `.test{display:flex;align-items:flex-start;gap:${px(space.sm)};padding:${px(space.md)} ${px(space.lg)};border-radius:${px(radius.md)};background:${withAlpha(color.warning, 0.14)};color:${color.text.primary};font-size:${px(typeScale.label.fontSize)};line-height:${px(typeScale.label.lineHeight)};font-weight:600}`,
  `.test svg{color:${color.warning}}`,
  `.lede{display:flex;align-items:flex-start;gap:${px(space.sm)};color:${color.text.secondary}}`,
  `.lede svg{color:${color.brand[600]};margin-top:3px}`,
  // The bank's form sits in a white kit card (radius 16, the card shadow); the frame itself is unchanged.
  `.frame{background:${color.surface.base};border-radius:${px(radius.lg)};box-shadow:${shadow.card};overflow:hidden}`,
  'iframe.card{display:block;width:100%;min-height:560px;border:0}',
  `.panel{display:flex;align-items:flex-start;gap:${px(space.md)};padding:${px(space.lg)};border-radius:${px(radius.lg)};background:${color.surface.base};box-shadow:${shadow.card}}`,
  // A return state: the kit's state pattern (a 72 tone chip, the heading, one sentence), centred.
  `.state{display:flex;flex-direction:column;align-items:center;text-align:center;gap:${px(space.md)};padding:${px(space.xl)} ${px(space.sm)} ${px(space.sm)}}`,
  `.state h1{font-size:${px(typeScale.title.fontSize)};line-height:${px(typeScale.title.lineHeight)}}`,
  `.state p{color:${color.text.secondary};max-width:320px}`,
  `.icon{display:flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:${px(radius.md)}}`,
  `.state .icon{width:72px;height:72px;border-radius:${px(radius.lg)}}`,
  ...Object.entries(TONES).map(([tone, t]) => `.tone-${tone}{background:${t.bg};color:${t.fg}}`),
  // The kit's PillButton (button.tsx): full radius, the lg tier (56), semibold 15/20; primary and soft.
  `.actions{display:flex;flex-direction:column;gap:${px(space.md)};margin-top:${px(space.sm)}}`,
  `.btn{display:flex;align-items:center;justify-content:center;min-height:56px;padding:${px(space.sm)} ${px(space['2xl'])};border-radius:${px(radius.full)};font-size:${px(typeScale.bodyStrong.fontSize)};line-height:${px(typeScale.bodyStrong.lineHeight)};font-weight:600;text-align:center;text-decoration:none}`,
  `.btn-primary{background:${color.brand[500]};color:${color.white}}`,
  `.btn-primary:active{background:${color.brand[600]}}`,
  `.btn-soft{background:${color.brand[50]};color:${color.brand[600]}}`,
  `.btn-soft:active{background:${color.brand[100]}}`,
  // The simulator's buttons (test servers only): the kit's outline pill.
  `button{display:block;width:100%;min-height:56px;padding:${px(space.sm)} ${px(space['2xl'])};border-radius:${px(radius.full)};border:1px solid ${color.border.subtle};background:${color.surface.base};color:${color.text.primary};font:inherit;font-weight:600;cursor:pointer}`,
  `button:active{background:${color.brand[50]}}`,
  `form p{margin:${px(space.xs + 2)} ${px(space.sm)} ${px(space.lg)};color:${color.text.secondary};font-size:${px(typeScale.caption.fontSize)};line-height:${px(typeScale.caption.lineHeight)}}`,
  `a:focus-visible,button:focus-visible{outline:2px solid ${color.focusRing};outline-offset:2px}`,
  `@media (min-width:600px){main{padding-top:${px(space['4xl'])}}}`,
].join('');

/** Every Swift card page: the app's paper, the one inline stylesheet, light only. */
export function cardPageHtml(title: string, inner: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<meta name="color-scheme" content="only light"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>`
    + `<style>${CARD_PAGE_CSS}</style></head><body><main>${inner}</main></body></html>`;
}

/** Feather's shapes (the icon set the app draws with), inline: nothing is fetched. */
const ICONS = {
  check: '<polyline points="20 6 9 17 4 12"></polyline>',
  clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
  alert: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
  info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
} as const;

function icon(name: keyof typeof ICONS, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const TONE_ICON: Record<CardPageTone, keyof typeof ICONS> = { success: 'check', waiting: 'clock', error: 'alert', neutral: 'info' };

/** A tone chip (the kit's IconChip): decorative, the words beside it carry the meaning. */
export function toneChip(tone: CardPageTone, size = 22): string {
  return `<div class="icon tone-${tone}" aria-hidden="true">${icon(TONE_ICON[tone], size)}</div>`;
}

/** The Swift mark and wordmark (components/SwiftLogo.tsx), at the head of a page Swift opens. */
export const SWIFT_PAGE_HEADER = '<header class="brand"><svg width="28" height="28" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g transform="translate(-1.5,-6)">'
  + `<path fill="${color.brand[500]}" d="M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z"></path>`
  + `<path fill="${color.brand[600]}" d="M50 52 C62 56 76 46 97 20 C76 30 60 40 50 52 Z"></path>`
  + '</g></svg><span class="word">Swift</span></header>';

/** A test system's label, at the top of the page. */
export function testBanner(label: string): string {
  return `<p class="test" role="note">${icon('warning', 18)}<span>${escapeHtml(label)}</span></p>`;
}

/** The lock beside the words that say the card is typed only in the bank's form. */
export const LOCK_ICON = icon('lock', 16);

/** A way back, as a kit pill button. A link (never a form): these pages run no script and post nothing. */
export function buttonLink(href: string, label: string, kind: 'primary' | 'soft'): string {
  return `<a class="btn btn-${kind}" href="${escapeHtml(href)}" target="_top">${escapeHtml(label)}</a>`;
}
