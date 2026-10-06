import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  userId: 'synthetic-owner', generation: 1,
  queries: [] as Array<Record<string, any>>, mutations: [] as Array<Record<string, any>>,
  refetch: vi.fn(), get: vi.fn(), mark: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: host.userId }, sessionGeneration: host.generation, isAuthenticated: true }),
  requireAuthSessionForPrincipal: (owner: { userId: string; generation: number }) => {
    if (owner.userId !== host.userId || owner.generation !== host.generation) throw new Error('Account changed');
    return { ...owner };
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: Record<string, any>) => { host.queries.push(options); return { refetch: host.refetch }; },
  useInfiniteQuery: (options: Record<string, any>) => { host.queries.push(options); return { refetch: host.refetch }; },
  useMutation: (options: Record<string, any>) => { host.mutations.push(options); return options; },
  useQueryClient: () => ({ invalidateQueries: host.invalidate }),
}));
vi.mock('../services/api', () => ({ safetyApi: { getSos: host.get, markSafeSos: host.mark, ownedActiveSos: host.list, monitoringPreference: host.read, setMonitoringPreference: host.write } }));
import { useMarkSafeSos, useMonitoringPreference, useOwnedSosAlert, useOwnedSosAlerts } from './owned-safety';
const alert = (extra = {}) => ({ id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: 'ACTIVE', userSafeFlaggedAt: null, graceEndsAt: null, ...extra });
const envelope = (data: unknown) => ({ data: { data } });
beforeEach(() => {
  vi.clearAllMocks(); host.userId = 'synthetic-owner'; host.generation = 1; host.queries = []; host.mutations = [];
  host.get.mockResolvedValue(envelope(alert())); host.mark.mockResolvedValue(envelope({}));
  host.read.mockResolvedValue(envelope({ enhancedSafetyMonitoring: false }));
  host.write.mockResolvedValue(envelope({})); host.refetch.mockResolvedValue({ data: true });
});
describe('current principal safety hook boundaries', () => {
  it('keys reads to account and generation, validates booleans and persists then refetches', async () => {
    useMonitoringPreference();
    expect(host.queries[0]!['queryKey']).toEqual(['safety', 'monitoring', 'synthetic-owner', 1]);
    expect(await host.queries[0]!['queryFn']()).toBe(false);
    const saved = await host.mutations[0]!['mutationFn'](true);
    expect(saved).toBe(true); expect(host.write).toHaveBeenCalledWith(true, { userId: 'synthetic-owner', generation: 1 });
    expect(host.refetch).toHaveBeenCalledExactlyOnceWith({ throwOnError: true });
    host.read.mockResolvedValue(envelope({ enhancedSafetyMonitoring: 'true' }));
    await expect(host.queries[0]!['queryFn']()).rejects.toThrow('read');
  });
  it('a failed refetch rejects the save acknowledgement', async () => {
    useMonitoringPreference(); host.refetch.mockRejectedValue(new Error('offline'));
    await expect(host.mutations[0]!['mutationFn'](true)).rejects.toThrow('offline');
  });
  it('account change during save prevents dependent refetch', async () => {
    useMonitoringPreference(); host.write.mockImplementation(async () => { host.generation++; return envelope({}); });
    await expect(host.mutations[0]!['mutationFn'](true)).rejects.toThrow('Account changed');
    expect(host.refetch).not.toHaveBeenCalled();
  });
  it('late read after same-account relogin cannot be accepted', async () => {
    useMonitoringPreference(); host.read.mockImplementation(async () => { host.generation++; return envelope({ enhancedSafetyMonitoring: true }); });
    await expect(host.queries[0]!['queryFn']()).rejects.toThrow('Account changed');
  });
  it('owned cold recovery validates principal and pages without inventing an alert', async () => {
    useOwnedSosAlerts(); const fn = host.queries[0]!['queryFn'];
    host.list.mockResolvedValue({ data: { data: [alert()], nextCursor: 'synthetic-next' } });
    expect(await fn({ pageParam: null })).toEqual({ rows: [alert()], nextCursor: 'synthetic-next' });
    expect(host.list).toHaveBeenCalledWith(null, { userId: 'synthetic-owner', generation: 1 });
    host.list.mockResolvedValue({ data: { data: [alert({ actorUserId: 'foreign-owner' })], nextCursor: null } });
    await expect(fn({ pageParam: 'synthetic-next' })).rejects.toThrow('verify');
    expect(host.mark).not.toHaveBeenCalled();
  });
  it('mark-safe reads current ownership, writes and returns the refreshed server truth', async () => {
    useMarkSafeSos(); const flagged = alert({ userSafeFlaggedAt: '2026-09-30T12:00:00.000Z' });
    host.get.mockResolvedValueOnce(envelope(alert())).mockResolvedValueOnce(envelope(flagged));
    expect(await host.mutations[0]!['mutationFn']('synthetic-alert')).toEqual(flagged);
    expect(host.get).toHaveBeenCalledTimes(2); expect(host.mark).toHaveBeenCalledOnce();
  });
  it.each(['TRIGGER_PENDING', 'RESOLVED', 'CANCELLED'])('%s cannot acquire a first safe flag', async (status) => {
    useMarkSafeSos(); host.get.mockResolvedValue(envelope(alert({ status })));
    expect((await host.mutations[0]!['mutationFn']('synthetic-alert')).status).toBe(status);
    expect(host.mark).not.toHaveBeenCalled();
  });
  it('foreign or wrong alert results cannot authorize a write', async () => {
    useMarkSafeSos(); host.get.mockResolvedValue(envelope(alert({ actorUserId: 'foreign-owner' })));
    await expect(host.mutations[0]!['mutationFn']('synthetic-alert')).rejects.toThrow('verify');
    expect(host.mark).not.toHaveBeenCalled();
  });
  it('a switch after preflight cannot issue a mark-safe request as the next account', async () => {
    useMarkSafeSos(); host.get.mockImplementation(async () => { host.userId = 'new-owner'; return envelope(alert()); });
    await expect(host.mutations[0]!['mutationFn']('synthetic-alert')).rejects.toThrow('Account changed');
    expect(host.mark).not.toHaveBeenCalled();
  });
  it('a lost write response remains unknown and never returns an assumed safe flag', async () => {
    useMarkSafeSos(); host.mark.mockRejectedValue(new Error('lost response'));
    await expect(host.mutations[0]!['mutationFn']('synthetic-alert')).rejects.toThrow('lost response');
    expect(host.get).toHaveBeenCalledOnce();
  });
  it('by-id recovery rejects unreadable or foreign acknowledgement', async () => {
    useOwnedSosAlert('synthetic-alert'); host.get.mockResolvedValue(envelope(alert({ userSafeFlaggedAt: 'invalid-time' })));
    await expect(host.queries[0]!['queryFn']()).rejects.toThrow('verify');
  });
});
