import { describe, expect, it } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { getAdvertisers, getCampaigns, getNotifications, switchWebRole } from './partner-api';

describe('partner web API contracts', () => {
  it('reads advertiser memberships and campaigns from the existing ads endpoints', async () => {
    const paths: string[] = [];
    mockApi(({ url }) => { paths.push(url.pathname); return { body: { success: true, data: [{ id: 'sample' }] } }; });
    expect(await getAdvertisers()).toEqual([{ id: 'sample' }]);
    expect(await getCampaigns('company/a')).toEqual([{ id: 'sample' }]);
    expect(paths).toEqual(['/api/v1/ads/advertiser/me', '/api/v1/ads/advertiser/company%2Fa/campaigns']);
  });
  it('keeps notification pagination and does not pretend a failed read is empty', async () => {
    mockApi(({ url }) => {
      expect(url.pathname).toBe('/api/v1/customer/notifications');
      expect(url.searchParams.get('page')).toBe('2');
      return { body: { success: true, data: [{ id: 'n1', title: 'Ready' }], meta: { total: 31, page: 2 } } };
    });
    expect(await getNotifications(2)).toEqual({ rows: [{ id: 'n1', title: 'Ready' }], total: 31 });
    mockApi(() => ({ status: 503, body: { success: false, error: { message: 'Try later' } } }));
    await expect(getNotifications(1)).rejects.toThrow('Try later');
  });
  it('uses the existing role payload and preserves the API cookie request policy', async () => {
    mockApi(({ url, method, init }) => {
      expect(url.pathname).toBe('/api/v1/customer/switch-role');
      expect(method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ role: 'RIDER' });
      expect(init?.credentials).toBe('include');
      return { body: { success: true, data: { activeRole: 'RIDER' } } };
    });
    expect(await switchWebRole('RIDER')).toEqual({ activeRole: 'RIDER' });
  });
});
