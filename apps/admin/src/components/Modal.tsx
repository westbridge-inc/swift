'use client';
import { useEffect, useRef } from 'react';

/** A labelled, focus-contained dialog. Mount only while open. */
export function Modal({ title, onClose, children, className = '', busy = false, overlayTestId }: {
  title: string; onClose: () => void; children: React.ReactNode; className?: string; busy?: boolean; overlayTestId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = useRef(busy);
  blocked.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current!;
    const focusable = () => [...container.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    (focusable()[0] ?? container).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!blocked.current) close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0] ?? container;
      const last = elements.at(-1) ?? container;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const contain = (event: FocusEvent) => {
      if (!container.contains(event.target as Node)) (focusable()[0] ?? container).focus();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', contain);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="admin-modal-overlay" data-testid={overlayTestId}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`admin-modal ${className}`}>
      {children}
    </div>
  </div>;
}
