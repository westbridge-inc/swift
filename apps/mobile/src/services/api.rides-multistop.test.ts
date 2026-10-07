import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DROPOFF, PICKUP, REQUEST_BODY_WITH_ONE_STOP } from '../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · parts 6–7] What actually goes on the wire, read off the
// REAL Axios instance through a capturing adapter (the checkout-idempotency
// test's recipe): the request body and its Idempotency-Key (CONTRACT.md Rev 2
// §3), the estimate body with and without stops (§2), the capability read
// (§1), the driver's capability declaration and the part-4 stop actions (§6.4).
// ---------------------------------------------------------------------------

const env = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  process.env['EXPO_PUBLIC_API_URL'] = 'https://api.test';
  return { previousApiUrl };
});

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => null,
  isAuthSessionSnapshotCurrent: () => false,
  useAuthStore: { getState: () => ({ rotateTokensIfCurrent: () => null, logoutIfCurrent: () => false }) },
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } }));

import { api, driverApi, rideApi } from './api';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;

function capture(): InternalAxiosRequestConfig[] {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push(config);
    const res: AxiosResponse = { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data: {} } };
    return res;
  };
  api.defaults.adapter = adapter;
  return seen;
}
const bodyOf = (config: InternalAxiosRequestConfig) => JSON.parse(String(config.data));

afterEach(() => {
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
});
afterAll(() => {
  if (env.previousApiUrl === undefined) delete process.env['EXPO_PUBLIC_API_URL'];
  else process.env['EXPO_PUBLIC_API_URL'] = env.previousApiUrl;
});

describe('POST /rides/request', () => {
  it('sends the contract’s body exactly, with the booking’s Idempotency-Key', async () => {
    const seen = capture();
    await rideApi.request({ ...REQUEST_BODY_WITH_ONE_STOP, stops: [...REQUEST_BODY_WITH_ONE_STOP.stops] }, 'ride_test_0123456789');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('post');
    expect(seen[0]!.url).toBe('/rides/request');
    expect(bodyOf(seen[0]!)).toEqual(REQUEST_BODY_WITH_ONE_STOP);
    expect(seen[0]!.headers.get('Idempotency-Key')).toBe('ride_test_0123456789');
  });

  it('a ride without stops sends today’s body — no stops, no expectedFare — and still a key', async () => {
    const seen = capture();
    const today = Object.fromEntries(Object.entries(REQUEST_BODY_WITH_ONE_STOP).filter(([k]) => k !== 'stops' && k !== 'expectedFare'));
    await rideApi.request(today as never, 'ride_test_today00001');
    expect(Object.keys(bodyOf(seen[0]!))).toEqual(['pickup', 'dropoff', 'pickupAddress', 'dropoffAddress', 'passengerCount', 'rideClass']);
    expect(seen[0]!.headers.get('Idempotency-Key')).toBe('ride_test_today00001');
  });
});

describe('POST /rides/estimate', () => {
  it('with stops: the stops in the passenger’s order', async () => {
    const seen = capture();
    await rideApi.estimate(PICKUP, DROPOFF, [{ lat: 6.825, lng: -58.15, address: 'Sheriff Street' }, { lat: 6.8143, lng: -58.1443, address: 'Camp Street' }]);
    expect(seen[0]!.url).toBe('/rides/estimate');
    expect(bodyOf(seen[0]!)).toEqual({
      pickup: PICKUP,
      dropoff: DROPOFF,
      stops: [{ lat: 6.825, lng: -58.15, address: 'Sheriff Street' }, { lat: 6.8143, lng: -58.1443, address: 'Camp Street' }],
    });
  });

  it('without stops: exactly today’s body, no stops key at all', async () => {
    const seen = capture();
    await rideApi.estimate(PICKUP, DROPOFF);
    await rideApi.estimate(PICKUP, DROPOFF, []);
    for (const config of seen) expect(Object.keys(bodyOf(config))).toEqual(['pickup', 'dropoff']);
  });
});

describe('GET /rides/capabilities', () => {
  it('reads the flag the app shows "+ Add stop" from', async () => {
    const seen = capture();
    await rideApi.capabilities();
    expect(seen[0]!.method).toBe('get');
    expect(seen[0]!.url).toBe('/rides/capabilities');
  });
});

describe('the driver side', () => {
  it('go-online without a capability is exactly today’s body', async () => {
    const seen = capture();
    await driverApi.goOnline(6.8, -58.1);
    expect(seen[0]!.url).toBe('/driver/go-online');
    expect(seen[0]!.data).toBe(JSON.stringify({ latitude: 6.8, longitude: -58.1 }));
  });

  it('go-online declares the multi-stop capability only when it is passed', async () => {
    const seen = capture();
    await driverApi.goOnline(6.8, -58.1, undefined, ['TAXI_STOPS_V1']);
    expect(bodyOf(seen[0]!)).toEqual({ latitude: 6.8, longitude: -58.1, capabilities: ['TAXI_STOPS_V1'] });
  });

  it('the part-4 stop actions hit the contract’s routes', async () => {
    const seen = capture();
    await driverApi.stopArrived('ride-1', 1);
    await driverApi.stopDepart('ride-1', 1);
    await driverApi.stopSkip('ride-1', 2, 'Road or access blocked');
    expect(seen.map((c) => `${c.method} ${c.url}`)).toEqual([
      'put /driver/rides/ride-1/stops/1/arrived',
      'put /driver/rides/ride-1/stops/1/depart',
      'post /driver/rides/ride-1/stops/2/skip',
    ]);
    expect(bodyOf(seen[2]!)).toEqual({ reason: 'Road or access blocked' });
  });
});
