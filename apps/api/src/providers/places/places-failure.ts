// SCAFFOLD (red-first): types only, no behaviour yet.
export type PlacesOp = 'autocomplete' | 'details' | 'reverse';
export type PlacesFailureReason = 'auth' | 'quota' | 'rejected' | 'upstream' | 'timeout' | 'network' | 'bad_response';
export interface PlacesFailure {
  reason: PlacesFailureReason;
  httpStatus?: number;
  googleStatus?: string;
  googleReason?: string;
}
export class PlacesProviderError extends Error {
  constructor(public readonly failure: PlacesFailure) {
    super(`Places provider failure: ${failure.reason}`);
    this.name = 'PlacesProviderError';
  }
}
export const PLACES_UNAVAILABLE_CODE = 'PLACES_UNAVAILABLE';
export const PLACES_UNAVAILABLE_MESSAGE = "Address search isn't working right now. Set the place on the map.";
export function describePlacesFailure(_f: PlacesFailure): string {
  return '';
}
