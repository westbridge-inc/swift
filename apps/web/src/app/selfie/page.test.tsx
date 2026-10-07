import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SelfiePage from './page';

// ---------------------------------------------------------------------------
// [WEB-GUARDS] The selfie page sends the customer on to `?next=` after the
// photo is saved, links back to it, and passes it through sign-in. A browser
// drops tab, line-feed and carriage-return characters while it reads a URL, so
// a value that LOOKS like an in-app path ("/" + tab + "/elsewhere") becomes a
// protocol-relative address to another site once the browser has read it. The
// page must hand on only a path that stays on Swift after that reading.
// ---------------------------------------------------------------------------

const mocked = vi.hoisted(() => ({
  query: '',
  replace: vi.fn(),
  session: { ok: true } as { ok: boolean },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocked.query),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/lib/auth', () => ({ sessionProbe: () => Promise.resolve(mocked.session) }));
vi.mock('@/lib/customer', () => ({ uploadSelfie: vi.fn() }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => {
  mocked.replace.mockReset();
  mocked.session = { ok: true };
});

const OFF_SITE = [
  ['a tab', '/\t/evil.example/'],
  ['a line feed', '/\n/evil.example/'],
  ['a carriage return', '/\r/evil.example/'],
  ['a tab before the second slash', '/\t\t/evil.example/path?x=1'],
] as const;

function backLink() {
  return screen.getByRole('link', { name: 'Back to the store' }).getAttribute('href');
}

describe('[WEB-GUARDS] the selfie page only continues to a path on this site', () => {
  it.each(OFF_SITE)('a ?next= holding %s that a browser reads as another site falls back to /', async (_name, next) => {
    // Premise: the browser really does read this value as another origin.
    expect(new URL(next, 'https://swift.example').origin).toBe('https://evil.example');

    mocked.query = `next=${encodeURIComponent(next)}`;
    render(<SelfiePage />);
    expect(backLink()).toBe('/');
    expect(screen.getByRole('link', { name: 'Return to store' }).getAttribute('href')).toBe('/');
  });

  it.each(OFF_SITE)('signed out, the sign-in detour never carries %s onward', async (_name, next) => {
    mocked.session = { ok: false };
    mocked.query = `next=${encodeURIComponent(next)}`;
    render(<SelfiePage />);
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledTimes(1));
    expect(mocked.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/selfie?next=%2F')}`);
  });

  it('keeps a real in-app path, query and all', () => {
    mocked.query = `next=${encodeURIComponent('/order/vendor/v1?item=i1')}`;
    render(<SelfiePage />);
    expect(backLink()).toBe('/order/vendor/v1?item=i1');
  });

  it.each([
    ['protocol-relative', '//evil.example/'],
    ['absolute', 'https://evil.example/'],
    ['backslash', '/\\evil.example/'],
    ['traversal', '/a/../../evil'],
  ])('still refuses a %s return', (_name, next) => {
    mocked.query = `next=${encodeURIComponent(next)}`;
    render(<SelfiePage />);
    expect(backLink()).toBe('/');
  });
});
