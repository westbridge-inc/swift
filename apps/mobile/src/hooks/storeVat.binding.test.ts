import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [STORE-VAT · REVIEW-G #2103 S4-1 + S4-2] The store's VAT on the phone is bound to the account and the store it started
// on: a store or account switch while a VAT read or write is out is refused, the read cache is per store + account +
// session, and the GRA certificate is filed only for the owner who picked it. In a sample preview the two VAT writes are
// the read-only stub (nothing is sent). Driven through the REAL hooks; the network, the stores and the cache are stubs.
// ---------------------------------------------------------------------------

type Session = { userId: string; generation: number; token: string };
const fx = vi.hoisted(() => ({
  storeId: 'store-a' as string | null,
  storeGeneration: 1,
  session: null as Session | null,
  previewType: null as string | null,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  whileOut: null as null | (() => void),
  uploads: [] as unknown[],
  whileUploading: null as null | (() => void),
  stub: { told: 0, mutateAsync: async () => { fx.stub.told += 1; return undefined; } },
}));

const sent = vi.hoisted(() => (fn: string) => async (...args: unknown[]) => {
  fx.calls.push({ fn, args });
  fx.whileOut?.();
  return { data: { data: { status: 'PENDING' } } };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});
vi.mock('../services/api', () => ({
  vendorDiscoveryApi: {},
  vendorApi: { vat: sent('vat'), updateVat: sent('updateVat'), sendVatCertificate: sent('sendVatCertificate') },
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: fx.session ? { id: fx.session.userId } : null, sessionGeneration: fx.session?.generation }),
  getAuthSessionSnapshot: () => (fx.session ? { ...fx.session } : null),
  requireAuthSessionSnapshot: () => {
    if (!fx.session) throw new Error('signed out');
    return { ...fx.session };
  },
  requireAuthSessionForPrincipal: (owner: Session) => {
    if (!fx.session || fx.session.userId !== owner.userId || fx.session.generation !== owner.generation) throw new Error('The account changed.');
    return { ...fx.session };
  },
}));
vi.mock('../stores/storeSwitcher', () => {
  const state = () => ({ selectedStoreId: fx.storeId, storeGeneration: fx.storeGeneration });
  return { useStoreSwitcher: Object.assign((selector: (s: unknown) => unknown) => selector(state()), { getState: state }) };
});
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: { getState: () => ({ previewType: fx.previewType }) } }));
vi.mock('../lib/vendorPreviewData', () => ({ previewMutation: () => fx.stub }));
vi.mock('./verification', () => ({
  useUploadFile: () => ({
    mutateAsync: async (file: unknown) => {
      fx.uploads.push(file);
      fx.whileUploading?.();
      return 'verification/owner/cert.enc';
    },
  }),
}));

import { useStoreVat, useUpdateStoreVat } from './storeVat';
import { useSendVatCertificate } from './storeVatCertificate';

type Read = { queryKey: unknown[]; queryFn: () => Promise<unknown> };
type Write<V> = { mutationFn: (v: V) => Promise<unknown>; mutateAsync?: unknown };
const owner: Session = { userId: 'owner-1', generation: 1, token: 'token-owner-1' };
const file = { uri: 'file:///certificate.jpg', name: 'certificate.jpg', type: 'image/jpeg' };

beforeEach(() => {
  fx.storeId = 'store-a';
  fx.storeGeneration = 1;
  fx.session = { ...owner };
  fx.previewType = null;
  fx.calls.length = 0;
  fx.uploads.length = 0;
  fx.whileOut = null;
  fx.whileUploading = null;
  fx.stub.told = 0;
});

describe('[O-5 · G S4-1] the VAT read belongs to one store and one account', () => {
  it('the cache key holds the store, the account and the session generation', () => {
    expect((useStoreVat(true) as unknown as Read).queryKey).toEqual(['vendor', 'vat', 'store-a', 'owner-1', 1]);
  });

  it('the request carries the captured session and store', async () => {
    await (useStoreVat(true) as unknown as Read).queryFn();
    expect(fx.calls).toEqual([{ fn: 'vat', args: [owner, 'store-a'] }]);
  });

  it('a store switch while the read is out is refused', async () => {
    const read = useStoreVat(true) as unknown as Read;
    fx.whileOut = () => { fx.storeId = 'store-b'; };
    await expect(read.queryFn()).rejects.toThrow('The store changed');
  });

  it('an account switch, or a new session of the same account, while the read is out is refused', async () => {
    const read = useStoreVat(true) as unknown as Read;
    fx.whileOut = () => { fx.session = { userId: 'other-2', generation: 1, token: 'token-other-2' }; };
    await expect(read.queryFn()).rejects.toThrow('The store changed');
    fx.session = { ...owner };
    fx.whileOut = () => { fx.session = { ...owner, generation: 2, token: 'token-owner-1b' }; };
    await expect(read.queryFn()).rejects.toThrow('The store changed');
  });
});

