'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * [WEB-REDESIGN · review S2] One modal for the customer app's sheets (Switch
 * app, the phone menu, Scan, a store's item and booking sheets), with real
 * modal behaviour:
 *
 *  - it is rendered at the end of <body>, and everything else on the page is
 *    made `inert` (and hidden from assistive tech) while it is open, so
 *    neither a pointer, Tab nor a screen reader can reach the page behind;
 *  - Tab and Shift+Tab cycle inside it;
 *  - focus starts on the first control (or the one marked
 *    `data-modal-initial-focus`), Escape and the backdrop close it, and on
 *    close focus returns to whatever opened it.
 */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true');
}

export function Modal({
  label, labelledBy, onClose, className = '', children,
}: {
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = document.createElement('div');
    node.setAttribute('data-swift-modal', '');
    document.body.appendChild(node);
    // Everything that was on the page before this modal opened goes inert.
    const background = Array.from(document.body.children).filter((child) => child !== node && !child.hasAttribute('inert')) as HTMLElement[];
    for (const element of background) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
    setHost(node);
    return () => {
      for (const element of background) {
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
      }
      node.remove();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (!host || !dialog.current) return;
    const root = dialog.current;
    const initial = root.querySelector<HTMLElement>('[data-modal-initial-focus]') ?? focusableIn(root)[0] ?? root;
    initial.focus();
  }, [host]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close.current();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const items = focusableIn(dialog.current);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!host) return null;
  return createPortal(
    <div className="sw-scrim" onKeyDown={onKeyDown}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={() => close.current()} className="absolute inset-0 cursor-default" />
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy} tabIndex={-1} className={`sw-sheet relative outline-none ${className}`}>
        {children}
      </div>
    </div>,
    host,
  );
}
