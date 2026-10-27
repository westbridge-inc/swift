import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { color, radius, withAlpha } from '@swift/ui';
import {
  CARD_APP_RETURN_LINK,
  CARD_FRAME_SANDBOX,
  CARD_RAIL_RUNTIME_DECORATION,
  CARD_RETURN_PAGES,
  HOSTED_CARD_PAGE_CSP,
  cardRailPublicRoutes,
  cardTextPageCsp,
  cardWebFeeUrl,
  hostedCardPageCsp,
  returnPageHtml,
} from '../modules/billing/card-rail.routes';
import { CARD_SANDBOX_TEST_LABEL } from '../modules/billing/card-rail.service';
import { PowerTranzCardRailProvider, type PowerTranzHostedPage } from '../providers/card/powertranz-provider';
import { SIMULATOR_PAGE, SimulatorCardRailProvider } from '../providers/card/simulator-provider';

// ---------------------------------------------------------------------------
// [CARD-PAGE · owner 27 Oct 2026] "Make it look like the rest of Swift —
// obviously the web hosting page is PowerTranz." Swift's server pages around
// the bank's card form (the frame page, its ended and missing states, the
// four return pages and the test simulator) take the Swift app's look:
// packages/ui's colours, the kit's pill buttons and tone chips, the Swift mark.
//
// The look changes; nothing a payment depends on may. These tests drive the
// REAL public routes (no database: the provider is a stand-in on the real
// prototype) and pin, byte for byte, what the restyle must never touch: the
// bank's frame (srcdoc binding, sandbox, allow), every page policy, no load
// from anywhere, no provider name, no card field, and the words.
// ---------------------------------------------------------------------------

const BASE = '/api/v1/billing/card';
const WEB = 'https://web.example.test';
const PAY_REF = 'ptz_0123456789abcdef01234567';
const SIM_REF = 'sim_0123456789abcdef01234567';

/** A stand-in for the provider's RedirectData: its own form and script, which only ever run inside the frame. */
const BANK_FORM = '<form id="f" method="post" action="https://hpp.example.test/pay"><input type="hidden" name="t" value="synthetic"></form><script>document.getElementById("f").submit()</script>';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The frame exactly as it shipped before the restyle (#PT-4 / review S3): not one byte may change. */
const SANDBOX_AS_SHIPPED = 'allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation';
const FRAME_AS_SHIPPED = `<iframe class="card" title="Your bank's secure card form" sandbox="${SANDBOX_AS_SHIPPED}" srcdoc="${esc(BANK_FORM)}" allow="payment"></iframe>`;

/** Every page policy exactly as it shipped before the restyle. */
const HOSTED_CSP_AS_SHIPPED = "default-src 'none'; script-src 'unsafe-inline' https://*.ptranz.com; style-src 'unsafe-inline' https://*.ptranz.com; img-src data: https:; font-src data: https://*.ptranz.com; frame-src 'self' https:; form-action https://*.ptranz.com; connect-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const RETURN_CSP_AS_SHIPPED = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://*.ptranz.com";
const SIMULATOR_CSP_AS_SHIPPED = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; connect-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'";

/** The app's own mark (apps/mobile/src/components/SwiftLogo.tsx, apps/web/src/components/swift-logo.tsx). */
const SWIFT_MARK_PATH = 'M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z';

const facts = (over: Partial<PowerTranzHostedPage> = {}): PowerTranzHostedPage => ({
  redirectData: BANK_FORM, amountMinor: 210_000, currencyCode: 'GYD', expired: false, finished: false, sandbox: false, ...over,
});

type SimFacts = Awaited<ReturnType<SimulatorCardRailProvider['pageFor']>>;
let hosted: PowerTranzHostedPage | null = null;
let simulated: SimFacts = null;
let provider: unknown = null;
const ptz = Object.create(PowerTranzCardRailProvider.prototype) as PowerTranzCardRailProvider;
Object.assign(ptz, { hostedPageFor: async () => hosted });
const sim = Object.create(SimulatorCardRailProvider.prototype) as SimulatorCardRailProvider;
Object.assign(sim, { pageFor: async () => simulated });

let app: FastifyInstance;
const envBefore: Record<string, string | undefined> = {};
const setEnv = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };

beforeAll(async () => {
  for (const key of ['CARD_RAIL_V2', 'CARD_RAIL_V2_DRAIN', 'APP_PUBLIC_URL']) envBefore[key] = process.env[key];
  setEnv('CARD_RAIL_V2', '1');
  setEnv('APP_PUBLIC_URL', WEB);
  app = Fastify({ logger: false });
  app.decorate(CARD_RAIL_RUNTIME_DECORATION, { service: {}, billing: {}, rail: () => provider });
  await app.register(cardRailPublicRoutes, { prefix: BASE });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const [key, value] of Object.entries(envBefore)) setEnv(key, value);
});

