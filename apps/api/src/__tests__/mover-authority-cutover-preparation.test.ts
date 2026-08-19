import { describe, expect, it, vi } from 'vitest';
import {
  prepareMoverAuthorityCutover,
  type MoverAuthorityCutoverState,
} from '../modules/mover-authority-cutover-preparation';

const zeroState = (): MoverAuthorityCutoverState => ({
  activeAssignments: '0',
  physicalCustody: '0',
  riderLivePointers: '0',
  driverLivePointers: '0',
  riderPointers: '0',
  driverPointers: '0',
  riderSupplyToRetire: '0',
  driverSupplyToRetire: '0',
});

function sqlText(parts: TemplateStringsArray): string {
  return Array.from(parts).join(' ');
}

function preparationPrisma(
  before: MoverAuthorityCutoverState,
  after: MoverAuthorityCutoverState,
  phaseCounts: Record<string, number[]> = {},
) {
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([before])
    .mockResolvedValueOnce([after]);
  const executeRaw = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = sqlText(parts);
    if (sql.includes('SET LOCAL')) return 0;

    let phase: string | undefined;
    if (sql.includes('SET "currentOrderId" = NULL')) phase = 'rider-pointer';
    else if (sql.includes('SET "currentRideId" = NULL')) phase = 'driver-pointer';
    else if (sql.includes('UPDATE "riders" r')) phase = 'rider-supply';
    else if (sql.includes('UPDATE "drivers" d')) phase = 'driver-supply';
    if (!phase) throw new Error(`unexpected preparation SQL: ${sql}`);
    return phaseCounts[phase]?.shift() ?? 0;
  });
  const tx = { $executeRaw: executeRaw };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<number>) => operation(tx));

  return {
    client: { $queryRaw: queryRaw, $transaction: transaction } as never,
    queryRaw,
    executeRaw,
    transaction,
  };
}

describe('mover authority cutover preparation', () => {
  it('refuses every mutation while assignment, custody, or live-pointer evidence exists', async () => {
    const before = {
      ...zeroState(),
      activeAssignments: '1',
      physicalCustody: '1',
      riderLivePointers: '1',
    };
    const fake = preparationPrisma(before, zeroState());

    await expect(prepareMoverAuthorityCutover(fake.client)).rejects.toThrow(
      'Mover authority preparation refused while live work exists',
    );
    expect(fake.transaction).not.toHaveBeenCalled();
    const proofSql = sqlText(fake.queryRaw.mock.calls[0]![0]);
    expect(proofSql).toContain('o."ridePinVerified" = true OR o."ridePinVerifiedAt" IS NOT NULL');
  });

  it('commits restart-safe bounded batches and proves every final state is zero', async () => {
    const before = {
      ...zeroState(),
      riderPointers: '2',
      driverPointers: '1',
      riderSupplyToRetire: '2',
      driverSupplyToRetire: '3',
    };
    const fake = preparationPrisma(before, zeroState(), {
      'rider-pointer': [2, 0],
      'driver-pointer': [1, 0],
      'rider-supply': [2, 0],
      'driver-supply': [3, 0],
    });
    const progress = vi.fn();

    const result = await prepareMoverAuthorityCutover(fake.client, {
      batchSize: 100,
      onProgress: progress,
    });

    expect(result.after).toEqual(zeroState());
    expect(result.updated).toEqual({
      'clear-terminal-rider-pointers': 2,
      'clear-terminal-driver-pointers': 1,
      'retire-rider-supply': 2,
      'retire-driver-supply': 3,
    });
    expect(fake.transaction).toHaveBeenCalledTimes(8);
    expect(progress).toHaveBeenCalledTimes(8);
    expect(fake.executeRaw.mock.calls.map(([parts]) => sqlText(parts)).join('\n'))
      .toContain('FOR UPDATE SKIP LOCKED');
  });

  it('fails closed when a writer or unreconciled row leaves residual state', async () => {
    const after = { ...zeroState(), driverSupplyToRetire: '1' };
    const fake = preparationPrisma(zeroState(), after);

    await expect(prepareMoverAuthorityCutover(fake.client, { batchSize: 100 }))
      .rejects.toThrow('Mover authority preparation incomplete: driverSupplyToRetire=1');
  });

  it('rejects unbounded operator batch sizes before querying the database', async () => {
    const fake = preparationPrisma(zeroState(), zeroState());

    await expect(prepareMoverAuthorityCutover(fake.client, { batchSize: 10_001 }))
      .rejects.toThrow('batch size must be an integer from 100 through 10000');
    expect(fake.queryRaw).not.toHaveBeenCalled();
  });
});
