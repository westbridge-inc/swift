import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldPrimeHeroVideo } from './hero-video-gate';

describe('hero video cold-start containment', () => {
  it('keeps the native source cold until the poster intersects the viewport', () => {
    expect(shouldPrimeHeroVideo(0)).toBe(false);
    expect(shouldPrimeHeroVideo(-0.1)).toBe(false);
    expect(shouldPrimeHeroVideo(Number.NaN)).toBe(false);
    expect(shouldPrimeHeroVideo(0.001)).toBe(true);
  });

  it('mounts HeroPlayer only behind the primed-video gate', () => {
    const source = readFileSync(new URL('./AdHeroVideo.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const useVideo = videoEligible && videoPrimed');
    expect(source).toContain('{useVideo && videoModule ? (');
    expect(source).toContain('onPlayer={handlePlayer}');
    expect(source).toContain('onProgress={handleProgress}');
    expect(source).toContain('onError={handleVideoError}');
  });
});
