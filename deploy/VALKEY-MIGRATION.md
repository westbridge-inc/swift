# Redis → Valkey: the cutover

**[LIC-001 · Codex REPORT-075]**

## Why

`redis:7-alpine` resolves to Redis **7.4.7**, which is offered under **RSALv2 or
SSPLv1**. Neither is OSI-approved. SSPL in particular carries service-source
obligations that a delivery platform should not discover after it has scaled.
Describing that image as "Redis 7 / BSD" — as this repository previously did —
was simply false.

**Valkey** is the Linux Foundation fork of Redis 7.2, **BSD-3-Clause**, and is
maintained by the people who wrote most of Redis. It is a drop-in for
everything Swift does with a cache.

## The one thing that makes this not a one-line change

**Valkey 8 cannot read Redis 7.4's data.** Measured, on the real images:

```
$ docker run -v <redis-7.4-volume>:/data valkey/valkey:8-alpine valkey-server --appendonly yes
7:M * Reading RDB base file on AOF loading...
7:M # Can't handle RDB format version 12
7:M # Error reading the RDB base file appendonly.aof.2.base.rdb, AOF loading aborted
$ docker inspect -f '{{.State.Status}} ({{.State.ExitCode}})' <container>
exited (1)
```

Redis 7.4 writes RDB format **v12**; Valkey 8 forked from Redis 7.2 and reads
up to **v11**. The logical paths fail for the same reason:

```
127.0.0.1:6379> MIGRATE <valkey-host> 6379 "otp:592700000" 15 5000 COPY REPLACE
(error) ERR Target instance replied with error: ERR DUMP payload version or checksum are wrong
```

`DUMP`/`RESTORE` carries the same version footer, so it fails identically.
**There is no binary migration path.** Valkey starts empty or it does not start.

If you point Valkey at the existing volume anyway:

1. Valkey exits 1.
2. `restart: unless-stopped` puts it in a crash loop.
3. The API's `redisPlugin` fails its startup `PING` and **Fastify refuses to
   register**, so the whole API is down — not degraded, down.
4. Everything in the old volume is still there, unreadable by the new server.

This is why the compose file names a **new volume** (`swift-valkeydata`) and
keeps `swift-redisdata` declared but unused. The old volume is the rollback.

## What is lost, and what is not

Starting empty loses the entire cache. Almost all of it is designed to be lost:

| State | Lost? | Consequence |
|---|---|---|
| OTP codes | yes | A code in flight stops working. The user requests another. |
| Rate-limit counters | yes | Everyone's budget resets. Generous, not dangerous. |
| Dispatch offer state | yes | The offer is re-made on the next dispatch pass. |
| Socket.IO adapter state | yes | Clients reconnect; the adapter rebuilds. |
| Driver/rider location + online marks | yes | Rewritten within one heartbeat. |
| Recurring jobs (`repeat:` crons) | yes | **Re-registered from code on boot.** Nothing to do. |
| **Delayed BullMQ jobs** | **yes** | **See below. This is the whole risk.** |

### The delayed jobs are the risk

`drainCheckoutOutbox` publishes an outbox row to BullMQ, then marks it
`processedAt`. The claim query is `WHERE "processedAt" IS NULL`. So **a
published job is never published again** — if it is lost from Redis, nothing
retries it.

The job that matters is `auto-cancel`:

```ts
autoCancelDelayMs: (holdMin + slaMin) * 60_000
//  holdMin = ORDER_HOLD_MINUTES (5 when LIFECYCLE_V2=1, else 0)
//  slaMin  = vendorResponseSlaMinutes() — DEFAULT 10, CONFIGURABLE TO 1440 (24h)
```

An order whose `auto-cancel` never fires **is never released**: the customer
waits on a vendor who has gone home, and no other code path corrects it.

So the window is not a constant you can look up — it depends on
`order_auto_reject_minutes` in `platform_config`. **Measure it.**

## Preflight

```bash
node deploy/valkey-preflight.mjs              # reads REDIS_URL
node deploy/valkey-preflight.mjs redis://host:6379/0
```

No dependencies — it speaks RESP over a socket, so it runs on a host with
nothing installed. Exit codes:

| Exit | Meaning |
|---|---|
| **0** | GO. Nothing delayed, waiting or active on any queue. |
| **1** | WAIT. It prints what is outstanding and when the last job fires. |
| **2** | The check could not run. **This is not a GO.** |

