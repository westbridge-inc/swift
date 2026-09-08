#!/usr/bin/env node
// ---------------------------------------------------------------------------
// [LIC-001 | Codex REPORT-075] VALKEY CUTOVER PREFLIGHT.
//
// Valkey 8 cannot read Redis 7.4 data. Not "migrate it carefully" - cannot:
//
//     # Can't handle RDB format version 12
//     # Error reading the RDB base file appendonly.aof.2.base.rdb, AOF loading aborted
//
// and the server exits 1. MIGRATE and DUMP/RESTORE fail the same way
// ("DUMP payload version or checksum are wrong"). There is no binary path.
//
// So the cutover starts Valkey EMPTY and whatever is still in Redis is gone.
// Most of that is fine: OTPs expire, rate limits reset, offers are re-offered,
// the Socket.IO adapter rebuilds, and every recurring job is a `repeat:` cron
// re-registered from code on boot.
//
// ONE THING IS NOT FINE. Delayed BullMQ jobs are lost, and the outbox that
// created them marks each row `processedAt` on publish and never publishes it
// again (drainCheckoutOutbox claims `WHERE "processedAt" IS NULL`), so nothing
// retries a lost one. The job that matters:
//
//     auto-cancel - delay = (ORDER_HOLD_MINUTES + vendor response SLA) minutes.
//                   Default 15 min; the SLA is configurable up to 24 HOURS.
//
// An order whose auto-cancel never fires is never released: the customer waits
// on a vendor who went home, and nothing in the system corrects it.
//
// This script does not guess that window. It reads what is actually pending.
//
// NO DEPENDENCIES, ON PURPOSE. It speaks RESP over a socket instead of
// importing ioredis, because the host that most needs this check is the one
// with nothing installed on it - and an ops tool that dies on a missing module
// is worse than no tool, since the crash exits non-zero and reads like a
// finding. Node alone is enough.
//
//   node deploy/valkey-preflight.mjs                  # uses REDIS_URL
//   node deploy/valkey-preflight.mjs redis://host:6379/0
//
// Exit 0 = GO (nothing outstanding). Exit 1 = WAIT, and it says until when.
// Exit 2 = the check could not run, which is NOT a GO.
// ---------------------------------------------------------------------------
import net from 'node:net';

const KNOWN_QUEUES = ['order', 'dispatch', 'notification', 'search', 'settlement', 'subscription', 'verification'];

// ---- a minimal RESP client -------------------------------------------------
function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    const onError = (e) => { sock.destroy(); reject(e); };
    sock.once('error', onError);
    sock.once('connect', () => { sock.removeListener('error', onError); resolve(sock); });
  });
}

/** Parse one RESP reply out of `buf`. Returns [value, bytesConsumed] or null when incomplete. */
function parse(buf, i = 0) {
  if (i >= buf.length) return null;
  const nl = buf.indexOf('\r\n', i);
  if (nl === -1) return null;
  const type = buf[i];
  const head = buf.slice(i + 1, nl);
  const after = nl + 2;
  if (type === 0x2b) return [head.toString(), after];                       // +simple
  if (type === 0x2d) return [new Error(head.toString()), after];            // -error
  if (type === 0x3a) return [Number(head.toString()), after];               // :integer
  if (type === 0x24) {                                                       // $bulk
    const len = Number(head.toString());
    if (len === -1) return [null, after];
    if (buf.length < after + len + 2) return null;
    return [buf.slice(after, after + len).toString(), after + len + 2];
  }
  if (type === 0x2a) {                                                       // *array
    const n = Number(head.toString());
    if (n === -1) return [null, after];
    const out = []; let p = after;
    for (let k = 0; k < n; k += 1) {
      const r = parse(buf, p);
      if (!r) return null;
      out.push(r[0]); p = r[1];
    }
    return [out, p];
  }
  return [new Error(`unsupported RESP type ${String.fromCharCode(type)}`), after];
}

function makeClient(sock) {
  let buf = Buffer.alloc(0);
  const waiting = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (waiting.length === 0) break;
      const r = parse(buf, 0);
      if (!r) break;
      buf = buf.slice(r[1]);
      const { resolve, reject } = waiting.shift();
      r[0] instanceof Error ? reject(r[0]) : resolve(r[0]);
    }
  });
  sock.on('error', (e) => { while (waiting.length) waiting.shift().reject(e); });
  sock.on('close', () => { while (waiting.length) waiting.shift().reject(new Error('connection closed')); });
  return (...args) => new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    let cmd = `*${args.length}\r\n`;
    for (const a of args) { const s = String(a); cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
    sock.write(cmd);
  });
}

