import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { accountHoldsRole, roleSwitchAuthorityPayload } from '../lib/roleLanding';
import { classifyVendorProfile, unwrapOptionalVendorProfile } from '../lib/vendorProfile';
import { resolveMoverProfile, unwrapOptionalMoverProfile } from '../lib/moverProfile';

// ---------------------------------------------------------------------------
// [phone feedback P2] "Switching role to business, rider or driver shows a
// broken screen."
//
// The owner's fresh account holds only CUSTOMER. Tapping "Swift Business"
// (Join) set `intent` and mounted the vendor shell, whose profile probe the
// server answered with 403 — deliberately: the API's authz matrix pins that a
// wrong-role token gets 401/403 on every /vendor, /driver and /rider route,
// never a 404 route oracle. The shell read that 403 as a permission failure
// ("This account cannot open that store. Ask the owner to add you again.")
// instead of what it is for an account that holds no vendor role: no business
// yet → the setup wizard. The mover shell's two probes hit the same 403 three
// times each (retry: 2) and carried an error into the application screen.
//
// The seam is the app. It knows the account's own roles — the switcher's Join
// branch already decides by them — so the shells read an outsider's 403 as
// "no profile yet" and open the JOIN flow, which provisions through the real
// route (POST /partner/become grants the role and the entity in one
// transaction) and then re-probes as an insider. The server contract is
// untouched. The API half of this journey is proven in
// apps/api/src/__tests__/role-join-journey.test.ts; this file proves the app
// half with the real query machinery and the real screen sources.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const SWITCHER = read('../components/RoleSwitcherSheet.tsx');
const VENDOR_STACK = read('../modules/vendor/VendorStack.tsx');
const VENDOR_HOOKS = read('../hooks/vendorops.ts');
const MOVER_STACK = read('../modules/mover/MoverStack.tsx');
const MOVER_HOOKS = read('../hooks/mover.ts');
const BUSINESS_SETUP = read('../modules/vendor/screens/BusinessSetup.tsx');
const MOVER_ONBOARDING = read('../modules/mover/screens/MoverOnboardingScreen.tsx');
const VERIFICATION_HOOKS = read('../hooks/verification.ts');
const AUTH_STORE = read('../stores/authStore.ts');
const API = read('../services/api.ts');

const customerOnly = { roles: ['CUSTOMER'], driver: null, rider: null, vendorOwner: null };
const forbidden = () => ({ response: { status: 403, data: { success: false, error: { code: 'FORBIDDEN', message: 'This account cannot access this resource' } } } });
const client = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });

