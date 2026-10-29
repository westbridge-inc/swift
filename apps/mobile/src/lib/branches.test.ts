import { describe, expect, it } from 'vitest';
import {
  BRANCH_COPY, awaitingApproval, branchFeeTick, branchDealLine, branchTrialLine, bulkOutcomeLine, forEachBranch, goLiveLine, goLiveOf, menuCopyLines, newCopyKey,
  ownerStepWords, storeLabel,
} from './branches';

const fee = (n: number) => `G$${n.toLocaleString('en-US')}`;

describe('[CHAINS] the add-a-branch trial line', () => {
  it('a shared trial holds only if Swift approves the branch before it ends (REVIEW-M #2211 S4-2)', () => {
    expect(branchTrialLine('2026-11-08T03:59:00.000Z', 'G$15,000'))
      .toBe('Free until 7 November 2026 if Swift approves it before 7 November 2026. After that, G$15,000/week.');
  });
  it('no shared trial: billed from approval', () => {
    expect(branchTrialLine(null, 'G$15,000')).toBe('Billed from the day Swift approves it: G$15,000/week.');
    expect(branchTrialLine('not a date', 'G$15,000')).toBe('Billed from the day Swift approves it: G$15,000/week.');
  });
  it('the trial belongs to the business: a closed branch still uses it up (REVIEW-M #2211 N1)', () => {
    expect(BRANCH_COPY.trialBelongsToBusiness).toMatch(/close during the free trial still uses it up/);
  });
  it('the chain deal line, only when there is one', () => {
    expect(branchDealLine(12000, fee)).toBe('Your agreed rate: G$12,000/week (or the branch’s own fee, if lower).');
    expect(branchDealLine(null, fee)).toBeNull();
    expect(branchDealLine(0, fee)).toBeNull();
  });
});

describe('[CHAINS] the switcher says which branch waits for Swift', () => {
  it('awaitingApproval from the server flag, the status, or the person-approval flag', () => {
    expect(awaitingApproval({ awaitingApproval: true })).toBe(true);
    expect(awaitingApproval({ status: 'PENDING_APPROVAL' })).toBe(true);
    expect(awaitingApproval({ status: 'ACTIVE', personApprovalRequired: true })).toBe(true);
    expect(awaitingApproval({ status: 'ACTIVE', personApprovalRequired: false })).toBe(false);
  });
  it('the label', () => {
    expect(storeLabel({ name: 'Royal North', status: 'PENDING_APPROVAL', goLive: { waitingFor: 'SWIFT', steps: [] } })).toBe('Royal North · waiting for Swift’s approval');
    expect(storeLabel({ name: 'Royal Camp', status: 'ACTIVE' })).toBe('Royal Camp');
  });
});

// [REVIEW-F #2220 S3-1] "Waiting for Swift's approval" only when nothing is owed by the owner.
describe('[CHAINS] a store not live yet says whose turn it is', () => {
  const owed = { name: 'Royal East', status: 'PENDING_APPROVAL', personApprovalRequired: true, goLive: { waitingFor: 'OWNER', steps: ['PUBLISHED_PHONE', 'FOOD_HANDLERS'] } };
  const swift = { name: 'Royal East', status: 'PENDING_APPROVAL', personApprovalRequired: true, goLive: { waitingFor: 'SWIFT', steps: [] } };
  it('the owner\'s turn: never "waiting for Swift", and the steps by name', () => {
    expect(storeLabel(owed)).toBe('Royal East · not live yet: finish setting it up');
    expect(storeLabel(owed)).not.toMatch(/Swift’s approval/);
    expect(ownerStepWords(owed)).toEqual(['Add the number customers can call', 'Confirm your food handlers']);
    expect(goLiveLine(owed)).toBe('Before Swift can check it: Add the number customers can call; Confirm your food handlers.');
    expect(ownerStepWords({ ...owed, goLive: { waitingFor: 'OWNER', steps: ['DOCUMENTS'] } })).toEqual(['Add the documents it still needs']);
  });
  it('Swift\'s turn: waiting for Swift\'s approval, no owner steps', () => {
    expect(storeLabel(swift)).toBe('Royal East · waiting for Swift’s approval');
    expect(ownerStepWords(swift)).toEqual([]);
    expect(goLiveLine(swift)).toBe(BRANCH_COPY.swiftChecks);
  });
  it('no word from the server: "not live yet", never a guess about whose turn it is', () => {
    expect(storeLabel({ name: 'Royal East', status: 'PENDING_APPROVAL' })).toBe('Royal East · not live yet');
    expect(storeLabel({ name: 'Royal East', status: 'PENDING_APPROVAL', goLive: { waitingFor: 'MAYBE' } })).toBe('Royal East · not live yet');
    expect(goLiveLine({ name: 'Royal East', status: 'PENDING_APPROVAL' })).toBeNull();
  });
  it('reads the server strictly: unknown steps dropped; a live store has no go-live line', () => {
    expect(goLiveOf({ goLive: { waitingFor: 'OWNER', steps: ['PUBLISHED_PHONE', 'SOMETHING_NEW', 3] } })).toEqual({ waitingFor: 'OWNER', steps: ['PUBLISHED_PHONE'] });
    // [REVIEW-F #2220 f710ebda N3] Only unknown steps: no step line at all (the Finish setting it up button stands
    // alone, never named twice); the branch's own screen says to finish what it still asks for.
    const unknownOnly = { name: 'Royal Camp', status: 'PENDING_APPROVAL', goLive: { waitingFor: 'OWNER', steps: ['SOMETHING_NEW'] } };
    expect(ownerStepWords(unknownOnly)).toEqual([]);
    expect(goLiveLine(unknownOnly)).toBe('Before Swift can check it, finish what this screen still asks for.');
    expect(goLiveLine({ ...unknownOnly, goLive: { waitingFor: 'OWNER', steps: [] } })).toBe(BRANCH_COPY.finishHere);
    for (const steps of [[], ['SOMETHING_NEW'], ['DOCUMENTS'], ['PUBLISHED_PHONE', 'FOOD_HANDLERS']]) {
      expect(ownerStepWords({ ...unknownOnly, goLive: { waitingFor: 'OWNER', steps } })).not.toContain(BRANCH_COPY.finishButton);
    }
    expect(goLiveLine({ name: 'Royal Camp', status: 'ACTIVE', goLive: null })).toBeNull();
  });
  it('the add screens name the owner\'s part instead of promising a wait for Swift', () => {
    expect(BRANCH_COPY.checkFirst).not.toMatch(/you’ll see it as waiting for Swift’s approval/i);
    expect(BRANCH_COPY.checkFirst).toMatch(/still needs something from you/);
  });
});

