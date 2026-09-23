# One-server staging pilot runbook

This is a reviewed repository procedure, not authorization to access or deploy
to any host. It applies only after the owner approves the named staging host,
DNS, exact main commit, and provider setup. The production API workflow remains
blocked. Keep the root session open until a separate key-only deploy-user SSH
session succeeds.

## 1. Prepare the staging host

Use an Ubuntu 24.04 host. Have its public DNS record point to the host before
starting Caddy. Transfer only the SSH **public** key to the host. In a root
session on the named staging host, use the approved repository remote and public
key path:

    REPOSITORY_URL='<approved-repository-remote>'
    PUBLIC_KEY_FILE='<path-to-deploy-public-key>'
    apt-get update
    apt-get install -y git
    git clone "$REPOSITORY_URL" /opt/swift
    /opt/swift/deploy/provision-ubuntu.sh "$PUBLIC_KEY_FILE"
    chown -R swift-deploy:swift-deploy /opt/swift

The provisioner checks free disk, creates or reuses the deploy account and
key, applies key-only SSH and UFW rules for TCP 22/80/443, enables security
updates and time sync, installs Docker Engine/Compose, PostgreSQL client tools
and AWS CLI, and creates swap only when needed. It checks active and saved UFW
rules, including IPv6 and rate-limited permits, and refuses extra permitted
ports for operator review. Docker membership grants root-equivalent host
access: grant the deploy
account to trusted operators only. Retain the root session, establish a fresh
SSH login as swift-deploy with its key, and check there:

    id
    docker compose version

In the retained root session, check:

    ufw status verbose
    timedatectl status
    swapon --show
    df -h / /var/lib/docker

The deploy user has no sudo grant by this script. Close the root session only
after the new SSH login works.

## 2. Place staging configuration

As swift-deploy on the host:

    cd /opt/swift
    ./deploy/gen-secrets.sh
    chmod 600 deploy/.env

Run gen-secrets.sh once. It refuses to overwrite an existing private file;
rotating MASTER_KEK without re-encrypting documents would lose access to them.
Place the generated MASTER_KEK in the owner-controlled off-host recovery vault.
Edit the private deploy/.env on the staging host through the approved secret
channel. Do not paste values into shell history, logs, Git, CI output, or this
runbook. The file must remain mode 0600 and owned by swift-deploy.

| Location | Names to set or verify |
| --- | --- |
| deploy/.env, host identity | PILOT_ENV=staging, API_HOST (staging DNS name only), CORS_ORIGIN, NODE_ENV, TRUST_PROXY |
| deploy/.env, bundled data | POSTGRES_USER, POSTGRES_DB, POSTGRES_PASSWORD, MEILISEARCH_KEY, MAPS_PROVIDER=osrm, OSRM_URL=http://osrm:5000 |
| deploy/.env, app authority | JWT_SECRET, OTP_HASH_SECRET, MASTER_KEK, MASTER_KEK_ESCROW_FINGERPRINT, STORAGE_SIGNING_SECRET, CONSENT_IP_PEPPER, plus the approved provider names from the external-services inventory |
| deploy/.env, private document bucket | STORAGE_PROVIDER, AWS_S3_BUCKET, AWS_S3_ENDPOINT, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_SSE |
| deploy/.env, separate backup bucket | BACKUP_BUCKET, BACKUP_PREFIX, BACKUP_RETAIN_DAYS, BACKUP_HEARTBEAT_URL; the backup runner uses the AWS names above |
| App/build configuration | EXPO_PUBLIC_API_URL, NEXT_PUBLIC_API_URL and similar public origin names belong in their client build environment, never in the server secret file |

The backup and document buckets must be separate and private. Ensure the
staging access identity can write and read the backup bucket. DATABASE_URL,
REDIS_URL, and MEILISEARCH_URL are assembled or set inside Compose; there is
no PostgreSQL, Redis, search, routing, or geocoder host port. Do not add one.
Do not use a production credential or live customer record for this drill.

The API's preflight uses workspace dependencies. If Node 20 and pnpm are
installed in the approved staging build environment, run these commands
against the exact checkout and staging configuration before a cutover:

    pnpm install --frozen-lockfile
    ./deploy/preflight.sh

Preflight forces a production posture and can intentionally refuse a staging
file with sandbox providers. Record that diagnostic; pilot-up uses the staging
file and must be checked against its own boot/readiness result. Preflight does
not prove provider credentials, seed data, object recovery, or real-device
flows.

