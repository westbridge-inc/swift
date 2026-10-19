import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { testPrismaClient } from './helpers/test-prisma-client';

// ---------------------------------------------------------------------------
// [Row 310] Chat polling reads one room's newest messages:
//   chat.routes.ts GET /rooms/:roomId/messages  WHERE chatRoomId = $1 [AND createdAt < $2]
//                                               ORDER BY createdAt DESC LIMIT n
//   chat.routes.ts recentSenderDigits           WHERE chatRoomId = $1 AND senderId = $2
//                                               AND createdAt >= $3 ORDER BY createdAt DESC
//   safety/evidence.service.ts                  WHERE chatRoomId = $1 ORDER BY createdAt ASC
// chat_messages had only an index on offPlatformFlag, so every poll read the
// whole table. One (chatRoomId, createdAt) index serves all three.
// ---------------------------------------------------------------------------

const INDEX = 'chat_messages_chatRoomId_createdAt_idx';
const MIGRATIONS = join(process.cwd(), 'prisma/migrations');
const ONLINE = '20261018204000_chat_messages_room_created_index';

/** What PostgreSQL executes: the file without its comment lines. */
const executable = (dir: string, file = 'migration.sql') => readFileSync(join(MIGRATIONS, dir, file), 'utf8')
  .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim();

describe('[Row 310] the chat polling index ships as one online build', () => {
  it('the schema declares the (chatRoomId, createdAt) index on ChatMessage', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model ChatMessage {'));
    const body = model.slice(0, model.indexOf('\n}'));
    expect(body).toMatch(/@@index\(\[chatRoomId, createdAt\]\)/);
  });

  it('its migration is exactly ONE statement, CREATE INDEX CONCURRENTLY, nothing that would wrap it in a transaction', () => {
    expect(readdirSync(MIGRATIONS)).toContain(ONLINE);
    const sql = executable(ONLINE);
    // Prisma sends a multi-statement file as one implicit transaction, where CONCURRENTLY is forbidden.
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql).toMatch(new RegExp(`^CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"\\s+ON "chat_messages"\\("chatRoomId", "createdAt"\\);$`));
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|SET|RESET)\b/);
  });

  it('its rollback drops only this index, bounded by a lock timeout', () => {
    const sql = executable(ONLINE, 'rollback.sql');
    expect(sql).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(sql).toContain(`DROP INDEX IF EXISTS "${INDEX}";`);
    expect(sql.match(/DROP /g)).toHaveLength(1);
    expect(sql).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${ONLINE}';`);
  });
});

describe('[Row 310] on the migrated database the polling queries use the index', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    prisma = testPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('the index exists and is VALID (a failed online build leaves an invalid one)', async () => {
    const rows = await prisma.$queryRaw<Array<{ valid: boolean; ready: boolean }>>`
      SELECT i."indisvalid" AS valid, i."indisready" AS ready
      FROM pg_index i JOIN pg_class c ON c.oid = i."indexrelid"
      WHERE c.relname = ${INDEX}`;
    expect(rows).toEqual([{ valid: true, ready: true }]);
  });

  /** The plan of one query with sequential scans priced out, so a test-sized
   *  table still shows which index the planner CAN use. Read-only. */
  async function plan(sql: string): Promise<string> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${sql}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  it.each([
    ['the newest page of a room', `SELECT * FROM "chat_messages" WHERE "chatRoomId" = 'room-x' ORDER BY "createdAt" DESC LIMIT 50`],
    ['an older page of a room', `SELECT * FROM "chat_messages" WHERE "chatRoomId" = 'room-x' AND "createdAt" < now() ORDER BY "createdAt" DESC LIMIT 50`],
    ['a sender\'s recent digits in a room', `SELECT "message" FROM "chat_messages" WHERE "chatRoomId" = 'room-x' AND "senderId" = 'user-x' AND "createdAt" >= now() - interval '10 minutes' ORDER BY "createdAt" DESC LIMIT 6`],
    ['a room\'s evidence export', `SELECT * FROM "chat_messages" WHERE "chatRoomId" = 'room-x' ORDER BY "createdAt" ASC LIMIT 500`],
  ])('%s reads through the index', async (_label, sql) => {
    const text = await plan(sql);
    expect(text, text).toContain(INDEX);
    expect(text, text).not.toMatch(/Seq Scan on chat_messages/);
  });
});