describe('[CHAINS] bulk actions run one branch at a time', () => {
  it('each branch once, in order; a refusal is that branch\'s, in the server\'s words, and the rest still run', async () => {
    const calls: string[] = [];
    const outcome = await forEachBranch(['a', 'b', 'a', 'c'], async (id) => {
      calls.push(id);
      if (id === 'b') throw { response: { data: { error: { code: 'STORE_SUSPENDED', message: 'This store is suspended.' } } } };
    });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({ done: ['a', 'c'], failed: [{ id: 'b', message: 'This store is suspended.' }] });
    expect(bulkOutcomeLine(outcome, (id) => ({ b: 'Royal Camp' }[id] ?? id))).toBe('Done for 2 branches. Not done for Royal Camp: This store is suspended.');
  });
  it('a refusal without words never shows a code', async () => {
    const outcome = await forEachBranch(['x'], async () => { throw new Error('ECONNRESET'); });
    expect(outcome.failed[0]!.message).toBe('Couldn’t save. Try again.');
  });
});

describe('[CHAINS] menu copy', () => {
  it('a copy key the server accepts ([A-Za-z0-9_-]{8,64})', () => {
    expect(newCopyKey()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newCopyKey()).not.toBe(newCopyKey());
  });
  it('the result in words: photos left out, items waiting, items not allowed, stock its own', () => {
    expect(menuCopyLines({ categories: 2, items: 4, options: 2, photos: 2, photosNotCopied: 1, waitingForCheck: 1, notAllowed: [{ name: 'Hennessy VS' }] })).toEqual([
      'Copied 4 items in 2 sections, with 2 photos.',
      '1 photo could not be copied: add it again here.',
      '1 item waits for a quick check by Swift before customers see it.',
      'Not copied (Swift doesn’t allow it): Hennessy VS.',
      'Stock counts are not copied: each branch counts its own.',
    ]);
  });
});

describe('[CHAINS] the branch\'s weekly-fee tick', () => {
  const terms = { version: 'v1', items: [{ heading: 'What it covers', text: 'Your store on Swift.' }], tick: 'I understand the weekly fee' };
  it('the server\'s words, given to this branch\'s amount', () => {
    const fee = branchFeeTick({ weeklyFee: { amount: 15000, currencyCode: 'GYD', version: 'v1' }, terms });
    expect(fee).toEqual({ kind: 'tick', terms, key: 'v1|GYD|15000', ack: { version: 'v1', amount: 15000, currencyCode: 'GYD' } });
  });
  it('no terms read yet: nothing to tick; words that are not terms, or no amount: refused', () => {
    expect(branchFeeTick(undefined)).toEqual({ kind: 'none' });
    expect(branchFeeTick({ weeklyFee: { amount: 15000, currencyCode: 'GYD' }, terms: { version: 'v1', items: [], tick: 'x' } }).kind).toBe('invalid');
    expect(branchFeeTick({ weeklyFee: { amount: 0, currencyCode: 'GYD' }, terms }).kind).toBe('invalid');
  });
});
