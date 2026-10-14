import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PWA-1 · size] The install card's code is not part of every app page's
// first-load JavaScript: a small piece stays in the app's frame to catch the
// browser's early install event, count engagement and keep the offer rules,
// and the card itself loads once an offer is possible on Home. What the
// visitor sees must not change: the early event is still caught, the card
// still appears after two deliberate actions on Home, and an offer is never
// spent (remembered) without the card being shown.
// ---------------------------------------------------------------------------

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const KEY = 'swift_web_install_prompt';
const ARRIVAL = { timeout: 5000 };

type Gate = { release: () => void; fail: boolean };

/** A fresh install prompt whose card code is held back until `gate.release()`. */
async function freshPrompt(gate: Gate) {
  vi.resetModules();
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  gate.release = () => open();
  vi.doMock('@/components/install-prompt-card', async (importOriginal) => {
    await held;
    if (gate.fail) throw new Error('The card could not be fetched.');
    return importOriginal();
  });
  return import('./install-prompt');
}

function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt: vi.fn().mockResolvedValue(undefined) });
  return event;
}

const card = () => screen.queryByRole('complementary', { name: 'Install Swift' });
const engage = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Browse stores' }));
  fireEvent.click(screen.getByRole('button', { name: 'Browse stores' }));
};

function onAndroidChrome() {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_CHROME });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
}

// No vi.doUnmock here (see item-sheet-loading.test.tsx): each fresh prompt sets its own mock.
afterEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe('[PWA-1] the install card is not in every page’s first load', () => {
  it('the always-loaded prompt loads the card separately', () => {
    const prompt = readFileSync(join(process.cwd(), 'src/components/install-prompt.tsx'), 'utf8');
    expect(prompt).not.toMatch(/from '\.\/install-prompt-card'/);
    expect(prompt).toMatch(/import\('\.\/install-prompt-card'\)/);
    expect(prompt).not.toMatch(/from 'next\/image'/);
  });

  it('catches the early install event before the card code arrives, and spends the offer only when the card shows', async () => {
    onAndroidChrome();
    const gate: Gate = { release: () => undefined, fail: false };
    const { InstallPrompt } = await freshPrompt(gate);
    const view = render(<><main><button>Browse stores</button></main><InstallPrompt enabled={false} /></>);
    const event = installEvent();
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    // Home: two deliberate actions, but the card's code is still on its way.
    view.rerender(<><main><button>Browse stores</button></main><InstallPrompt enabled /></>);
    engage();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    gate.release();
    expect(await screen.findByRole('complementary', { name: 'Install Swift' }, ARRIVAL)).toBeTruthy();
    expect(localStorage.getItem(KEY)).toMatch(/^\d+$/);
    // Dismiss still works and is remembered.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(card()).toBeNull();
    expect(localStorage.getItem(KEY)).toMatch(/^\d+$/);
  });

  it('if the card code cannot be fetched, nothing shows and the offer is not spent', async () => {
    onAndroidChrome();
    const gate: Gate = { release: () => undefined, fail: true };
    const { InstallPrompt } = await freshPrompt(gate);
    render(<><main><button>Browse stores</button></main><InstallPrompt enabled /></>);
    act(() => { window.dispatchEvent(installEvent()); });
    engage();
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(card()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
