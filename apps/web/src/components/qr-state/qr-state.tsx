'use client';

import Link from 'next/link';
import { QrCode } from 'lucide-react';
import { SwiftLogo } from '@/components/swift-logo';
import styles from './qr-state.module.css';

export function QrState({
  eyebrow,
  title,
  children,
  storeSlug,
  retryAction,
  embedded = false,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  storeSlug?: string;
  retryAction?: () => void;
  /** [W6] Drawn inside the customer app's frame (a store page's error or
   *  not-found state), which already holds the page's one <main>. */
  embedded?: boolean;
}) {
  const Frame = embedded ? 'div' : 'main';
  return (
    <Frame className={embedded ? styles.embedded : styles.page}>
      <section className={styles.card}>
        <SwiftLogo />
        <span className={styles.icon} aria-hidden="true"><QrCode size={28} /></span>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 className={styles.title}>{title}</h1>
        </div>
        <p className={styles.copy}>{children}</p>
        <div className={styles.actions}>
          {retryAction ? (
            <button type="button" className={styles.primary} onClick={retryAction}>Try this store again</button>
          ) : null}
          {storeSlug ? (
            <Link href={`/store/${storeSlug}`} className={retryAction ? styles.secondary : styles.primary}>Open the current store page</Link>
          ) : null}
          <Link href="/stores" className={storeSlug || retryAction ? styles.secondary : styles.primary}>Browse stores on Swift</Link>
        </div>
      </section>
    </Frame>
  );
}
