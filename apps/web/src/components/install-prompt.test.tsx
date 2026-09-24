import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_PROMPT_KEY, InstallPrompt, isIosSafari } from './install-prompt';

// ---------------------------------------------------------------------------
// [PWA-1] The install card asks once and never nags: never inside the
// installed app, never again after a dismissal, a "no" or an install, and
// Chrome's own mini-infobar is kept away throughout.
// ---------------------------------------------------------------------------

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.46 Mobile/15E148 Safari/604.1';
const IPHONE_GOOGLE_APP =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/337.0.681106624 Mobile/15E148 Safari/604.1';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

const restores: Array<() => void> = [];
function override(target: object, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function device(userAgent: string, maxTouchPoints = 0) {
  override(navigator, 'userAgent', { value: userAgent });
  override(navigator, 'maxTouchPoints', { value: maxTouchPoints });
}

function runningInstalled() {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)', media: query }));
}

/** Chrome's install event, as the page receives it. */
function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(event, { prompt });
  return { event, prompt };
}

function fire(event: Event) {
  act(() => {
    window.dispatchEvent(event);
  });
}

const card = () => screen.queryByRole('complementary', { name: 'Install Swift' });

describe('[PWA-1] install card on Chrome (Android, desktop)', () => {
  it('turns the install event into a card, and keeps Chrome’s own infobar away', () => {
    device(ANDROID_CHROME);
    render(<InstallPrompt enabled />);
    const { event } = installEvent();
    fire(event);

    expect(event.defaultPrevented).toBe(true);
    expect(card()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('Install opens the browser’s dialog once, and the card never comes back', async () => {
    device(ANDROID_CHROME);
    const user = userEvent.setup();
    const view = render(<InstallPrompt enabled />);
    const { event, prompt } = installEvent();
    fire(event);

    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).not.toBeNull();

    view.unmount();
    render(<InstallPrompt enabled />);
    const again = installEvent();
    fire(again.event);
    expect(again.event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
  });

  it('a dismissal is remembered, and Chrome is still kept from asking in its place', async () => {
    device(ANDROID_CHROME);
    const user = userEvent.setup();
    const view = render(<InstallPrompt enabled />);
    fire(installEvent().event);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(card()).toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).not.toBeNull();

    view.unmount();
    render(<InstallPrompt enabled />);
    const next = installEvent();
    fire(next.event);
    expect(next.event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
  });

  it('an earlier answer holds from the first render', () => {
    localStorage.setItem(INSTALL_PROMPT_KEY, 'dismissed');
    device(ANDROID_CHROME);
    render(<InstallPrompt enabled />);
    fire(installEvent().event);
    expect(card()).toBeNull();
  });

  it('an install from the browser menu retires the card too', () => {
    device(ANDROID_CHROME);
    render(<InstallPrompt enabled />);
    fire(installEvent().event);
    expect(card()).not.toBeNull();

    fire(new Event('appinstalled'));
    expect(card()).toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).not.toBeNull();
  });

  it('shows nothing on a page that does not enable it, and appears when one does', () => {
    device(ANDROID_CHROME);
    const view = render(<InstallPrompt enabled={false} />);
    fire(installEvent().event);
    expect(card()).toBeNull();

    view.rerender(<InstallPrompt enabled />);
    expect(card()).not.toBeNull();
  });

  it('offers nothing when storage is unavailable, since a dismissal could not be kept', () => {
    device(ANDROID_CHROME);
    // What a browser with site data blocked does: reading the store throws.
    override(window, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    render(<InstallPrompt enabled />);
    const { event } = installEvent();
    fire(event);
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
  });
});

describe('[PWA-1] never inside the installed app', () => {
  it('shows no card in display-mode: standalone', () => {
    device(ANDROID_CHROME);
    runningInstalled();
    render(<InstallPrompt enabled />);
    fire(installEvent().event);
    expect(card()).toBeNull();
  });

  it('shows no Safari hint when launched from the home screen (navigator.standalone)', () => {
    device(IPHONE_SAFARI);
    override(navigator, 'standalone', { value: true });
    render(<InstallPrompt enabled />);
    expect(card()).toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBeNull();
  });
});

describe('[PWA-1] Safari on iPhone and iPad', () => {
  it('gets the Share → Add to Home Screen hint exactly once', () => {
    device(IPHONE_SAFARI);
    const view = render(<InstallPrompt enabled />);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toMatch(/Tap\s*Share, then Add to Home Screen\./);
    // There is no install dialog on iOS, so no Install button.
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();

    view.unmount();
    render(<InstallPrompt enabled />);
    expect(card()).toBeNull();
  });

  it('does not spend the hint on a page that does not show it', () => {
    device(IPHONE_SAFARI);
    const view = render(<InstallPrompt enabled={false} />);
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBeNull();

    view.rerender(<InstallPrompt enabled />);
    expect(card()).not.toBeNull();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).not.toBeNull();
  });

  it('recognises Safari on an iPhone or iPad, and nothing else', () => {
    expect(isIosSafari(IPHONE_SAFARI, 5)).toBe(true);
    expect(isIosSafari(IPAD_SAFARI, 5)).toBe(true); // iPadOS reports a Mac, with a touch screen
    expect(isIosSafari(IPAD_SAFARI, 0)).toBe(false); // a real Mac
    expect(isIosSafari(IPHONE_CHROME, 5)).toBe(false);
    expect(isIosSafari(IPHONE_GOOGLE_APP, 5)).toBe(false);
    expect(isIosSafari(IPHONE_INSTAGRAM, 5)).toBe(false); // in-app browsers cannot add to the home screen
    expect(isIosSafari(ANDROID_CHROME, 5)).toBe(false);
  });
});
