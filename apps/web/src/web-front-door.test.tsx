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
vi.mock('@/lib/customer', () => ({ verifyOtp: vi.fn(), registerAccount: vi.fn(), becomePartner: vi.fn() }));
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
  it('says "Launching soon in Georgetown" and links to /welcome and the company and legal pages', async () => {
    await configWith('');
    const { default: FrontDoor } = await load<{ default: () => React.ReactNode }>('app/(marketing)/launching-soon/page.tsx');
    render(<>{FrontDoor()}</>);
    expect(screen.getByRole('heading', { level: 1, name: 'Launching soon in Georgetown' })).toBeTruthy();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const href of ['/welcome', '/about', '/contact', '/pricing', '/legal/refunds', '/legal/delivery', '/legal/terms', '/legal/privacy']) {
      expect(hrefs, href).toContain(href);
    }
    expect(hrefs).not.toContain('/cart');
    expect(hrefs).not.toContain('/');
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
    expect((screen.getByRole('button', { name: /Drive & deliver/ }) as HTMLButtonElement).disabled).toBe(false);
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
