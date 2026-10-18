import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';
import { DEMO_ENDED_NOTICE, noteDemoEnded } from '@/lib/demo-ended';

// [Row 353] Sent to sign-in because the store-review demo ended: the page says
// so, once, above the form, and is otherwise the ordinary sign-in.

const mocked = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocked.query),
}));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn(), verifyPartnerLogin: vi.fn() }));
vi.mock('@/lib/customer', () => ({ verifyCustomerLogin: vi.fn() }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => { window.sessionStorage.clear(); mocked.query = ''; });

describe('the demo-ended notice', () => {
  it('?ended=demo says why, as a status line above the ordinary form', async () => {
    mocked.query = 'ended=demo';
    render(<LoginPage />);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toBe(DEMO_ENDED_NOTICE);
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
  });

  it('a tab that just signed a demo out says it once', async () => {
    noteDemoEnded();
    const first = render(<LoginPage />);
    expect((await screen.findByTestId('demo-ended')).textContent).toBe(DEMO_ENDED_NOTICE);
    first.unmount();
    render(<LoginPage />);
    await screen.findByLabelText('Phone number');
    expect(screen.queryByTestId('demo-ended')).toBeNull();
  });

  it('an ordinary sign-in shows nothing extra', async () => {
    mocked.query = 'next=%2Faccount';
    render(<LoginPage />);
    await screen.findByLabelText('Phone number');
    expect(screen.queryByTestId('demo-ended')).toBeNull();
  });
});
