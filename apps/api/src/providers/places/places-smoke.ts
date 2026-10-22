// SCAFFOLD (red-first): shells only, no behaviour yet.
import type { PlacesProvider } from './places-provider';

export interface PlacesSmokeLine { call: 'autocomplete' | 'details' | 'reverse'; pass: boolean; detail: string }
export interface PlacesSmokeResult { pass: boolean; lines: PlacesSmokeLine[] }

export async function runPlacesSmoke(_provider: PlacesProvider): Promise<PlacesSmokeResult> {
  return { pass: true, lines: [] };
}

export function formatPlacesSmoke(_result: PlacesSmokeResult): string[] {
  return [];
}

export async function placesSmokeMain(
  _env: Record<string, string | undefined>,
  _print: (line: string) => void,
): Promise<number> {
  return 0;
}
