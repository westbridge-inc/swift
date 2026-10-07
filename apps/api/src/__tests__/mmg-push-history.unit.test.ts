import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveMmgProvider, type LiveMmgConfig } from '../providers/mmg/mmg-provider';
import { historyQueryFor } from '../modules/billing/mmg-checkout.service';

const cfg: LiveMmgConfig = { baseUrl: 'https://mmg.invalid', apiKey: 'test-key', merchantMsisdn: '9991161', password: 'test-password', mkey: 'test-mkey', msecret: 'test-msecret' };
const opened = new Date('2026-10-01T19:38:19Z');
const bound = new Date('2026-10-01T19:39:05Z');
// Probe-shaped history records; all account and payment identifiers are synthetic.
const row = (id: string) => ({ amount: '500', currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
  modificationDate: '2026-10-01T15:38:31.000Z', transactionReference: id, transactionReceipt: id,
  debitParty: [{ key: 'accountid', value: '11111' }, { key: 'accountcategory', value: {} }],
  creditParty: [{ key: 'accountid', value: '22222' }, { key: 'accountcategory', value: 'ewallet' }], external_id: '1790000001' });
function transport(body: unknown, status = 200) {
  return vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'test-session', expires_in: 120 }) })
    .mockResolvedValueOnce({ ok: status === 200, status, json: async () => body });
}
afterEach(() => vi.useRealTimers());

describe('dormant push history uses the checkout history clock, window and complete row count', () => {
  it.each([
    ['2026-10-01T22:00:00Z', '2026-10-01T15:51:05.000Z'],
    ['2026-10-01T19:39:10.200Z', '2026-10-01T15:39:11.000Z'],
  ])('uses the same query at %s, including both rows from the probe shape', async (clock, todate) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(clock));
    const fetcher = transport({ executionId: 'test-execution', TransactionList: [row('TX1'), row('TX2')] });
    const result = await new LiveMmgProvider(cfg, fetcher as any).transactionHistory({ from: opened, to: bound, limit: 100 });
    const query = new URL(String(fetcher.mock.calls[1]![0])).searchParams;
    const checkout = historyQueryFor({ createdAt: opened, expiresAt: bound }, bound, 'GUYANA_WALL_CLOCK', new Date(clock));
    expect(Object.fromEntries(query)).toEqual({ msisdn: cfg.merchantMsisdn, offset: '100', fromdate: '2026-10-01T15:26:19.000Z', todate });
    expect(query.get('fromdate')).toBe(checkout.fromdate);
    expect(query.get('todate')).toBe(checkout.todate);
    expect(query.get('offset')).toBe(String(checkout.rows));
    expect(result.map((item) => item.transactionId)).toEqual(['TX1', 'TX2']);
  });

  it.each([100, 101])('refuses a %s-row answer before applying the caller display limit', async (length) => {
    const fetcher = transport({ TransactionList: Array.from({ length }, (_, i) => row(`TX${i}`)) });
    await expect(new LiveMmgProvider(cfg, fetcher as any).transactionHistory({ from: opened, to: bound, limit: 1 })).rejects.toThrow(/incomplete/i);
  });

  it.each([{}, { TransactionList: {} }, { TransactionList: [row('TX1'), null] }])('refuses a malformed answer without exposing a partial list: %j', async (body) => {
    await expect(new LiveMmgProvider(cfg, transport(body) as any).transactionHistory({ from: opened, to: bound })).rejects.toThrow();
  });

  it('accepts an empty complete answer', async () => {
    expect(await new LiveMmgProvider(cfg, transport({ TransactionList: [] }) as any).transactionHistory({ from: opened, to: bound })).toEqual([]);
  });
});