describe('business: a customer with no business lands on the setup wizard, never the error screen', () => {
  it('the switcher reads the surface as Join and sends no switch-role for it', () => {
    expect(accountHoldsRole(customerOnly, 'vendor')).toBe(false);
    // no server authority call for an unheld surface (the server would 403 it)
    expect(roleSwitchAuthorityPayload('customer', 'vendor', false, ['CUSTOMER'], null)).toBeNull();
    expect(SWITCHER).toContain('const owns = (intent: Intent): boolean => accountHoldsRole(user, intent);');
    expect(SWITCHER).toContain('const owned = accountHoldsRole(operationUser, intent);');
  });

  it('the shell’s probe gets the server’s 403 once and classifies it as ABSENT → BusinessSetup', async () => {
    const qc = client();
    const probe = vi.fn(() => Promise.reject(forbidden()));
    const outsider = !accountHoldsRole(customerOnly, 'vendor');
    const observer = new QueryObserver(qc, {
      queryKey: ['vendor', 'profile'],
      queryFn: () => unwrapOptionalVendorProfile<{ vendors: unknown[] }>(probe(), { outsider }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isFetched).toBe(true));
    const result = observer.getCurrentResult();
    const verdict = classifyVendorProfile({ isLoading: result.isLoading, error: result.error, owner: result.data ?? null, fetched: result.isFetched });
    expect(verdict.state).toBe('absent');
    expect(verdict.failure).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
    unsubscribe();
    qc.clear();
    // and the shell really routes absent → the wizard, with the outsider flag from the account's own roles
    expect(VENDOR_HOOKS).toContain("const outsider = useAuthStore((s) => !accountHoldsRole(s.user as Parameters<typeof accountHoldsRole>[0], 'vendor'));");
    expect(VENDOR_HOOKS).toContain('unwrapOptionalVendorProfile<any>(vendorApi.profile(), { outsider })');
    expect(VENDOR_STACK).toContain('if (!store) return <BusinessSetup />;');
  });

  it('after "Create store" the same probe seats the owner: the pending store shows, then the dashboard once ACTIVE', async () => {
    const qc = client();
    let store = { id: 'v1', status: 'PENDING_APPROVAL' };
    const probe = vi.fn(async () => ({ data: { data: { myRole: 'OWNER', vendors: [store] } } }));
    const observer = new QueryObserver(qc, {
      queryKey: ['vendor', 'profile'],
      queryFn: () => unwrapOptionalVendorProfile<{ myRole: string; vendors: typeof store[] }>(probe(), { outsider: false }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isFetched).toBe(true));
    let result = observer.getCurrentResult();
    expect(classifyVendorProfile({ isLoading: result.isLoading, error: result.error, owner: result.data ?? null, fetched: result.isFetched }))
      .toEqual({ state: 'ready', myRole: 'OWNER' });
    expect(result.data?.vendors[0]?.status).toBe('PENDING_APPROVAL'); // → VendorOnboarding (document checklist)
    store = { id: 'v1', status: 'ACTIVE' };
    await observer.refetch();
    result = observer.getCurrentResult();
    expect(result.data?.vendors[0]?.status).toBe('ACTIVE'); // → VendorTabs
    unsubscribe();
    qc.clear();
    expect(VENDOR_STACK).toMatch(/store\.status !== 'ACTIVE' && !preview \? \(\s*<VendorOnboarding store=\{store\}/);
    expect(VENDOR_STACK).toMatch(/\) : \(\s*<VendorTabs \/>/);
  });

  it('an account that HOLDS the vendor role keeps the honest permission error on 403 — nothing is papered over', async () => {
    const holder = { roles: ['CUSTOMER', 'VENDOR_OWNER'] };
    const outsider = !accountHoldsRole(holder, 'vendor');
    expect(outsider).toBe(false);
    await expect(unwrapOptionalVendorProfile(Promise.reject(forbidden()), { outsider })).rejects.toBeTruthy();
    expect(classifyVendorProfile({ isLoading: false, error: forbidden(), owner: undefined, fetched: true }))
      .toEqual({ state: 'error', failure: 'forbidden', myRole: undefined });
    expect(VENDOR_STACK).toContain("failure === 'forbidden' ? 'This account cannot open that store. Ask the owner to add you again.'");
  });
});

describe('rider and driver: a customer with no mover account lands on the application, with no probe storm', () => {
  it('both profile probes answer 403 ONCE each under retry: 2, resolve to "no profile", and carry no error', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    const outsider = !accountHoldsRole(customerOnly, 'mover');
    const driverProbe = vi.fn(() => Promise.reject(forbidden()));
    const riderProbe = vi.fn(() => Promise.reject(forbidden()));
    const retryDelay = (attempt: number) => Math.min(500 * (2 ** attempt), 2_000);
    const driver = new QueryObserver(qc, { queryKey: ['mover', 'driverProfile'], queryFn: () => unwrapOptionalMoverProfile(driverProbe(), { outsider }), retry: 2, retryDelay });
    const rider = new QueryObserver(qc, { queryKey: ['mover', 'riderProfile'], queryFn: () => unwrapOptionalMoverProfile(riderProbe(), { outsider }), retry: 2, retryDelay });
    const stop = [driver.subscribe(() => {}), rider.subscribe(() => {})];
    await vi.waitFor(() => {
      expect(driver.getCurrentResult().isFetched).toBe(true);
      expect(rider.getCurrentResult().isFetched).toBe(true);
    });
    expect(driverProbe).toHaveBeenCalledOnce(); // was ×3 on the owner's phone
    expect(riderProbe).toHaveBeenCalledOnce(); // was ×3 on the owner's phone
    expect(driver.getCurrentResult().error).toBeNull();
    expect(rider.getCurrentResult().error).toBeNull();
    const resolution = resolveMoverProfile({ activeRole: 'CUSTOMER', lastMoverRole: null, driver: driver.getCurrentResult().data ?? null, rider: rider.getCurrentResult().data ?? null });
    expect(resolution).toEqual({ kind: null, profile: null, ambiguous: false });
    stop.forEach((unsubscribe) => unsubscribe());
    qc.clear();
    expect(MOVER_HOOKS).toContain("const outsider = !accountHoldsRole(authority, 'mover');");
    expect(MOVER_HOOKS).toContain('unwrapOptionalMoverProfile(driverApi.profile(), { outsider })');
    expect(MOVER_HOOKS).toContain('unwrapOptionalMoverProfile(riderApi.profile(), { outsider })');
  });

  it('the mover shell opens the application for an unverified account — the server’s verification status decides, not a dashboard', () => {
    expect(MOVER_STACK).toContain("useVerificationStatus<any>('MOVER', undefined, { poll: true })");
    expect(MOVER_STACK).toContain('{status?.roleVerified ? <MoverHomeScreen navigation={navigation} /> : <MoverOnboardingScreen status={status} />}');
  });

  it('after "Save vehicle" the granted roles make the account an insider, so the probes refetch as one', () => {
    // the roles the server returns from /partner/become are written back into the session…
    expect(VERIFICATION_HOOKS).toContain('partnerApi.become(data, owner)');
    expect(VERIFICATION_HOOKS).toContain('roles: result.roles,');
    // …and the probes and checklists are invalidated so the shells re-read as an insider
    for (const key of ["['verification']", "['vendor']", "['mover']"]) {
      expect(VERIFICATION_HOOKS).toContain(`void qc.invalidateQueries({ queryKey: ${key} });`);
    }
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'MOVER', 'RIDER'] }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'MOVER', 'DRIVER'] }, 'mover')).toBe(true);
    expect(accountHoldsRole({ roles: ['CUSTOMER', 'VENDOR_OWNER'] }, 'vendor')).toBe(true);
  });
});

