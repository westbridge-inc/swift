import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderStepState, type OrderStepFacts } from './timeline-states';

// [PICKUP · owner 30 Oct 2026, staging test of a takeaway] "Preparing still shows on the customer side, which it
// should, but it's not green when the restaurant accepts it, and same with Ready." A store order's step turns
// GREEN (done, with its tick) the moment the server says it is reached; the next step stays upcoming. A step that
// is reached and still happening is `live`: it keeps its present-tense words and does not light the leg after it.
// Never green before the server says so: an ACCEPTED order not yet preparing (an MMG order before "Paid by MMG")
// keeps Preparing in progress; a held order is not yet sent.

const base: OrderStepFacts = {
  currentIndex: 2, storeOrder: true, holdActive: false, releasePending: false, status: 'PREPARING',
  preparationStarted: true, preparationFinished: false, acceptedRecorded: true,
};
const states = (facts: Partial<OrderStepFacts>) =>
  ['placed', 'sent', 'preparing', 'transit', 'complete'].map((key, index) => orderStepState(key, index, { ...base, ...facts }));
const word = (s: { state: string; live: boolean }) => (s.live ? 'live' : s.state);

describe('a store order: a step is green the moment it is reached', () => {
  it('the store accepts (Accept = Preparing): Preparing is green and live; Ready / On the way waits', () => {
    expect(states({}).map(word)).toEqual(['done', 'done', 'live', 'upcoming', 'upcoming']);
  });

  it('a takeaway marked ready: Preparing done, Ready green and live, Picked up waits', () => {
    expect(states({ currentIndex: 3, status: 'READY_FOR_PICKUP', preparationFinished: true }).map(word))
      .toEqual(['done', 'done', 'done', 'live', 'upcoming']);
  });

  it('a delivery marked ready: the "Ready for pickup" step is green and live; On the way waits', () => {
    expect(states({ currentIndex: 2, status: 'READY_FOR_PICKUP', preparationFinished: true }).map(word))
      .toEqual(['done', 'done', 'live', 'upcoming', 'upcoming']);
  });

  it('a rider already on the way while the kitchen still cooks: both are green and live, Delivered waits', () => {
    expect(states({ currentIndex: 3, status: 'RIDER_EN_ROUTE_PICKUP', preparationFinished: false }).map(word))
      .toEqual(['done', 'done', 'live', 'live', 'upcoming']);
  });

  it('collected / delivered: every step done, none live', () => {
    expect(states({ currentIndex: 4, status: 'COMPLETED', preparationFinished: true }).map(word))
      .toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('sent to the store (hold over, not accepted yet): Sent is green and live, Preparing waits', () => {
    expect(states({ currentIndex: 1, status: 'PENDING', preparationStarted: false, acceptedRecorded: false }).map(word))
      .toEqual(['done', 'live', 'upcoming', 'upcoming', 'upcoming']);
  });
});

describe('never green before the server says so', () => {
  it('ACCEPTED but not preparing (an MMG order before "Paid by MMG"): Preparing stays in progress', () => {
    expect(states({ status: 'ACCEPTED', preparationStarted: false }).map(word))
      .toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
  });

  it('a held order, or one whose release is being checked, is not yet sent', () => {
    for (const hold of [{ holdActive: true }, { releasePending: true }]) {
      expect(states({ currentIndex: 1, status: 'PENDING', preparationStarted: false, acceptedRecorded: false, ...hold }).map(word))
        .toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
    }
  });

  it('a rider status with no preparation fact on record never ticks Preparing', () => {
    expect(states({ currentIndex: 3, status: 'RIDER_ASSIGNED', preparationStarted: false, acceptedRecorded: true }).map(word))
      .toEqual(['done', 'done', 'current', 'live', 'upcoming']);
    expect(states({ currentIndex: 3, status: 'RIDER_ASSIGNED', preparationStarted: false, acceptedRecorded: false }).map(word))
      .toEqual(['done', 'done', 'upcoming', 'live', 'upcoming']);
  });

  it('an unknown position claims only the first step', () => {
    expect(states({ currentIndex: null }).map(word)).toEqual(['done', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });
});

describe('parcels and bookings keep their timeline', () => {
  it('the current step stays in progress', () => {
    expect(states({ storeOrder: false, currentIndex: 2, status: 'RIDER_ASSIGNED' }).map(word))
      .toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    expect(states({ storeOrder: false, currentIndex: 4, status: 'DELIVERED' }).map(word))
      .toEqual(['done', 'done', 'done', 'done', 'current']);
  });
});

describe('the order screen draws it', () => {
  const SCREEN = readFileSync(new URL('./screens/DeliveryScreen.tsx', import.meta.url), 'utf8');
  const KIT = readFileSync(new URL('../../kit/timeline.tsx', import.meta.url), 'utf8');

  it('reads each step\'s state from orderStepState and draws done steps green (the success tone)', () => {
    expect(SCREEN).toContain('orderStepState(step.key, index, {');
    expect(SCREEN).toContain('doneTone="success"');
    expect(SCREEN).not.toMatch(/done = preparationFinished;/);
  });

  it('the kit: a live step keeps its present-tense words, says "Now" to a screen reader, and leaves the next leg unlit', () => {
    expect(KIT).toMatch(/state === 'done' && !step\.live\) return step\.doneDescription \?\? step\.description;/);
    expect(KIT).toContain("state === 'done' ? (step.live ? 'Now' : 'Complete')");
    expect(KIT).toContain("if (!(state === 'done' && !step.live)) return onDark ? withAlpha(color.white, 0.18) : color.border.subtle;");
    expect(KIT.split('backgroundColor: legColor(step, state, onDark, doneTone),').length - 1).toBe(2);
    // The tick stays: state is never told by colour alone.
    expect(KIT).toContain("name={state === 'done' ? 'check' : step.icon}");
  });
});
