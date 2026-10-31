import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [OPEN-EARLY · owner 31 Oct 2026] Partners arrive from the proposals before
// ordering opens: businesses, riders and taxi drivers sign up and send their
// documents now; a person checks them now and approves partners on launch day.
// The public site says exactly that, and nothing more:
//  - the front door: "Opening soon" with a Join Swift button, the Order and
//    Ride cards marked "Opening soon", the Earn card first on a phone;
//  - /signup?as=business|rider|driver opens on that door's phone step (never
//    the customer door), and the partner pages link the right door;
//  - the pre-launch partner note shows on the public site only once the server
//    said "not open yet": never on a guess, never once live, never on staging.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const NOTE = 'Swift opens in Georgetown soon. We check documents now and approve partners on launch day. Your free trial starts the day you are approved.';

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn(), pricing: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace, push: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: vi.fn() }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become, signOwnName: vi.fn() }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: vi.fn(), placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('@/app/signup/weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchPricing: fx.pricing }));
// The partner consoles' chrome needs a session; here only what the layout puts inside it matters.
vi.mock('@/app/portal/portal-shell', () => ({ PortalShell: ({ children }: { children: ReactNode }) => <div data-shell="portal">{children}</div> }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ DashboardShell: ({ children }: { children: ReactNode }) => <div data-shell="dashboard">{children}</div> }));
vi.mock('@/components/legal-acceptance-gate', () => ({ LegalAcceptanceGate: () => null }));

async function load<T>(relativePath: string): Promise<T> {
  const path = join(SRC, relativePath);
  expect(existsSync(path), `${relativePath} does not exist`).toBe(true);
  return (await import(/* @vite-ignore */ path)) as T;
}

/** A fresh page load against a web server whose switch is `webOrdering`; /api/launch-state answers as the route does. */
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
}

async function answered() {
  await waitFor(() => expect(launchQuestions).toBeGreaterThan(0));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function openAt(url: string) {
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  fx.pricing.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  openAt('http://localhost:3000/');
});

