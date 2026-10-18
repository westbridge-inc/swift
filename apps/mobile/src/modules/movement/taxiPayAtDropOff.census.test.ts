import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] A taxi passenger pays the driver
// directly at drop-off, in cash OR by MMG, the way cash already works. No taxi
// passenger line may say the fare is cash-only, and the booking, ride and
// receipt surfaces say the owner's sentence.
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const SURFACES = ['screens/TaxiScreen.tsx', 'TaxiStops.tsx', 'RidePostTripSheet.tsx'];

describe('[PAYMENT-SIMPLIFY] taxi fare lines say cash or MMG at drop-off', () => {
  it('no passenger fare line is cash-only', () => {
    for (const file of SURFACES) {
      const src = read(file);
      expect(src, `${file}: "cash to the driver"`).not.toMatch(/cash to the driver/);
      expect(src, `${file}: "Fare · cash"`).not.toMatch(/Fare · cash</);
      expect(src, `${file}: "· cash ·"`).not.toMatch(/ · cash · /);
    }
  });

  it("the owner's wording is on the booking, ride and fare-panel lines", () => {
    const taxi = read('screens/TaxiScreen.tsx');
    expect(taxi.match(/pay the driver cash or MMG at drop-off/gi)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(read('TaxiStops.tsx')).toContain('pay the driver cash or MMG at drop-off');
    expect(read('RidePostTripSheet.tsx')).toContain('cash or MMG · paid to');
  });

  // [REVIEW-F #1825 S3-1] The DRIVER is told the same thing as the passenger,
  // so neither side can refuse a payment the app told the other was fine. The
  // driver is paid directly; Swift holds nothing.
  it("the driver's own trip lines say cash or MMG too", () => {
    const itinerary = read('../mover/TaxiItinerary.tsx');
    expect(itinerary, 'TaxiItinerary.tsx: "Collect in cash"').not.toMatch(/Collect in cash/);
    expect(itinerary).toContain('Collect cash or MMG: trip fare');
    const active = read('../mover/screens/ActiveJobScreen.tsx');
    expect(active, 'ActiveJobScreen.tsx: "Cash collected —"').not.toMatch(/Cash collected —/);
    expect(active).toContain("'Fare collected — 100% yours.'");
  });
});