describe('[O-5 · G S4-1] the owner\'s VAT answer is written for the store and account that gave it', () => {
  it('sends the answer with the captured session and store', async () => {
    await (useUpdateStoreVat() as unknown as Write<{ registered: boolean; vatRegistrationNumber?: string }>).mutationFn({ registered: true, vatRegistrationNumber: '012345678' });
    // [REVIEW-M #2256 N1] No choice made = no mode sent (never a built-in default that could ask to switch it).
    expect(fx.calls).toEqual([{ fn: 'updateVat', args: [{ registered: true, vatRegistrationNumber: '012345678' }, owner, 'store-a'] }]);
  });

  it('[REVIEW-M #2256 N1] sends the price choice the store made, with the captured session and store', async () => {
    await (useUpdateStoreVat() as unknown as Write<{ registered: boolean; vatRegistrationNumber?: string; mode?: string }>).mutationFn({ registered: true, vatRegistrationNumber: '012345678', mode: 'ADD_VAT_AT_CHECKOUT' });
    expect(fx.calls).toEqual([{ fn: 'updateVat', args: [{ registered: true, vatRegistrationNumber: '012345678', mode: 'ADD_VAT_AT_CHECKOUT' }, owner, 'store-a'] }]);
  });

  it('a store switched after the screen drew is refused before anything is sent', async () => {
    const write = useUpdateStoreVat() as unknown as Write<{ registered: boolean }>;
    fx.storeId = 'store-b';
    fx.storeGeneration = 2;
    await expect(write.mutationFn({ registered: false })).rejects.toThrow('The store changed');
    expect(fx.calls).toEqual([]);
  });

  it('a store or account switch while the write is out is refused', async () => {
    const write = useUpdateStoreVat() as unknown as Write<{ registered: boolean }>;
    fx.whileOut = () => { fx.storeId = 'store-b'; };
    await expect(write.mutationFn({ registered: false })).rejects.toThrow('The store changed');
    fx.storeId = 'store-a';
    fx.whileOut = () => { fx.session = { userId: 'other-2', generation: 1, token: 'token-other-2' }; };
    await expect(write.mutationFn({ registered: false })).rejects.toThrow('The store changed');
  });
});

describe('[O-5 · G S4-1] the GRA certificate is filed only for the owner who picked it', () => {
  it('the upload carries the owner\'s session; the filing carries the same account\'s session, the store and the consent tick', async () => {
    await (useSendVatCertificate() as unknown as Write<typeof file>).mutationFn(file);
    expect(fx.uploads).toEqual([{ ...file, authSession: owner }]);
    expect(fx.calls).toEqual([{
      fn: 'sendVatCertificate',
      args: [{ fileUrl: 'verification/owner/cert.enc', consent: true, privacyNoticeVersion: 'v1', consentTick: 'document_v1' }, owner, 'store-a'],
    }]);
  });

  it('an account switch during the upload: the certificate is never filed', async () => {
    const write = useSendVatCertificate() as unknown as Write<typeof file>;
    fx.whileUploading = () => { fx.session = { userId: 'other-2', generation: 1, token: 'token-other-2' }; };
    await expect(write.mutationFn(file)).rejects.toThrow('The account changed.');
    expect(fx.calls).toEqual([]);
  });

  it('a store switch while the filing is out is refused', async () => {
    const write = useSendVatCertificate() as unknown as Write<typeof file>;
    fx.whileOut = () => { fx.storeId = 'store-b'; };
    await expect(write.mutationFn(file)).rejects.toThrow('The store changed');
  });
});

describe('[O-5 · G S4-2] a sample preview never sends a VAT write', () => {
  it('in a preview both VAT writes send nothing (no answer, no upload, no filing) and say preview is read-only', async () => {
    fx.previewType = 'STORE';
    await expect((useUpdateStoreVat() as unknown as Write<{ registered: boolean }>).mutationFn({ registered: false })).resolves.toBeUndefined();
    await expect((useSendVatCertificate() as unknown as Write<typeof file>).mutationFn(file)).resolves.toBeUndefined();
    expect(fx.calls).toEqual([]);
    expect(fx.uploads).toEqual([]);
    expect(fx.stub.told).toBe(2);
  });

  it('a preview opened after the screen drew is still caught at the send', async () => {
    const write = useUpdateStoreVat() as unknown as Write<{ registered: boolean }>;
    fx.previewType = 'RESTAURANT';
    await write.mutationFn({ registered: false });
    expect(fx.calls).toEqual([]);
  });
});
