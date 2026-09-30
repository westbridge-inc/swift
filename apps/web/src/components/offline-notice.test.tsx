import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { OfflineNotice } from './offline-notice';
import OfflinePage from '@/app/offline/page';

vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

it('renders a plain retry form and account-cart copy without needing JavaScript', () => {
  render(<OfflinePage />);
  const button = screen.getByRole('button', { name: 'Try again' });
  expect(button.getAttribute('type')).toBe('submit');
  expect(button.closest('form')?.getAttribute('action')).toBe('');
  expect(button.closest('form')?.getAttribute('method')).toBe('get');
  expect(screen.getByText(/Your cart is kept on your account/)).toBeTruthy();
});

it('the shipped offline document reloads the original URL once on reconnect without any external scripts', () => {
  const view = render(<OfflinePage />);
  const target = new EventTarget();
  const reload = vi.fn();
  const script = view.container.querySelector('script')!;
  expect(script.getAttribute('src')).toBeNull();
  runInNewContext(script.textContent!, { window: { addEventListener: target.addEventListener.bind(target), location: { reload } } });
  target.dispatchEvent(new Event('online'));
  target.dispatchEvent(new Event('online'));
  expect(reload).toHaveBeenCalledTimes(1);
});

describe('offline inside the customer shell', () => {
  it('shows the offline state and retries without losing the current route', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    render(<OfflineNotice />);
    expect(screen.getByRole('status').textContent).toContain('Your cart is kept on your account');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads only a screen that showed offline, once per reconnect, and removes its listeners on exit', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const view = render(<OfflineNotice />);
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(reload).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
    expect(reload).toHaveBeenCalledTimes(1);
    view.unmount();
    act(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
