/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [DOC-CONSENT · owner 25 Oct 2026, iPhone build 12 on staging] "The 'I consent to Swift processing this document'
// tick in the upload documents screen for riders and drivers keeps coming off by itself."
//
// The tick lived only in the screen (useState(false)) and never read what the consent ledger holds, so every new
// visit (back to Swift and in again, a role or account switch, the app restarting, Account → Documents) showed it
// empty and every upload card waited again, although each upload had recorded the person's tick. The REAL
// checklist; the upload card is a stand-in that reports what it was given.
//
// The law stays: nothing is ever ticked for anyone. A box shows ticked only from the person's own tick on this
// visit or their own grant the server returns (GET /verification/status `documentConsent`), and a police clearance
// (sensitive data) is not unlocked by the record alone.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  cards: {} as Record<string, { consented?: boolean; askConsentFirst?: boolean; consentVia?: string }>,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel, accessibilityState, testID }: any) =>
    R.createElement('button', {
      type: 'button', 'aria-label': accessibilityLabel, 'data-testid': testID,
      'aria-checked': accessibilityState?.checked === undefined ? undefined : String(accessibilityState.checked),
      onClick: onPress,
    }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  return {
    BrandCheckbox: ({ checked }: { checked: boolean }) => R.createElement('span', { 'data-box': String(checked) }),
    EmptyState: ({ title }: { title: string }) => R.createElement('p', null, title),
    Spinner: () => R.createElement('p', null, 'loading'),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
// [ROLE-DOCS] The own-name card belongs to business checklists and talks to the server itself: out of this test.
vi.mock('./OwnNameCard', () => ({ OwnNameCard: () => null }));
vi.mock('./DocumentUploadCard', async () => {
  const R = await import('react');
  return {
    DocumentUploadCard: (p: { docType: string; consented?: boolean; askConsentFirst?: boolean; consentVia?: string }) => {
      fx.cards[p.docType] = { consented: p.consented, askConsentFirst: p.askConsentFirst, ...(p.consentVia === undefined ? {} : { consentVia: p.consentVia }) };
      return R.createElement('div', { 'data-doc': p.docType });
    },
  };
});

import { DocumentChecklist } from './DocumentChecklist';

const h = React.createElement;
const REQUIRED = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const GIVEN_AT = '2026-10-25T16:18:58.000Z';
const onRecord = { tick: 'document_v1', given: true, givenAt: GIVEN_AT };
const statusWith = (documentConsent?: unknown, optional: string[] = []) =>
  ({ checklist: REQUIRED, optional, documents: [], ...(documentConsent === undefined ? {} : { documentConsent }) });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const mount = async (status: unknown) => {
  fx.cards = {};
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(DocumentChecklist, { role: 'MOVER', status })));
};
const rerender = async (status: unknown) => act(async () => root.render(h(DocumentChecklist, { role: 'MOVER', status })));
const unmount = async () => { await act(async () => root.unmount()); host.remove(); };
const tick = () => host.querySelector('[data-testid="document-consent-tick"]') as HTMLButtonElement;
const ticked = () => tick().getAttribute('aria-checked') === 'true' && host.querySelector('[data-box]')?.getAttribute('data-box') === 'true';
const press = async () => act(async () => tick().click());
const everyCard = (consented: boolean) => REQUIRED.every((d) => fx.cards[d]?.consented === consented);
const recordLine = () => /You ticked this on 25 Oct 2026/.test(host.textContent ?? '');

beforeEach(() => { fx.cards = {}; });
afterEach(async () => { if (host?.isConnected) await unmount(); });

describe('[DOC-CONSENT] the document tick shows the person\'s own recorded choice', () => {
  it('the owner\'s bug: a tick the server recorded is shown as given when the screen opens again, and every card is open', async () => {
    await mount(statusWith(onRecord));
    expect(ticked(), 'the box shows the recorded tick').toBe(true);
    expect(everyCard(true), 'no card waits for a second tick').toBe(true);
    expect(recordLine(), 'it says the tick is the person\'s own, and when').toBe(true);
  });

  it('tick → upload (recorded) → leave and come back: a fresh screen still shows it ticked', async () => {
    await mount(statusWith());
    expect(ticked()).toBe(false);
    await press();
    expect(ticked()).toBe(true);
    expect(everyCard(true)).toBe(true);
    await unmount();
    await mount(statusWith(onRecord));
    expect(ticked(), 'the new visit reads the ledger, not an empty box').toBe(true);
    expect(everyCard(true)).toBe(true);
  });

  it('never ticked for anyone: no record, not given, other words or a malformed answer start empty and every card waits', async () => {
    for (const documentConsent of [
      undefined, null, {}, { tick: 'document_v1', given: false, givenAt: null }, { tick: 'document_v2', given: true, givenAt: GIVEN_AT },
      { tick: 'customer_id_v1', given: true, givenAt: GIVEN_AT }, { tick: 'document_v1', given: 'true', givenAt: GIVEN_AT }, { given: true, givenAt: GIVEN_AT },
      'given', true,
    ]) {
      await mount(statusWith(documentConsent));
      expect(ticked(), JSON.stringify(documentConsent)).toBe(false);
      expect(everyCard(false), JSON.stringify(documentConsent)).toBe(true);
      expect(recordLine()).toBe(false);
      await unmount();
    }
  });

  it('a tick given on this visit stays through the refetch after each upload', async () => {
    await mount(statusWith());
    await press();
    await rerender({ ...statusWith(), documents: [{ docType: 'drivers_licence', status: 'PENDING', createdAt: GIVEN_AT }] });
    expect(ticked()).toBe(true);
    await rerender(statusWith(onRecord));
    expect(ticked()).toBe(true);
    expect(everyCard(true)).toBe(true);
  });

  it('the person can still untick a recorded tick on this visit: the cards wait again and the record line goes', async () => {
    await mount(statusWith(onRecord));
    await press();
    expect(ticked()).toBe(false);
    expect(everyCard(false)).toBe(true);
    expect(recordLine()).toBe(false);
    // A refetch that still carries the record does not tick it back on this visit.
    await rerender(statusWith(onRecord));
    expect(ticked()).toBe(false);
    await press();
    expect(ticked()).toBe(true);
  });

  it('a police clearance (sensitive data) is not unlocked by the record alone: its card asks again; a tick on this visit needs no second ask', async () => {
    await mount(statusWith(onRecord, ['police_clearance']));
    expect(fx.cards['police_clearance']).toMatchObject({ consented: true, askConsentFirst: true });
    for (const d of REQUIRED) expect(fx.cards[d]?.askConsentFirst, d).toBe(false);
    await press(); // untick
    await press(); // a fresh tick, on this visit
    expect(fx.cards['police_clearance']).toMatchObject({ consented: true, askConsentFirst: false });
    await unmount();
    await mount(statusWith(undefined, ['police_clearance']));
    await press();
    expect(fx.cards['police_clearance']).toMatchObject({ consented: true, askConsentFirst: false });
  });

  it('[S4 · REVIEW-G2] every card is told how the tick was given, so the upload records its true source', async () => {
    await mount(statusWith(onRecord, ['police_clearance']));
    for (const d of [...REQUIRED, 'police_clearance']) expect(fx.cards[d]?.consentVia, d).toBe('record');
    await press(); // untick
    await press(); // ticked on this visit
    for (const d of [...REQUIRED, 'police_clearance']) expect(fx.cards[d]?.consentVia, d).toBe('checkbox');
    await unmount();
    await mount(statusWith());
    await press();
    for (const d of REQUIRED) expect(fx.cards[d]?.consentVia, d).toBe('checkbox');
  });
});
