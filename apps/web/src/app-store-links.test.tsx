import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [G11 · launch day] The website's App Store and Google Play links.
//
// Before launch the site says the store links will come; on Release day the
// owner turns them on WITHOUT a code deploy: the web server reads
// SWIFT_APP_STORES while it runs (the same pattern as the SWIFT_WEB_ORDERING
// front door), the browser asks it through /api/launch-state, and only the
// exact answer "live" shows the links. Unset, a near miss, a slow answer or a
// failed one all keep "coming soon": a store link to an app that is not live
// yet is a false claim and a review flag. The links are a public claim, so only
// the public site (swiftgy.com and www) shows them; staging, previews and local
// runs never do, and ask the server nothing new.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

/** Loads a source module by its checked path, so a missing one fails as an assertion. */
async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

const APP_STORE = 'https://apps.apple.com/app/id6815507102';
const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=gy.swift.app';
const SOON_SENTENCE = 'Store download links will appear here when available.';

/** A fresh page load against a web server whose store switch is `appStores` (read while it runs). */
let launchQuestions = 0;
async function serverWith(appStores: string | undefined, webOrdering = '') {
  vi.resetModules();
  if (appStores !== undefined) vi.stubEnv('SWIFT_APP_STORES', appStores);
  vi.stubEnv('SWIFT_WEB_ORDERING', webOrdering);
  launchQuestions = 0;
  const { GET } = await load<{ GET: () => Response }>('app/api/launch-state/route.ts');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/launch-state')) { launchQuestions += 1; return GET(); }
    return new Response('{}', { status: 404 });
  }));
  return GET;
}

/** Lets the page's one question to the server be answered before asserting what it shows. */
async function answered() {
  await waitFor(() => expect(launchQuestions).toBeGreaterThan(0));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function openAt(url: string) {
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL(url);
}

/** Every link on the page whose HOST is a store (parsed, never a substring match). */
const STORE_HOSTS = new Set(['apps.apple.com', 'play.google.com']);
function storeHrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a')]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => {
      try { return STORE_HOSTS.has(new URL(href, 'https://swiftgy.com').hostname); } catch { return false; }
    });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  openAt('http://localhost:3000/');
});

describe('[G11] the switch, as the web server holds it', () => {
  it('is "soon" unless set to exactly "live", and the answer is never cached', async () => {
    for (const value of [undefined, '', 'soon', 'Live', 'LIVE', 'true', '1', 'yes', ' live']) {
      const GET = await serverWith(value);
      const response = GET();
      expect(response.headers.get('cache-control'), String(value)).toBe('no-store');
      expect((await response.json()).appStores, JSON.stringify(value)).toBe('soon');
    }
    const GET = await serverWith('live');
    expect((await GET().json()).appStores).toBe('live');
  });

  it('is its own switch: opening web ordering shows no store link, and live stores do not open ordering', async () => {
    let GET = await serverWith('', 'live');
    expect(await GET().json()).toEqual({ webOrdering: 'live', appStores: 'soon' });
    GET = await serverWith('live', '');
    expect(await GET().json()).toEqual({ webOrdering: 'soon', appStores: 'live' });
  });
});