describe('the JOIN flows provision through the real route, and are never a dead end', () => {
  it('BusinessSetup creates the store with POST /partner/become as VENDOR; the mover application as MOVER', () => {
    expect(API).toContain("api.post('/partner/become', data, capturedAuthConfig(session))");
    expect(BUSINESS_SETUP).toContain('const become = useBecomePartner();');
    expect(BUSINESS_SETUP).toMatch(/become\.mutate\(\{\s*role: 'VENDOR',/);
    expect(MOVER_ONBOARDING).toContain('const become = useBecomePartner();');
    expect(MOVER_ONBOARDING).toMatch(/become\.mutate\(\s*\{\s*role: 'MOVER',/);
  });

  it('both application screens carry the switcher, and the switcher always lists the customer surface', () => {
    expect(BUSINESS_SETUP).toContain('<RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />');
    expect(MOVER_ONBOARDING).toContain('<RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />');
    expect(SWITCHER).toContain("{ intent: 'customer', pictogram: 'groceries', title: 'Swift'");
    // leaving an earner surface for the open one is an owned switch: the server is told
    expect(roleSwitchAuthorityPayload('vendor', 'customer', true, ['CUSTOMER'], null)).toBe('CUSTOMER');
    expect(roleSwitchAuthorityPayload('mover', 'customer', true, ['CUSTOMER'], null)).toBe('CUSTOMER');
  });

  it('the sign-in landing law reads the same predicate as the switcher and the shells', () => {
    expect(AUTH_STORE).toContain("const isMover = accountHoldsRole(u, 'mover');");
    expect(AUTH_STORE).toContain("const isVendor = accountHoldsRole(u, 'vendor');");
  });
});
