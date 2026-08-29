import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import {
  checkBackupFreshness,
  LAST_BACKUP_KEY,
  LAST_BACKUP_OFFSITE_KEY,
  DEFAULT_MAX_AGE_HOURS,
} from '../modules/ops/backup-freshness';

// ---------------------------------------------------------------------------
// The failure this guards is not a backup that errors loudly. It is a backup
// that quietly stops — an uninstalled timer, a full disk, an expired
// credential. Nothing looks wrong until the file is needed and is not there.
// ---------------------------------------------------------------------------

describe('backup freshness — noticing when backups quietly stop', () => {
  let app: FastifyInstance;
  const HOUR = 3_600_000;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
    // A real backup run against this database leaves a heartbeat behind, and
    // residue in swift_test has already cost this project days. Start clean.
    await app.prisma.platformConfig.deleteMany({
      where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } },
    });
  });

  afterEach(async () => {
    await app.prisma.platformConfig.deleteMany({
      where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } },
    });
  });

  afterAll(async () => {
    await app.prisma.platformConfig.deleteMany({
      where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } },
    });
    await app.close();
  });

  async function heartbeat(at: Date | null, offsite: boolean) {
    if (at) {
      await app.prisma.platformConfig.create({
        data: { key: LAST_BACKUP_KEY, value: at.toISOString() as never },
      });
    }
    await app.prisma.platformConfig.create({
      data: { key: LAST_BACKUP_OFFSITE_KEY, value: offsite as never },
    });
  }

  it('pages when no backup has EVER run', async () => {
    const r = await checkBackupFreshness(app.prisma);
    expect(r.stale).toBe(true);
    expect(r.ageHours).toBeNull();
    expect(r.reason).toMatch(/has ever been recorded|nothing restorable/i);
  });

  it('is quiet when a recent backup went offsite', async () => {
    await heartbeat(new Date(Date.now() - 3 * HOUR), true);
    const r = await checkBackupFreshness(app.prisma);
    expect(r.stale).toBe(false);
    expect(r.offsite).toBe(true);
    expect(Math.round(r.ageHours!)).toBe(3);
  });

  it('pages when backups have stopped', async () => {
    await heartbeat(new Date(Date.now() - 72 * HOUR), true);
    const r = await checkBackupFreshness(app.prisma);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/stopped/i);
  });

  it('⭐ pages when backups RUN but never leave the machine they protect', async () => {
    // The seductive failure: the operator has watched backups succeed, so it
    // feels safe. One dead disk still loses the database and every backup.
    await heartbeat(new Date(Date.now() - 1 * HOUR), false);
    const r = await checkBackupFreshness(app.prisma);
    expect(r.stale).toBe(true);
    expect(r.offsite).toBe(false);
    expect(r.reason).toMatch(/server they protect|BACKUP_BUCKET/);
  });

  it('an unreadable heartbeat is treated as stale, never as healthy', async () => {
    await app.prisma.platformConfig.create({
      data: { key: LAST_BACKUP_KEY, value: 'not-a-date' as never },
    });
    await app.prisma.platformConfig.create({
      data: { key: LAST_BACKUP_OFFSITE_KEY, value: true as never },
    });
    const r = await checkBackupFreshness(app.prisma);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/unreadable/i);
  });

  it('the boundary holds on both sides', async () => {
    const now = new Date();
    await heartbeat(new Date(now.getTime() - (DEFAULT_MAX_AGE_HOURS - 1) * HOUR), true);
    expect((await checkBackupFreshness(app.prisma, now)).stale).toBe(false);

    await app.prisma.platformConfig.deleteMany({
      where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } },
    });
    await heartbeat(new Date(now.getTime() - (DEFAULT_MAX_AGE_HOURS + 1) * HOUR), true);
    expect((await checkBackupFreshness(app.prisma, now)).stale).toBe(true);
  });
});
