import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QrState } from './qr-state';

vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

// ---------------------------------------------------------------------------
// [Row 111 · W8 · REVIEW-E S3-1] A scanned counter code that lands on a QR
// status page (not found, retired, unavailable) has a "Skip to main content"
// target like every other page. Embedded in a store page, the app frame already
// holds the page's one main region, so the state adds none.
// ---------------------------------------------------------------------------

describe('[W8] the QR status pages are skip-link targets', () => {
  it('on its own page, the state is the main region: id="main", focusable', () => {
    render(<QrState eyebrow="Counter code" title="This code is not in use">Ask the store for a new one.</QrState>);
    const main = document.getElementById('main');
    expect(main?.tagName).toBe('MAIN');
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('embedded in a store page it adds no second main region and no second target', () => {
    render(<QrState embedded eyebrow="Store" title="This store is not open">Try again later.</QrState>);
    expect(document.getElementById('main')).toBeNull();
    expect(document.querySelector('main')).toBeNull();
  });
});
