/** [BUG-GUARDS C3] Your rating in words for the Profile row and its info card. A rating that has not been
 *  read yet (still loading, or the read failed with nothing cached) is never "No rating yet". */
export interface MyRatingRead {
  data?: { displayRating?: number | null; ratingBucket?: string | null } | null;
  isError: boolean;
  isLoading: boolean;
}

export function myRatingWords(q: MyRatingRead, separator: ' · ' | ' '): string {
  if (q.data?.displayRating != null) return `${q.data.displayRating.toFixed(1)}${separator}${q.data.ratingBucket ?? ''}`;
  if (q.data === undefined && q.isError) return "Couldn't load your rating";
  if (q.data === undefined && q.isLoading) return 'Loading…';
  return 'No rating yet';
}
