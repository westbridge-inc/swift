'use client';

import { useEffect, useRef, useState } from 'react';

export const INSTALL_PROMPT_KEY = 'swift_web_install_prompt';
const OFFER_WINDOW = 14 * 24 * 60 * 60_000;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

type Offer = 'none' | 'install' | 'ios-hint';

/**
 * The card itself is only needed once an offer is possible on Home, so its
 * code is not in every page's first load: it is fetched then, and kept here.
 * The offer is decided (and remembered) only once the card can show, so it is
 * never spent unseen; nothing stands in for the card while its code arrives.
 */
let cardModule: typeof import('./install-prompt-card') | null = null;
let cardLoading: Promise<typeof import('./install-prompt-card')> | null = null;
/** Fetches the install card's code once (and again after a failed fetch). */
export function loadInstallCard(): Promise<typeof import('./install-prompt-card')> {
  cardLoading ??= import('./install-prompt-card').then(
    (module) => (cardModule = module),
    (error: unknown) => { cardLoading = null; throw error; },
  );
  return cardLoading;
}

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
  const [cardReady, setCardReady] = useState(() => cardModule !== null);

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
    if (!enabled || cardReady || spent.current || isInstalledApp()) return;
    if (!available && !isIosSafari(navigator.userAgent, navigator.maxTouchPoints)) return;
    let alive = true;
    loadInstallCard().then(() => { if (alive) setCardReady(true); }, () => undefined);
    return () => { alive = false; };
  }, [enabled, available, cardReady]);

  useEffect(() => {
    if (!enabled || !engaged || !cardReady || spent.current || isInstalledApp()) return;
    const ios = isIosSafari(navigator.userAgent, navigator.maxTouchPoints);
    if ((!ios && !available) || !mayOffer(ios)) return;
    // The window starts when the offer is shown, even if the visitor leaves it open.
    if (!remember(ios ? 'ios-seen' : String(Date.now()))) return;
    spent.current = true;
    setOffer(ios ? 'ios-hint' : 'install');
  }, [enabled, engaged, available, cardReady]);

  if (!enabled || offer === 'none' || !cardModule) return null;

  const dismiss = () => {
    installEvent.current = null;
    setOffer('none');
  };
  const install = () => {
    const event = installEvent.current;
    dismiss();
    if (!isInstalledApp()) void event?.prompt().catch(() => undefined);
  };

  return <cardModule.InstallCard offer={offer} onInstall={install} onDismiss={dismiss} />;
}
