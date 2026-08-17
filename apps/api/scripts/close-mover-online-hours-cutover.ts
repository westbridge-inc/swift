import Redis from 'ioredis';

const CONFIRMATION = 'CLOSE_RIDER_ONLINE_HOURS';
const ONLINE_MS_TTL_SECONDS = 172_800;
const MARKER_PATTERN = 'rider:online_since:*';
const CUTOFF_PROOF_KEY =
  'cutover:mover_authority:20260808021500:online_hours_epoch_ms';

function requireCutoverAuthorization(): string {
  if (process.env['MOVER_AUTHORITY_CUTOVER_CONFIRM'] !== CONFIRMATION) {
    throw new Error(
      `Refusing Redis mutation: set MOVER_AUTHORITY_CUTOVER_CONFIRM=${CONFIRMATION} during the reviewed maintenance window`,
    );
  }
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }
  return redisUrl;
}

function guyanaDay(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Guyana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const value = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new Error('Could not derive Guyana cutover day');
  return `${year}-${month}-${day}`;
}

async function scanMarkerKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, page] = await redis.scan(
      cursor,
      'MATCH',
      MARKER_PATTERN,
      'COUNT',
      500,
    );
    cursor = nextCursor;
    keys.push(...page);
  } while (cursor !== '0');
  return keys;
}

const CLOSE_MARKER_AT_CUTOVER = `
local onlineSince = redis.call('GET', KEYS[1])
if not onlineSince then
  return {0, 0}
end

local startedAt = tonumber(onlineSince)
local cutoffAt = tonumber(ARGV[1])
if not startedAt then
  return redis.error_reply('online-hours marker is not an integer epoch-ms value')
end
if startedAt > cutoffAt then
  return redis.error_reply('online-hours marker begins after the cutover timestamp')
end

local elapsed = cutoffAt - startedAt
redis.call('INCRBY', KEYS[2], elapsed)
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return {1, elapsed}
`;

async function main(): Promise<void> {
  const redis = new Redis(requireCutoverAuthorization(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

  try {
    await redis.connect();
    let cutoffRaw = await redis.get(CUTOFF_PROOF_KEY);
    let cutoffCreated = false;
    if (!cutoffRaw) {
      const [seconds, microseconds] = await redis.time();
      const proposed = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
      if (!Number.isSafeInteger(proposed)) {
        throw new Error('Redis TIME did not return a safe epoch-ms value');
      }
      const won = await redis.set(CUTOFF_PROOF_KEY, String(proposed), 'NX');
      cutoffCreated = won === 'OK';
      cutoffRaw = await redis.get(CUTOFF_PROOF_KEY);
    }
    if (cutoffRaw === null) {
      throw new Error('Durable Redis cutover proof could not be read after creation');
    }
    const cutoffEpochMs = Number(cutoffRaw);
    if (!Number.isSafeInteger(cutoffEpochMs) || cutoffEpochMs < 1_600_000_000_000) {
      throw new Error('Durable Redis cutover proof is missing or is not a safe epoch-ms value');
    }

    const day = guyanaDay(cutoffEpochMs);
    const markerKeys = [...new Set(await scanMarkerKeys(redis))];
    let closedMarkers = 0;
    let totalMsFolded = 0;

    for (const markerKey of markerKeys) {
      const riderId = markerKey.slice('rider:online_since:'.length);
      if (!riderId || riderId.includes(':')) {
        throw new Error(`Unexpected online-hours marker key: ${markerKey}`);
      }
      const bucketKey = `rider:online_ms:${riderId}:${day}`;
      const result = await redis.eval(
        CLOSE_MARKER_AT_CUTOVER,
        2,
        markerKey,
        bucketKey,
        String(cutoffEpochMs),
        String(ONLINE_MS_TTL_SECONDS),
      ) as [number | string, number | string];
      if (Number(result[0]) === 1) {
        const elapsed = Number(result[1]);
        closedMarkers += 1;
        totalMsFolded += elapsed;
      }
    }

    const residualMarkers = await scanMarkerKeys(redis);
    if (residualMarkers.length > 0) {
      throw new Error(
        `${residualMarkers.length} online-hours marker(s) remain; keep maintenance mode and prove every writer is stopped`,
      );
    }

    process.stdout.write(`${JSON.stringify({
      operation: 'mover-authority-online-hours-cutover',
      cutoffEpochMs,
      cutoffIso: new Date(cutoffEpochMs).toISOString(),
      guyanaDay: day,
      cutoffProofKey: CUTOFF_PROOF_KEY,
      cutoffCreated,
      closedMarkers,
      totalMsFolded,
      residualMarkers: 0,
    })}\n`);
  } finally {
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Mover online-hours cutover failed: ${message}\n`);
  process.exitCode = 1;
});
