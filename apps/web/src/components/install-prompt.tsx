'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Share, X } from 'lucide-react';

export const INSTALL_PROMPT_KEY = 'swift_web_install_prompt';
const OFFER_WINDOW = 14 * 24 * 60 * 60_000;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

type Offer = 'none' | 'install' | 'ios-hint';

export function isInstalledApp(): boolean {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPadOS reports a Mac; its touch screen distinguishes it from desktop Safari. */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari\//.test(userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//.test(userAgent);
}

function mayOffer(ios: boolean): boolean {
  try {
    const saved = localStorage.getItem(INSTALL_PROMPT_KEY);
    if (saved === null) return true;
    // Keep earlier permanent dismissals, installed answers and Safari's one-time hint.
    if (ios || !/^\d+$/.test(saved)) return false;
    return Date.now() - Number(saved) >= OFFER_WINDOW;
  } catch {
    return false;
  }
}

function remember(value: string): boolean {
  try {
    localStorage.setItem(INSTALL_PROMPT_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** Caught throughout the app; offered only on Home after two deliberate actions.
 *  Only install timing is persisted, never a person, location or query result. */
export function InstallPrompt({ enabled }: { enabled: boolean }) {
  const [offer, setOffer] = useState<Offer>('none');
  const [engaged, setEngaged] = useState(false);
  const [available, setAvailable] = useState(false);
  const installEvent = useRef<BeforeInstallPromptEvent | null>(null);
  const spent = useRef(false);
  const card = useRef<HTMLElement | null>(null);
  const [clearance, setClearance] = useState(0);

  useLayoutEffect(() => {
    const element = card.current;
    if (!enabled || offer === 'none' || !element) return;
    // Include wrapped Safari steps and the padding above the dock/home bar.
    const measure = () => setClearance(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element, { box: 'border-box' });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [enabled, offer]);

  useEffect(() => {
    let interactions = 0;
    const onEngage = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('main a, main button, main input, main select')) {
        interactions += 1;
        if (interactions >= 2) setEngaged(true);
      }
    };
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (isInstalledApp() || spent.current) return;
      installEvent.current = event as BeforeInstallPromptEvent;
      setAvailable(true);
    };
    const hide = () => {
      spent.current = true;
      installEvent.current = null;
      setOffer('none');
    };
    const onInstalled = () => { remember('installed'); hide(); };
    const onModeChange = () => { if (isInstalledApp()) hide(); };
    const onStorage = (event: StorageEvent) => { if (event.key === INSTALL_PROMPT_KEY) hide(); };
    const mode = window.matchMedia?.('(display-mode: standalone)');
    document.addEventListener('click', onEngage);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('storage', onStorage);
    mode?.addEventListener?.('change', onModeChange);
    return () => {
      document.removeEventListener('click', onEngage);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('storage', onStorage);
      mode?.removeEventListener?.('change', onModeChange);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !engaged || spent.current || isInstalledApp()) return;
    const ios = isIosSafari(navigator.userAgent, navigator.maxTouchPoints);
    if ((!ios && !available) || !mayOffer(ios)) return;
    // The window starts when the offer is shown, even if the visitor leaves it open.
    if (!remember(ios ? 'ios-seen' : String(Date.now()))) return;
    spent.current = true;
    setOffer(ios ? 'ios-hint' : 'install');
  }, [enabled, engaged, available]);

  if (!enabled || offer === 'none') return null;

  const dismiss = () => {
    installEvent.current = null;
    setOffer('none');
  };
  const install = () => {
    const event = installEvent.current;
    dismiss();
    if (!isInstalledApp()) void event?.prompt().catch(() => undefined);
  };

  return (
    <>
    <div aria-hidden="true" data-install-clearance style={{ height: clearance }} />
    <aside ref={card} aria-label="Install Swift" className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(1rem_+_var(--swift-dock,env(safe-area-inset-bottom)))]">
      <div className="mx-auto max-w-md sw-card p-3 shadow-[var(--swift-elevation-floating)]">
        <div className="flex items-center gap-3">
          <Image src="/icons/icon-192.png" alt="" width={44} height={44} unoptimized className="h-11 w-11 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Install Swift</p>
            <p className="text-xs text-[var(--swift-muted)]">Open Swift from your home screen.</p>
          </div>
          {offer === 'install' && <button type="button" onClick={install} className="sw-btn sw-btn-sm">Install</button>}
          <button type="button" onClick={dismiss} aria-label="Dismiss" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)]"><X className="h-4 w-4" aria-hidden /></button>
        </div>
        {offer === 'ios-hint' && (
          <ol className="mt-3 list-inside list-decimal space-y-2 border-t border-[var(--swift-border)] pt-3 text-sm">
            <li>Tap <Share aria-hidden className="inline h-4 w-4 align-[-2px]" /> <b>Share</b> in Safari.</li>
            <li>Scroll down and choose <b>Add to Home Screen</b>.</li>
            <li>Tap <b>Add</b>, then open the Swift icon.</li>
          </ol>
        )}
      </div>
    </aside>
    </>
  );
}
