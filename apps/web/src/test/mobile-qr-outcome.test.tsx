import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import RetiredQrPage from '@/app/qr/retired/page';
import UnavailableQrPage from '@/app/qr/unavailable/page';
import UnknownQrPage from '@/app/qr/not-found/page';

const state = vi.hoisted(() => ({ params: { reason: 'offline', destination: { kind: 'short', code: 'BCDFGHJKMN' }, requestId: 7 }, retry: vi.fn() }));
vi.mock('../../../mobile/src/services/deep-links', () => ({ retryQrDestination: state.retry }));
vi.mock('../../../mobile/node_modules/react-native', () => ({ View: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../../mobile/node_modules/@react-navigation/native', () => ({ useRoute: () => ({ params: state.params }) }));
vi.mock('../../../mobile/src/kit', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  Header: ({ title }: { title: string }) => <h1>{title}</h1>,
  T: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  PillButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) => <button onClick={onPress} disabled={disabled}>{label}</button>,
}));
const path = new URL('../../../mobile/src/screens/QrOutcomeScreen.tsx', import.meta.url).pathname;
let QrOutcomeScreen: React.ComponentType;
beforeAll(async () => { ({ QrOutcomeScreen } = await import(path)); });
beforeEach(() => { state.retry.mockReset(); state.params = { reason: 'offline', destination: { kind: 'short', code: 'BCDFGHJKMN' }, requestId: 7 }; });

describe('the dedicated phone QR outcome screen', () => {
  it.each([
    ['replaced', 'This QR code has been replaced', 'no longer in use'],
    ['unavailable', 'This store is not available from this code', 'isn’t taking orders right now'],
    ['not-a-swift-code', 'Swift could not read this counter code', 'ask the business for a current link'],
  ])('%s matches the web outcome and discloses no server reason', async (reason, title, body) => {
    state.params.reason = reason;
    const phone = render(<QrOutcomeScreen />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(phone.container.textContent).toContain(body);
    expect(phone.container.textContent).not.toMatch(/suspend|ban|fraud/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const paragraphs = [...phone.container.querySelectorAll('p')].map(p => p.textContent);
    phone.unmount();
    const web = render(reason === 'replaced' ? await RetiredQrPage({ searchParams: Promise.resolve({}) }) : reason === 'unavailable' ? <UnavailableQrPage /> : <UnknownQrPage />);
    expect(web.container.textContent).toContain(title);
    expect(web.container.textContent).toContain(paragraphs[1]);
  });

  it('Retry preserves the exact destination and blocks repeated taps while checking', async () => {
    let finish!: () => void;
    state.retry.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    render(<QrOutcomeScreen />);
    expect(screen.getByText('Could not connect to this store')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }));
    expect(state.retry).toHaveBeenCalledExactlyOnceWith({ kind: 'short', code: 'BCDFGHJKMN' }, 7);
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
  });
});
