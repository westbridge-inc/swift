/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';

// ---------------------------------------------------------------------------
// [DOC-CONSENT · DPA s.9(1)(a), legal research D1] The checklist now shows a person's recorded tick on a later
// visit. A police clearance is sensitive data, so the record alone never opens it: when the tick on screen comes
// only from the record, tapping that card asks for the consent first, in the exact words the ledger anchors the
// upload to, and only "I consent" goes on to the photo choice. A tick given on this visit opens it as today.
// The REAL card; native dialogs, the picker and the upload are stand-ins.
// ---------------------------------------------------------------------------

type Button = { text: string; style?: string; onPress?: () => void };
const fx = vi.hoisted(() => ({
  alerts: [] as { title: string; message?: string; buttons: Button[] }[],
  mutate: vi.fn(),
  withdraw: vi.fn(),
  libraryPermission: vi.fn(async () => ({ granted: false, canAskAgain: true })),
  library: vi.fn(async () => ({ canceled: true, assets: [] as unknown[] })),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  // Like React Native: the innermost pressable takes the tap (no bubbling to the card), and a disabled one ignores it.
  const Pressable = ({ children, onPress, disabled, testID, accessibilityState }: any) =>
    R.createElement('div', {
      role: 'button', 'data-card': testID ?? 'card', 'data-disabled': String(!!disabled),
      'aria-checked': accessibilityState?.checked === undefined ? undefined : String(accessibilityState.checked),
      onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); if (!disabled) onPress?.(); },
    }, typeof children === 'function' ? children({ pressed: false }) : children);
  return {
    View, Pressable, ActivityIndicator: () => null,
    Alert: { alert: (title: string, message: string | undefined, buttons: Button[]) => { fx.alerts.push({ title, message, buttons }); } },
    Linking: { openSettings: vi.fn() },
  };
});
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestCameraPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true })),
  requestMediaLibraryPermissionsAsync: () => fx.libraryPermission(),
  launchCameraAsync: vi.fn(), launchImageLibraryAsync: () => fx.library(),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Badge: () => null, Card: Box, T: ({ children }: any) => R.createElement('span', null, children),
    BrandCheckbox: ({ checked }: { checked: boolean }) => R.createElement('span', { 'data-box': String(checked) }),
    LinkText: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      R.createElement('a', { 'data-link': label, onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onPress?.(); } }, label),
  };
});
vi.mock('../../hooks/verification', () => ({
  useUploadDocument: () => ({ mutate: fx.mutate, isPending: false, isError: false, error: null, variables: undefined }),
  useWithdrawPoliceClearance: () => ({ mutate: fx.withdraw, isPending: false, isError: false, error: null }),
}));
vi.mock('../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: 'u1' }),
  requireAuthSessionForPrincipal: (s: unknown) => s,
}));

import { DocumentUploadCard } from './DocumentUploadCard';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const mount = async (props: Record<string, unknown>) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(DocumentUploadCard, { role: 'MOVER', status: undefined, ...props } as any)));
};
const card = () => host.querySelector('[data-card="card"]') as HTMLElement;
const tap = async () => act(async () => card().click());
const choose = async (n: number, text: string) => act(async () => fx.alerts[n]!.buttons.find((b) => b.text === text)?.onPress?.());
const isPhotoChoice = (n: number) => fx.alerts[n]?.buttons.some((b) => b.text === 'Take photo') && fx.alerts[n]?.buttons.some((b) => b.text === 'Choose from library');

