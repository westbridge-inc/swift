import { describe, expect, it } from 'vitest';
import { STORE_URLS, buildNumberOf, minimumBuildFor, storePlatformOf, updateRequired } from './appVersionGate';

// [Row 3 · force update] The phone blocks itself ONLY on a clear "this build is
// below the minimum". Everything uncertain shows the app as usual.

const answer = (ios: unknown, android: unknown) => ({ ios: { minBuild: ios }, android: { minBuild: android } });

describe('updateRequired', () => {
  it.each([
    ['ios', '11', answer(12, null), true],
    ['ios', '12', answer(12, null), false],
    ['ios', '13', answer(12, null), false],
    ['android', '7', answer(null, 8), true],
    ['android', '8', answer(null, 8), false],
    // Each platform reads only its own minimum.
    ['android', '7', answer(12, null), false],
    ['ios', '11', answer(null, 8), false],
  ] as const)('%s build %s against %j → %s', (os, build, policy, want) => {
    expect(updateRequired(policy, os, build)).toBe(want);
  });

  it('no minimum set (the launch state) blocks nobody', () => {
    for (const build of ['9', '10', '11', '12']) {
      expect(updateRequired(answer(null, null), 'ios', build)).toBe(false);
      expect(updateRequired(answer(null, null), 'android', build)).toBe(false);
    }
  });

  it.each([
    ['no answer', null, 'ios', '11'],
    ['an older API (404 body)', { success: false }, 'ios', '11'],
    ['a malformed minimum', answer('twelve', null), 'ios', '11'],
    ['a zero minimum', answer(0, null), 'ios', '11'],
    ['an unreadable build number', answer(12, null), 'ios', null],
    ['a non-numeric build number', answer(12, null), 'ios', '12.0.1'],
    ['the web', answer(12, 12), 'web', '1'],
  ])('fails open on %s', (_why, policy, os, build) => {
    expect(updateRequired(policy, os, build)).toBe(false);
  });
});

describe('the parts', () => {
  it('reads a build number only when it is whole and positive', () => {
    expect([buildNumberOf('12'), buildNumberOf(' 8 '), buildNumberOf(12)]).toEqual([12, 8, 12]);
    expect([buildNumberOf('0'), buildNumberOf('-1'), buildNumberOf(''), buildNumberOf('1.0.0'), buildNumberOf(undefined), buildNumberOf(1.5)]).toEqual([null, null, null, null, null, null]);
  });

  it('reads each platform’s minimum from the API’s data', () => {
    expect(minimumBuildFor(answer(12, 8), 'ios')).toBe(12);
    expect(minimumBuildFor(answer(12, 8), 'android')).toBe(8);
    expect(minimumBuildFor({ ios: 12 }, 'ios')).toBeNull();
  });

  it('knows the two store platforms and their store pages', () => {
    expect([storePlatformOf('ios'), storePlatformOf('android'), storePlatformOf('web'), storePlatformOf(undefined)]).toEqual(['ios', 'android', null, null]);
    expect(STORE_URLS.ios).toMatch(/^https:\/\/apps\.apple\.com\/app\/id\d+$/);
    expect(STORE_URLS.android).toBe('https://play.google.com/store/apps/details?id=gy.swift.app');
  });
});
