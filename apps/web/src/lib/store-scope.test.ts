import { QueryClient } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORE_SCOPE,
  UNSCOPED,
  clearDirtyDrafts,
  dirtyDraftIds,
  hasDirtyDrafts,
  setDraftDirty,
  storeKey,
  storeScope,
  switchStore,
} from './store-scope';

// ---------------------------------------------------------------------------
// [W-04] S0 tenant isolation. One operator can own several stores. Every vendor
// request is scoped server-side by an x-vendor-id header, so the SERVER always
// answered about the right store; the client cache was the part that lied.
//
// Every dashboard query key omitted the store, and the switch called
// `invalidateQueries()` — which marks entries stale and REFETCHES but does not
// clear them. React Query keeps serving the last successful data during a
// refetch, so store A's orders and settlements rendered under store B's name
// for the whole round trip, and forever if B's refetch failed.
// ---------------------------------------------------------------------------

const A = 'store_aaa';
const B = 'store_bbb';

beforeEach(() => clearDirtyDrafts());

describe('[W-04] the store is part of the cache identity', () => {
  it('puts the store id in the key, in a removable prefix position', () => {
    expect(storeKey(A, 'orders')).toEqual([STORE_SCOPE, A, 'orders']);
    expect(storeScope(A)).toEqual([STORE_SCOPE, A]);
  });

  it('two stores never share a key for the same resource', () => {
    expect(storeKey(A, 'orders')).not.toEqual(storeKey(B, 'orders'));
    expect(storeKey(A, 'order', 'ord_1')).not.toEqual(storeKey(B, 'order', 'ord_1'));
  });

  it('"no store yet" is its own scope, and cannot be mistaken for a real store', () => {
    expect(storeKey(null, 'overview')).toEqual([STORE_SCOPE, UNSCOPED, 'overview']);
    expect(storeKey(undefined, 'overview')).toEqual(storeKey(null, 'overview'));
    expect(storeKey(null, 'overview')).not.toEqual(storeKey(A, 'overview'));
  });
});

