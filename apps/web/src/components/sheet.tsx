'use client';

import { useEffect, type ReactNode } from 'react';
import { Modal } from './modal';

/** The menu sheet uses the shared portal, inert background and focus trap. */
export function Sheet({ children, ...props }: {
  children: ReactNode; labelledBy: string; onClose: () => void; className?: string;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <Modal {...props}>{children}</Modal>;
}
