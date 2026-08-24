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
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  storeSlug?: string;
  retryAction?: () => void;
}) {
  return (
    <main className={styles.page}>
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
    </main>
  );
}