describe('[G11] what the visitor sees', () => {
  it('the footer shows no store link while the switch is off', async () => {
    for (const url of ['https://swiftgy.com/legal/refunds', 'https://www.swiftgy.com/legal/refunds']) {
      await serverWith('');
      openAt(url);
      const { SiteFooter } = await import('@/components/site');
      const view = render(<SiteFooter />);
      await answered();
      expect(storeHrefs(view.container), url).toEqual([]);
      expect(view.container.textContent, url).toContain('Taxi rides require the Swift mobile app.');
      view.unmount();
    }
  });

  it('staging, previews and local runs never show store links, even with the switch live, and ask nothing', async () => {
    for (const url of ['https://staging.swiftgy.com/legal/refunds', 'http://localhost:3000/faq']) {
      await serverWith('live');
      openAt(url);
      const { SiteFooter } = await import('@/components/site');
      const view = render(<SiteFooter />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(storeHrefs(view.container), url).toEqual([]);
      expect(launchQuestions, url).toBe(0);
      view.unmount();
    }
  });

  it('once live, the footer links to the real App Store and Google Play pages and keeps the taxi sentence', async () => {
    for (const url of ['https://swiftgy.com/legal/refunds', 'https://www.swiftgy.com/legal/refunds']) {
      await serverWith('live');
      openAt(url);
      const { SiteFooter } = await import('@/components/site');
      const view = render(<SiteFooter />);
      await answered();
      expect(storeHrefs(view.container), url).toEqual([APP_STORE, GOOGLE_PLAY]);
      expect(view.container.querySelector(`a[href="${APP_STORE}"]`)?.textContent).toBe('Swift on the App Store');
      expect(view.container.querySelector(`a[href="${GOOGLE_PLAY}"]`)?.textContent).toBe('Swift on Google Play');
      expect(view.container.textContent, url).toContain('Taxi rides require the Swift mobile app.');
      view.unmount();
    }
  });

  it('/welcome and the launching-soon front door show the links only once live', async () => {
    for (const route of ['app/(marketing)/welcome/page.tsx', 'app/(marketing)/launching-soon/page.tsx']) {
      for (const [value, expected] of [['', []], ['live', [APP_STORE, GOOGLE_PLAY]]] as const) {
        await serverWith(value);
        openAt('https://swiftgy.com/');
        const { default: Page } = await load<{ default: () => React.ReactNode }>(route);
        const view = render(<>{Page()}</>);
        await answered();
        expect(storeHrefs(view.container), `${route} with ${JSON.stringify(value)}`).toEqual(expected);
        view.unmount();
      }
    }
  });

  // [WEBSITE 30 Oct · owner] The front door's store area: a calm line while the switch is off (never a dead
  // badge, never a disclaimer), and two real store buttons once it is live. The line goes when the buttons come.
  it('the front door says "Coming to the App Store and Google Play" while off, and shows the two store buttons once live', async () => {
    const COMING = 'Coming to the App Store and Google Play';
    await serverWith('');
    openAt('https://swiftgy.com/');
    let { default: Page } = await load<{ default: () => React.ReactNode }>('app/(marketing)/launching-soon/page.tsx');
    let view = render(<>{Page()}</>);
    // Before the server answers, and while off, the line shows and nothing links to a store.
    expect(view.container.textContent).toContain(COMING);
    await answered();
    expect(view.container.textContent).toContain(COMING);
    expect(storeHrefs(view.container)).toEqual([]);
    view.unmount();

    await serverWith('live');
    openAt('https://swiftgy.com/');
    ({ default: Page } = await load<{ default: () => React.ReactNode }>('app/(marketing)/launching-soon/page.tsx'));
    view = render(<>{Page()}</>);
    await answered();
    expect(view.container.textContent).not.toContain(COMING);
    expect(view.container.querySelector(`a[href="${APP_STORE}"]`)?.textContent).toBe('Download on the App Store');
    expect(view.container.querySelector(`a[href="${GOOGLE_PLAY}"]`)?.textContent).toBe('Get it on Google Play');
    view.unmount();
  });

  it('the FAQ says the links will come while off, and gives them once live', async () => {
    await serverWith('');
    openAt('https://swiftgy.com/faq');
    let { default: Faq } = await load<{ default: () => React.ReactNode }>('app/(marketing)/faq/page.tsx');
    let view = render(<>{Faq()}</>);
    await answered();
    expect(view.container.textContent).toContain(SOON_SENTENCE);
    expect(storeHrefs(view.container)).toEqual([]);
    view.unmount();

    await serverWith('live');
    ({ default: Faq } = await load<{ default: () => React.ReactNode }>('app/(marketing)/faq/page.tsx'));
    view = render(<>{Faq()}</>);
    await answered();
    expect(view.container.textContent).not.toContain(SOON_SENTENCE);
    expect(storeHrefs(view.container)).toEqual([APP_STORE, GOOGLE_PLAY]);
    expect(view.container.textContent).toContain('Taxi rides require the Swift mobile app');
    view.unmount();
  });

  it('until the server has answered, and if it cannot, no store link shows', async () => {
    await serverWith('live');
    let answer!: (_value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    openAt('https://swiftgy.com/legal/refunds');
    const { SiteFooter } = await import('@/components/site');
    const view = render(<SiteFooter />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(storeHrefs(view.container)).toEqual([]);
    await act(async () => { answer(new Response('busy', { status: 503 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(storeHrefs(view.container)).toEqual([]);
    view.unmount();

    await serverWith('live');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const { SiteFooter: Footer } = await import('@/components/site');
    const again = render(<Footer />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(storeHrefs(again.container)).toEqual([]);
    again.unmount();
  });
});

describe('[G11] the links are the real store pages, never invented', () => {
  it('match the phone app’s own store links (the update-required screen sends people to the same two pages)', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'lib', 'appVersionGate.ts'), 'utf8');
    expect(phone).toContain(`ios: '${APP_STORE}'`);
    expect(phone).toContain(`android: '${GOOGLE_PLAY}'`);
    const web = readFileSync(join(SRC, 'lib', 'app-stores.ts'), 'utf8');
    expect(web).toContain(`'${APP_STORE}'`);
    expect(web).toContain(`'${GOOGLE_PLAY}'`);
  });

  it('no build-time store switch is left: the site config has no store state to flip in code', () => {
    const launch = readFileSync(join(SRC, 'site.launch.ts'), 'utf8');
    expect(launch).not.toMatch(/\biosApp\b|\bandroidApp\b/);
    const config = readFileSync(join(SRC, 'site.config.ts'), 'utf8');
    expect(config).not.toMatch(/showAppStoreBadges/);
  });
});
