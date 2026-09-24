'use client';

import { useEffect } from 'react';

/**
 * [PWA-1] Installs public/sw.js — the offline page and the build-file cache —
 * in production builds on secure origins only.
 *
 * - Production only: under `next dev` a worker would cache the unhashed dev
 *   files, and every edit would then be answered with the old one. A dev page
 *   instead retires any Swift worker a local production run left behind.
 * - Secure origins only (https, or localhost): browsers refuse a worker
 *   anywhere else, and a site served over plain http has no business keeping
 *   one.
 * - Registered after `load`, so on a slow connection the worker's first fetch
 *   never competes with the page it is installing for.
 *
 * THE UPDATE PATH. A new worker installs in the background and then waits.
 * When this tab is hidden — the person switched apps or tabs — it is asked to
 * take over. Nothing reloads, nothing changes mid-tap, and the page keeps
 * working because the worker never stored the page itself.
 */
export const SERVICE_WORKER_URL = '/sw.js';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      void retireServiceWorkers();
      return;
    }
    const register = () => {
      void registerServiceWorker();
    };
    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    });
    return registration;
  } catch {
    // A site that cannot install its worker is still a working site.
    return null;
  }
}

async function retireServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => {
          const worker = registration.active ?? registration.waiting ?? registration.installing;
          return worker !== null && new URL(worker.scriptURL).pathname === SERVICE_WORKER_URL;
        })
        .map((registration) => registration.unregister()),
    );
  } catch {
    // Nothing to retire, or the browser will not say — either way, carry on.
  }
}
