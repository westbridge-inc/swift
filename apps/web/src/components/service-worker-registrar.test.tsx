import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker, ServiceWorkerRegistrar } from './service-worker-registrar';

// ---------------------------------------------------------------------------
// [PWA-1] The worker is installed by production builds on secure origins only,
// after the page has loaded; `next dev` retires one a local production run left
// behind; and an update takes over only while the tab is hidden.
// ---------------------------------------------------------------------------

const restores: Array<() => void> = [];
function override(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true });
  restores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  vi.unstubAllEnvs();
});

function worker(scriptURL: string) {
  return { scriptURL, postMessage: vi.fn() };
}

function registration(options: { active?: string; waiting?: ReturnType<typeof worker> } = {}) {
  return {
    active: options.active ? worker(options.active) : null,
    waiting: options.waiting ?? null,
    installing: null,
    unregister: vi.fn().mockResolvedValue(true),
  };
}

function browser({ secure = true, registrations = [] as unknown[], registered = registration() } = {}) {
  const container = {
    register: vi.fn().mockResolvedValue(registered),
    getRegistrations: vi.fn().mockResolvedValue(registrations),
  };
  override(window, 'isSecureContext', secure);
  override(navigator, 'serviceWorker', container);
  override(document, 'readyState', 'complete');
  return container;
}

function tab(state: 'visible' | 'hidden') {
  override(document, 'visibilityState', state);
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('[PWA-1] service worker registration', () => {
  it('registers /sw.js for the whole site in a production build on a secure origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const container = browser();
    render(<ServiceWorkerRegistrar />);
    await waitFor(() => expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' }));
  });

  it('waits for the page to finish loading before it registers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const container = browser();
    override(document, 'readyState', 'interactive');
    render(<ServiceWorkerRegistrar />);
    expect(container.register).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('load'));
    await waitFor(() => expect(container.register).toHaveBeenCalledTimes(1));
  });

  it('never registers under next dev, and retires a Swift worker a local production run left', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const ours = registration({ active: 'http://localhost:3002/sw.js' });
    const foreign = registration({ active: 'http://localhost:3002/other-worker.js' });
    const container = browser({ registrations: [ours, foreign] });
    render(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(ours.unregister).toHaveBeenCalledTimes(1));
    expect(foreign.unregister).not.toHaveBeenCalled();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('never registers on an insecure origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const container = browser({ secure: false });
    render(<ServiceWorkerRegistrar />);
    await expect(registerServiceWorker()).resolves.toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('leaves a browser without service workers alone', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    override(window, 'isSecureContext', true);
    override(document, 'readyState', 'complete');
    expect('serviceWorker' in navigator).toBe(false);
    render(<ServiceWorkerRegistrar />);
    await expect(registerServiceWorker()).resolves.toBeNull();
  });

  it('a failed registration never breaks the page', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const container = browser();
    container.register.mockRejectedValue(new TypeError('bad script'));
    await expect(registerServiceWorker()).resolves.toBeNull();
  });
});

describe('[PWA-1] the update path', () => {
  it('asks a waiting update to take over only once the tab is hidden', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const next = worker('https://swiftgy.com/sw.js');
    browser({ registered: registration({ active: 'https://swiftgy.com/sw.js', waiting: next }) });
    await registerServiceWorker();

    tab('visible');
    expect(next.postMessage).not.toHaveBeenCalled();

    tab('hidden');
    expect(next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('with no update waiting, hiding the tab asks nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const current = registration({ active: 'https://swiftgy.com/sw.js' });
    browser({ registered: current });
    await registerServiceWorker();
    expect(() => tab('hidden')).not.toThrow();
  });
});
