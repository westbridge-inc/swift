import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOOD_HANDLERS_DOC, foodHandlerStoresToTick, foodHandlerTickFrom } from './foodHandlers';
import { docLabel } from './docLabels';

// [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant's owner ticks "Everyone who handles food here holds a
// current food handler's certificate." in Documents instead of uploading a certificate. The words come from the
// server (GET /verification/status → foodHandlerAttestation), never from the app; the step arrives in `checklist`
// as `food_handler_attestation`, which this app draws as the tick — never as an upload card.

const status = {
  checklist: ['owner_national_id', FOOD_HANDLERS_DOC],
  foodHandlerAttestation: {
    version: 'v1',
    tick: 'Everyone who handles food here holds a current food handler’s certificate.',
    stores: [
      { vendorId: 'v1', name: 'Sample Kitchen', attested: false },
      { vendorId: 'v2', name: 'Second Kitchen', attested: true },
    ],
  },
};

describe('[FOOD-PERMIT] the food handlers tick', () => {
  it('reads the server’s words and version, and the stores still to tick', () => {
    expect(FOOD_HANDLERS_DOC).toBe('food_handler_attestation');
    expect(foodHandlerTickFrom(status)).toEqual({ version: 'v1', tick: status.foodHandlerAttestation.tick });
    expect(foodHandlerStoresToTick(status)).toEqual([{ vendorId: 'v1', name: 'Sample Kitchen', attested: false }]);
  });

  it('an older server (no words) or a malformed answer shows no tick at all — never words the app made up', () => {
    expect(foodHandlerTickFrom({ checklist: [FOOD_HANDLERS_DOC] })).toBeNull();
    expect(foodHandlerTickFrom({ foodHandlerAttestation: { version: 'v1', stores: [] } })).toBeNull();
    expect(foodHandlerStoresToTick({ foodHandlerAttestation: { version: 'v1', tick: 'x', stores: 'nope' } })).toEqual([]);
    expect(foodHandlerStoresToTick(undefined)).toEqual([]);
  });

  it('the Documents checklist draws the step as the tick, never as an upload card', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentChecklist.tsx'), 'utf8');
    const step = src.indexOf('docType === FOOD_HANDLERS_DOC');
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(src.indexOf('<DocumentUploadCard'));
    expect(src).toContain('<FoodHandlersCard');
  });

  it('names the step in plain words wherever a document is named', () => {
    expect(docLabel(FOOD_HANDLERS_DOC)).toBe('Food handlers confirmation');
  });
});
