import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { OfflineNotice } from './offline-notice';
import OfflinePage from '@/app/offline/page';

vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

it('renders a retry button, account-cart copy and a browser-reload fallback', () => {
  render(<OfflinePage />);
  const button = screen.getByRole('button', { name: 'Try again' });
  expect(button.getAttribute('type')).toBe('button');
  expect(button.closest('form')).toBeNull();
  expect(document.querySelector('noscript')?.textContent).toContain('reload');
  expect(screen.getByText(/Your cart is kept on your account/)).toBeTruthy();
});

it('the shipped offline document reloads the original URL once on reconnect without any external scripts', () => {
  const view = render(<OfflinePage />);
  const target = new EventTarget();
  const reload = vi.fn();
  const script = view.container.querySelector('script')!;
  expect(script.getAttribute('src')).toBeNull();
  runInNewContext(script.textContent!, { document, window: { addEventListener: target.addEventListener.bind(target), location: { reload } } });
  target.dispatchEvent(new Event('online'));
  target.dispatchEvent(new Event('online'));
  expect(reload).toHaveBeenCalledTimes(1);
});

it('retry preserves the complete original URL, including query parameters and hash', () => {
  const original = '/order/vendor/store-1?item=lunch%20box&source=pwa#menu';
  window.history.replaceState(null, '', original);
  const view = render(<OfflinePage />);
  const retried: string[] = [];
  vi.spyOn(window.location, 'reload').mockImplementation(() => { retried.push(window.location.href); });
  const target = new EventTarget();
  runInNewContext(view.container.querySelector('script')!.textContent!, { document, window: { location: window.location, addEventListener: target.addEventListener.bind(target) } });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retried).toEqual([`${window.location.origin}${original}`]);
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(original);
  window.history.replaceState(null, '', '/');
});

describe('offline inside the customer shell', () => {
  it('shows connection status without offering a reload of a live page', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    render(<OfflineNotice />);
    expect(screen.getByRole('status').textContent).toContain('Your cart is kept on your account');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('clears the connection notice without reloading and removes its listeners on exit', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const view = render(<OfflineNotice />);
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(reload).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    view.unmount();
    act(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    expect(reload).not.toHaveBeenCalled();
  });
});
