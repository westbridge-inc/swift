import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { WifiOff } from 'lucide-react';
import { SwiftLogo } from '@/components/swift-logo';

/**
 * [PWA-1] What the service worker (public/sw.js) shows when a page cannot reach
 * the network. The worker stores it when it installs — fetched with no cookies,
 * so it is the same page for everyone and carries nothing personal.
 *
 * It has to work from its HTML alone: offline, the stylesheet and scripts it
 * links may not be in any cache. So it is styled inline from the token
 * variables the root layout sets on <html>, and "Try again" is a plain link to
 * the current address — served in place of /orders/123, it reloads
 * /orders/123, with no JavaScript needed.
 *
 * Changing this page? Bump VERSION in public/sw.js, or phones keep the old copy.
 */
export const metadata: Metadata = {
  title: 'Offline',
  robots: { index: false, follow: false },
};

const page: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--swift-space-2xl)',
};

const panel: CSSProperties = {
  display: 'grid',
  justifyItems: 'center',
  gap: 'var(--swift-space-lg)',
  maxWidth: 'var(--swift-modal-width)',
  textAlign: 'center',
};

const heading: CSSProperties = {
  margin: 0,
  color: 'var(--swift-ink)',
  fontFamily: 'var(--swift-font-display)',
  fontSize: 'var(--swift-type-title)',
  lineHeight: 'var(--swift-leading-title)',
};

const retry: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 'var(--swift-touch)',
  padding: '0 var(--swift-space-2xl)',
  borderRadius: 'var(--swift-radius-full)',
  background: 'var(--swift-red)',
  color: 'var(--swift-white)',
  fontWeight: 600,
  textDecoration: 'none',
};

export default function OfflinePage() {
  return (
    <main style={page}>
      <div style={panel}>
        <SwiftLogo />
        <WifiOff aria-hidden="true" size={28} color="var(--swift-muted)" />
        <h1 style={heading}>You’re offline.</h1>
        <p style={{ margin: 0, color: 'var(--swift-muted)' }}>Swift needs a connection to order.</p>
        <a href="" style={retry}>
          Try again
        </a>
      </div>
    </main>
  );
}
