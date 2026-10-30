import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Item 7] The pre-launch front door: what the visitor sees. The switch and
// the middleware that applies it are proved in web-front-door-middleware.test.ts.
// Here: the front door page, and the CTAs that lead to ordering, on the public
// site before launch and on staging (which keeps the full marketplace).
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn() }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: vi.fn(), registerAccount: vi.fn(), becomePartner: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

/** Loads a source module by its checked path, so a missing one fails as an assertion. */
async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

/**
 * [S1] A fresh page load against a web server whose switch (SWIFT_WEB_ORDERING,
 * read while it runs) is `webOrdering`. The browser learns it by asking the
 * server (/api/launch-state); this answers exactly as the route would.
 */
let launchQuestions = 0;
async function configWith(webOrdering: string) {
  vi.resetModules();
  vi.stubEnv('SWIFT_WEB_ORDERING', webOrdering);
  launchQuestions = 0;
  const { GET } = await import('@/app/api/launch-state/route');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/launch-state')) { launchQuestions += 1; return GET(); }
    return new Response('{}', { status: 404 });
  }));
  return import('@/site.config');
}

/** Lets the page's one question to the server be answered before asserting what it shows. */
async function answered() {
  await waitFor(() => expect(launchQuestions).toBeGreaterThan(0));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The address bar the page is opened at. */
function openAt(url: string) {
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL(url);
}

afterEach(() => {
  vi.unstubAllEnvs();
  openAt('http://localhost:3000/');
});

describe('[Item 7] the front door itself', () => {
  // [WEBSITE 30 Oct · owner] The front door is a real launch page: a headline naming Georgetown, the app's own
  // screen, Order / Ride / Earn, and a short trust strip. It leads to how Swift works, pricing and partner
  // sign-up, never into ordering. The company and policy links live once, in the footer every marketing page
  // carries; the page no longer repeats them as rows of pills.
  async function frontDoor() {
    await configWith('');
    const { default: FrontDoor } = await load<{ default: () => React.ReactNode }>('app/(marketing)/launching-soon/page.tsx');
    return render(<>{FrontDoor()}</>);
  }

  it('names Georgetown in its one headline and leads to how it works, pricing, partner sign-up and support', async () => {
    await frontDoor();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Georgetown, in one app.']);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const href of ['/how-it-works', '/faq', '/pricing', '/signup', '/contact']) expect(hrefs, href).toContain(href);
    expect(hrefs).not.toContain('/cart');
    expect(hrefs).not.toContain('/');
  });

  it('has an Order, a Ride and an Earn section, and a trust strip whose words the Terms back', async () => {
    const view = await frontDoor();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Order', 'Ride', 'Earn with Swift', 'Why people trust Swift']);
    const words = view.container.textContent ?? '';
    // Terms §4: paid in cash or straight to the business's own MMG; Swift holds no money.
    // [REVIEW-F N2] Exact: the business (Terms §4), the rider (courier) or the driver (taxi fare) is paid directly;
    // MMG only where they take it.
    expect(words).toContain('Pay the business, rider or driver directly, in cash or by MMG where they take it. Swift never holds your money.');
    // Terms §11 + Privacy: a person checks every partner's documents before they operate (GUARDRAILS §7(4)).
    expect(words).toContain('Every business, rider and driver has their documents checked by a person on our team before they go live.');
    // Terms §10: the PIN handshake and live trip sharing.
    expect(words).toContain('A PIN check before every ride, and the trip live on the map.');
    expect(words).toContain('Keep 100% of every sale, fare and tip. One flat weekly fee, no commission.');
  });

  it('repeats no footer link: no policy or company page is linked from the page itself', async () => {
    await frontDoor();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => href.startsWith('/legal/') || href === '/about' || href === '/welcome')).toEqual([]);
  });

  it('the footer under it still carries every company and policy link', async () => {
    await configWith('');
    const { SiteFooter } = await import('@/components/site');
    const view = render(<SiteFooter />);
    const hrefs = [...view.container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const href of ['/about', '/contact', '/legal/refunds', '/legal/delivery', '/legal/terms', '/legal/privacy', '/legal/child-safety', '/account/delete']) {
      expect(hrefs, href).toContain(href);
    }
  });

  it('reads as a launch page, not a disclaimer: no hedging line and no em dash', async () => {
    const view = await frontDoor();
    const words = view.container.textContent ?? '';
    expect(words).not.toMatch(/nothing can be ordered|Ordering opens on this site/);
    expect(words).not.toContain('—');
  });

  // [WEBSITE round 2 · owner] More of the app: the Home screen in the hero, then the taxi fare before booking, live
  // order tracking and the rider's side on the Order / Ride / Earn cards. Real app screens only, cut so no rating,
  // review, earning or shop price shows; the greeting carries no name. Each is sized (no jump) and the three below
  // the fold load lazily.
  it('shows four real app screens, each described and sized; only the first loads eagerly', async () => {
    const view = await frontDoor();
    const images = [...view.container.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('alt'))).toEqual([
      'The Swift app’s Home screen: a Good afternoon greeting, search, and tiles for Food, Groceries, Taxi, Send, Services, Orders, Favourites and Scan.',
      'Live order tracking in the Swift app: the rider on the map and where the order stands.',
      'Booking a taxi in the Swift app: pickup, destination and the fare for each ride before you request it.',
      'The rider’s side of the Swift app: a map of Georgetown and the button to go online for jobs.',
    ]);
    for (const img of images) {
      expect(Number(img.getAttribute('width')), img.alt).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height')), img.alt).toBeGreaterThan(0);
    }
    expect(images[0]!.getAttribute('loading')).not.toBe('lazy');
    expect(images.slice(1).map((img) => img.getAttribute('loading'))).toEqual(['lazy', 'lazy', 'lazy']);
  });

  it('the screens never carry a name, a rating, a review or earnings in their words', async () => {
    const view = await frontDoor();
    const alts = [...view.container.querySelectorAll('img')].map((img) => img.alt).join(' ');
    expect(alts).not.toMatch(/Demo|Kezia|rating|review|earn(ed|ings)/i);
  });

  it('on a phone the Order / Ride / Earn cards are one swipe row; on a wide screen, three columns', async () => {
    const view = await frontDoor();
    const row = view.container.querySelector('[data-swipe-row]')!;
    expect(row).toBeTruthy();
    for (const cls of ['overflow-x-auto', 'snap-x', 'snap-mandatory', 'md:grid', 'md:grid-cols-3', 'md:overflow-visible']) expect(row.className, cls).toContain(cls);
    expect(row.querySelectorAll(':scope > article').length).toBe(3);
  });

  // [REVIEW-F S3-1] The page's focus ring is the brand maroon, invisible on the maroon Earn card: its two links
  // draw a white ring instead (WCAG 2.4.7).
  it('the Earn card\'s links show a white focus ring on the maroon card', async () => {
    await frontDoor();
    for (const name of ['Become a partner', 'See pricing']) {
      const link = screen.getByRole('link', { name });
      expect(link.className, name).toContain('focus-visible:outline-[var(--swift-white)]');
    }
  });

  // [REVIEW-F S4-1] The support hours come from the company facts, never typed into the page.
  it('the support line reads the hours from site.config, in Guyana time', async () => {
    const view = await frontDoor();
    const { site } = await import('@/site.config');
    expect(site.supportDays).toContain('Guyana time');
    expect(site.supportHours.startsWith(site.supportDays)).toBe(true);
    expect(view.container.textContent).toContain(`People answer Help & Support in the app, ${site.supportDays}.`);
  });

  // [REVIEW-F S4-2] Turning the store switch on must not move the page: the store area keeps the height of the
  // two buttons (one 56 px row, never wrapping) in both states.
  it('the store area keeps one button-row of height whether the stores are live or not', async () => {
    const view = await frontDoor();
    const area = view.container.querySelector('[data-store-area]')!;
    expect(area).toBeTruthy();
    expect(area.className).toContain('min-h-14');
    const { readFileSync } = await import('node:fs');
    const buttons = readFileSync(join(SRC, 'components', 'app-store-links.tsx'), 'utf8');
    expect(buttons).toMatch(/aria-label="Get the Swift app" className=\{`flex flex-nowrap gap-3/);
  });

  it('no heading skips a level, and axe finds nothing', async () => {
    const view = await frontDoor();
    const levels = [...view.container.querySelectorAll('h1, h2, h3, h4')].map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => { if (i > 0) expect(level - levels[i - 1]!).toBeLessThanOrEqual(1); });
    const { axeViolations } = await import('@/test/axe');
    expect(await axeViolations(view.container)).toEqual([]);
  });
});

describe('[Item 7] the CTAs that lead to ordering follow the switch', () => {
  it('/welcome on the closed public site offers no ordering, only the launch note', async () => {
    await configWith('');
    openAt('https://swiftgy.com/welcome');
    const { default: WelcomePage } = await import('@/app/(marketing)/welcome/page');
    render(<WelcomePage />);
    await answered();
    expect(screen.queryByRole('link', { name: 'Order on the web' })).toBeNull();
    expect(screen.getByText('Launching soon in Georgetown')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'List your business' }).getAttribute('href')).toBe('/vendors');
  });

  it('/welcome on staging still sends customers to order', async () => {
    await configWith('');
    openAt('https://staging.swiftgy.com/welcome');
    const { default: WelcomePage } = await import('@/app/(marketing)/welcome/page');
    render(<WelcomePage />);
    expect(screen.getByRole('link', { name: 'Order on the web' }).getAttribute('href')).toBe('/');
  });

  it('sign-up on the closed public site cannot start a customer account; business and driver sign-up stay open', async () => {
    await configWith('');
    openAt('https://swiftgy.com/signup');
    const { default: SignupPage } = await import('@/app/signup/page');
    render(<SignupPage />);
    await answered();
    const customer = screen.getByRole('button', { name: /Order on Swift/ });
    expect((customer as HTMLButtonElement).disabled).toBe(true);
    expect(customer.textContent).toContain('Launching soon in Georgetown');
    expect((screen.getByRole('button', { name: /Put my business on Swift/ }) as HTMLButtonElement).disabled).toBe(false);
    // [W9] Riders and taxi drivers are now two doors; both stay open.
    expect((screen.getByRole('button', { name: /Deliver with Swift/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /Drive a taxi with Swift/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the footer never says store ordering works in the browser where it does not', async () => {
    for (const [switchValue, url, note] of [
      ['', 'https://swiftgy.com/legal/refunds', 'Ordering opens soon in Georgetown.'],
      ['', 'https://staging.swiftgy.com/legal/refunds', 'Store ordering works in your browser.'],
      ['live', 'https://swiftgy.com/legal/refunds', 'Store ordering works in your browser.'],
    ] as const) {
      await configWith(switchValue);
      openAt(url);
      const { SiteFooter } = await import('@/components/site');
      const view = render(<SiteFooter />);
      if (url.startsWith('https://swiftgy.com')) await answered();
      const footerText = view.container.textContent ?? '';
      expect(footerText, url).toContain(note);
      expect(footerText, url).toContain('Taxi rides require the Swift mobile app.');
      if (note.startsWith('Ordering')) expect(footerText, url).not.toContain('works in your browser');
      view.unmount();
    }
  });

  it('/welcome and the FAQ claim browser ordering only where it works', async () => {
    for (const [route, openClaim] of [
      ['@/app/(marketing)/welcome/page', "Order from stores in your phone's browser, tracking included."],
      ['@/app/(marketing)/faq/page', "Store ordering and order tracking work in your phone's browser."],
    ] as const) {
      for (const [switchValue, url, open] of [
        ['', 'https://swiftgy.com/', false],
        ['', 'https://staging.swiftgy.com/', true],
        ['live', 'https://swiftgy.com/', true],
      ] as const) {
        await configWith(switchValue);
        openAt(url);
        const { default: Page } = (await import(/* @vite-ignore */ route)) as { default: () => React.ReactNode };
        const view = render(<>{Page()}</>);
        if (url.startsWith('https://swiftgy.com')) await answered();
        const words = view.container.textContent ?? '';
        if (open) expect(words, `${route} at ${url}`).toContain(openClaim);
        else {
          expect(words, `${route} at ${url}`).not.toContain("phone's browser");
          expect(words, `${route} at ${url}`).toContain('Ordering opens soon in Georgetown.');
        }
        expect(words, `${route} at ${url}`).toMatch(/Taxi rides require the Swift mobile app/);
        view.unmount();
      }
    }
  });

  it('until the server has answered, and if it cannot, the public site shows no ordering', async () => {
    await configWith('live');
    let answer!: (_value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    openAt('https://swiftgy.com/signup');
    const { default: SignupPage } = await import('@/app/signup/page');
    render(<SignupPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // Waiting for the answer: closed, even though the server's switch is live.
    expect((screen.getByRole('button', { name: /Order on Swift/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { answer(new Response('busy', { status: 503 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The question failed: still closed.
    expect((screen.getByRole('button', { name: /Order on Swift/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sign-up on staging, or once live, starts a customer account as before', async () => {
    for (const [switchValue, url] of [['', 'https://staging.swiftgy.com/signup'], ['live', 'https://swiftgy.com/signup']] as const) {
      await configWith(switchValue);
      openAt(url);
      const { default: SignupPage } = await import('@/app/signup/page');
      const view = render(<SignupPage />);
      if (url.startsWith('https://swiftgy.com')) await answered();
      expect((screen.getByRole('button', { name: /Order on Swift/ }) as HTMLButtonElement).disabled, url).toBe(false);
      view.unmount();
    }
  });
});
