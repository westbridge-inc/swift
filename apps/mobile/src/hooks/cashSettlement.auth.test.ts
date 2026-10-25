import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => ({
  BoundaryError: class TestAuthSessionBoundaryError extends Error {},
  current: null as AuthSessionSnapshot | null,
  riderConfirm: vi.fn(),
  vendorConfirm: vi.fn(),
}));

const accountA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a-1',
  refreshToken: 'refresh-a-1',
};

const accountB: AuthSessionSnapshot = {
  generation: 3,
  userId: 'account-b',
  accessToken: 'access-b-1',
  refreshToken: 'refresh-b-1',
};

vi.mock('../stores/authStore', () => ({
  requireAuthSessionSnapshot: () => {
    if (!mocks.current) throw new mocks.BoundaryError();
    return { ...mocks.current };
  },
  requireAuthSessionForPrincipal: (owner: AuthSessionSnapshot) => {
    if (
      !mocks.current
      || mocks.current.generation !== owner.generation
      || mocks.current.userId !== owner.userId
    ) throw new mocks.BoundaryError();
    return { ...mocks.current };
  },
}));

vi.mock('../services/api', () => ({
  riderApi: { confirmCashSettlement: mocks.riderConfirm },
  vendorApi: { confirmCashSettlement: mocks.vendorConfirm },
}));

import {
  captureRiderCashSettlementConfirmation,
  captureVendorCashSettlementConfirmation,
  confirmRiderCashSettlement,
  confirmVendorCashSettlement,
  requireCurrentCashSettlementConfirmation,
} from './cashSettlement';

function mutationObserver<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return new MutationObserver(client, { mutationFn });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = { ...accountA };
  mocks.riderConfirm.mockResolvedValue({ data: { data: { status: 'RIDER_CONFIRMED' } } });
  mocks.vendorConfirm.mockResolvedValue({ data: { data: { status: 'STORE_CONFIRMED' } } });
});

describe('cash-settlement confirmation session ownership', () => {
  it('rejects an A-origin rider mutation after B replaces the account', async () => {
    const confirmation = captureRiderCashSettlementConfirmation('settlement-1', 417.25, accountA);
    const observer = mutationObserver(confirmRiderCashSettlement);
    mocks.current = { ...accountB };

    await expect(observer.mutate(confirmation)).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.riderConfirm).not.toHaveBeenCalled();
  });

  it('rejects an A-origin vendor mutation after B replaces the account', async () => {
    const confirmation = captureVendorCashSettlementConfirmation('settlement-1', 417.25, 'store-a', accountA);
    const observer = mutationObserver(confirmVendorCashSettlement);
    mocks.current = { ...accountB };

    await expect(observer.mutate(confirmation)).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.vendorConfirm).not.toHaveBeenCalled();
  });

  it('rejects a retained vendor confirmation callback after account replacement', () => {
    const confirmation = captureVendorCashSettlementConfirmation('settlement-1', 417.25, 'store-a', accountA);
    const retainedCallback = () => requireCurrentCashSettlementConfirmation(confirmation);
    mocks.current = { ...accountB };

    expect(retainedCallback).toThrow(mocks.BoundaryError);
    expect(mocks.vendorConfirm).not.toHaveBeenCalled();
  });

  it('rejects a retained rider-row callback after account replacement', () => {
    const confirmation = captureRiderCashSettlementConfirmation('settlement-1', 417.25, accountA);
    const retainedCallback = () => requireCurrentCashSettlementConfirmation(confirmation);
    mocks.current = { ...accountB };

    expect(retainedCallback).toThrow(mocks.BoundaryError);
    expect(mocks.riderConfirm).not.toHaveBeenCalled();
  });

  it('allows the same rider principal and pins its rotated credentials', async () => {
    const confirmation = captureRiderCashSettlementConfirmation('settlement-1', 417.25, accountA);
    const observer = mutationObserver(confirmRiderCashSettlement);
    const rotatedA = {
      ...accountA,
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    };
    mocks.current = rotatedA;

    await expect(observer.mutate(confirmation)).resolves.toEqual({ status: 'RIDER_CONFIRMED' });
    expect(mocks.riderConfirm).toHaveBeenCalledWith('settlement-1', 417.25, rotatedA);
  });

  it('allows the same vendor principal while retaining the originating store', async () => {
    const confirmation = captureVendorCashSettlementConfirmation('settlement-1', 417.25, 'store-a', accountA);
    const observer = mutationObserver(confirmVendorCashSettlement);
    const rotatedA = {
      ...accountA,
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    };
    mocks.current = rotatedA;

    await expect(observer.mutate(confirmation)).resolves.toEqual({ status: 'STORE_CONFIRMED' });
    expect(mocks.vendorConfirm).toHaveBeenCalledWith('settlement-1', 417.25, rotatedA, 'store-a');
  });
});
