import { describe, expect, it } from 'vitest';
import { BRANCH_TRIAL_IS_THE_BUSINESS, branchTrialLine, dealLine, weeklyFeeWords, BRANCH_IS_CHECKED } from './branches';
import { branchLabel, isAwaitingApproval } from './branch-label';
import { branchOutcomeWords, forEachBranch } from './branch-bulk';
import { copyResultWords, newCopyKey } from './branch-menu-copy-words';
import { ownerSteps } from './branch-go-live';

// [CHAINS PR2] The branch words and the bulk rule the branch pages share.
describe('branches', () => {
  // [REVIEW-F #2220 S3-1] "Waiting for Swift's approval" only on Swift's turn.
  it('a store not live yet says whose turn it is where it is named', () => {
    expect(branchLabel({ name: 'Royal Camp', awaitingApproval: true, goLive: { waitingFor: 'SWIFT', steps: [] } })).toBe('Royal Camp · waiting for Swift’s approval');
    expect(branchLabel({ name: 'Royal Camp', status: 'PENDING_APPROVAL', goLive: { waitingFor: 'OWNER', steps: ['FOOD_HANDLERS'] } })).toBe('Royal Camp · not live yet: finish setting it up');
    expect(branchLabel({ name: 'Royal Camp', status: 'PENDING_APPROVAL' })).toBe('Royal Camp · not live yet');
    expect(branchLabel({ name: 'Royal Camp', awaitingApproval: true, goLive: { waitingFor: 'LATER' as never, steps: [] } })).toBe('Royal Camp · not live yet');
    expect(branchLabel({ name: 'Royal North', awaitingApproval: false, status: 'ACTIVE' })).toBe('Royal North');
    expect(isAwaitingApproval({ status: 'ACTIVE' })).toBe(false);
  });

  it('the owner\'s steps, each with where it is done; none on Swift\'s turn; unknown steps left out', () => {
    expect(ownerSteps({ status: 'PENDING_APPROVAL', goLive: { waitingFor: 'OWNER', steps: ['DOCUMENTS', 'PUBLISHED_PHONE', 'FOOD_HANDLERS', 'NEW_THING'] } })).toEqual([
      { words: 'Add the documents it still needs, in the Swift app under Documents', where: 'app' },
      { words: 'Add the number customers can call', where: 'settings' },
      { words: 'Confirm your food handlers', where: 'settings' },
    ]);
    expect(ownerSteps({ status: 'PENDING_APPROVAL', goLive: { waitingFor: 'SWIFT', steps: ['DOCUMENTS'] } })).toEqual([]);
    expect(ownerSteps({ status: 'ACTIVE', goLive: { waitingFor: 'OWNER', steps: ['DOCUMENTS'] } })).toEqual([]);
    expect(BRANCH_IS_CHECKED).not.toMatch(/You’ll see it as waiting for Swift’s approval/);
    // [REVIEW-F #2220 f710ebda S4-1] A documents-only branch has no button on the website (documents are added in the
    // Swift app), so the promise is what is left and where, never a button.
    expect(BRANCH_IS_CHECKED).not.toMatch(/button/);
    expect(BRANCH_IS_CHECKED).toBe('A person at Swift checks every new branch before it goes live. If a branch still needs something from you first, the Branches page says what is left and where: on this website, or in the Swift app for documents.');
  });

  it('the shared trial holds only if Swift approves the branch before it ends; with no running trial, billed from approval', () => {
    const fee = weeklyFeeWords(15000, 'GYD');
    expect(fee).toBe('$15,000/week');
    expect(branchTrialLine('2026-11-05T16:00:00.000Z', fee))
      .toBe('Free until 5 November 2026 if Swift approves it before 5 November 2026. After that, $15,000/week.');
    expect(branchTrialLine(null, fee)).toBe('Billed from the day Swift approves it: $15,000/week.');
    expect(BRANCH_TRIAL_IS_THE_BUSINESS).toContain('a branch you close during the free trial still uses it up');
  });

  it('the trial day is Guyana\'s (a late-evening end is not tomorrow)', () => {
    expect(branchTrialLine('2026-11-06T02:30:00.000Z', 'x')).toContain('Free until 5 November 2026');
  });

  it('the chain deal line, only when there is one', () => {
    expect(dealLine(12000, 'GYD')).toBe('Your agreed rate: $12,000/week (or the branch’s own fee, if lower).');
    expect(dealLine(null, null)).toBeNull();
  });

  it('bulk actions run one branch after another and name each one that refused, with the server\'s words', async () => {
    const order: string[] = [];
    let running = 0;
    const out = await forEachBranch(['a', 'b', 'c'], async (id) => {
      running += 1;
      expect(running).toBe(1);
      order.push(id);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      if (id === 'b') throw new Error('This store is suspended.');
    });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(out).toEqual([{ storeId: 'a', ok: true }, { storeId: 'b', ok: false, message: 'This store is suspended.' }, { storeId: 'c', ok: true }]);
    const names: Record<string, string> = { a: 'North', b: 'Camp', c: 'East' };
    expect(branchOutcomeWords(out, (id) => names[id]!)).toBe('Done for 2 of 3 branches. Not done: Camp: This store is suspended.');
    expect(branchOutcomeWords([{ storeId: 'a', ok: true }], (id) => names[id]!)).toBe('Done for 1 branch.');
  });

  it('a copy key fits the server\'s rule and is new each time', () => {
    const a = newCopyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newCopyKey()).not.toBe(a);
  });

  it('what a copy did, in words', () => {
    expect(copyResultWords({ items: 4, categories: 2, photos: 2, photosNotCopied: 1, waitingForCheck: 1, notAllowed: [{ name: 'Hennessy VS' }] })).toEqual([
      'Copied 4 items in 2 sections, with 2 photos.',
      '1 photo could not be copied: add it again here.',
      '1 item waits for a quick check by Swift before customers see it.',
      'Not copied, Swift doesn’t allow: Hennessy VS.',
      'Stock counts are per branch: set this branch’s counts here.',
    ]);
  });
});
