import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEORGETOWN } from './deviceLocation';
import {
  STORE_PIN_OUT_OF_MARKET,
  businessSetupBlocker,
  confirmedStorePin,
  geocodeStoreAddress,
  reverseGeocodeStorePin,
  storeCreateErrorCopy,
  storePinAddressLine,
  storePinConfirmable,
  storePinMoved,
  storePinStart,
  storePinStartLine,
  vendorBusinessPayload,
  type BusinessSetupFields,
  type LatLng,
  type StorePin,
} from './storePin';

// ---------------------------------------------------------------------------
// [Q8] Owner report: "they can't just use the location they're registering
// from for the store, come on now." List-your-business sent the phone's GPS as
// the store's coordinates. These pin the pure rules of the replacement: where
// the store map opens, when a spot can be confirmed, and that the store is
// created only at a pin the owner confirmed — the phone's position has no way
// into the request.
// ---------------------------------------------------------------------------

const placed: LatLng = { latitude: 6.8102, longitude: -58.1623 };
const typedAddress: LatLng = { latitude: 6.8131, longitude: -58.1587 };
const phone: LatLng = { latitude: 6.7712, longitude: -58.1874 };

describe('where the store map opens', () => {
  it('on the pin already placed, first — the owner is adjusting it', () => {
    expect(storePinStart({ current: placed, geocoded: typedAddress, device: phone })).toEqual({ ...placed, basis: 'current' });
  });

  it('else at the typed address, when the phone can find it', () => {
    expect(storePinStart({ current: null, geocoded: typedAddress, device: phone })).toEqual({ ...typedAddress, basis: 'address' });
  });

  it('else where the phone is — a suggestion to move from, labelled as one', () => {
    expect(storePinStart({ current: null, geocoded: null, device: phone })).toEqual({ ...phone, basis: 'device' });
  });

  it('else in the market centre', () => {
    expect(storePinStart({})).toEqual({ latitude: GEORGETOWN.latitude, longitude: GEORGETOWN.longitude, basis: 'market' });
  });

  it('a candidate without real coordinates is skipped, never used', () => {
    const broken = { latitude: Number.NaN, longitude: -58.16 };
    expect(storePinStart({ current: broken, geocoded: typedAddress }).basis).toBe('address');
    expect(storePinStart({ geocoded: broken, device: phone }).basis).toBe('device');
    expect(storePinStart({ device: { latitude: 6.8, longitude: Number.POSITIVE_INFINITY } }).basis).toBe('market');
  });
});

describe('when a spot can be confirmed', () => {
  it('the market centre is a place to start looking, never a store: only after the map has moved', () => {
    expect(storePinConfirmable('market', false)).toBe(false);
    expect(storePinConfirmable('market', true)).toBe(true);
  });

  it('a real place the owner can see is confirmable as it is', () => {
    for (const basis of ['current', 'address', 'device'] as const) {
      expect(storePinConfirmable(basis, false)).toBe(true);
    }
  });

  it('float noise on the first settle is not a move; a few metres of drag is', () => {
    const start = { latitude: GEORGETOWN.latitude, longitude: GEORGETOWN.longitude };
    expect(storePinMoved(start, { latitude: start.latitude + 0.00001, longitude: start.longitude - 0.00002 })).toBe(false);
    expect(storePinMoved(start, { latitude: start.latitude + 0.0003, longitude: start.longitude })).toBe(true);
    expect(storePinMoved(start, { latitude: start.latitude, longitude: start.longitude - 0.0003 })).toBe(true);
  });
});

describe('the picker says where it started, truthfully', () => {
  it('a start at the phone says so, and says to move the pin if the owner is elsewhere', () => {
    const line = storePinStartLine('device', false);
    expect(line).toMatch(/where your phone is/);
    expect(line).toMatch(/move the pin/);
  });

  it('an address the phone could not find is admitted, not glossed over', () => {
    expect(storePinStartLine('market', true)).toMatch(/^We couldn’t find that address on the map\. Starting in Georgetown\./);
    expect(storePinStartLine('device', true)).toMatch(/^We couldn’t find that address/);
    expect(storePinStartLine('market', false)).not.toMatch(/couldn/);
  });

  it('the typed address and a placed pin each say what they are', () => {
    expect(storePinStartLine('address', false)).toBe('Starting at the address you typed.');
    expect(storePinStartLine('current', false)).toBe('This is where your store’s pin is now.');
  });
});

describe('finding the typed address on the phone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks it up in Guyana, the market, not in a same-named town abroad', async () => {
    const geocodeAsync = vi.fn(async () => [typedAddress]);
    await expect(geocodeStoreAddress({ geocodeAsync }, ' 12 Regent Street ', ' Georgetown ')).resolves.toEqual(typedAddress);
    expect(geocodeAsync).toHaveBeenCalledExactlyOnceWith('12 Regent Street, Georgetown, Guyana');
  });

  it('asks nothing when too little is typed', async () => {
    const geocodeAsync = vi.fn(async () => [typedAddress]);
    await expect(geocodeStoreAddress({ geocodeAsync }, '12', 'Georgetown')).resolves.toBeNull();
    expect(geocodeAsync).not.toHaveBeenCalled();
  });

  it('nothing found, a broken result or an error all mean no start from the address', async () => {
    await expect(geocodeStoreAddress({ geocodeAsync: async () => [] }, '12 Regent Street', 'Georgetown')).resolves.toBeNull();
    await expect(geocodeStoreAddress({ geocodeAsync: async () => [{ latitude: Number.NaN, longitude: 1 }] }, '12 Regent Street', 'Georgetown')).resolves.toBeNull();
    await expect(geocodeStoreAddress({ geocodeAsync: async () => { throw new Error('no permission'); } }, '12 Regent Street', 'Georgetown')).resolves.toBeNull();
  });

  it('a slow geocoder never keeps the owner waiting', async () => {
    vi.useFakeTimers();
    const pending = geocodeStoreAddress({ geocodeAsync: () => new Promise(() => {}) }, '12 Regent Street', 'Georgetown', 4000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBeNull();
  });
});

