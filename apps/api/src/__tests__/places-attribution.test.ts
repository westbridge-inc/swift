import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  LocalPlacesProvider, GooglePlacesProvider, OsmPlacesProvider, getPlacesProvider,
} from '../providers/places/places-provider';

// ---------------------------------------------------------------------------
// [LIC-002 · PROV-003] SWIFT OWES OPENSTREETMAP A VISIBLE CREDIT, AND OWED IT
// NOTHING BUT SILENCE.
//
// OSRM, Photon and Nominatim all read OpenStreetMap data. The ODbL requires an
// application showing derived results to credit OpenStreetMap visibly, and
// Google's Places terms make the same kind of demand. Neither credit existed
// anywhere in Swift — not in the app, not in the legal notice.
//
// The reason is structural rather than forgetful: the provider seam DROPPED
// provider identity. A suggestion arrived as a label and an id with nothing
// saying where it came from, so no screen could have attributed it correctly,
// and any hardcoded credit would have become a lie the day `PLACES_PROVIDER`
// changed. Attribution is now a fact each provider states about itself and
// carries with its results.
// ---------------------------------------------------------------------------

const prisma = {} as PrismaClient;

describe('[LIC-002] every places provider declares what it obliges Swift to show', () => {
  it('OSM-derived results credit OpenStreetMap, with the licence link', () => {
    const osm = new OsmPlacesProvider(prisma, 'http://photon.local');
    expect(osm.attribution.source).toBe('osm');
    expect(osm.attribution.text).toBe('© OpenStreetMap contributors');
    expect(osm.attribution.url).toContain('openstreetmap.org/copyright');
  });

  it('Google predictions carry the Google credit and a source the client can render a logo for', () => {
    const google = new GooglePlacesProvider('key');
    expect(google.attribution.source).toBe('google');
    expect(google.attribution.text).toContain('Google');
  });

  it('Swift’s own rows owe nobody a credit, and say so explicitly rather than by omission', () => {
    const local = new LocalPlacesProvider(prisma);
    expect(local.attribution.source).toBe('swift');
    expect(local.attribution.text, 'empty means "none owed", not "nobody filled this in"').toBe('');
  });

  it('EVERY selectable provider declares one — a new adapter cannot ship without saying', () => {
    // The point of the test. An adapter added later inherits the obligation to
    // state its attribution, because the interface requires it and this walks
    // every value `PLACES_PROVIDER` accepts.
    const cases: Array<[string, Record<string, string>]> = [
      ['local', {}],
      ['osm', { PHOTON_URL: 'http://photon.local' }],
      ['google', { GOOGLE_MAPS_API_KEY_BACKEND: 'key' }],
    ];
    for (const [name, env] of cases) {
      const saved = { ...process.env };
      Object.assign(process.env, env, { PLACES_PROVIDER: name });
      try {
        const provider = getPlacesProvider(prisma);
        expect(provider.attribution, name).toBeTruthy();
        expect(typeof provider.attribution.text, name).toBe('string');
        expect(['osm', 'google', 'swift'], name).toContain(provider.attribution.source);
        // A provider whose data belongs to someone else must name them.
        if (provider.attribution.source !== 'swift') {
          expect(provider.attribution.text.length, `${name} must carry a visible credit`).toBeGreaterThan(0);
          expect(provider.attribution.url, `${name} must link its licence/terms`).toBeTruthy();
        }
      } finally {
        process.env = saved;
      }
    }
  });
});
