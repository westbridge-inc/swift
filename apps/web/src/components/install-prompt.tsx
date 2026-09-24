'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Share, X } from 'lucide-react';

/**
 * [PWA-1] Swift's one nudge to install the web app, and it never nags.
 *
 * - Chrome and Edge (Android, desktop): `beforeinstallprompt` becomes a small
 *   "Install Swift" card whose button opens the browser's own install dialog.
 *   Chrome's automatic mini-infobar is suppressed every time, before and after
 *   a dismissal — this card is the only ask, and after "no" there is none.
 * - Safari on iPhone and iPad has no install event, so it gets a one-time hint
 *   instead: Share, then Add to Home Screen. The visit that shows it is the only
 *   one that does.
 * - Never inside the installed app, and never again once dismissed, declined or
 *   installed. The answer is kept in localStorage; when storage is unavailable
 *   a dismissal could not be remembered, so the card is not offered at all.
 *
 * `enabled` says whether this page is a place to show it. The customer shell
 * enables it on the home page only, never over a cart, a checkout or a live
 * order. The install event is still caught everywhere, so arriving at the home
 * page later can still offer it.
 */
export const INSTALL_PROMPT_KEY = 'swift_web_install_prompt';

// Chromium's install event. It is not in the DOM typings: no other engine has it.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

type Offer = 'none' | 'install' | 'ios-hint';

/** Running as the installed app: Chromium reports the display mode, iOS sets navigator.standalone. */
export function isInstalledApp(): boolean {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Safari on an iPhone or iPad — iPadOS reports a Mac, told apart by its touch screen. */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari\//.test(userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//.test(userAgent);
}

/** True only when storage works and holds no earlier answer. */
function mayOffer(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_PROMPT_KEY) === null;
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_KEY, 'dismissed');
  } catch {
    // Storage refused the write; the card is still gone for this visit.
  }
}

export function InstallPrompt({ enabled }: { enabled: boolean }) {
  const [offer, setOffer] = useState<Offer>('none');
  const installEvent = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isInstalledApp()) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (!mayOffer()) return;
      installEvent.current = event as BeforeInstallPromptEvent;
      setOffer('install');
    };
    const onInstalled = () => {
      remember();
      installEvent.current = null;
      setOffer('none');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (mayOffer() && isIosSafari(navigator.userAgent, navigator.maxTouchPoints)) setOffer('ios-hint');

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // One-time: the Safari hint is spent the moment it is actually on screen.
  useEffect(() => {
    if (enabled && offer === 'ios-hint') remember();
  }, [enabled, offer]);

  if (!enabled || offer === 'none') return null;

  const dismiss = () => {
    remember();
    installEvent.current = null;
    setOffer('none');
  };

  const install = () => {
    const event = installEvent.current;
    // Whatever the answer in the browser's dialog, the question has been asked.
    dismiss();
    void event?.prompt().catch(() => undefined);
  };

  return (
    <>
      {/* Room to scroll the last of the page clear of the card. */}
      <div aria-hidden="true" className="h-20" />
      <aside
        aria-label="Install Swift"
        className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-black/5 bg-white p-3 shadow-[var(--swift-elevation-floating)]">
          <Image src="/icons/icon-192.png" alt="" width={40} height={40} unoptimized className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Install Swift</p>
            {offer === 'install' ? (
              <p className="text-xs text-[var(--swift-muted)]">Open it from your home screen, like an app.</p>
            ) : (
              <p className="text-xs text-[var(--swift-muted)]">
                Tap <Share aria-hidden="true" className="inline h-3.5 w-3.5 align-[-2px]" /> Share, then{' '}
                <span className="font-semibold text-[var(--swift-ink)]">Add to Home Screen</span>.
              </p>
            )}
          </div>
          {offer === 'install' && (
            <button
              type="button"
              onClick={install}
              className="rounded-full bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)]"
            >
              Install
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </aside>
    </>
  );
}
