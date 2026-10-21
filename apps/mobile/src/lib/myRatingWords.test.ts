import { describe, expect, it } from 'vitest';
import { myRatingWords } from './myRatingWords';

// [BUG-GUARDS C3 · #1951 review S3-1] The Profile rating never says "No rating yet" before the rating read
// has answered: a failed read says so, a read in flight says Loading…, and only an answered read with no
// rating says "No rating yet".
describe('your rating on Profile', () => {
  it('a failed read with nothing cached says so, not "No rating yet"', () => {
    expect(myRatingWords({ data: undefined, isError: true, isLoading: false }, ' · ')).toBe("Couldn't load your rating");
  });
  it('a read in flight says Loading…, not "No rating yet"', () => {
    expect(myRatingWords({ data: undefined, isError: false, isLoading: true }, ' ')).toBe('Loading…');
  });
  it('an answered read with no rating says "No rating yet" (also when a later refresh fails)', () => {
    expect(myRatingWords({ data: { displayRating: null }, isError: false, isLoading: false }, ' · ')).toBe('No rating yet');
    expect(myRatingWords({ data: null, isError: true, isLoading: false }, ' · ')).toBe('No rating yet');
  });
  it('a rating reads as the number and its bucket, in each place’s format', () => {
    expect(myRatingWords({ data: { displayRating: 4.84, ratingBucket: 'Great' }, isError: true, isLoading: false }, ' · ')).toBe('4.8 · Great');
    expect(myRatingWords({ data: { displayRating: 4.84, ratingBucket: 'Great' }, isError: false, isLoading: false }, ' ')).toBe('4.8 Great');
  });
});