## 3. Build routing data and deploy an exact revision

As swift-deploy, after the staging DNS record resolves and ports 80/443 reach
the host:

    cd /opt/swift
    ./deploy/setup-routing.sh
    APPROVED_SHA='<full-40-character-origin-main-commit>'
    ./deploy/pilot-up.sh "$APPROVED_SHA"

pilot-up.sh fetches origin/main, refuses a dirty checkout or a SHA outside
current origin/main, switches to that exact commit, pulls the versioned
infrastructure images, builds the API image, starts private dependencies,
checks OSRM through the private network, stops the old API/worker, runs
Prisma migrate deploy through the existing migrate service, starts API/worker
and Caddy, and waits for container plus public HTTPS /ready success. A failed
step exits nonzero. It never edits deploy-api.yml or launches production.
VROOM and the geocoders are opt-in profiles; enable them only after their data
and disk budget are reviewed. Their Compose file publishes no host ports.

Verify the exact revision and public entrance:

    git rev-parse HEAD
    docker compose -f deploy/docker-compose.yml ps
    docker compose -f deploy/docker-compose.routing.yml ps
    API_HOST='<staging-api-dns-name>'
    curl -fsS --resolve "$API_HOST:443:127.0.0.1" "https://$API_HOST/ready"
    API_URL="https://$API_HOST" ./deploy/doctor.sh

The /ready result is a dependency check, not a launch approval. Verify pilot
seed data, provider UAT, search indexing, real routing, flow tests, and
document recovery separately before inviting any user.

## 4. Start and verify off-site backups

From the retained root session after the deploy user can run Docker:

    install -m 0644 /opt/swift/deploy/swift-backup.service /etc/systemd/system/swift-backup.service
    install -m 0644 /opt/swift/deploy/swift-backup.timer /etc/systemd/system/swift-backup.timer
    systemctl daemon-reload
    systemctl start swift-backup.service
    systemctl status swift-backup.service --no-pager
    systemctl enable --now swift-backup.timer
    systemctl list-timers swift-backup.timer

The timer runs as swift-deploy and requires BACKUP_BUCKET and the R2/S3
endpoint and credentials. backup.sh runs pg_dump inside the private Postgres
container, checks the archive table of contents, uploads to the separate
bucket, checks the remote object length, and records a heartbeat. A successful
object-length check is still not a restore proof. Alert on a failed unit and a
stale backup heartbeat; prove the external heartbeat destination receives a
signal.

## 5. Restore drill, with no live overwrite

As swift-deploy, take a fresh backup and copy its object key from the
success output. Restore from the off-site object into a new scratch database:

    cd /opt/swift
    BACKUP_REQUIRED=1 ./deploy/backup.sh /var/backups/swift
    OFFSITE_OBJECT='s3://<backup-bucket>/<prefix>/<object-key>'
    SCRATCH_DB="swift_restore_$(date -u +%Y%m%d%H%M%S)"
    ./deploy/restore.sh "$OFFSITE_OBJECT" "$SCRATCH_DB"

The restore script accepts only a new lowercase scratch database name,
refuses an existing or live database, and fails on archive or row-count
errors. Record the actual elapsed time and inspect constraints and policies
in the scratch database. Restore an encrypted document from the separate
document bucket and verify it can be decrypted with the off-host MASTER_KEK
escrow copy; the database dump alone cannot prove this. Keep the scratch
database until the drill evidence is reviewed. A controlled cleanup then
uses a separately reviewed SQL DROP DATABASE command against that scratch
name only.

## 6. Rollback and incident boundary

Record the previous serving full SHA before each update. On a failed cutover,
pilot-up.sh leaves the old API/worker stopped if migration was reached. Inspect
logs without printing environment values:

    cd /opt/swift
    docker compose -f deploy/docker-compose.yml logs --tail=100 migrate api worker caddy
    docker compose -f deploy/docker-compose.routing.yml logs --tail=100 osrm

After confirming the new schema remains backward-compatible with the
previous binary, redeploy the previous approved main SHA:

    PREVIOUS_SHA='<full-40-character-previous-main-commit>'
    ./deploy/pilot-up.sh "$PREVIOUS_SHA"

Prisma migrate deploy does not roll back schema changes. If compatibility is
unknown or a destructive migration occurred, keep serving stopped, preserve
the failed state and off-site backup, and use a reviewed migration/restore
procedure. Never point restore.sh at the live database. No command in this
runbook authorizes a production cutover.
