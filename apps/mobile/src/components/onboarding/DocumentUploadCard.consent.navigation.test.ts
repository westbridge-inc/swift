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
  libraryPermission: vi.fn(async () => ({ granted: false, canAskAgain: true })),
  library: vi.fn(async () => ({ canceled: true, assets: [] as unknown[] })),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled }: any) =>
    R.createElement('button', { type: 'button', 'data-card': 'card', disabled: !!disabled, onClick: onPress }, typeof children === 'function' ? children({ pressed: false }) : children);
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
  return { Badge: () => null, Card: Box, LinkText: () => null, T: ({ children }: any) => R.createElement('span', null, children) };
});
vi.mock('../../hooks/verification', () => ({
  useUploadDocument: () => ({ mutate: fx.mutate, isPending: false, isError: false, error: null, variables: undefined }),
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
const tap = async () => act(async () => (host.querySelector('[data-card]') as HTMLButtonElement).click());
const choose = async (n: number, text: string) => act(async () => fx.alerts[n]!.buttons.find((b) => b.text === text)?.onPress?.());
const isPhotoChoice = (n: number) => fx.alerts[n]?.buttons.some((b) => b.text === 'Take photo') && fx.alerts[n]?.buttons.some((b) => b.text === 'Choose from library');

beforeEach(() => { fx.alerts = []; fx.mutate.mockClear(); });
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
    expect((host.querySelector('[data-card]') as HTMLButtonElement).disabled).toBe(true);
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
});
