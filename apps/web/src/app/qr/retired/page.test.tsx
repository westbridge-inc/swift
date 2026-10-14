import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RetiredQrPage from './page';

// The server sends the store's live address (qr-codes.ts), which is the
// store name plus a nanoid code — capitals and underscores included.
describe('retired QR page: the current-store link', () => {
  it('keeps the link for a real store address with capitals or an underscore', async () => {
    for (const store of ['green-bowl-MSFa7a', 'sample-kitchen-aaKL9_']) {
      const page = render(await RetiredQrPage({ searchParams: Promise.resolve({ store }) }));
      expect(page.container.querySelector(`a[href*="/store/${store}"]`)).not.toBeNull();
      page.unmount();
    }
  });
  it('drops anything that is not a store address', async () => {
    for (const store of ['a/b', '../x', 'bad.slug', '-x']) {
      const page = render(await RetiredQrPage({ searchParams: Promise.resolve({ store }) }));
      expect(page.container.querySelector('a[href*="/store/"]')).toBeNull();
      page.unmount();
    }
  });
});