const get = (url: string) => app.inject({ method: 'GET', url });

/** Every page Swift serves around a card payment, as the routes serve it. */
async function servedPages(): Promise<Array<{ name: string; html: string; csp: string }>> {
  const pages: Array<{ name: string; html: string; csp: string }> = [];
  const take = async (name: string, url: string) => {
    const res = await get(url);
    pages.push({ name, html: res.body, csp: String(res.headers['content-security-policy']) });
  };
  provider = ptz;
  hosted = facts(); await take('pay: live', `${BASE}/pay/${PAY_REF}`);
  hosted = facts({ sandbox: true }); await take('pay: live, test system', `${BASE}/pay/${PAY_REF}`);
  hosted = facts({ finished: true }); await take('pay: ended', `${BASE}/pay/${PAY_REF}`);
  hosted = facts({ expired: true, sandbox: true }); await take('pay: ended, test system', `${BASE}/pay/${PAY_REF}`);
  hosted = null; await take('pay: no such page', `${BASE}/pay/${PAY_REF}`);
  await take('return: as served', `${BASE}/return`);
  provider = sim;
  simulated = { purpose: 'PAY_NOW', amountMinor: 210_000, currencyCode: 'GYD', expired: false, chosen: null }; await take('simulator: pay now', `${BASE}/simulator/${SIM_REF}`);
  simulated = { purpose: 'ENROLL', expired: false, chosen: null }; await take('simulator: add a card', `${BASE}/simulator/${SIM_REF}`);
  simulated = { purpose: 'PAY_NOW', amountMinor: 210_000, currencyCode: 'GYD', expired: true, chosen: null }; await take('simulator: expired', `${BASE}/simulator/${SIM_REF}`);
  simulated = null; await take('simulator: no such page', `${BASE}/simulator/${SIM_REF}`);
  for (const state of CARD_RETURN_PAGES) pages.push({ name: `return: ${state}`, html: returnPageHtml(state), csp: cardTextPageCsp('return') });
  return pages;
}

