import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Legal research G2 · R26 · Terms "Changes"] "Continued use" is no longer acceptance: a signed-in person whose
// accepted version is behind a material change sees what changed and accepts with a fresh, unticked tick (or
// stops and deletes the account). Guests and people already up to date see nothing.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ principal: null as string | null, listeners: [] as Array<() => void>, get: vi.fn(), accept: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getSessionPrincipal: () => fx.principal,
  subscribeSession: (l: () => void) => { fx.listeners.push(l); return () => {}; },
}));
vi.mock('@/lib/legal-acceptance', async () => {
  const actual = await vi.importActual<typeof import('@/lib/legal-acceptance')>('@/lib/legal-acceptance');
  return { ...actual, getLegalAcceptance: fx.get, acceptLegal: fx.accept };
});
vi.mock('@/lib/legal-url', () => ({ LEGAL_URL: (doc: string) => `https://api.example/legal/${doc}` }));

import { LegalAcceptanceGate, acceptLabel } from './legal-acceptance-gate';
import { askLegalAcceptanceAgain, LEGAL_ACCEPTED_EVENT } from '@/lib/legal-acceptance';

const UPDATED = { currentVersion: '2026-10-16', acceptedVersion: '2026-10-15', needsAcceptance: true, summary: ['The company behind Swift is named.', 'Swift never carries letters, documents or mail.'], agreements: [] as Array<'driver_agreement' | 'vendor_agreement'> };

beforeEach(() => {
  fx.principal = null; fx.listeners = []; fx.get.mockReset(); fx.accept.mockReset();
});

describe('the fresh acceptance tick on the website', () => {
  it('a guest sees nothing and nothing is asked of the server', () => {
    render(<LegalAcceptanceGate />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fx.get).not.toHaveBeenCalled();
  });

  it('a person already up to date sees nothing', async () => {
    fx.principal = 'u1';
    fx.get.mockResolvedValue({ ...UPDATED, acceptedVersion: '2026-10-16', needsAcceptance: false, summary: [] });
    render(<LegalAcceptanceGate />);
    await waitFor(() => expect(fx.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('after a material change: what changed, an unticked tick, and Accept stays off until it is ticked; accepting records the served version', async () => {
    fx.principal = 'u1';
    fx.get.mockResolvedValue(UPDATED);
    fx.accept.mockResolvedValue({ ...UPDATED, acceptedVersion: '2026-10-16', needsAcceptance: false });
    const user = userEvent.setup();
    render(<LegalAcceptanceGate />);
    const dialog = await screen.findByRole('dialog', { name: 'We’ve updated our Terms' });
    expect(dialog.textContent).toContain('Swift never carries letters, documents or mail.');
    const tick = screen.getByRole('checkbox', { name: 'I agree to the updated Terms of Service and Privacy Policy.' }) as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Accept and continue' }) as HTMLButtonElement;
    expect(tick.checked).toBe(false);
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'delete your account' }).getAttribute('href')).toBe('/account/delete');
    await user.click(tick);
    await user.click(button);
    expect(fx.accept).toHaveBeenCalledWith('2026-10-16');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a signed-in person is asked as soon as the shell learns who they are', async () => {
    fx.get.mockResolvedValue(UPDATED);
    render(<LegalAcceptanceGate />);
    expect(fx.get).not.toHaveBeenCalled();
    fx.principal = 'u2';
    fx.listeners.forEach((l) => l());
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('if the words changed while they read, the new words are shown, unticked', async () => {
    fx.principal = 'u1';
    fx.get.mockResolvedValueOnce(UPDATED).mockResolvedValueOnce({ ...UPDATED, currentVersion: '2026-10-20' });
    fx.accept.mockRejectedValue(new Error('The Terms changed again while you were reading. Please read the new version.'));
    const user = userEvent.setup();
    render(<LegalAcceptanceGate />);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed again/);
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
  });

  it('the tick names every document accepted: partners accept their agreement too', () => {
    expect(acceptLabel({ acceptedVersion: null, agreements: [] })).toBe('I agree to the Terms of Service and Privacy Policy.');
    expect(acceptLabel({ acceptedVersion: '2026-10-15', agreements: ['driver_agreement'] })).toBe('I agree to the updated Terms of Service, Privacy Policy and Mover Agreement.');
    expect(acceptLabel({ acceptedVersion: null, agreements: ['vendor_agreement'] })).toBe('I agree to the Terms of Service, Privacy Policy and Business Agreement.');
  });

  it('the customer app, the earner portal and the business console all carry the gate', () => {
    const app = (...p: string[]) => readFileSync(join(process.cwd(), 'src', 'app', ...p), 'utf8');
    for (const layout of [app('(app)', 'layout.tsx'), app('portal', 'layout.tsx'), app('dashboard', 'layout.tsx')]) {
      expect(layout).toMatch(/<LegalAcceptanceGate \/>/);
    }
    // [perf-budget] the customer app's pages sit at their first-load ceilings: the gate loads as its own chunk after
    // the page, so it costs those pages (cart, checkout, browse) nothing up front. [PERF #7] Tried twice (lib/chunk-retry).
    expect(app('(app)', 'layout.tsx')).toMatch(/const LegalAcceptanceGate = lazyRetry\(\(\) => import\('@\/components\/legal-acceptance-gate'\)\.then\(module => \(\{ default: module\.LegalAcceptanceGate \}\)\)\);/);
    expect(app('(app)', 'layout.tsx')).toMatch(/<Suspense fallback=\{null\}><LegalAcceptanceGate \/><\/Suspense>/);
  });
});

// [BILL-PRO PR6 · REVIEW-F #2231 S4 / S3-4] The pro fee page's "Review the agreement" asks the server again, and the gate
// comes up when the agreement is owed; a recorded tick tells the page, so the pro's standing and fee are read again.
describe('the gate, asked again by a page', () => {
  it('"Review the agreement" reads the server again and brings the gate up when the agreement is owed', async () => {
    fx.principal = 'u1';
    fx.get.mockResolvedValueOnce({ ...UPDATED, needsAcceptance: false, summary: [] })
      .mockResolvedValueOnce({ ...UPDATED, acceptedVersion: null, agreements: ['vendor_agreement'] });
    render(<LegalAcceptanceGate />);
    await waitFor(() => expect(fx.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    askLegalAcceptanceAgain();
    expect(await screen.findByRole('checkbox', { name: 'I agree to the Terms of Service, Privacy Policy and Business Agreement.' })).toBeTruthy();
    expect(fx.get).toHaveBeenCalledTimes(2);
  });

  it('a recorded tick is announced to the page; a refused one is not', async () => {
    const heard = vi.fn();
    window.addEventListener(LEGAL_ACCEPTED_EVENT, heard);
    try {
      fx.principal = 'u1';
      fx.get.mockResolvedValue(UPDATED);
      fx.accept.mockRejectedValueOnce(new Error('That did not go through.')).mockResolvedValueOnce({ ...UPDATED, acceptedVersion: '2026-10-16', needsAcceptance: false });
      const user = userEvent.setup();
      render(<LegalAcceptanceGate />);
      await user.click(await screen.findByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(heard).not.toHaveBeenCalled();
      await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
      await user.click(screen.getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(LEGAL_ACCEPTED_EVENT, heard);
    }
  });
});
