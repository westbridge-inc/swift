import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../utils/errors';
import {
  assertAcceptableContent,
  configuredObjectionableTerms,
  containsObjectionableContent,
} from '../modules/moderation/content-filter';
import { needsProfanityHold } from '../modules/rating/review-scrub';

describe('server-side objectionable-content filter', () => {
  const originalExtraWords = process.env['CONTENT_FILTER_EXTRA_WORDS'];

  afterEach(() => {
    if (originalExtraWords === undefined) delete process.env['CONTENT_FILTER_EXTRA_WORDS'];
    else process.env['CONTENT_FILTER_EXTRA_WORDS'] = originalExtraWords;
  });

  it('matches seeded English and local terms case-insensitively', () => {
    expect(containsObjectionableContent('This is SHIT.')).toBe(true);
    expect(containsObjectionableContent('real skunt behaviour')).toBe(true);
    expect(containsObjectionableContent('A normal delivery note')).toBe(false);
  });

  it('matches whole words instead of innocent substrings', () => {
    expect(containsObjectionableContent('The shipment arrived')).toBe(false);
    expect(containsObjectionableContent('Classic bassoon music')).toBe(false);
  });

  it('rejects before storage and identifies every affected field', () => {
    let error: unknown;
    try {
      assertAcceptableContent({
        name: 'A friendly name',
        description: 'This is fucking awful',
        tags: ['fresh', 'buller'],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'OBJECTIONABLE_CONTENT',
      details: { fields: ['description', 'tags'] },
    });
  });

  it('adds configured words without allowing configuration to remove seeds', () => {
    process.env['CONTENT_FILTER_EXTRA_WORDS'] = '  spamword,customword  ';
    expect(configuredObjectionableTerms()).toEqual(['spamword', 'customword']);
    expect(() => assertAcceptableContent({ message: 'a spamword here' })).toThrowError(AppError);
    expect(needsProfanityHold('a customword review')).toBe(true);
    expect(containsObjectionableContent('still shit')).toBe(true);
  });

  it('keeps the existing rating hold semantics on the same seed list', () => {
    expect(needsProfanityHold('bitch')).toBe(true);
    expect(needsProfanityHold('This is clean')).toBe(false);
    expect(needsProfanityHold('blocked by admin', ['blocked'])).toBe(true);
  });
});