## Cutover

1. **Stop accepting new orders.** Maintenance mode, or scale the API to zero.
   The worker keeps running — you want the queues to drain, not freeze.
2. **Run the preflight until it exits 0.** Re-run, don't estimate. The longest
   outstanding job is usually an `auto-cancel` and the tool tells you when it
   fires.
3. **Stop the old cache**, leaving its volume alone:
   ```bash
   docker compose -f deploy/docker-compose.yml stop redis    # pre-migration name
   ```
4. **Bring up the new stack.** `docker compose up -d` creates
   `swift-valkeydata` empty and starts `valkey`.
5. **Prove it is healthy before letting traffic in:**
   ```bash
   docker compose exec valkey valkey-cli PING                # PONG
   docker compose exec valkey valkey-cli INFO server | grep valkey_version
   docker compose ps                                         # api/worker healthy
   ```
   The API will not report healthy unless its startup `PING` succeeded, so a
   healthy API *is* the proof that Valkey is serving.
6. **Re-open traffic.** The recurring crons re-register on worker boot; confirm
   with `valkey-cli --scan --pattern 'bull:*:repeat:*' | head`.

## Rollback

Rollback is intact at every step because **the old volume is never touched**.

```bash
docker compose stop valkey
git revert <this commit>          # restores the redis service + swift-redisdata
docker compose up -d
```

Redis comes back on `swift-redisdata` with its AOF exactly as it was at step 3.
Only whatever Valkey accumulated after the cutover is discarded — which is a
cache, and is rebuilt.

**Rollback is only clean while the old volume exists.** Do not remove
`swift-redisdata` until the cutover has held through at least one full billing
cycle.

### The rollback was rehearsed, not assumed

Against the real images, on a volume that a Valkey 8 start had already failed
on:

```
$ docker run -d -v swift-migration-drill:/data redis:7-alpine     redis-server --appendonly yes --appendfsync everysec
status: running        redis_version:7.4.7
keys recovered: 5 of 6
  dispatch:offers      -> order-a 1757280000  order-b 1757280060
  bull:billing:42      -> name weekly  attempts 1  timestamp 1757280000
  bull:billing:delayed -> 42 1757281000
  events:handover      -> 1 entry
  bull:billing:wait    -> 42
```

The sixth key was `otp:592700000`, written with `EX 600` twenty-one minutes
earlier. **It expired on schedule** — the TTL doing its job, not data loss.
Every key that was still meant to exist came back, and the failed Valkey start
had left the volume completely untouched.

## Compatibility evidence

Not asserted — measured against Valkey 8.1.10:

| Check | Result |
|---|---|
| Full API suite (516 files) against Valkey | **6 failing files; the same run against Redis 7.4 failed 13.** Every Valkey failure also fails on Redis, so none is attributable to Valkey. |
| Distinct commands exercised (captured with `MONITOR`) | **58 verbs, 13,187 calls, zero errors** |
| Lua | `EVAL` ×636, `EVALSHA` ×199 — script cache works |
| BullMQ | `BZPOPMIN`, `ZPOPMIN`, `RPOPLPUSH`, `LPOS`, `LREM`, `HINCRBY`, `XADD`, `XTRIM` |
| Socket.IO adapter | `SUBSCRIBE`, `PSUBSCRIBE`, `PUBLISH`, `UNSUBSCRIBE`, `PUNSUBSCRIBE` |
| Streams / sorted sets / rate limits | `XADD`, `XTRIM`; `ZADD`, `ZREVRANGE`, `ZCOUNT`, `ZSCORE`, `ZRANGEBYSCORE`; `INCR`, `EXPIRE`, `SETEX` |
| AOF crash recovery | `SIGKILL` mid-flight, restart: **all 7 key types recovered, TTL preserved (600 → 596)** |
| `maxmemory-policy noeviction` | honoured |
| `redis-server` / `redis-cli` | present as symlinks — the compose calls the `valkey-*` names anyway, so nothing depends on the shim |
| Image platforms | amd64, arm64, arm/v7, ppc64le |

## What this does not fix

`REDIS_URL` keeps its name. `redis://` is the wire protocol and the client
library is still ioredis, so renaming it would touch 200+ call sites to say the
same thing. Only the compose **service** is renamed, and the URL's host with it.
