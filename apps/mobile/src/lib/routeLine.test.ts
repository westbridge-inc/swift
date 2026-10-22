import { describe, expect, it } from 'vitest';
import { driverMapLine, roadPointsFrom, skippedStopsKey } from './routeLine';

// [TAXI route line · MAPS-CHECK G1] The driver's map draws the road the server
// sends; anything else keeps the straight heading line of before.

const STRAIGHT = [
  { latitude: 6.81, longitude: -58.15 },
  { latitude: 6.8143, longitude: -58.1443 },
  { latitude: 6.82, longitude: -58.16 },
];
const ROAD = { source: 'road', points: [{ lat: 6.81, lng: -58.15 }, { lat: 6.8121, lng: -58.1478 }, { lat: 6.8143, lng: -58.1443 }, { lat: 6.82, lng: -58.16 }] };

describe('roadPointsFrom', () => {
  it('the road’s points, as map coordinates, in order', () => {
    expect(roadPointsFrom(ROAD)).toEqual([
      { latitude: 6.81, longitude: -58.15 },
      { latitude: 6.8121, longitude: -58.1478 },
      { latitude: 6.8143, longitude: -58.1443 },
      { latitude: 6.82, longitude: -58.16 },
    ]);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a straight answer', { source: 'straight', points: ROAD.points }],
    ['no points', { source: 'road' }],
    ['one point', { source: 'road', points: [{ lat: 6.81, lng: -58.15 }] }],
    ['a point that is a string', { source: 'road', points: [{ lat: 6.81, lng: -58.15 }, { lat: '6.82', lng: -58.16 }] }],
    ['a point that is not finite', { source: 'road', points: [{ lat: 6.81, lng: -58.15 }, { lat: Number.NaN, lng: -58.16 }] }],
    ['a point off the globe', { source: 'road', points: [{ lat: 6.81, lng: -58.15 }, { lat: 6.82, lng: -181 }] }],
    ['a point that is null', { source: 'road', points: [{ lat: 6.81, lng: -58.15 }, null] }],
  ])('%s: no road', (_name, answer) => {
    expect(roadPointsFrom(answer)).toBeNull();
  });
});

describe('driverMapLine', () => {
  it('the road when the server sent one (not geodesic)', () => {
    expect(driverMapLine(ROAD, STRAIGHT)).toEqual({ coordinates: roadPointsFrom(ROAD), road: true });
  });

  it('otherwise the straight heading through the ride’s own points, exactly as before (geodesic)', () => {
    for (const answer of [undefined, null, { source: 'straight', points: ROAD.points }, { source: 'road', points: [] }]) {
      expect(driverMapLine(answer, STRAIGHT)).toEqual({ coordinates: STRAIGHT, road: false });
    }
  });

  it('with no pickup and drop-off to draw between, nothing is drawn even if a road came', () => {
    expect(driverMapLine(ROAD, [])).toEqual({ coordinates: [], road: false });
  });
});

describe('skippedStopsKey', () => {
  it('the skipped stops in order, so a skip (and only a skip) asks for the line again', () => {
    expect(skippedStopsKey([])).toBe('');
    expect(skippedStopsKey([{ sequence: 1, status: 'ARRIVED' }, { sequence: 2, status: 'PENDING' }])).toBe('');
    expect(skippedStopsKey([{ sequence: 3, status: 'SKIPPED' }, { sequence: 1, status: 'SKIPPED' }, { sequence: 2, status: 'DEPARTED' }])).toBe('1,3');
  });
});
