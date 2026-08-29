import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [B3] The tracking screen says when an ETA is "after another delivery".
//
// A stacked rider's second customer receives an ETA that is the chain through
// the first delivery. The server labels it `etaBasis: 'after_current'`. A
// screen that prints "Rider arriving in ~14 min" for that number is telling
// the truth about the minutes and lying about the route — the rider is about
// to drive away from them first. The label is the difference.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

describe('the chained ETA is labelled, never passed off as direct', () => {
  it('the basis is read from the rider:location payload', () => {
    const handler = SCREEN.slice(SCREEN.indexOf('const onRider = (p: any) => {'), SCREEN.indexOf('const onDriver = (p: any) => {'));
    expect(handler).toContain("p?.etaBasis === 'after_current'");
  });

  it('an unknown or missing basis is treated as direct — the old payload keeps working', () => {
    const handler = SCREEN.slice(SCREEN.indexOf('const onRider = (p: any) => {'), SCREEN.indexOf('const onDriver = (p: any) => {'));
    expect(handler).toMatch(/=== 'after_current' \? 'after_current' : 'direct'/);
  });

  it('the copy says "after another delivery" when it is', () => {
    const start = SCREEN.indexOf('} else if (freshLiveEta != null) {');
    expect(start).toBeGreaterThan(-1);
    // The branch body is a few lines; the next `} else` or closing brace ends it.
    const body = SCREEN.slice(start + 1);
    const branch = body.slice(0, body.indexOf('\n  }'));
    expect(branch).toContain("liveEtaBasis === 'after_current'");
    expect(branch).toContain('after another delivery');
    // And the direct wording is unchanged for the first customer.
    expect(branch).toContain('`Rider arriving in ~${Math.round(freshLiveEta)} min`');
  });
});
