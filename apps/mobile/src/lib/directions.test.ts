import { describe, expect, it } from 'vitest';
import { directionsDestination, directionsLinks } from './directions';

// [row 363] Which maps link a Directions tap opens, per platform.
const STORE = { lat: 6.8143, lng: -58.1443, address: 'Lot 1 Test Street, Georgetown' };

describe('directionsLinks', () => {
  it('iOS: Apple Maps first, the Google web map only if Apple Maps will not open', () => {
    expect(directionsLinks(STORE, 'ios')).toEqual({
      primary: 'https://maps.apple.com/?daddr=6.8143,-58.1443',
      fallback: 'https://www.google.com/maps/dir/?api=1&destination=6.8143,-58.1443',
    });
  });

  it('Android: Google Maps (its link opens the app when installed), nothing Apple', () => {
    const links = directionsLinks(STORE, 'android')!;
    expect(links).toEqual({ primary: 'https://www.google.com/maps/dir/?api=1&destination=6.8143,-58.1443', fallback: null });
    expect(JSON.stringify(links)).not.toContain('apple');
  });

  it('any other platform (web) gets the Google map too', () => {
    expect(directionsLinks(STORE, 'web')?.primary).toBe('https://www.google.com/maps/dir/?api=1&destination=6.8143,-58.1443');
  });

  it('exact coordinates win over the address; the address is used, encoded, only without them', () => {
    expect(directionsDestination(STORE)).toBe('6.8143,-58.1443');
    expect(directionsDestination({ lat: null, lng: -58.1, address: '  Lot 1 & 2, Regent St  ' })).toBe(encodeURIComponent('Lot 1 & 2, Regent St'));
    expect(directionsDestination({ lat: '6.8', lng: '-58.1', address: 'Main St' })).toBe('Main%20St');
  });

  it('no coordinates and no address: no link (the opener says so instead of opening a blank map)', () => {
    expect(directionsLinks({ lat: null, lng: null, address: '   ' }, 'android')).toBeNull();
    expect(directionsLinks({}, 'ios')).toBeNull();
  });
});
