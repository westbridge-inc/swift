import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [ALG-34 / ALG-INV-14] The pay-link card shows the server's pending state
// exactly — the moment it takes effect is the server's, never computed here —
// and the cancel is the one that also signs out every other device.
// ---------------------------------------------------------------------------

const card = readFileSync(join(process.cwd(), 'src/components/MmgPayLinkCard.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
const vendor = readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorAccountScreen.tsx'), 'utf8');
const mover = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverAccountScreen.tsx'), 'utf8');

describe('the pending link is the server\'s, verbatim', () => {
  it('renders the apply time from pending.applyAt through fmtWhen and computes no time of its own', () => {
    expect(card).toContain('const when = fmtWhen(pending?.applyAt);');
    expect(card).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(card).not.toMatch(/24[- ]hour/);
    expect(card).toContain('New link takes effect ${when}');
    // When the server sent no usable moment the card says so instead of inventing one.
    expect(card).toContain("'New link is waiting for its cool-off'");
  });

  it('tells the truth about what keeps happening in the meantime', () => {
    expect(card).toContain('keep paying to your current link.');
    expect(card).toContain('Until then, you stay cash-only.');
  });

  it('the cancel says what it does — it signs out other devices — and only renders when the screen can cancel', () => {
    expect(card).toContain('This wasn’t me — cancel and sign out other devices');
    expect(card).toContain('{onCancelPending ? (');
  });

  it('a manager reads, only the owner writes', () => {
    expect(card).toContain('Only the store owner can change where the money goes.');
    expect(vendor).toContain('readOnly={!isOwner}');
    expect(vendor).toContain('onCancelPending={isOwner ? () => cancelPendingMmgLink.mutate() : undefined}');
  });
});

describe('both screens wire the same seam', () => {
  it('the save is wrapped in the step-up guard and the pending state comes from the profile read', () => {
    for (const screen of [vendor, mover]) {
      expect(screen).toContain('stepUp.withStepUp((mmgPayUrl: string | null) =>');
      expect(screen).toContain('{stepUp.sheet}');
      expect(screen).toMatch(/pending=\{(store|profile)\?\.mmgPayUrlPending \? \{ url: (store|profile)\.mmgPayUrlPending, applyAt: (store|profile)\.mmgPayUrlApplyAt \?\? null \} : null\}/);
      // A dismissed sheet is a non-event, never an error line.
      expect(screen).toContain('if (!isStepUpDismissed(e)) setMmgError(serverMessage(e,');
    }
  });

  it('staff grants go through the same guard on the vendor screen', () => {
    expect(vendor).toContain('useAddStaff(stepUp.withStepUp)');
    expect(vendor).toContain('useUpdateStaffRole(stepUp.withStepUp)');
  });

  it('the client hits the exact server routes', () => {
    expect(api).toContain("stepUp: () => api.post('/auth/step-up')");
    expect(api).toContain("verifyStepUp: (code: string) => api.post('/auth/step-up/verify', { code })");
    expect(api).toContain("api.delete('/vendor/profile/mmg-pay-url/pending')");
    expect(api).toContain("api.delete('/driver/profile/mmg-pay-url/pending')");
  });
});
