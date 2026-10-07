import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from '../layout';
import ServicesPage from './page';
import ServiceRequestsPage from './requests/page';
import ServiceRequestPage from './requests/[id]/page';

const state = vi.hoisted(() => ({ pathname: '/services', params: {} as Record<string, string>, query: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ push: state.push, back: vi.fn(), replace: state.replace }),
}));
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'live' },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swiftgy.com',
}));

// ---------------------------------------------------------------------------
// [W11] Local pros on the web — the app's Services screen and job card:
// browse the services that take requests and their checked pros (public, in
// the page from the server), ask a pro for a quote (needs an account), then
// follow the request: accept the quote by booking a time, cancel before it is
// booked, rate the work when it is done. Emergency numbers whenever someone is
// coming or on site.
// ---------------------------------------------------------------------------

const CATALOG = {
  version: 1, documentNotice: 'x',
  categories: [
    { id: 'electrician', label: 'Electrician', group: 'HOME_AND_TRADES', riskTier: 'HIGH', modes: ['QUOTE_JOB'], quoteRequestsEnabled: true, appointmentsEnabled: false, availabilityMessage: null, documents: [] },
    { id: 'tutor', label: 'Tutor', group: 'EDUCATION', riskTier: 'LOW', modes: ['QUOTE_JOB'], quoteRequestsEnabled: true, appointmentsEnabled: false, availabilityMessage: 'Request a quote and agree a time with your provider.', documents: [] },
    { id: 'gas_fitter', label: 'Gas fitter', group: 'HOME_AND_TRADES', riskTier: 'HIGH', modes: ['QUOTE_JOB'], quoteRequestsEnabled: false, appointmentsEnabled: false, availabilityMessage: 'Not available yet.', documents: [] },
  ],
};
const PRO = { id: 'p1', trade: 'electrician', tradeLabel: 'Electrician', bio: 'Rewiring and fault finding.', displayRating: 4.7, totalRatings: 23, certified: true, selfSkilled: false, badges: ['LICENCE'] };
const PROVIDERS = { trade: 'electrician', tradeLabel: 'Electrician', riskTier: 'HIGH', guidance: 'Electrical work needs a licensed pro.', providers: [PRO], page: { limit: 20, nextCursor: null } };
const JOB = { id: 'j1', customerId: 'c1', providerId: 'p1', description: 'Kitchen light keeps tripping the breaker', status: 'QUOTED', quoteAmount: '6000', scheduledFor: null, providerConfirmedAt: null, createdAt: '2026-10-06T12:00:00Z' };

let signedIn = false;
let job: Record<string, unknown> = JOB;
let providers: unknown = PROVIDERS;
let api: (_request: ApiRequest) => ApiReply | Promise<ApiReply>;
let fetchMock: ReturnType<typeof mockApi>;
const calls = (path: string, method = 'GET') => fetchMock.mock.calls
  .filter(([url, init]) => new URL(String(url)).pathname === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  signedIn = false;
  job = JOB;
  providers = PROVIDERS;
  state.pathname = '/services';
  state.params = {};
  state.query = '';
  state.push.mockReset();
  api = ({ url, method, init }) => {
    if (url.pathname === '/api/v1/auth/me') return signedIn ? { body: { success: true, data: { user: { id: 'c1' } } } } : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return { body: { success: true, data: { visible: false, items: 0, vendors: 0 } } };
    if (url.pathname === '/api/v1/services/catalog') return { body: { success: true, data: CATALOG } };
    if (url.pathname === '/api/v1/services/providers') return { body: { success: true, data: providers } };
    if (url.pathname === '/api/v1/services/jobs' && method === 'POST') return { body: { success: true, data: { ...JOB, id: 'j9', status: 'REQUESTED' } } };
    if (url.pathname === '/api/v1/services/jobs') return { body: { success: true, data: [JOB, { ...JOB, id: 'j2', customerId: 'someone-else', description: 'A job this account does as a pro' }] } };
    if (url.pathname === '/api/v1/services/jobs/j1') return { body: { success: true, data: job } };
    if (url.pathname === '/api/v1/services/jobs/j1/schedule') {
      const { scheduledFor } = JSON.parse(String(init?.body));
      return { body: { success: true, data: { ...job, status: 'SCHEDULED', scheduledFor } } };
    }
    if (url.pathname === '/api/v1/services/jobs/j1/cancel') return { body: { success: true, data: { ...job, status: 'CANCELLED' } } };
    if (url.pathname === '/api/v1/services/jobs/j1/rate') return { body: { success: true, data: { id: 'r1' } } };
    return { status: 404, body: { success: false } };
  };
  fetchMock = mockApi((request) => api(request));
});

async function servicesAt(trade: string) {
  state.query = trade ? `trade=${trade}` : '';
  const page = await ServicesPage({ searchParams: Promise.resolve(trade ? { trade } : {}) });
  return render(<AppLayout>{page}</AppLayout>);
}