beforeEach(() => { fx.alerts = []; fx.mutate.mockClear(); fx.withdraw.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[DOC-CONSENT] a police clearance asks for the consent again when the tick came from the record', () => {
  it('the tap asks first, in the ledger\'s exact words; Cancel opens no picker and uploads nothing', async () => {
    await mount({ docType: 'police_clearance', consented: true, askConsentFirst: true, optionalHint: 'Optional.' });
    await tap();
    expect(fx.alerts).toHaveLength(1);
    expect(fx.alerts[0]!.title).toBe('Police Clearance Certificate');
    expect(fx.alerts[0]!.message).toContain(DOCUMENT_CONSENT_TEXT);
    expect(fx.alerts[0]!.buttons.map((b) => b.text)).toEqual(['Cancel', 'I consent']);
    expect(isPhotoChoice(0)).toBe(false);
    await choose(0, 'Cancel');
    expect(fx.alerts).toHaveLength(1);
    expect(fx.mutate).not.toHaveBeenCalled();
  });

  it('"I consent" goes on to the usual photo choice', async () => {
    await mount({ docType: 'police_clearance', consented: true, askConsentFirst: true });
    await tap();
    await choose(0, 'I consent');
    expect(fx.alerts).toHaveLength(2);
    expect(isPhotoChoice(1)).toBe(true);
  });

  it('a clearance waiting for review: Replace → the consent → the photo choice', async () => {
    await mount({ docType: 'police_clearance', status: 'PENDING', consented: true, askConsentFirst: true });
    await tap();
    await choose(0, 'Replace');
    expect(fx.alerts[1]!.buttons.map((b) => b.text)).toEqual(['Cancel', 'I consent']);
    await choose(1, 'I consent');
    expect(isPhotoChoice(2)).toBe(true);
  });

  it('without the ask (a tick on this visit, or any other document) the tap goes straight to the photo choice, as today', async () => {
    await mount({ docType: 'police_clearance', consented: true, askConsentFirst: false });
    await tap();
    expect(isPhotoChoice(0)).toBe(true);
    await act(async () => root.unmount()); host.remove();
    fx.alerts = [];
    await mount({ docType: 'drivers_licence', consented: true });
    await tap();
    expect(isPhotoChoice(0)).toBe(true);
  });

  it('without a tick the card stays shut, ask or not', async () => {
    await mount({ docType: 'police_clearance', consented: false, askConsentFirst: true });
    expect(card().getAttribute('data-disabled')).toBe('true');
  });

  describe('[S4 · REVIEW-G2] the upload says how its consent was given', () => {
    const fromLibrary = async (n: number) => {
      fx.libraryPermission.mockResolvedValueOnce({ granted: true, canAskAgain: true });
      fx.library.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///doc.jpg', fileName: 'doc.jpg', mimeType: 'image/jpeg' }] });
      await choose(n, 'Choose from library');
      await vi.waitFor(() => expect(fx.mutate).toHaveBeenCalledTimes(1));
      return fx.mutate.mock.calls[0]![0] as { docType: string; consentVia?: string };
    };

    it('the box shown from the record: "record"', async () => {
      await mount({ docType: 'drivers_licence', consented: true, consentVia: 'record' });
      await tap();
      expect(await fromLibrary(0)).toMatchObject({ docType: 'drivers_licence', consentVia: 'record' });
    });

    it('the box ticked on this visit: "checkbox"', async () => {
      await mount({ docType: 'drivers_licence', consented: true, consentVia: 'checkbox' });
      await tap();
      expect(await fromLibrary(0)).toMatchObject({ consentVia: 'checkbox' });
    });

    it('a police clearance after "I consent": "prompt", not the record it came from', async () => {
      await mount({ docType: 'police_clearance', consented: true, askConsentFirst: true, consentVia: 'record' });
      await tap();
      await choose(0, 'I consent');
      expect(await fromLibrary(1)).toMatchObject({ docType: 'police_clearance', consentVia: 'prompt' });
    });
  });

  describe('[POLICE-CLEARANCE CONSENT] a police clearance with its own words (from the API)', () => {
    const WORDS = {
      tick: 'police_clearance_v1' as const, version: 'taxi-v1-30d',
      text: 'Optional. I choose to upload my police clearance. (the words from the API)',
      withdrawConfirm: 'Swift stops using your police clearance now and deletes it, keeping only a note that it was withdrawn. If the law requires Swift to keep it, it is kept but no longer used for your account.',
    };
    const ownTick = () => host.querySelector('[data-card="police-clearance-consent-tick"]') as HTMLElement | null;
    const fromLibrary = async (n: number) => {
      fx.libraryPermission.mockResolvedValueOnce({ granted: true, canAskAgain: true });
      fx.library.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///pc.jpg', fileName: 'pc.jpg', mimeType: 'image/jpeg' }] });
      await choose(n, 'Choose from library');
      await vi.waitFor(() => expect(fx.mutate).toHaveBeenCalledTimes(1));
      return fx.mutate.mock.calls[0]!;
    };

    it('its own box shows the API\'s words, unticked; the list\'s tick does not open the card; its own tick does, with no second ask', async () => {
      await mount({ docType: 'police_clearance', consented: true, askConsentFirst: true, consentVia: 'record', policeConsent: WORDS });
      expect(ownTick()).not.toBeNull();
      expect(ownTick()!.textContent).toContain(WORDS.text);
      expect(ownTick()!.getAttribute('aria-checked')).toBe('false');
      expect(card().getAttribute('data-disabled'), 'the list tick is not this consent').toBe('true');
      expect(host.textContent).toContain('Tick the box below to upload');
      await act(async () => ownTick()!.click());
      expect(ownTick()!.getAttribute('aria-checked')).toBe('true');
      expect(card().getAttribute('data-disabled')).toBe('false');
      await tap();
      expect(isPhotoChoice(0), 'its own tick is the explicit consent: straight to the photo').toBe(true);
      const [vars, opts] = await fromLibrary(0);
      expect(vars).toMatchObject({ docType: 'police_clearance', consent: { tick: 'police_clearance_v1', version: 'taxi-v1-30d' } });
      // Each upload asks again: after it lands the box is empty.
      await act(async () => (opts as { onSuccess?: () => void } | undefined)?.onSuccess?.());
      expect(ownTick()!.getAttribute('aria-checked')).toBe('false');
      expect(card().getAttribute('data-disabled')).toBe('true');
    });

    it('new words (the API changed them) empty its box: a tick belongs to the words it was given to', async () => {
      await mount({ docType: 'police_clearance', consented: true, policeConsent: WORDS });
      await act(async () => ownTick()!.click());
      expect(ownTick()!.getAttribute('aria-checked')).toBe('true');
      await act(async () => root.render(React.createElement(DocumentUploadCard, { role: 'MOVER', status: undefined, docType: 'police_clearance', consented: true, policeConsent: { ...WORDS, version: 'taxi-v1-45d', text: 'Other words.' } } as any)));
      expect(ownTick()!.getAttribute('aria-checked')).toBe('false');
      expect(ownTick()!.textContent).toContain('Other words.');
    });

    it('a clearance on file can be withdrawn: the API\'s confirmation first, then the withdrawal', async () => {
      await mount({ docType: 'police_clearance', status: 'APPROVED', consented: true, policeConsent: WORDS });
      const link = host.querySelector('[data-link="Withdraw my police clearance"]') as HTMLElement;
      expect(link).not.toBeNull();
      await act(async () => link.click());
      expect(fx.alerts[0]!.title).toBe('Withdraw your police clearance?');
      expect(fx.alerts[0]!.message).toBe(WORDS.withdrawConfirm);
      expect(fx.alerts[0]!.buttons.map((b) => b.text)).toEqual(['Cancel', 'Withdraw']);
      await choose(0, 'Cancel');
      expect(fx.withdraw).not.toHaveBeenCalled();
      await act(async () => link.click());
      await choose(1, 'Withdraw');
      expect(fx.withdraw).toHaveBeenCalledTimes(1);
    });

    it('[REVIEW-F #2111 S3-1] after the tap the phone says what happened, from the API\'s answer', async () => {
      await mount({ docType: 'police_clearance', status: 'APPROVED', consented: true, policeConsent: WORDS });
      const link = host.querySelector('[data-link="Withdraw my police clearance"]') as HTMLElement;
      await act(async () => link.click());
      await choose(0, 'Withdraw');
      expect(fx.withdraw).toHaveBeenCalledTimes(1);
      const opts = fx.withdraw.mock.calls[0]![1] as { onSuccess?: (_answer: unknown) => void } | undefined;
      expect(typeof opts?.onSuccess, 'the withdrawal reports its result').toBe('function');
      await act(async () => opts!.onSuccess!({ withdrawn: 1, keptForLegalHold: 1, deletionPending: 0 }));
      expect(fx.alerts[1]).toMatchObject({
        title: 'Police clearance withdrawn',
        message: 'Swift must keep it for a legal reason, so it is not deleted. It is no longer used for your account.',
      });
      await act(async () => opts!.onSuccess!({ withdrawn: 1, keptForLegalHold: 0, deletionPending: 0 }));
      expect(fx.alerts[2]).toMatchObject({ title: 'Police clearance withdrawn', message: 'It is deleted. Swift keeps only a note that it was withdrawn.' });
    });

    it('nothing on file, or an older API without the words: no withdraw link; older API keeps the list tick', async () => {
      await mount({ docType: 'police_clearance', consented: true, policeConsent: WORDS });
      expect(host.querySelector('[data-link="Withdraw my police clearance"]')).toBeNull();
      await act(async () => root.unmount()); host.remove();
      await mount({ docType: 'police_clearance', status: 'APPROVED', consented: true, askConsentFirst: false });
      expect(ownTick()).toBeNull();
      expect(host.querySelector('[data-link="Withdraw my police clearance"]')).toBeNull();
    });
  });
});