describe('[W-04] switching stores REMOVES the old store, it does not merely invalidate', () => {
  function seeded() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(storeKey(A, 'orders'), [{ id: 'ord_a', total: '4000' }]);
    qc.setQueryData(storeKey(A, 'overview'), { revenue: '99999' });
    qc.setQueryData(storeKey(null, 'overview'), { revenue: 'pre-store' });
    qc.setQueryData(['stores'], { stores: [{ id: A }, { id: B }], selectedId: A });
    return qc;
  }

  it('the defect, pinned: invalidateQueries LEAVES store A’s bytes in the cache', () => {
    const qc = seeded();
    qc.invalidateQueries();
    // this is what the switch used to do, and why A's orders rendered under B
    expect(qc.getQueryData(storeKey(A, 'orders'))).toEqual([{ id: 'ord_a', total: '4000' }]);
  });

  it('after a switch there is nothing of store A left to render', async () => {
    const qc = seeded();
    const committed: string[] = [];
    await switchStore(qc, { from: A, to: B, commit: (id) => committed.push(id) });

    expect(qc.getQueryData(storeKey(A, 'orders'))).toBeUndefined();
    expect(qc.getQueryData(storeKey(A, 'overview'))).toBeUndefined();
    expect(qc.getQueryData(storeKey(null, 'overview'))).toBeUndefined();
    expect(committed).toEqual([B]);
  });

  it('the store LIST survives — it belongs to the operator, not to a store', async () => {
    const qc = seeded();
    await switchStore(qc, { from: A, to: B, commit: () => {} });
    expect(qc.getQueryData(['stores'])).toBeTruthy();
  });

  it('commits the new selection BEFORE cancelling, so a late reply is refused not cached', async () => {
    // The ORDER is the whole point. apiFetch compares the persisted store at
    // response time against the one the request was issued under, so the
    // selection must already be B before anything is torn down; otherwise a
    // reply for A that lands during the switch still looks current.
    const qc = seeded();
    const order: string[] = [];
    const cancelSpy = vi.spyOn(qc, 'cancelQueries').mockImplementation((async () => {
      order.push('cancel');
    }) as never);
    const removeSpy = vi.spyOn(qc, 'removeQueries').mockImplementation((() => {
      order.push('remove');
    }) as never);
    await switchStore(qc, { from: A, to: B, commit: () => order.push('commit') });
    expect(order).toEqual(['commit', 'cancel', 'remove', 'remove']);
    cancelSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('the store being switched TO is never cleared by the switch', async () => {
    // storeScope(null) must not be a PREFIX of a real store's scope: if it
    // were, removing it would take every store with it — including the one
    // just selected, whose data would vanish the moment it arrived.
    const qc = seeded();
    qc.setQueryData(storeKey(B, 'orders'), [{ id: 'ord_b' }]);
    await switchStore(qc, { from: A, to: B, commit: () => {} });
    expect(qc.getQueryData(storeKey(B, 'orders'))).toEqual([{ id: 'ord_b' }]);
  });

  it('switching to the store already selected changes nothing', async () => {
    const qc = seeded();
    const applied = await switchStore(qc, { from: A, to: A, commit: () => {} });
    expect(applied).toBe(false);
    expect(qc.getQueryData(storeKey(A, 'orders'))).toBeTruthy();
  });
});

describe('[W-04] unsaved work is discarded by DECISION, never by surprise', () => {
  it('registers and reports what is dirty', () => {
    expect(hasDirtyDrafts()).toBe(false);
    setDraftDirty('Operating hours', true);
    expect(dirtyDraftIds()).toEqual(['Operating hours']);
    setDraftDirty('Operating hours', false);
    expect(hasDirtyDrafts()).toBe(false);
  });

  it('a declined confirmation abandons the switch entirely', async () => {
    const qc = new QueryClient();
    qc.setQueryData(storeKey(A, 'hours'), [{ dayOfWeek: 0 }]);
    setDraftDirty('Operating hours', true);
    let committed = false;
    const applied = await switchStore(qc, {
      from: A, to: B,
      commit: () => { committed = true; },
      confirmDiscard: () => false,
    });
    expect(applied).toBe(false);
    expect(committed).toBe(false);
    expect(qc.getQueryData(storeKey(A, 'hours'))).toBeTruthy(); // nothing was touched
    expect(hasDirtyDrafts()).toBe(true);
  });

  it('an accepted confirmation switches and forgets the old store’s drafts', async () => {
    const qc = new QueryClient();
    qc.setQueryData(storeKey(A, 'hours'), [{ dayOfWeek: 0 }]);
    setDraftDirty('Operating hours', true);
    const seen: string[][] = [];
    const applied = await switchStore(qc, {
      from: A, to: B,
      commit: () => {},
      confirmDiscard: (ids) => { seen.push(ids); return true; },
    });
    expect(applied).toBe(true);
    expect(seen).toEqual([['Operating hours']]);
    expect(hasDirtyDrafts()).toBe(false);
    expect(qc.getQueryData(storeKey(A, 'hours'))).toBeUndefined();
  });

  it('with nothing unsaved the operator is not asked', async () => {
    const qc = new QueryClient();
    const asked = vi.fn(() => true);
    await switchStore(qc, { from: A, to: B, commit: () => {}, confirmDiscard: asked });
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('[W-04] the dashboard actually uses it', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src/app/dashboard', p), 'utf8');
  const pages = ['page.tsx', 'orders/page.tsx', 'inventory/page.tsx', 'settings/page.tsx'];

  it('no dashboard query key is storeless — only the store LIST is', () => {
    for (const p of [...pages, 'layout.tsx']) {
      const body = src(p);
      const bare = [...body.matchAll(/queryKey: \['([^']+)'/g)].map((m) => m[1]);
      expect(bare.filter((k) => k !== 'stores'), `${p} has storeless query keys`).toEqual([]);
    }
  });

  it('every page derives its store id', () => {
    for (const p of pages) expect(src(p), p).toMatch(/const storeId = useStoreId\(\)/);
  });

  it('the shell remounts the page subtree when the store changes', () => {
    // local component state — a half-typed form — belongs to the store it was
    // typed in. The remount is what stops the hours editor carrying A's rows
    // into B, where Save would have written them.
    expect(src('layout.tsx')).toMatch(/<main key=\{storeId \?\? 'no-store'\}/);
  });

  it('the switch clears rather than invalidates', () => {
    const layout = src('layout.tsx');
    expect(layout).toMatch(/switchStore\(queryClient, \{/);
    expect(layout).not.toMatch(/queryClient\.invalidateQueries\(\);/);
  });

  it('[W-05] no store is ever merely DISPLAYED — the selection is persisted', () => {
    const layout = src('layout.tsx');
    // the old shape: fall back to the first store without persisting it, so the
    // header named one store while x-vendor-id named another
    expect(layout).not.toMatch(/\?\? list\[0\]/);
    expect(layout).toMatch(/Choose a store/);
  });

  it('the hours editor declares when it holds unsaved work', () => {
    expect(src('settings/page.tsx')).toMatch(/setDraftDirty\(HOURS_DRAFT, true\)/);
  });
});