describe('[OPEN-EARLY] the front door says "opening soon" and leads partners in', () => {
  async function frontDoor() {
    await configWith('');
    const { default: FrontDoor } = await load<{ default: () => ReactNode }>('app/(marketing)/launching-soon/page.tsx');
    return render(<>{FrontDoor()}</>);
  }

  it('the hero says Swift is opening soon, that partners can sign up now, with a Join Swift button above the store area', async () => {
    const view = await frontDoor();
    const hero = view.container.querySelector('[data-opening-soon-hero]')!;
    expect(hero).toBeTruthy();
    expect(hero.textContent).toContain('Opening soon in Georgetown. Businesses, riders and taxi drivers can sign up now.');
    const join = within(hero as HTMLElement).getByRole('link', { name: 'Join Swift' });
    expect(join.getAttribute('href')).toBe('/signup');
    const storeArea = view.container.querySelector('[data-store-area]')!;
    expect(hero.compareDocumentPosition(storeArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the Order and Ride cards are marked "Opening soon" with a muted screen; the Earn card is not', async () => {
    const view = await frontDoor();
    const cards = [...view.container.querySelectorAll('[data-swipe-row] > article')];
    const titleOf = (card: Element) => card.querySelector('h2')!.textContent;
    expect(cards.map(titleOf)).toEqual(['Order', 'Ride', 'Earn with Swift']);
    for (const card of cards.slice(0, 2)) {
      expect(card.hasAttribute('data-opening-soon'), titleOf(card)!).toBe(true);
      expect(within(card as HTMLElement).getByText('Opening soon')).toBeTruthy();
      expect(card.querySelector('img')!.closest('.opacity-60'), titleOf(card)!).toBeTruthy();
    }
    expect(within(cards[2] as HTMLElement).queryByText('Opening soon')).toBeNull();
  });

  it('on a phone the Earn card comes first in the swipe row; on a wide screen it is back in third place', async () => {
    const view = await frontDoor();
    const earn = view.container.querySelector('[data-earn-card]')!;
    expect(earn.className.split(' ')).toEqual(expect.arrayContaining(['order-first', 'md:order-none']));
    expect(within(earn as HTMLElement).getByRole('link', { name: 'Become a partner' }).getAttribute('href')).toBe('/signup');
  });

  it('still reads as a launch page: no em dash and no promise of ordering', async () => {
    const view = await frontDoor();
    const words = view.container.textContent ?? '';
    expect(words).not.toContain('—');
    expect(words).not.toMatch(/order now|book now|available now/i);
  });
});

describe('[OPEN-EARLY] /signup?as= opens on a partner door', () => {
  async function signupAt(url: string) {
    openAt(url);
    const { default: SignupPage } = await import('@/app/signup/page');
    return render(<SignupPage />);
  }

  it.each([
    ['business', 'Put my business on Swift'],
    ['rider', 'Deliver with Swift'],
    ['driver', 'Drive a taxi with Swift'],
  ])('?as=%s opens on the phone step of "%s", and Back reaches the four doors', async (door, title) => {
    await signupAt(`http://localhost:3000/signup?as=${door}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Confirm your phone' })).toBeTruthy();
    expect(screen.getByText(`Signing up as: ${title}`)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go back one signup step' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Who are you signing up as?' })).toBeTruthy();
  });

  it.each([
    ['business', 'VENDOR', 'Your business', null],
    ['rider', 'MOVER', 'How you deliver', 'MOTORCYCLE'],
    ['driver', 'MOVER', 'Your taxi', 'CAR'],
  ])('?as=%s signs up as that partner, on its own vehicles', async (door, accountRole, heading, vehicle) => {
    await signupAt(`http://localhost:3000/signup?as=${door}`);
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText('Phone number'), { target: { value: '+5926001234' } });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Partner' } });
    await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
    await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(fx.register.mock.calls[0]![0]).toMatchObject({ role: accountRole });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    if (!vehicle) return;
    // The door's own first vehicle is chosen, so the partner can create the account without touching the list.
    if (door === 'driver') {
      for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Axio'], ['Year', '2018'], ['Colour', 'Silver'], ['Licence plate', 'HAA 1234']]) {
        fireEvent.change(screen.getByLabelText(label!), { target: { value } });
      }
    }
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await user.click(screen.getByRole('button', { name: door === 'driver' ? 'Create driver account' : 'Create rider account' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'MOVER', vehicleType: vehicle });
  });

  it('no link opens the customer door, nor a door named any other way: the four doors show', async () => {
    for (const value of ['customer', 'CUSTOMER', 'Business', 'vendor', 'VENDOR', 'taxi', '', 'business ']) {
      const view = await signupAt(`http://localhost:3000/signup?as=${encodeURIComponent(value)}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(screen.getByRole('heading', { level: 1, name: 'Who are you signing up as?' }), value).toBeTruthy();
      view.unmount();
    }
  });

  it('on the closed public site ?as=customer stays on the doors, with the customer door closed', async () => {
    await configWith('');
    await signupAt('https://swiftgy.com/signup?as=customer');
    await answered();
    expect(screen.getByRole('heading', { level: 1, name: 'Who are you signing up as?' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Order on Swift/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a business account resuming its store keeps its own path, whatever ?as= says', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { phone: '+5926001234' } });
    const resumed = await signupAt('http://localhost:3000/signup?resume=business&as=rider');
    expect(await screen.findByRole('heading', { level: 1, name: 'Your business' })).toBeTruthy();
    resumed.unmount();
    // Not signed in: the resume path shows the four doors, as it always did; ?as= does not take over.
    fx.probe.mockResolvedValue({ ok: false });
    await signupAt('http://localhost:3000/signup?resume=business&as=rider');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole('heading', { level: 1, name: 'Who are you signing up as?' })).toBeTruthy();
  });
});

describe('[OPEN-EARLY] the partner pages link the right door', () => {
  it('For businesses opens sign-up on the business door', async () => {
    await configWith('');
    const { default: VendorsPage } = await import('@/app/(marketing)/vendors/page');
    render(<>{VendorsPage()}</>);
    expect(screen.getByRole('link', { name: 'Start a business account' }).getAttribute('href')).toBe('/signup?as=business');
  });

  it('For riders and drivers offers two doors: delivery rider and taxi driver', async () => {
    await configWith('');
    const { default: DriversPage } = await import('@/app/(marketing)/drivers/page');
    render(<>{DriversPage()}</>);
    expect(screen.getByRole('link', { name: 'Deliver with Swift' }).getAttribute('href')).toBe('/signup?as=rider');
    expect(screen.getByRole('link', { name: 'Drive a taxi with Swift' }).getAttribute('href')).toBe('/signup?as=driver');
    expect(screen.queryByRole('link', { name: 'Start a driver account' })).toBeNull();
  });

  it('Pricing carries a Join Swift section with each partner door', async () => {
    await configWith('');
    const { default: PricingPage } = await import('@/app/(marketing)/pricing/page');
    render(await PricingPage({ searchParams: Promise.resolve({}) }));
    const section = screen.getByRole('heading', { level: 2, name: 'Join Swift' }).closest('section')!;
    const links = within(section).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Join Swift', '/signup'],
      ['Put my business on Swift', '/signup?as=business'],
      ['Deliver with Swift', '/signup?as=rider'],
      ['Drive a taxi with Swift', '/signup?as=driver'],
    ]);
  });
});

describe('[OPEN-EARLY] the pre-launch partner note', () => {
  async function note(webOrdering: string, url: string) {
    await configWith(webOrdering);
    openAt(url);
    const { PrelaunchPartnerNote } = await import('@/components/prelaunch-partner-note');
    return render(<PrelaunchPartnerNote />);
  }

  it('on the closed public site it says, once the server answered, that partners are approved on launch day', async () => {
    const view = await note('', 'https://swiftgy.com/portal');
    expect(view.container.textContent).toBe('');
    await answered();
    expect(screen.getByRole('note').textContent).toBe(NOTE);
  });

  it('once live it never shows, and nor while the answer is on its way or if the question fails', async () => {
    const live = await note('live', 'https://swiftgy.com/portal');
    await answered();
    expect(live.container.textContent).toBe('');
    live.unmount();

    await configWith('');
    let answer!: (_value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    openAt('https://swiftgy.com/portal');
    const { PrelaunchPartnerNote } = await import('@/components/prelaunch-partner-note');
    const failed = render(<PrelaunchPartnerNote />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(failed.container.textContent).toBe('');
    await act(async () => { answer(new Response('busy', { status: 503 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(failed.container.textContent).toBe('');
    failed.unmount();

    // No connection at all: still nothing.
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const again = await import('@/components/prelaunch-partner-note');
    const offline = render(<again.PrelaunchPartnerNote />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(offline.container.textContent).toBe('');
  });

  it('staging and local runs never show it and never ask', async () => {
    for (const url of ['https://staging.swiftgy.com/portal', 'http://localhost:3000/portal']) {
      const view = await note('', url);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(view.container.textContent, url).toBe('');
      expect(launchQuestions, url).toBe(0);
      view.unmount();
    }
  });

  // A new partner lands on these right after sign-up (a store on /dashboard, a rider or driver on /portal).
  it('every partner console page carries it, above the page: the earner portal and the store console', async () => {
    for (const [layout, shell] of [['app/portal/layout.tsx', 'portal'], ['app/dashboard/layout.tsx', 'dashboard']] as const) {
      await configWith('');
      openAt(`https://swiftgy.com/${shell}`);
      const { default: Layout } = await load<{ default: (_p: { children: ReactNode }) => ReactNode }>(layout);
      const view = render(<>{Layout({ children: <p data-page>page</p> })}</>);
      await answered();
      const inside = view.container.querySelector(`[data-shell="${shell}"]`)!;
      await waitFor(() => expect(inside.querySelector('[data-prelaunch-partner-note]'), layout).toBeTruthy());
      const banner = inside.querySelector('[data-prelaunch-partner-note]')!;
      expect(banner?.textContent, layout).toBe(NOTE);
      expect(banner.compareDocumentPosition(inside.querySelector('[data-page]')!) & Node.DOCUMENT_POSITION_FOLLOWING, layout).toBeTruthy();
      view.unmount();
    }
  });

  it('the For businesses, For riders and drivers and Pricing pages carry it under their sign-up buttons', () => {
    for (const page of ['app/(marketing)/vendors/page.tsx', 'app/(marketing)/drivers/page.tsx', 'app/(marketing)/pricing/page.tsx']) {
      expect(readFileSync(join(SRC, page), 'utf8'), page).toMatch(/<PrelaunchPartnerNote className="mt-6[^"]*" \/>/);
    }
  });
});

// [OPEN-EARLY · owner 31 Oct 2026] "Most businesses clear review within a day" is not true before launch: Swift checks
// documents as they arrive and approves partners on launch day. The partner pages follow the same server answer as
// the note: "soon" says launch day; open (live, or staging) keeps the review-time words; while the answer is on its
// way, or if it fails, a sentence true in both states.
describe('[OPEN-EARLY] the partner pages never promise review within a day before launch', () => {
  const SOON = 'We check documents as they arrive and approve partners on launch day.';
  const PAGES = [
    ['For businesses', 'app/(marketing)/vendors/page.tsx', 'Most businesses clear review within a day'],
    ['For riders and drivers', 'app/(marketing)/drivers/page.tsx', 'Most riders clear review within a day'],
    ['Questions', 'app/(marketing)/faq/page.tsx', 'Most businesses clear review within a day'],
  ] as const;

  async function page(file: string) {
    const { default: Page } = await load<{ default: () => ReactNode }>(file);
    return render(<>{Page()}</>);
  }

  it.each(PAGES)('%s on the closed public site says launch day, never "within a day"', async (_name, file) => {
    await configWith('');
    openAt('https://swiftgy.com/');
    const view = await page(file);
    await answered();
    await waitFor(() => expect(view.container.textContent).toContain(SOON));
    expect(view.container.textContent).not.toMatch(/within a day/i);
  });

  it.each(PAGES)('%s once live (and on staging) keeps its review-time words', async (_name, file, live) => {
    for (const [switchValue, url] of [['live', 'https://swiftgy.com/'], ['', 'https://staging.swiftgy.com/']] as const) {
      await configWith(switchValue);
      openAt(url);
      const view = await page(file);
      if (url.startsWith('https://swiftgy.com')) await answered();
      await waitFor(() => expect(view.container.textContent, url).toContain(live));
      expect(view.container.textContent, url).not.toContain(SOON);
      view.unmount();
    }
  });

  it.each(PAGES)('%s says neither while the answer is on its way, nor if it fails', async (_name, file) => {
    await configWith('');
    let answer!: (_value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    openAt('https://swiftgy.com/');
    const view = await page(file);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(view.container.textContent).not.toMatch(/within a day/i);
    expect(view.container.textContent).not.toContain(SOON);
    expect(view.container.textContent).toContain('A person checks your documents before you go live.');
    await act(async () => { answer(new Response('busy', { status: 503 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.container.textContent).not.toMatch(/within a day/i);
    expect(view.container.textContent).not.toContain(SOON);
  });

  it('no web page states a review time outside that switch', () => {
    const hits = execSync(`grep -rniE "within a day|same-day review|24 hours to (review|approve)|approved (in|within)" ${join(SRC, 'app')} ${join(SRC, 'components')} --include=*.tsx || true`, { encoding: 'utf8' })
      .split('\n').filter((line) => line && !/\.test\./.test(line));
    for (const line of hits) expect(line, line).toMatch(/live="/);
  });
});