describe('the address line under the pin', () => {
  it('names the spot from the phone’s reverse geocode', async () => {
    const reverseGeocodeAsync = vi.fn(async () => [{ name: '12 Regent St', street: 'Regent St', city: 'Georgetown' }]);
    await expect(reverseGeocodeStorePin({ reverseGeocodeAsync }, placed)).resolves.toBe('12 Regent St, Georgetown');
    expect(reverseGeocodeAsync).toHaveBeenCalledExactlyOnceWith(placed);
  });

  it('falls back through the parts a result has', () => {
    expect(storePinAddressLine({ streetNumber: '4', street: 'Camp Street', district: 'Cummingsburg' })).toBe('4 Camp Street, Cummingsburg');
    expect(storePinAddressLine({ street: 'Republic Avenue', subregion: 'Upper Demerara-Berbice' })).toBe('Republic Avenue, Upper Demerara-Berbice');
    expect(storePinAddressLine({})).toBeNull();
    expect(storePinAddressLine(undefined)).toBeNull();
  });

  it('no name, or no answer, is null — the picker then shows the coordinates', async () => {
    await expect(reverseGeocodeStorePin({ reverseGeocodeAsync: async () => [] }, placed)).resolves.toBeNull();
    await expect(reverseGeocodeStorePin({ reverseGeocodeAsync: async () => { throw new Error('offline'); } }, placed)).resolves.toBeNull();
  });
});

describe('Create store waits for a confirmed pin', () => {
  const pin: StorePin = { ...placed, address: '12 Regent St, Georgetown' };
  const complete: BusinessSetupFields = {
    name: 'Kitty Bakes',
    type: 'RESTAURANT',
    phone: '6001234',
    addr: '12 Regent Street',
    city: 'Georgetown',
    agree: true,
    pin,
  };

  it('with everything else filled in and agreed, no pin keeps Create off and says so', () => {
    expect(businessSetupBlocker({ ...complete, pin: null })).toBe('Place your store on the map');
    expect(vendorBusinessPayload({ ...complete, pin: null })).toBeNull();
  });

  it('a pin with broken coordinates is not a confirmed pin', () => {
    const broken = { ...pin, latitude: Number.NaN };
    expect(confirmedStorePin(broken)).toBeNull();
    expect(businessSetupBlocker({ ...complete, pin: broken })).toBe('Place your store on the map');
    expect(vendorBusinessPayload({ ...complete, pin: broken })).toBeNull();
  });

  it('names the first missing thing in the order the form asks for it: the pin after the address, before the agreement', () => {
    const empty: BusinessSetupFields = { name: '', type: 'STORE', phone: '', addr: '', city: '', agree: false, pin: null };
    expect(businessSetupBlocker(empty)).toBe('Name your business');
    expect(businessSetupBlocker({ ...empty, name: 'Kitty Bakes' })).toBe('Add the business phone');
    expect(businessSetupBlocker({ ...empty, name: 'Kitty Bakes', phone: '6001234' })).toBe('Add the street address');
    expect(businessSetupBlocker({ ...empty, name: 'Kitty Bakes', phone: '6001234', addr: '12 Regent Street' })).toBe('Add the city');
    expect(businessSetupBlocker({ ...complete, pin: null, agree: false })).toBe('Place your store on the map');
    expect(businessSetupBlocker({ ...complete, agree: false })).toBe('Agree to the Business Agreement first');
    expect(businessSetupBlocker(complete)).toBeNull();
  });

  it('the store is sent at exactly the confirmed pin, with the typed details trimmed', () => {
    expect(vendorBusinessPayload({ ...complete, name: ' Kitty Bakes ', addr: ' 12 Regent Street ' })).toEqual({
      name: 'Kitty Bakes',
      vendorType: 'RESTAURANT',
      phone: '6001234',
      addressLine1: '12 Regent Street',
      city: 'Georgetown',
      latitude: placed.latitude,
      longitude: placed.longitude,
    });
  });

  it('the payload has no way to take the phone’s position: the form is its only input', () => {
    expect(vendorBusinessPayload.length).toBe(1);
    expect(Object.keys(complete).sort()).toEqual(['addr', 'agree', 'city', 'name', 'phone', 'pin', 'type']);
  });
});

describe('a pin the server refuses says what to do', () => {
  it('an out-of-market pin is reported in the server’s words, not as "try again"', () => {
    const refused = { response: { data: { error: { code: STORE_PIN_OUT_OF_MARKET, message: 'That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.' } } } };
    expect(storeCreateErrorCopy(refused)).toBe('That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.');
    expect(STORE_PIN_OUT_OF_MARKET).toBe('STORE_PIN_OUT_OF_MARKET');
  });

  it('any other failure keeps the plain retry line', () => {
    expect(storeCreateErrorCopy(new Error('Network Error'))).toBe('Couldn’t create your store. Try again.');
    expect(storeCreateErrorCopy({ response: { data: { error: { code: 'AGREEMENT_REQUIRED', message: 'x' } } } })).toBe('Couldn’t create your store. Try again.');
    expect(storeCreateErrorCopy(undefined)).toBe('Couldn’t create your store. Try again.');
  });
});
