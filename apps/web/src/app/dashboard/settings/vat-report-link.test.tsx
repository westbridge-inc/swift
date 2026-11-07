import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import * as storeVatRead from '@/lib/store-vat-read';
import { VatReportLink } from './vat-report-link';

// [STORE-VAT · owner O-5 · PR4] The way to the VAT report: an owner whose store has had VAT; nobody else.
afterEach(() => { vi.restoreAllMocks(); });
const profile = (myRole: string) => ({ myRole, vendors: [{ id: 'store-1', name: 'Sample Shop' }] });

describe('[O-5 PR4] the VAT report link', () => {
  it.each(['APPROVED', 'REVOKED'])('an owner whose store is %s gets the link', async (status) => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(storeVatRead, 'getStoreVat').mockResolvedValue({ status } as never);
    renderWithQuery(<VatReportLink storeId="store-1" />);
    expect((await screen.findByRole('link', { name: 'Open your VAT report' })).getAttribute('href')).toBe('/dashboard/settings/vat-report');
  });

  it.each(['NONE', 'PENDING', 'REJECTED'])('a store that never had VAT (%s) shows nothing', async (status) => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    const vat = vi.spyOn(storeVatRead, 'getStoreVat').mockResolvedValue({ status } as never);
    renderWithQuery(<VatReportLink storeId="store-1" />);
    await waitFor(() => expect(vat).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Open your VAT report' })).toBeNull();
  });

  it('a manager sees nothing, and the owner-only VAT read is not asked', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('MANAGER') as never);
    const vat = vi.spyOn(storeVatRead, 'getStoreVat').mockResolvedValue({ status: 'APPROVED' } as never);
    renderWithQuery(<VatReportLink storeId="store-1" />);
    await waitFor(() => expect(vendorApi.getProfile).toHaveBeenCalled());
    expect(vat).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