/** Swift's own markup: the page with the bank's frame document (its srcdoc) left out. */
const own = (html: string) => html.replace(/ srcdoc="[^"]*"/g, ' srcdoc=""');
const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
const ruleOf = (css: string, selector: string) => new RegExp(`(?:^|\\})${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

/** Every colour packages/ui defines: the only colours a Swift page may use. */
function tokenHexes(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) out.add(value.toUpperCase());
  else if (value && typeof value === 'object') for (const v of Object.values(value)) tokenHexes(v, out);
  return out;
}

describe('[CARD-PAGE] Swift\'s card pages look like the Swift app', () => {
  it('every page is light only, like the app and the web (userInterfaceStyle "light"), so an in-app browser never darkens it', async () => {
    for (const { name, html } of await servedPages()) {
      expect(html, name).toContain('<meta name="color-scheme" content="only light">');
      expect(styleOf(html), name).toContain('color-scheme:only light');
    }
  });

  it('every colour on every page is one of Swift\'s own tokens (packages/ui): the app\'s paper, ink and Indian Red, no new palette', async () => {
    const tokens = tokenHexes(color);
    for (const { name, html } of await servedPages()) {
      const used = own(html).match(/(?<![&\w])#[0-9a-f]{3,8}\b/gi) ?? [];
      expect(used.length, name).toBeGreaterThan(0);
      expect(used.filter((hex) => !tokens.has(hex.toUpperCase())), name).toEqual([]);
      expect(ruleOf(styleOf(html), 'body'), name).toContain(`background:${color.surface.subtle}`);
      expect(ruleOf(styleOf(html), 'body'), name).toContain(`color:${color.text.primary}`);
    }
  });

  it('the Swift mark and wordmark head every page Swift opens around the card; the return states, shown inside it, do not repeat it', async () => {
    for (const { name, html } of await servedPages()) {
      const headed = !name.startsWith('return');
      expect(html.includes(SWIFT_MARK_PATH), name).toBe(headed);
      if (headed) {
        expect(html, name).toMatch(/<header class="brand">[\s\S]*?<\/svg><span class="word">Swift<\/span><\/header>/);
        expect(html, name).toContain(`fill="${color.brand[500]}"`);
        expect(html.indexOf('<header class="brand">'), name).toBeLessThan(html.indexOf('<h1>'));
      }
    }
  });

  it('"Back to the Swift app", "Continue on the web" and "Cancel" are Swift pill buttons with big tap targets, not bare links', async () => {
    const back = `<a class="btn btn-primary" href="${CARD_APP_RETURN_LINK}" target="_top">Back to the Swift app</a>`;
    const web = `<a class="btn btn-soft" href="${cardWebFeeUrl()}" target="_top">Continue on the web</a>`;
    const cancel = `<a class="btn btn-soft" href="${CARD_APP_RETURN_LINK}" target="_top">Cancel and go back to the Swift app</a>`;
    for (const { name, html } of await servedPages()) {
      if (name.startsWith('return')) { expect(html, name).toContain(back); expect(html, name).toContain(web); }
      if (name === 'pay: live' || name === 'pay: live, test system') expect(html, name).toContain(cancel);
      if (name.startsWith('pay: ended') || name === 'pay: no such page') expect(html, name).toContain(back);
      // No link is left bare: every link on every page is one of the buttons.
      expect(own(html).match(/<a\b[^>]*>/g)?.every((a) => a.startsWith('<a class="btn btn-')) ?? true, name).toBe(true);
      const css = styleOf(html);
      const btn = ruleOf(css, '.btn');
      expect(Number(/min-height:(\d+)px/.exec(btn)?.[1] ?? 0), name).toBeGreaterThanOrEqual(48);
      expect(btn, name).toContain(`border-radius:${radius.full}px`);
      expect(ruleOf(css, '.btn-primary'), name).toBe(`background:${color.brand[500]};color:${color.white}`);
      expect(ruleOf(css, '.btn-soft'), name).toBe(`background:${color.brand[50]};color:${color.brand[600]}`);
    }
  });

  it('each return state wears the app\'s tone for it (cardSessionTone): Done success, Checking waiting, didn\'t go through error, otherwise neutral', () => {
    const tone = { SUCCEEDED: 'success', PENDING: 'waiting', FAILED: 'error', UNKNOWN: 'neutral' } as const;
    for (const state of CARD_RETURN_PAGES) {
      const html = returnPageHtml(state);
      expect(html.match(/class="icon tone-(\w+)"/g), state).toEqual([`class="icon tone-${tone[state]}"`]);
    }
    const css = styleOf(returnPageHtml('PENDING'));
    expect(ruleOf(css, '.tone-success')).toBe(`background:${color.soft.success};color:${color.success}`);
    expect(ruleOf(css, '.tone-waiting')).toBe(`background:${color.soft.warning};color:${color.warning}`);
    expect(ruleOf(css, '.tone-error')).toBe(`background:${color.soft.danger};color:${color.error}`);
    expect(ruleOf(css, '.tone-neutral')).toBe(`background:${color.soft.info};color:${color.info}`);
  });

  it('the unknown state is headed "Weekly fee", as the MMG return page is, not a bare "Swift"', () => {
    expect(returnPageHtml('UNKNOWN')).toContain('<h1>Weekly fee</h1>');
    expect(returnPageHtml('UNKNOWN')).not.toContain('<h1>Swift</h1>');
  });

  it('the TEST label is the app\'s warning pill tint, at the top of the page, above the payment', async () => {
    for (const { name, html } of await servedPages()) {
      const label = name.startsWith('simulator') && name !== 'simulator: no such page' ? SIMULATOR_PAGE.testModeLabel : name.endsWith('test system') ? CARD_SANDBOX_TEST_LABEL : null;
      if (!label) { expect(html, name).not.toContain('class="test"'); continue; }
      expect(html, name).toMatch(new RegExp(`<p class="test" role="note"><svg [^>]*>[\\s\\S]*?</svg><span>${esc(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span></p>`));
      expect(html.indexOf('class="test"'), name).toBeLessThan(html.indexOf('<h1>'));
      expect(ruleOf(styleOf(html), '.test'), name).toContain(`background:${withAlpha(color.warning, 0.14)}`);
    }
  });
});

describe('[CARD-PAGE] what the restyle must never change', () => {
  it('the bank\'s card frame is byte for byte as shipped: the same srcdoc binding, sandbox and allow, once, and only while the page is live', async () => {
    expect(CARD_FRAME_SANDBOX).toBe(SANDBOX_AS_SHIPPED);
    for (const { name, html } of await servedPages()) {
      const live = name === 'pay: live' || name === 'pay: live, test system';
      expect(html.split('<iframe').length - 1, name).toBe(live ? 1 : 0);
      if (live) expect(html, name).toContain(FRAME_AS_SHIPPED);
      // The bank's own markup appears only inside the frame's srcdoc, escaped.
      expect(own(html), name).not.toContain('hpp.example.test');
    }
  });

  it('every page policy is byte for byte as shipped (the hosted page, the return page, the simulator; with and without Swift\'s web)', async () => {
    expect(HOSTED_CARD_PAGE_CSP).toBe(HOSTED_CSP_AS_SHIPPED);
    expect(hostedCardPageCsp(null)).toBe(HOSTED_CSP_AS_SHIPPED);
    expect(hostedCardPageCsp(WEB)).toBe(HOSTED_CSP_AS_SHIPPED.replace("frame-ancestors 'none'", `frame-ancestors ${WEB}`));
    expect(cardTextPageCsp('return', null)).toBe(RETURN_CSP_AS_SHIPPED);
    expect(cardTextPageCsp('return', WEB)).toBe(`${RETURN_CSP_AS_SHIPPED} ${WEB}`);
    expect(cardTextPageCsp('simulator', null)).toBe(SIMULATOR_CSP_AS_SHIPPED);
    expect(cardTextPageCsp('simulator', WEB)).toBe(`${SIMULATOR_CSP_AS_SHIPPED} ${WEB}`);
    // ...and the routes send exactly those.
    for (const { name, csp } of await servedPages()) {
      const expected = name.startsWith('pay') ? hostedCardPageCsp(WEB) : name.startsWith('return') ? `${RETURN_CSP_AS_SHIPPED} ${WEB}` : `${SIMULATOR_CSP_AS_SHIPPED} ${WEB}`;
      expect(csp, name).toBe(expected);
    }
  });

  it('no page loads anything from anywhere: no script, stylesheet, font, image, media or frame of Swift\'s own, and no address but the two ways back', async () => {
    for (const { name, html } of await servedPages()) {
      const mine = own(html);
      expect(mine, name).not.toMatch(/<script|<link|<img|<object|<embed|<video|<audio|<source|<base|<frame\b|<portal|@import|@font-face|url\(|\ssrc=|\sxlink:href=|<use\b|<image\b/i);
      // A style attribute is not needed: every style is in the page's one inline <style>.
      expect(mine, name).not.toMatch(/\sstyle=/i);
      expect(mine.match(/<style>/g), name).toEqual(['<style>']);
      // The only addresses anywhere are the two ways back (and the simulator's own buttons' post).
      const hrefs = [...mine.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs.filter((h) => h !== CARD_APP_RETURN_LINK && h !== cardWebFeeUrl()), name).toEqual([]);
      const actions = [...mine.matchAll(/\saction="([^"]*)"/g)].map((m) => m[1]);
      expect(actions.filter((a) => a !== `${BASE}/simulator/${SIM_REF}`), name).toEqual([]);
      const addresses = mine.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi) ?? [];
      expect(addresses.filter((u) => u !== CARD_APP_RETURN_LINK && u !== cardWebFeeUrl()), name).toEqual([]);
    }
  });

  it('no page names the card provider, and none carries a field of any kind: the card is typed only in the bank\'s form', async () => {
    for (const { name, html } of await servedPages()) {
      expect(own(html), name).not.toMatch(/powertranz|ptranz/i);
      expect(own(html), name).not.toMatch(/<input|<select|<textarea|contenteditable/i);
    }
  });

  it('the words stay as they were (the unknown state\'s heading, "Weekly fee", is pinned above)', async () => {
    const body = {
      SUCCEEDED: 'Go back to the Swift app to see it.',
      PENDING: 'We&#39;re checking with the bank. Don&#39;t pay again. You can close this page.',
      FAILED: 'You can try again in the Swift app.',
      UNKNOWN: 'Open the Swift app to see your weekly fee.',
    } as const;
    const title = { SUCCEEDED: 'Done', PENDING: 'Checking with the bank', FAILED: 'This didn&#39;t go through' } as const;
    for (const state of CARD_RETURN_PAGES) {
      if (state !== 'UNKNOWN') expect(returnPageHtml(state), state).toContain(`<h1>${title[state]}</h1>`);
      expect(returnPageHtml(state), state).toContain(`<p>${body[state]}</p>`);
    }
    const pages = Object.fromEntries((await servedPages()).map((p) => [p.name, p.html]));
    expect(pages['pay: live']).toContain('<h1>Pay GY$2,100 by card</h1>');
    expect(pages['pay: live']).toContain("Type your card on your bank's secure form below. Swift never sees your card number or security code.");
    expect(pages['pay: ended']).toContain('<h1>Pay GY$2,100 by card</h1>');
    expect(pages['pay: ended']).toContain('<p>This card page has ended. Open the Swift app to see your weekly fee, or start again there.</p>');
    expect(pages['pay: no such page']).toContain('<h1>There is no such card page</h1>');
    expect(pages['pay: no such page']).toContain('<p>Open the Swift app to see your weekly fee.</p>');
    expect(pages['simulator: pay now']).toContain(`<h1>${SIMULATOR_PAGE.title}</h1>`);
    for (const b of SIMULATOR_PAGE.buttons) {
      expect(pages['simulator: pay now']).toContain(`<button type="submit" name="scenario" value="${b.scenario}">${esc(b.label)}</button><p>${esc(b.explains)}</p>`);
    }
    expect(pages['simulator: expired']).toContain('<p>This test page has expired. Start again in the Swift app.</p>');
    expect(pages['simulator: no such page']).toContain('<p>There is no such test page.</p>');
  });
});
