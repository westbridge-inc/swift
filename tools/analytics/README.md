# Swift Analytics (Apache Superset)

Local, self-hosted **business-intelligence dashboards** for Swift — the SAP/PowerBI-style
"see the whole business" layer. Read-only. Complements the Swift Command app (which does
the *operational* work: approving documents, resolving tickets); this does *analytics*.

- **Themed Swift** — deep Indian-Red `#803B3B` on warm paper `#FBFBF9` (matches `packages/ui/tokens.ts`).
- **Read-only** — connects through the `superset_ro` Postgres role (SELECT-only). It can never
  change Swift's data.
- **Reproducible** — everything is in this folder. No manual clicking required to stand it up.

## Run it

```bash
cd tools/analytics
docker compose up -d          # first boot builds the image + migrates; ~2 min
open http://localhost:8088    # login: admin / admin  (change it under Settings)
```

Stop / reset:

```bash
docker compose down           # stop (keeps dashboards)
docker compose down -v        # wipe Superset's own metadata too (fresh start)
```

## What you get out of the box

- Database **"Swift (read-only)"** already connected.
- Datasets: `orders`, `subscriptions`, `users`, `vendors`, `earnings`.
- Dashboard **"Swift — Command Overview"** with live KPI tiles (orders, active subs, users, vendors).

Build more charts in ~5 clicks: **Charts → + Chart → pick a dataset → drag metrics → Save**,
then add them to any dashboard. That drag-and-drop, no-SQL flow is why Superset (over Grafana)
fits a business-metrics cockpit.

## How it connects (one-time, already done)

The read-only role was created on Swift's dev DB:

```sql
CREATE ROLE superset_ro LOGIN PASSWORD 'superset_ro';
GRANT CONNECT ON DATABASE swift TO superset_ro;
GRANT USAGE ON SCHEMA public TO superset_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO superset_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO superset_ro;
```

Superset (in Docker) reaches the host Postgres at `host.docker.internal:5434`, database `swift`.

## Notes

- The `SUPERSET_SECRET_KEY` default in `docker-compose.yml` is a **local-only** placeholder.
  Set a real one via env before using this anywhere but your laptop.
- This is a laptop/analyst tool. It is **not** part of the Swift runtime and ships nothing to
  production. For live infra metrics, Swift already exposes Prometheus `/metrics` (see
  `apps/api/src/plugins/observability.ts`).
