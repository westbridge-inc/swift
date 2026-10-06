import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// [L09 · row 40] A scheduled (or provider-confirmed) service job can be
// cancelled from the phone by either party, through the same compare-and-set
// command the API enforces. The REAL mobile screen runs in the DOM test host;
// only the native primitives, the kit, the stores and the hooks are replaced.

const state = vi.hoisted(() => ({
  me: 'customer-1',
  jobs: [] as any[],
  cancel: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
}));
const idle = () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null });

vi.mock('../../../mobile/node_modules/react-native', () => {
  const View = ({ children, testID }: any) => <div data-testid={testID}>{children}</div>;
  return {
    View, ScrollView: View,
    RefreshControl: () => null,
    TextInput: ({ value, onChangeText }: any) => <input value={value} onChange={(e) => onChangeText?.(e.target.value)} />,
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    Platform: { OS: 'ios' },
  };
});
vi.mock('../../../mobile/src/hooks', () => ({
  useServiceJobs: () => ({ data: state.jobs, isLoading: false, isError: false, refetch: vi.fn() }),
  useCancelJob: () => state.cancel,
  useScheduleJob: idle, useRateJob: idle, useQuoteJob: idle, useConfirmJob: idle,
  useDeclineSlot: idle, useStartJob: idle, useCompleteJob: idle,
}));
vi.mock('../../../mobile/src/hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: async () => {} }) }));
vi.mock('../../../mobile/src/modules/safety/SosCeremony', () => ({ SosCeremony: () => null }));
vi.mock('../../../mobile/src/stores/authStore', () => ({
  useAuthStore: (select: (_state: unknown) => unknown) => select({ user: { id: state.me } }),
}));
vi.mock('../../../mobile/src/stores/locationStore', () => ({ useLocationStore: () => ({}) }));
vi.mock('../../../mobile/src/lib/deviceLocation', () => ({ grantedLocationFix: async () => null }));
vi.mock('../../../mobile/src/kit', () => ({
  Screen: ({ children }: any) => <main>{children}</main>,
  Header: ({ title }: any) => <h1>{title}</h1>,
  Card: ({ children }: any) => <section>{children}</section>,
  T: ({ children }: any) => <span>{children}</span>,
  TonePill: ({ label }: any) => <span>{label}</span>,
  Chip: ({ label, onPress }: any) => <button type="button" onClick={onPress}>{label}</button>,
  IconChip: () => null, Stars: () => null, LoadingBlock: () => null, ErrorState: () => null, EmptyState: () => null,
  PillButton: ({ label, onPress, disabled }: any) => <button type="button" disabled={disabled} onClick={onPress}>{label}</button>,
  PopupCard: ({ children, visible }: any) => (visible ? <div role="dialog">{children}</div> : null),
  PopupTitle: ({ children }: any) => <h2>{children}</h2>,
}));

const screenPath = new URL('../../../mobile/src/modules/services/screens/ServiceJobsScreen.tsx', import.meta.url).pathname;
let ServiceJobsScreen: React.ComponentType<{ navigation: unknown }>;

beforeAll(async () => {
  ({ ServiceJobsScreen } = await import(screenPath));
});

beforeEach(() => {
  state.cancel = { mutate: vi.fn(), isPending: false, isError: false, error: null };
});
afterEach(() => cleanup());

function scheduledJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', status: 'SCHEDULED', customerId: 'customer-1', provider: { userId: 'provider-1' },
    trade: 'carpenter', description: 'Fix the gate', quoteAmount: '9000.00',
    scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    providerConfirmedAt: new Date().toISOString(), createdAt: '2026-10-04T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z', chatRoomId: null,
    ...overrides,
  };
}

describe('[row 40] a booked service job can be cancelled from the phone', () => {
  it.each([
    ['the customer, slot awaiting confirmation', 'customer-1', { providerConfirmedAt: null }],
    ['the customer, slot confirmed', 'customer-1', {}],
    ['the provider, slot confirmed', 'provider-1', {}],
  ])('%s: Cancel opens the confirmation and sends the compare-and-set cancel', (_name, me, overrides) => {
    state.me = me;
    state.jobs = [scheduledJob(overrides as Record<string, unknown>)];
    render(<ServiceJobsScreen navigation={{ navigate: vi.fn() }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
    expect(state.cancel.mutate).toHaveBeenCalledWith(
      { id: 'job-1', expectedUpdatedAt: '2026-10-05T12:00:00.000Z' },
      expect.any(Object),
    );
  });

  it('a finished job offers no cancel', () => {
    state.me = 'customer-1';
    state.jobs = [scheduledJob({ status: 'COMPLETED' })];
    render(<ServiceJobsScreen navigation={{ navigate: vi.fn() }} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
