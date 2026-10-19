import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import { StorePhotosCard } from './store-photos-card';

// ---------------------------------------------------------------------------
// [IMAGES-E2E] The store's own logo and cover on the web dashboard, the same as
// the phone app: a photo is uploaded for the SELECTED store, taken down with
// Remove, and a refusal is shown in the API's own words. Synthetic store only.
// ---------------------------------------------------------------------------

const KEY = 'items/store-1/AbCdEfGhIjKlMnOp.jpg';
const profile = (logoUrl: string | null, coverImageUrl: string | null) => ({
  id: 'owner-1', userId: 'user-1', myRole: 'OWNER',
  vendors: [{ id: 'store-1', name: 'Sample Kitchen', logoUrl, coverImageUrl }, { id: 'store-2', name: 'Other', logoUrl: null, coverImageUrl: null }],
});

afterEach(() => { vi.restoreAllMocks(); });

describe('[IMAGES-E2E] the store photos card', () => {
  it('uploads the chosen file as the selected store’s cover', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile(null, null) as never);
    const upload = vi.spyOn(vendorApi, 'uploadStorePhoto').mockResolvedValue({ id: 'store-1', logoUrl: null, coverImageUrl: KEY });
    renderWithQuery(<StorePhotosCard storeId="store-1" />);
    const input = await screen.findByLabelText('Cover photo file');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'front.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(upload).toHaveBeenCalledWith('cover', file));
  });

  it('shows the photos on file through the store-photo route, and Remove takes the logo down', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile(KEY, null) as never);
    const remove = vi.spyOn(vendorApi, 'removeStorePhoto').mockResolvedValue({ id: 'store-1', logoUrl: null, coverImageUrl: null });
    renderWithQuery(<StorePhotosCard storeId="store-1" />);
    const logo = await screen.findByAltText('Logo');
    expect(logo.getAttribute('src')).toContain('/media/items/store-1/AbCdEfGhIjKlMnOp.jpg');
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('logo'));
  });

  it('a refusal is shown in the API’s own words', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile(null, null) as never);
    vi.spyOn(vendorApi, 'uploadStorePhoto').mockRejectedValue(new Error('File content does not match an image format'));
    renderWithQuery(<StorePhotosCard storeId="store-1" />);
    await userEvent.upload(await screen.findByLabelText('Logo file'), new File(['x'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File content does not match an image format');
  });
});
