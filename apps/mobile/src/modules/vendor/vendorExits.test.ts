import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Owner report: business-unavailable, onboarding and owner screens could trap a
// person with no working way back to Swift, the welcome or sign-out.
//
// VendorRoot's profile-error screen rendered an ErrorState and nothing else —
// no header, so no "Switch app" and no "Log out", only Retry. `intent` is
// persisted, so a cold start reopened the same screen. It is reached by an
// outage ("Swift can't reach your store"), by a 403 ("Ask the owner to add you
// again") and by a guest with no session ("Your session ended"). The pending
// checklist and the billing-paused screen offered Log out but no way back to
// Swift, so returning to the customer app meant signing out.
//
// Every one of them now carries the same header the List-your-business screen
// already had: "Switch app" through the one role switcher (server authority for
// the move) and TabHeader's own "Log out". Mobile has no render tests, so these
// pin the source shape (as VendorStack.router/keys tests do).
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const STACK = strip(read('./VendorStack.tsx'));
const SETUP = strip(read('./screens/BusinessSetup.tsx'));
const SUSPENDED = strip(read('./screens/VendorBillingSuspended.tsx'));
const SHARED = strip(read('./shared.tsx'));

/** One top-level function's source, up to the next top-level declaration. */
function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:export )?function ${name}\\b`, 'm'));
  if (start < 0) throw new Error(`${name} is not declared`);
  const rest = src.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:function|const|type|interface) /m);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** Every JSX element of one component inside a block (attributes only). */
function elements(block: string, component: string): string[] {
  return [...block.matchAll(new RegExp(`<${component}\\b[\\s\\S]*?\\/>`, 'g'))].map((m) => m[0]);
}

function expectSwiftAndSignOutExits(block: string) {
  const headers = elements(block, 'TabHeader');
  expect(headers.length, 'the screen renders the vendor header').toBeGreaterThan(0);
  for (const header of headers) expect(header).toMatch(/\bonSwitch=\{/);
  const sheets = elements(block, 'RoleSwitcherSheet');
  expect(sheets, 'the header opens the one role switcher').toHaveLength(1);
  expect(sheets[0]).toMatch(/\bcurrent="vendor"/);
  expect(sheets[0]).toMatch(/\bvisible=\{/);
  expect(sheets[0]).toMatch(/\bonClose=\{/);
}

function profileErrorBranch(): string {
  const root = fn(STACK, 'VendorRoot');
  const start = root.indexOf("if (profileState === 'error')");
  const end = root.indexOf('if (!store)', start);
  expect(start, 'VendorRoot still distinguishes a failed profile read').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return root.slice(start, end);
}

describe('no business screen is a one-way door', () => {
  it('the business-unavailable screen offers Switch app and Log out, and keeps Retry', () => {
    const branch = profileErrorBranch();

    expectSwiftAndSignOutExits(branch);
    expect(branch).toMatch(/<ErrorState\b[\s\S]*onRetry=\{refetch\}/);
  });

  it('the pending-approval checklist offers Switch app beside Log out', () => {
    expectSwiftAndSignOutExits(fn(SETUP, 'VendorOnboarding'));
  });

  it('the billing-paused screen offers Switch app beside Log out', () => {
    expectSwiftAndSignOutExits(fn(SUSPENDED, 'VendorBillingSuspended'));
  });

  it('the List-your-business screen keeps the same exits', () => {
    expectSwiftAndSignOutExits(fn(SETUP, 'BusinessSetup'));
  });

  it('the vendor header always offers Log out, and Switch app wherever a screen asks for it', () => {
    const header = fn(SHARED, 'TabHeader');

    // Log out asks first: the header opens the shared confirm and renders it.
    expect(header).toMatch(/const \{ requestLogout, logoutDialog \} = useLogoutConfirm\(\{ body: logoutBody \}\)/);
    expect(header).toMatch(/\{onSwitch \? <HeaderAction label="Switch app" onPress=\{onSwitch\} \/> : null\}/);
    expect(header).toMatch(/\n\s*<HeaderAction label="Log out" tone="muted" onPress=\{requestLogout\} \/>/);
    expect(header).toContain('{logoutDialog}');
  });
});

describe('the pending vendor’s dashboard preview', () => {
  it('is the real-data peek at their own store — the press handler never passes a type', () => {
    const root = fn(STACK, 'VendorRoot');
    const onboarding = elements(root, 'VendorOnboarding');

    expect(onboarding).toHaveLength(1);
    // enterPreview(type?) takes a business TYPE; a press handler receives an
    // event. Binding the action directly stored the event as the type.
    expect(onboarding[0]).not.toMatch(/onPreview=\{enterPreview\}/);
    expect(onboarding[0]).toMatch(/onPreview=\{\(\) => enterPreview\(\)\}/);
  });
});

describe('the List-your-business form', () => {
  const setup = fn(SETUP, 'BusinessSetup');

  it('reads every field from the account-bound draft, not component state', () => {
    expect(setup).toMatch(/useBusinessSetupDraft\(\(s\) => businessSetupDraftFor\(s, owner\)\)/);
    expect(setup).not.toMatch(/const \[(name|type|phone|addr|city|agree),/);
  });

  it('writes only through the signed-in-account guard', () => {
    expect(setup).toMatch(/editBusinessSetupDraft\(getAuthSessionSnapshot\(\), owner, patch\)/);
    expect(setup).not.toMatch(/useBusinessSetupDraft\.getState\(\)\.update\(/);
  });

  it('leaves clearing to the durable store-creation result', () => {
    const start = setup.indexOf('const submit');
    const submit = setup.slice(start, setup.indexOf('return (', start));

    expect(start).toBeGreaterThan(-1);
    expect(submit).toMatch(/become\.mutate\(/);
    expect(submit).not.toMatch(/onSuccess|clear/);
  });
});