describe('[W11] browse local pros', () => {
  it('shows only the services that take requests, grouped as the app groups them — in the page from the server', async () => {
    await servicesAt('');
    expect(calls('/api/v1/services/catalog')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Local pros' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Home, repairs & trades' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lessons & tutoring' })).toBeTruthy();
    const kinds = within(screen.getByRole('navigation', { name: 'Kinds of service' })).getAllByRole('link').map((link) => link.textContent);
    expect(kinds).toEqual(['Electrician', 'Tutor']);
    expect(screen.queryByText('Gas fitter')).toBeNull();
  });

  it('a chosen service lists its checked pros, licence first, with the safety guidance — already in the page', async () => {
    await servicesAt('electrician');
    expect(calls('/api/v1/services/providers')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Electrician' })).toBeTruthy();
    expect(screen.getByText('Electrical work needs a licensed pro.')).toBeTruthy();
    expect(screen.getByText('Licensed')).toBeTruthy();
    expect(screen.getByText('4.7 (23)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask for a quote' })).toBeTruthy();
  });

  it('a service that does not take requests, or one that does not exist, is never asked for on the server', async () => {
    await servicesAt('gas_fitter');
    await servicesAt('not-a-service');
    expect(calls('/api/v1/services/providers')).toHaveLength(0);
  });

  it('no pros yet is said plainly — never an empty page', async () => {
    providers = { ...PROVIDERS, providers: [] };
    await servicesAt('electrician');
    expect(screen.getByText(/No electrician pros near you yet/)).toBeTruthy();
  });
});

describe('[W11] ask a pro for a quote', () => {
  it('a guest is sent to sign in, and brought back to the same service', async () => {
    await servicesAt('electrician');
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a quote' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask for a quote' });
    expect((within(dialog).getByRole('button', { name: 'Describe the job to send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('What do you need done?'), { target: { value: 'Kitchen light keeps tripping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/login?next=%2Fservices%3Ftrade%3Delectrician'));
    expect(calls('/api/v1/services/jobs', 'POST')).toHaveLength(0);
  });

  it('a signed-in customer sends the request to that pro and lands on it', async () => {
    signedIn = true;
    await servicesAt('electrician');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Your requests' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a quote' }));
    fireEvent.change(screen.getByLabelText('What do you need done?'), { target: { value: '  Kitchen light keeps tripping  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/services/requests/j9'));
    expect(JSON.parse(String((calls('/api/v1/services/jobs', 'POST')[0]![1] as RequestInit).body))).toEqual({ providerId: 'p1', description: 'Kitchen light keeps tripping' });
  });
});

describe('[W11] follow a request', () => {
  beforeEach(() => { signedIn = true; });

  it('the list holds the customer’s own requests only — not jobs this account does as a pro', async () => {
    state.pathname = '/services/requests';
    render(<AppLayout><ServiceRequestsPage /></AppLayout>);
    expect(await screen.findByText('Kitchen light keeps tripping the breaker')).toBeTruthy();
    expect(screen.queryByText('A job this account does as a pro')).toBeNull();
    expect(screen.getByRole('link', { name: /Kitchen light/ }).getAttribute('href')).toBe('/services/requests/j1');
  });

  it('a quote is accepted by booking a time, sent as the Guyana wall-clock instant the app sends', async () => {
    state.pathname = '/services/requests/j1';
    state.params = { id: 'j1' };
    render(<AppLayout><ServiceRequestPage /></AppLayout>);
    expect(await screen.findByText('$6,000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(screen.getByRole('button', { name: '10:00' }));
    fireEvent.click(screen.getByRole('button', { name: /^Accept and book — Tomorrow 10:00$/ }));
    expect(await screen.findByText(/^Booked for /)).toBeTruthy();
    const { serviceJobScheduleSelection, upcomingAppointmentDays } = await import('@/lib/service-jobs');
    const sent = JSON.parse(String((calls('/api/v1/services/jobs/j1/schedule', 'POST')[0]![1] as RequestInit).body));
    expect(sent).toEqual({ scheduledFor: serviceJobScheduleSelection(upcomingAppointmentDays()[1]!.key, '10:00').scheduledFor });
  });

  it('a request can be cancelled before it is booked, after a confirmation', async () => {
    state.pathname = '/services/requests/j1';
    state.params = { id: 'j1' };
    job = { ...JOB, status: 'REQUESTED', quoteAmount: null };
    render(<AppLayout><ServiceRequestPage /></AppLayout>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }));
    expect(calls('/api/v1/services/jobs/j1/cancel', 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Cancelled' })).toBeTruthy();
  });

  it('once someone is coming, the emergency numbers are on the page and the request can no longer be cancelled here', async () => {
    state.pathname = '/services/requests/j1';
    state.params = { id: 'j1' };
    job = { ...JOB, status: 'SCHEDULED', scheduledFor: '2026-10-08T14:00:00Z', providerConfirmedAt: '2026-10-07T12:00:00Z' };
    render(<AppLayout><ServiceRequestPage /></AppLayout>);
    expect((await screen.findByRole('link', { name: 'Police 911' })).getAttribute('href')).toBe('tel:911');
    expect(screen.getByRole('link', { name: 'Ambulance 913' }).getAttribute('href')).toBe('tel:913');
    expect(screen.getByText(/The pro confirmed the time/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
  });

  it('a finished job can be rated once', async () => {
    state.pathname = '/services/requests/j1';
    state.params = { id: 'j1' };
    job = { ...JOB, status: 'COMPLETED' };
    render(<AppLayout><ServiceRequestPage /></AppLayout>);
    fireEvent.click(await screen.findByRole('radio', { name: '4 stars' }));
    expect(await screen.findByText(/your rating is saved/)).toBeTruthy();
    expect(JSON.parse(String((calls('/api/v1/services/jobs/j1/rate', 'POST')[0]![1] as RequestInit).body))).toEqual({ score: 4 });
    expect((screen.getByRole('radio', { name: '5 stars' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('[W11] before launch, the public site keeps services behind the front door like every ordering page', () => {
  it.each(['/services', '/services?trade=electrician', '/services/requests', '/services/requests/j1'])('%s passes through the front-door middleware', async (path) => {
    const { config } = await import('@/middleware');
    expect(unstable_doesMiddlewareMatch({ config, url: `https://swiftgy.com${path}` })).toBe(true);
  });
});
