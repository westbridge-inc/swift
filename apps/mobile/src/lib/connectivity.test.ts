import { describe, expect, it } from 'vitest';
import { offlineBannerBodyHeight, OFFLINE_BANNER_MIN_BODY_HEIGHT } from './connectivity';

describe('offline banner layout', () => {
  it('reserves only the body below the device safe area', () => {
    expect(offlineBannerBodyHeight(91, 59)).toBe(32);
    expect(offlineBannerBodyHeight(112, 59)).toBe(53);
  });

  it('keeps a stable floor for initial layout and invalid measurements', () => {
    expect(offlineBannerBodyHeight(0, 59)).toBe(OFFLINE_BANNER_MIN_BODY_HEIGHT);
    expect(offlineBannerBodyHeight(Number.NaN, 59)).toBe(OFFLINE_BANNER_MIN_BODY_HEIGHT);
  });
});
