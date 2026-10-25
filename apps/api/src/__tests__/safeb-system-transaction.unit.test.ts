import { describe, expect, it, vi } from 'vitest';
const wiring = vi.hoisted(() => ({ enabled: true, system: null as any }));
vi.mock('../plugins/prisma', () => ({ rlsBindEnabled: () => wiring.enabled, systemPrismaClient: () => wiring.system }));
import { identityTransaction } from '../modules/integrity/identity-review';

describe('identity system work keeps its interactive transaction connection', () => {
  it('selects the system transaction once and never sends scoped writes to a root delegate', async () => {
    const tx = { identityReviewCase: { update: vi.fn(async () => 'retained') } };
    const rootUpdate = vi.fn(() => { throw new Error('escaped transaction'); });
    wiring.system = { $transaction: vi.fn(async (work: any) => work(tx)), identityReviewCase: { update: rootUpdate } };
    const request: any = { $transaction: vi.fn(() => { throw new Error('wrong connection'); }) };
    expect(await identityTransaction(request, async (connection) => connection.identityReviewCase.update({} as never))).toBe('retained');
    expect(wiring.system.$transaction).toHaveBeenCalledOnce(); expect(tx.identityReviewCase.update).toHaveBeenCalledOnce();
    expect(rootUpdate).not.toHaveBeenCalled(); expect(request.$transaction).not.toHaveBeenCalled();
  });
  it('fails closed when binding is enabled but the system connection is unavailable', async () => {
    wiring.system = null; const work = vi.fn();
    await expect(identityTransaction({} as never, work)).rejects.toMatchObject({ code: 'IDENTITY_SYSTEM_DATABASE_UNAVAILABLE' });
    expect(work).not.toHaveBeenCalled();
  });
});