// ---- the check -------------------------------------------------------------
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const when = (ms) => {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

const raw = process.argv[2] ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
let exitCode = 2;
let sock;
try {
  const u = new URL(raw);
  const db = u.pathname.replace(/^\//, '') || '0';
  sock = await connect(u.hostname, Number(u.port || 6379));
  const cmd = makeClient(sock);
  if (u.password) await cmd('AUTH', ...(u.username ? [u.username, u.password] : [u.password]));
  if (db !== '0') await cmd('SELECT', db);

  const info = await cmd('INFO', 'server');
  const server = /^server_name:(.+)$/m.exec(info)?.[1]?.trim() ?? 'redis';
  // Valkey reports BOTH: `redis_version` (a compatibility number clients
  // version-sniff on - 7.2.4) and `valkey_version` (what is actually running -
  // 8.1.10), and redis_version comes first in the payload. Prefer the real one
  // or this prints "valkey 7.2.4", which reads like a downgrade.
  const version = /^valkey_version:(.+)$/m.exec(info)?.[1]?.trim()
    ?? /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? '?';
  console.log(`connected: ${server} ${version}  (${raw.replace(/\/\/[^@]*@/, '//***@')} db ${db})`);

  // BullMQ keeps delayed jobs in a zset scored by fire-time; :wait and :active
  // hold jobs due now or running. All three block a clean cutover, but only
  // :delayed can be far in the future.
  const rows = [];
  for (const q of KNOWN_QUEUES) {
    const delayed = await cmd('ZCARD', `bull:${q}:delayed`);
    const wait = await cmd('LLEN', `bull:${q}:wait`);
    const active = await cmd('LLEN', `bull:${q}:active`);
    let furthest = null;
    if (delayed > 0) {
      const tail = await cmd('ZRANGE', `bull:${q}:delayed`, -1, -1, 'WITHSCORES');
      // BullMQ packs the fire-time in the high bits of the score.
      if (tail?.[1] !== undefined) furthest = Math.floor(Number(tail[1]) / 4096);
    }
    if (delayed || wait || active) rows.push({ q, delayed, wait, active, furthest });
  }

  if (rows.length === 0) {
    console.log('\nNo delayed, waiting or active jobs on any known queue.');
    console.log('GO - nothing is outstanding, so nothing is lost by starting Valkey empty.');
    exitCode = 0;
  } else {
    console.log('\nOutstanding work that will NOT survive the cutover:\n');
    console.log('  queue          delayed   wait  active   last job fires in');
    console.log('  ' + '-'.repeat(58));
    let furthestOverall = 0;
    for (const r of rows) {
      if (r.furthest) furthestOverall = Math.max(furthestOverall, r.furthest);
      console.log(
        `  ${r.q.padEnd(13)}${String(r.delayed).padStart(7)}${String(r.wait).padStart(7)}` +
        `${String(r.active).padStart(8)}   ${r.furthest ? when(r.furthest) : '-'}`,
      );
    }
    const total = rows.reduce((n, r) => n + r.delayed + r.wait + r.active, 0);
    console.log('');
    console.log(`WAIT - ${plural(total, 'job')} outstanding.`);
    if (furthestOverall) {
      console.log(`The last one fires at ${new Date(furthestOverall).toISOString()} (in ${when(furthestOverall)}).`);
      console.log('Stop accepting new orders, let these drain, then re-run this check.');
    }
    console.log('\nAn `order` queue delayed job is usually auto-cancel. Losing it leaves that');
    console.log('order pending forever: no customer release, no vendor release, no alert.');
    exitCode = 1;
  }
} catch (err) {
  // A socket error's `message` is often empty; the code is the useful part.
  const why = err instanceof Error
    ? [err.message, err.code, err.syscall].filter(Boolean).join(' ') || err.name
    : String(err);
  console.error(`\nPREFLIGHT COULD NOT RUN: ${why}`);
  console.error('This is not a GO. A cutover decision needs the measurement, not its absence.');
  exitCode = 2;
} finally {
  sock?.destroy();
}
process.exit(exitCode);
