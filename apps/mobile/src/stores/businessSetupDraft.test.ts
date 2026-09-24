import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMPTY_BUSINESS_SETUP_DRAFT,
  businessSetupDraftFor,
  editBusinessSetupDraft,
  useBusinessSetupDraft,
} from './businessSetupDraft';

// ---------------------------------------------------------------------------
// Owner report: the List-your-business form loses what was typed and makes the
// owner enter it again.
//
// BusinessSetup kept all six fields in component-local useState, and the
// component is unmounted by ordinary events: VendorRoot swaps it for an error
// screen whenever one 20-second profile refetch fails, and "Switch app" to Swift
// and back remounts the whole vendor stack. Every remount started blank.
//
// The draft now lives outside the component, bound to exactly one signed-in
// account (user + session generation), in memory only.
// ---------------------------------------------------------------------------

const accountA = { userId: 'owner-a', generation: 4 };
const accountALater = { userId: 'owner-a', generation: 6 };
const accountB = { userId: 'owner-b', generation: 5 };

const typed = {
  name: 'Kitty Bakes',
  type: 'SERVICE' as const,
  phone: '6001234',
  addr: '12 Regent Street',
  city: 'Linden',
  agree: true,
  // [Q8] The store pin the owner confirmed on the map travels with the rest of the form.
  pin: { latitude: 6.0123, longitude: -58.3045, address: '12 Regent Street, Linden' },
};

beforeEach(() => {
  useBusinessSetupDraft.getState().clear();
});

describe('the List-your-business draft', () => {
  it('starts as the form’s own defaults, with no store pin until the owner places one', () => {
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountA)).toEqual({
      name: '',
      type: 'RESTAURANT',
      phone: '',
      addr: '',
      city: 'Georgetown',
      agree: false,
      pin: null,
    });
  });

  it('a remount finds the same account’s form exactly where it was left', () => {
    // Typed one field at a time, as onChangeText delivers it.
    for (const [field, value] of Object.entries(typed)) {
      useBusinessSetupDraft.getState().update(accountA, { [field]: value });
    }

    // A fresh component instance reads the store again.
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountA)).toEqual(typed);
  });

  it('never shows one account’s form to another account or a later session', () => {
    useBusinessSetupDraft.getState().update(accountA, typed);

    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountB)).toEqual(EMPTY_BUSINESS_SETUP_DRAFT);
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountALater)).toEqual(EMPTY_BUSINESS_SETUP_DRAFT);
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), null)).toEqual(EMPTY_BUSINESS_SETUP_DRAFT);
  });

  it('a different account’s first edit replaces the previous draft instead of merging into it', () => {
    useBusinessSetupDraft.getState().update(accountA, typed);

    useBusinessSetupDraft.getState().update(accountB, { city: 'New Amsterdam' });

    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountB)).toEqual({
      ...EMPTY_BUSINESS_SETUP_DRAFT,
      city: 'New Amsterdam',
    });
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountA)).toEqual(EMPTY_BUSINESS_SETUP_DRAFT);
  });

  it('applies a toggle to the latest state, so two quick taps are two toggles', () => {
    const toggle = (draft: { agree: boolean }) => ({ agree: !draft.agree });

    useBusinessSetupDraft.getState().update(accountA, toggle);
    expect(useBusinessSetupDraft.getState().draft.agree).toBe(true);
    useBusinessSetupDraft.getState().update(accountA, toggle);
    expect(useBusinessSetupDraft.getState().draft.agree).toBe(false);
  });

  it('clears only for the account that owns it', () => {
    useBusinessSetupDraft.getState().update(accountA, typed);

    expect(useBusinessSetupDraft.getState().clearIfOwner(accountB)).toBe(false);
    expect(useBusinessSetupDraft.getState().clearIfOwner(accountALater)).toBe(false);
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountA)).toEqual(typed);

    expect(useBusinessSetupDraft.getState().clearIfOwner(accountA)).toBe(true);
    expect(useBusinessSetupDraft.getState().owner).toBeNull();
    expect(useBusinessSetupDraft.getState().draft).toEqual(EMPTY_BUSINESS_SETUP_DRAFT);
  });

  it('a screen edits only while its own account is the signed-in one', () => {
    expect(editBusinessSetupDraft(accountA, accountA, { name: 'Kitty Bakes' })).toBe(true);
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountA).name).toBe('Kitty Bakes');

    // B signed in; a keystroke from A's screen that outlived the switch.
    useBusinessSetupDraft.getState().update(accountB, { name: 'B Barbers' });
    expect(editBusinessSetupDraft(accountB, accountA, { name: 'stale A' })).toBe(false);
    // Signed out, or a screen with no account at all.
    expect(editBusinessSetupDraft(null, accountA, { name: 'stale A' })).toBe(false);
    expect(editBusinessSetupDraft(accountB, null, { name: 'no account' })).toBe(false);

    expect(useBusinessSetupDraft.getState().owner).toEqual(accountB);
    expect(businessSetupDraftFor(useBusinessSetupDraft.getState(), accountB).name).toBe('B Barbers');
  });

  it('never mutates the shared blank form', () => {
    useBusinessSetupDraft.getState().update(accountA, typed);

    expect(EMPTY_BUSINESS_SETUP_DRAFT).toEqual({
      name: '',
      type: 'RESTAURANT',
      phone: '',
      addr: '',
      city: 'Georgetown',
      agree: false,
      pin: null,
    });
  });

  it('holds the six form fields and the store pin only, in memory only', () => {
    expect(Object.keys(EMPTY_BUSINESS_SETUP_DRAFT).sort()).toEqual(['addr', 'agree', 'city', 'name', 'phone', 'pin', 'type']);
    // A business phone, street address and store pin must not be written to
    // disk, and the agreement tick must never outlive the process that showed the terms.
    const src = readFileSync(new URL('./businessSetupDraft.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/zustand\/middleware|persist\(|storage/);
  });
});
