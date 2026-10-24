/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C2 · #1952 review S3-2] Rating one item never drops the rating
// of ANOTHER item.
//
// One shared "a verdict is sending" flag held the whole list: thumbs-up on
// item A, then on item B while A was still saving, and B's tap was dropped
// with no sign (the rating was lost). The hold is per row now: only the SAME
// row waits for its request.
// The REAL FeedbackScreen drawn by a real React renderer, with a REAL React
// Query mutation for the item verdicts; only the server is a stand-in whose
// answers each case releases by hand. Asserted: two different rows both go
// through; the same row tapped twice while it sends fires once (and goes
// again once it answered); a failed row rolls back only its own thumb.
// ---------------------------------------------------------------------------

interface Sent { body: { itemId: string; verdict: 'UP' | 'DOWN' }; ok: () => void; fail: () => void }

const fx = vi.hoisted(() => {
  /** A design token that prints its own path (`color.brand.600`), so the thumb's colour can be read. */
  const tok = (path: string): any => new Proxy(() => path, {
    get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => path : tok(`${path}.${String(k)}`)),
  });
  return {
    tok,
    sent: [] as Sent[],
    order: {
      id: 'o1', vendor: { name: 'Corner Store' }, rider: null,
      items: [{ id: 'l1', itemId: 'i1', name: 'Rice' }, { id: 'l2', itemId: 'i2', name: 'Juice' }],
    },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', { 'aria-label': p.accessibilityLabel }, p.children);
  const Pressable = (p: any) => h('div', { 'aria-label': p.accessibilityLabel, role: 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  return {
    View, Pressable, Text: View, ScrollView: View, KeyboardAvoidingView: View, TextInput: () => h('input'),
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', async () => {
  const R = await import('react');
  return { Feather: (p: any) => R.createElement('i', { 'data-icon': p.name, 'data-color': String(p.color) }) };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn(), goBack: vi.fn(), popToTop: vi.fn() }),
  useRoute: () => ({ params: { orderId: 'o1' } }),
}));
vi.mock('@swift/ui', () => ({ color: fx.tok('color'), font: fx.tok('font'), fontSize: fx.tok('fontSize'), radius: fx.tok('radius'), space: fx.tok('space') }));
vi.mock('../../../lib/images', () => ({ DARK_BLURHASH: '', vendorPhoto: () => null }));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    T: (p: any) => h('span', null, p.children), PopupTitle: Box, Screen: Box, Header: (p: any) => h('header', null, p.title),
    Chip: (p: any) => h('span', null, p.label), IconChip: () => null, LoadingBlock: () => h('div', null, 'Loading'),
    ErrorState: () => h('div', { role: 'alert' }), Stars: () => null, PopupCard: (p: any) => (p.visible ? h('div', null, p.children) : null),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
  };
});
// The order and the star rating are stand-ins; the item verdict is a REAL mutation over a stand-in server.
vi.mock('../../../hooks/customer', async () => {
  const { useMutation } = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    useOrder: () => ({ data: fx.order, isLoading: false, isError: false, refetch: vi.fn() }),
    useRateOrder: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useRatingTags: () => ({ data: {} }),
    useItemFeedback: () => useMutation({
      mutationFn: (body: Sent['body']) => new Promise<void>((resolve, reject) => {
        fx.sent.push({ body, ok: () => resolve(), fail: () => reject(new Error('down')) });
      }),
      meta: { silent: true },
    }),
  };
});

import { FeedbackScreen } from './FeedbackScreen';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  fx.sent = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client: qc }, h(FeedbackScreen))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const thumb = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const tap = async (label: string) => { await act(async () => { thumb(label).click(); }); };
const lit = (label: string) => thumb(label).querySelector('i')?.getAttribute('data-color') === 'color.brand.600';
// React Query hands a settled mutation to its observers on a timer: wait one past it.
const settle = async (s: Sent | undefined, how: 'ok' | 'fail') => { await act(async () => { s![how](); await new Promise((r) => setTimeout(r, 20)); }); };

describe('[BUG-GUARDS C2 · #1952 S3-2] item thumbs hold per row, not per list', () => {
  it('two different rows both go through while the first is still sending', async () => {
    await tap('Liked Rice');
    await tap('Liked Juice'); // Rice has not answered yet
    expect(fx.sent.map((s) => s.body)).toEqual([{ itemId: 'i1', verdict: 'UP' }, { itemId: 'i2', verdict: 'UP' }]);
    expect(lit('Liked Rice')).toBe(true);
    expect(lit('Liked Juice')).toBe(true);
  });

  it('the same row tapped twice while it sends fires once, and goes again once it answered', async () => {
    await tap('Liked Rice');
    await tap('Liked Rice');
    await tap('Disliked Rice'); // the same row: it waits for its own request
    expect(fx.sent.map((s) => s.body)).toEqual([{ itemId: 'i1', verdict: 'UP' }]);
    await settle(fx.sent[0], 'ok');
    await tap('Disliked Rice');
    expect(fx.sent.map((s) => s.body)).toEqual([{ itemId: 'i1', verdict: 'UP' }, { itemId: 'i1', verdict: 'DOWN' }]);
  });

  it('a failed row rolls back only its own thumb, even when another row sent after it', async () => {
    await tap('Liked Rice');
    await tap('Disliked Juice');
    expect(fx.sent).toHaveLength(2);
    await settle(fx.sent[0], 'fail'); // Rice fails AFTER Juice was sent
    expect(lit('Liked Rice')).toBe(false);
    expect(lit('Disliked Juice')).toBe(true);
    await settle(fx.sent[1], 'ok');
    expect(lit('Disliked Juice')).toBe(true);
  });
});
