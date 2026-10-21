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
and creates swap only when needed (there is no host AWS CLI: the backup and
restore scripts run it inside a pinned container image). It checks active and
saved UFW rules, including IPv6 and rate-limited permits, and refuses extra
permitted ports for operator review. Docker membership grants root-equivalent
host access: grant the deploy account to trusted operators only. Retain the
root session, establish a fresh SSH login as swift-deploy with its key, and
check there:

    id
    docker compose version

In the retained root session, check:

    ufw status verbose
    timedatectl status
    swapon --show
    df -h / /var/lib/docker

The deploy user has passwordless sudo from this script
(/etc/sudoers.d/90-swift-deploy); gen-secrets.sh and pilot-up.sh use it for the
secret store below. Close the root session only after the new SSH login works.

## 2. Install the secret store and place staging configuration

Secrets never live in deploy/.env, in Docker's container configuration, in a
backup, in a log or in this repository. They are encrypted at rest on the host,
bound to that host, and reach the containers only as files on tmpfs
(deploy/swift-secrets and deploy/swift-secrets.service; the app reads
NAME_FILE=/run/secrets/NAME through apps/api/src/utils/secret-files.ts).

In the retained root session, install the store command and its boot unit:

    install -m 0755 -o root -g root /opt/swift/deploy/swift-secrets /usr/local/sbin/swift-secrets
    install -m 0644 -o root -g root /opt/swift/deploy/swift-secrets.service /etc/systemd/system/swift-secrets.service
    install -d -m 0755 -o root -g root /etc/credstore.encrypted/swift
    systemctl daemon-reload
    systemctl enable swift-secrets.service

systemd-creds ships with systemd 255 on Ubuntu 24.04; the host key
/var/lib/systemd/credential.secret is created on first use, root-only.

As swift-deploy on the host, generate the application secrets and the settings
file:

    cd /opt/swift
    ./deploy/gen-secrets.sh
    chmod 600 deploy/.env

gen-secrets.sh generates each value locally and pipes it on stdin into
`sudo swift-secrets set NAME`; it prints names only. It refuses to replace a
stored MASTER_KEK (`--missing` adds only names the store lacks; `--force`
rotates); rotating the key without re-encrypting documents would lose access
to them. An existing deploy/.env keeps its settings and loses any secret line
it still carries, whatever the spelling. Place the generated MASTER_KEK in the owner-controlled off-host
recovery vault: in the root session used for escrow only,
`systemd-creds decrypt --name=MASTER_KEK /etc/credstore.encrypted/swift/MASTER_KEK.cred -`
prints it once to that terminal. Edit the private deploy/.env (settings only)
through the approved channel. Do not paste values into shell history, logs,
Git, CI output, or this runbook. The file must remain mode 0600 and owned by
swift-deploy.

Provider secrets are entered by the owner from a Mac with
deploy/owner/swift-secrets-prompt.command (double-click, or run it with
`swift-deploy@<host> <key-path> NAME ...`): hidden input, confirmed once, sent
over SSH on stdin to `sudo swift-secrets set NAME`; it prints only `saved NAME`
and stores no host or key. Switch a provider on in deploy/.env together with
its wiring line `NAME_FILE=/run/secrets/NAME` (the template shows each one).
After any `set`, run `sudo systemctl restart swift-secrets.service` and restart
the app; pilot-up.sh does both and refuses a deploy/.env that declares a
secret, or a wired name that is not in the store.

| Location | Names to set or verify |
| --- | --- |
| encrypted store (`sudo swift-secrets list`; the store is root-only) | Created on the host by deploy/owner/emergency-policy-key.command (1, REQUIRED: the api is wired to it, so pilot-up refuses a deploy without it): EMERGENCY_POLICY_SIGNING_KEY. Generated by gen-secrets.sh (14): POSTGRES_PASSWORD, MEILISEARCH_KEY, JWT_SECRET, OTP_HASH_SECRET, MASTER_KEK, STORAGE_SIGNING_SECRET, CONSENT_IP_PEPPER, ATTRIB_SALT, IDENTITY_SALT, SCAN_IP_SALT, ADS_EVENT_SECRET, TEST_CONTROL_SECRET, METRICS_TOKEN, HEALTH_DETAIL_TOKEN. Owner-entered: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SWIFT_BOOTSTRAP_PASSWORD, and when a provider or feature is switched on TWILIO_API_KEY_SECRET, SMTP_PASS, MMG_API_KEY, MMG_PASSWORD, MMG_MKEY, MMG_MSECRET, MMG_CHECKOUT_SECRET_KEY, MMG_CHECKOUT_PRIVATE_KEY (a multi-line PEM: store it from its file, `sudo swift-secrets set MMG_CHECKOUT_PRIVATE_KEY < the-key-file`; the one-line owner prompt cannot carry it), PAYMENT_GATEWAY_KEY, PAYMENT_GATEWAY_SECRET, STRIPE_SECRET_KEY, AGENT_CASH_WEBHOOK_SECRET, GOOGLE_MAPS_API_KEY_BACKEND, SENTRY_DSN, CW_ALERT_WEBHOOK_URL, SERVICE_PROVIDER_CURSOR_SECRET, VELOCITY_KEY_SECRET, and SYSTEM_DATABASE_URL once the TEN-01 least-privilege login exists (the pilot database is single-role, so it stays unset). REDIS_URL may carry a password and is allowlisted; the pilot's Redis has none and Compose sets that credential-free endpoint itself. The full list is apps/api/src/utils/secret-files.ts; a host set up by an older gen-secrets.sh gets new generated names with `./deploy/gen-secrets.sh --missing` |
| deploy/.env, host identity | PILOT_ENV=staging, API_HOST (staging DNS name only), CORS_ORIGIN, NODE_ENV, TRUST_PROXY; optionally WEB_HOST (the website's DNS name, section 3b), WEB_ALIAS_HOSTS and WEB_ORDERING (the public names and the pre-launch switch, section 3c), and ADMIN_HOST and ADMIN_BASIC_AUTH_HASH (the admin console and its optional gate, section 3d) |
| deploy/.env, bundled data | POSTGRES_USER, POSTGRES_DB, MAPS_PROVIDER=osrm, OSRM_URL=http://osrm:5000 |
| deploy/.env, app settings | MASTER_KEK_ESCROW_FINGERPRINT (written by gen-secrets.sh), the approved provider names and identifiers from the external-services inventory (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, exactly one of TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID, MMG_MERCHANT_ID, SMTP_HOST, SMTP_USER, ...), and each switched-on provider's NAME_FILE wiring line |
| deploy/.env, private document bucket | STORAGE_PROVIDER, AWS_S3_BUCKET, AWS_S3_ENDPOINT, AWS_REGION, AWS_S3_SSE, AWS_ACCESS_KEY_ID_FILE, AWS_SECRET_ACCESS_KEY_FILE |
| deploy/.env, separate backup bucket | BACKUP_BUCKET, BACKUP_PREFIX, BACKUP_RETAIN_DAYS, BACKUP_HEARTBEAT_URL; the backup unit takes the two storage keys from the store itself |
| App/build configuration | EXPO_PUBLIC_API_URL, NEXT_PUBLIC_API_URL and similar public origin names belong in their client build environment, never in the server settings file |

The backup and document buckets must be separate and private. Ensure the
staging access identity can write and read the backup bucket. REDIS_URL and
MEILISEARCH_URL are set inside Compose; DATABASE_URL is assembled by the app
from the POSTGRES_* parts and the password file, so it exists nowhere on disk.
There is no PostgreSQL, Redis, search, routing, or geocoder host port. Do not
add one. Do not use a production credential or live customer record for this
drill.

### What the store protects, and what it does not

The store defeats the leaks that a plaintext env file invites: a copied or
backed-up deploy/.env, a repository or CI accident, `docker inspect` and the
container configuration Docker keeps on disk, process listings, logs, and
casual reads by any local account. Values exist in clear only on tmpfs, mode
0400 for the container runtime uid, and in the memory of the processes that
need them.

It does not defeat root on this host. The host has no TPM, so
systemd-creds binds the store to /var/lib/systemd/credential.secret, and a
full-disk snapshot together with root access recovers that key and, with it,
every stored credential. Treat disk snapshots and images of this host as
sensitive as the secrets themselves, and use only credentials that are
revocable and least-privilege: a Twilio API key with a spend cap rather than
the account token, a dedicated sending mailbox, bucket keys scoped to the two
buckets, sandbox or merchant credentials the provider can rotate on request.
Rotation is `swift-secrets set NAME` again (the previous encrypted version is
kept as NAME.cred.prev), a restart of swift-secrets.service, and a restart of
the app; revoke the old credential at the provider afterwards.

The API's preflight uses workspace dependencies. If Node 20 and pnpm are
installed in the approved staging build environment, run these commands
against the exact checkout and staging configuration before a cutover, as
root so the materialized files are readable:

    pnpm install --frozen-lockfile
    sudo systemctl restart swift-secrets.service
    sudo -E env PATH="$PATH" ./deploy/preflight.sh --secrets-dir /run/swift-secrets

Preflight runs the same secret-file loader as the server and then forces a
production posture; it can intentionally refuse a staging file with sandbox
providers. Without --secrets-dir the store-held names read as MISSING, which
is true of the file and not of the server. Record the diagnostic; pilot-up
uses the staging file and must be checked against its own boot/readiness
result. Preflight does not prove provider credentials, seed data, object
recovery, or real-device flows.

### The emergency-policy signing key (AUD-G7-023)

The SOS button dials the number in the market's emergency policy, which the
API serves at GET /public/emergency-policy. From app build 12 the phone trusts
a served number only when its Ed25519 signature verifies under a public key
pinned in the app (apps/mobile/src/lib/emergencyPolicyPins.ts); otherwise it
keeps the last policy that verified or its bundled numbers (Guyana 911, 912,
913). Builds 9-11 read only the unchanged v1 fields and are not affected.

The private key is EMERGENCY_POLICY_SIGNING_KEY. Each host (staging and
production) gets its OWN, created ON that host so nobody ever types, sees or
copies it:

1. On your Mac, double-click deploy/owner/emergency-policy-key.command (or run
   it with `swift-deploy@<host> <ssh-key-path>`). On the host, openssl draws 48
   random bytes straight into `sudo -n swift-secrets set
   EMERGENCY_POLICY_SIGNING_KEY`. It prints only `saved ...`, and refuses if
   the host already holds a key.
2. Deploy as usual. pilot-up refuses (before stopping anything) while the
   store lacks the key; production also refuses to boot without it.
3. Read the PUBLIC key the API prints at boot (not a secret):
   `docker compose logs api | grep 'public key to pin in the app'`. Send the
   `kid` and `ed25519` values from each host to the lane that pins them in
   emergencyPolicyPins.ts; that PR must merge before the app build that
   should use the served policy. Until a key is pinned, phones simply use
   their bundled numbers.

Rotation: pin the NEW public key and ship that app build first; only then
replace the host key (`openssl rand -base64 48 | tr -d '\n=' | sudo -n
swift-secrets set EMERGENCY_POLICY_SIGNING_KEY` on the host; the store keeps
the previous version); remove the old pin in a later build. Phones that never
got the new pin fall back to their bundled numbers, never to an unverified one.

## 3. Build routing data and deploy an exact revision

As swift-deploy, after the staging DNS record resolves and ports 80/443 reach
the host:

    cd /opt/swift
    ./deploy/setup-routing.sh
    APPROVED_SHA='<full-40-character-origin-main-commit>'
    ./deploy/pilot-up.sh "$APPROVED_SHA"

pilot-up.sh fetches origin/main, refuses a dirty checkout or a SHA outside
current origin/main, switches to that exact commit, refuses a deploy/.env that
declares a secret or a wired NAME_FILE whose name is not in the store,
re-materializes the store (`sudo systemctl restart swift-secrets.service`),
pulls the versioned infrastructure images, builds the API image, starts
private dependencies, checks OSRM through the private network, stops the old
API/worker, runs Prisma migrate deploy through the existing migrate service
(behind the secret-file loader), starts API/worker and Caddy, and waits for
container plus public HTTPS /ready success. A failed step exits nonzero. It
never edits deploy-api.yml or launches production.
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

## 3b. Serving the website on staging

The full website (apps/web) can run on this host at its own name, against this
host's API. It is optional and off until WEB_HOST is set; without it the stack
is exactly the API stack above.

1. DNS: in the swiftgy.com zone, add an A record `staging` pointing to this
   host's public IPv4 (the same address as the API's record), with the DNS
   provider's proxy OFF (DNS only). Caddy obtains the certificate itself over
   ports 80/443, which needs the record to reach this host directly.
2. In deploy/.env (settings only, never a secret):

       WEB_HOST=staging.swiftgy.com

   CORS_ORIGIN must include `https://staging.swiftgy.com`; the staging file
   already does. The site signs in with the API's HttpOnly cookies, and the
   API honours them only from an allowed origin. For printed QR codes and
   trip-share links to open this site rather than swiftgy.com, also set
   `APP_PUBLIC_URL=https://staging.swiftgy.com` (an API setting). While
   apps/web/src/site.config.ts still has unfilled company details
   ({{LEGAL_ENTITY_NAME}}, {{COMPANY_ADDRESS}}, {{COMPANY_PHONE}}), the site's
   build refuses; `WEB_ALLOW_SITE_TOKENS=1` lets the staging site build and
   show them unfilled. That is an owner decision, and never for a public site.
   The site's maps draw MapTiler's tiles with the owner's MapTiler browser key,
   `WEB_MAPTILER_KEY` (a build argument, NEXT_PUBLIC_MAPTILER_KEY in the image).
   It is public by design and restricted in MapTiler to the site's own names,
   but the owner still enters it at a hidden prompt, never in chat. Without it
   the built site draws no map tiles (it never falls back to OpenStreetMap's
   servers), and no pin can be placed on its maps; the build log says so.
3. Deploy as usual: `./deploy/pilot-up.sh "$APPROVED_SHA"`. With WEB_HOST set
   it builds `swift-web:<SHA>` from apps/web/Dockerfile for the same commit
   BEFORE anything is stopped (a site that fails to build leaves the running
   stack untouched), starts it once the API is ready, and waits until the
   container reports healthy and Caddy serves `https://$WEB_HOST/` on this
   host. The site needs no migration: it is stateless and only a client of
   the public API.

What the image is: Next's standalone server as a non-root user, with no
secret, no settings file, no volume and no published port; Caddy reaches it
on the private network. `https://$API_HOST` is fixed into it at build time
(the site's origin law accepts only the staging API for a staging build, so a
wrong API_HOST fails the build rather than shipping a site that calls the
wrong server). It sends its own security headers, plus `X-Robots-Tag:
noindex, nofollow` only on the staging name (every name except swiftgy.com and
www), so search engines never index the staging copy in the public site's
place. It is capped at 640 MB of memory; the build adds a few minutes and
roughly 2 GB of peak memory to a deploy.

Verify:

    WEB_HOST='staging.swiftgy.com'
    docker compose -f deploy/docker-compose.yml --profile web ps web
    curl -fsSI --resolve "$WEB_HOST:443:127.0.0.1" "https://$WEB_HOST/" |
      grep -iE '^HTTP|^content-security-policy|^x-robots-tag'
    ./deploy/doctor.sh

The content-security-policy line must name `https://api-staging.swiftgy.com`,
and the doctor prints an `ok` line for `website https://staging.swiftgy.com`
(a FAIL there names the status it got). Then, from a
phone or a laptop, open https://staging.swiftgy.com: browse stores, sign in
with a real SMS code, place an order, track it, and open the business
dashboard.

To limit the staging name to people who have a password, see 3e.

To turn the website off, empty WEB_HOST and rerun pilot-up.sh (Caddy stops
serving the name), then remove the idle container:

    docker compose -f deploy/docker-compose.yml --profile web rm --stop --force web

## 3c. Serving the public site from this stack (swiftgy.com and www)

Until a production stack exists, this stack can also answer the public names,
the way API_ALIAS_HOST lets it answer the API's public name. It is optional and
off until WEB_ALIAS_HOSTS is set, and it needs the website (WEB_HOST, 3b).

1. DNS: point `swiftgy.com` (the apex) and `www` at this host's public IPv4,
   proxy OFF, as in 3b. Caddy obtains a certificate for each name.
2. In deploy/.env (settings only, never a secret; space-separated, no quotes):

       WEB_ALIAS_HOSTS=swiftgy.com www.swiftgy.com
       WEB_ORDERING=

   pilot-up refuses a malformed name, a repeated one, or one equal to
   API_HOST, API_ALIAS_HOST or WEB_HOST (in any letter case), and aliases
   without a website, before anything changes.
3. Deploy as usual: `./deploy/pilot-up.sh "$APPROVED_SHA"`.

What the public names get:

- The same site from the same image as the staging name, so the same API
  (`https://$API_HOST`, with staging data) until a production stack exists.
- Indexing: the image marks only the staging name noindex. swiftgy.com and www
  send no `X-Robots-Tag`, except on the QR scan and MMG return links, which
  always carry their own.
- www answers with a 301 to the apex, from the website itself; the app-link
  files under `/.well-known/` stay on www unredirected, because the phone apps
  refuse a redirect there. Caddy adds no redirect of its own.
- The pre-launch front door until `WEB_ORDERING=live`: the home feed, store
  pages, cart, checkout, orders and the customer's account show "Launching
  soon in Georgetown"; the company, policy, pricing and partner pages stay
  visible. `WEB_ORDERING=live` (exactly that; pilot-up refuses anything else)
  opens ordering on the public names. The site reads it while it runs: change
  it, then recreate the website container (`docker compose up -d web`, or
  redeploy as usual); no rebuild is needed, and closing it again is the same
  one change. The staging name always keeps the full marketplace.

What the front door is: presentation-only. It decides what the website shows
on the public names. The API stays open to the apps, and to any API client, by
design; the door does not change who can place an order through the API.
Adding `https://swiftgy.com` to CORS_ORIGIN lets the public site's partner
sign-up and sign-in call the API from the browser; it does not open ordering on
the website, whose ordering pages still show "Launching soon" until
`WEB_ORDERING=live`.

Verify:

    for host in swiftgy.com www.swiftgy.com; do
      curl -fsSI --resolve "$host:443:127.0.0.1" "https://$host/" |
        grep -iE '^HTTP|^location|^x-robots-tag'
    done

Expect a 200 and no x-robots-tag line for swiftgy.com, and a 301 with
`location: https://swiftgy.com/` for www. In a browser, https://swiftgy.com
shows the front door until `WEB_ORDERING=live`.

To stop serving the public names, empty WEB_ALIAS_HOSTS and rerun pilot-up.sh.

## 3d. Serving the admin console on staging

The admin console (apps/admin) is where partner documents are approved and
rejected. It can run on this host at its own name, against this host's API.
It is optional and off until ADMIN_HOST is set; without it the stack is
exactly the stack above.

Who gets in: the console's own sign-in is a phone and the one-time code texted
to it, and the API admits only an account holding ADMIN or SUPER_ADMIN, on
every admin route. A document decision also needs a stated reason, and a
fraud-class rejection needs a second, different reviewer. The optional gate
below adds a password in front of that sign-in.

Use a separate browser profile for the console, used for nothing else. The
console and the website keep their sign-in in the same cookies on the API's
name, so in one browser profile a console sign-in also becomes the website's
session there (and the other way round): any page that browser opens on the
website would then act with admin rights.

1. DNS: in the swiftgy.com zone, add an A record `admin-staging` pointing to
   this host's public IPv4 (the same address as the API's record), with the
   DNS provider's proxy OFF (DNS only). Caddy obtains the certificate itself
   over ports 80/443, which needs the record to reach this host directly.
2. In deploy/.env (settings only, never a secret):

       ADMIN_HOST=admin-staging.swiftgy.com

   and add the console's origin to CORS_ORIGIN, keeping every origin already
   there (comma-separated):

       CORS_ORIGIN=<the current value>,https://admin-staging.swiftgy.com

   The console signs in with the API's HttpOnly cookies, which the API honours
   only from an origin in CORS_ORIGIN; pilot-up.sh refuses an ADMIN_HOST whose
   https:// origin is missing there, before anything changes. The API reads
   CORS_ORIGIN at boot, which this deploy restarts anyway.
3. Optional second gate (recommended while the console is on the internet):
   HTTP basic authentication on every page of the console, before its own
   sign-in. The owner chooses the password and makes its hash on their own
   Mac, so the password never leaves it:

       htpasswd -nBC 12 admin

   It asks for the password twice without showing it and prints
   `admin:$2y$12$…`. Only the part after `admin:` (the hash, never the
   password) goes into deploy/.env, in single quotes:

       ADMIN_BASIC_AUTH_HASH='$2y$12$…'

   The single quotes matter: without them Compose reads the `$` signs as
   variables. pilot-up.sh refuses anything but a quoted bcrypt hash of cost 10
   or more and never prints the value. The browser then asks for the user
   `admin` and that password; a password manager can keep it. Empty means no
   gate. To change the password, replace the hash and redeploy.
4. Deploy as usual: `./deploy/pilot-up.sh "$APPROVED_SHA"`. With ADMIN_HOST
   set it builds `swift-admin:<SHA>` from apps/admin/Dockerfile for the same
   commit BEFORE anything is stopped (a console that fails to build leaves the
   running stack untouched), starts it once the API is ready, and waits until
   the container reports healthy and Caddy answers
   `https://$ADMIN_HOST/login` on this host with 200, or with 401 when the gate
   is on. A console that answers without the gate it was configured with fails
   the deploy.

What the image is: Next's standalone server as a non-root user, with no
secret, no settings file, no volume and no published port; Caddy reaches it on
the private network and strips the gate's credential before it.
`https://$API_HOST` is fixed into it at build time (the build refuses anything
but an https origin). It sends its own security headers: a CSP with
`frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS and
`X-Robots-Tag: noindex, nofollow`.

Verify:

    ADMIN_HOST='admin-staging.swiftgy.com'
    docker compose -f deploy/docker-compose.yml --profile admin ps admin
    curl -sSI --resolve "$ADMIN_HOST:443:127.0.0.1" "https://$ADMIN_HOST/login" |
      grep -iE '^HTTP|^x-robots-tag|^referrer-policy|^www-authenticate'

With the gate on, the first line is `HTTP/2 401` and `www-authenticate` names
Basic; without it, `HTTP/2 200` with the console's own headers. Then, from a
laptop, open https://admin-staging.swiftgy.com (the gate's user and password
first, if it is on), sign in with an admin phone and its code, and open
Verification. Approve and reject a test document: a rejection names one of the
server's reason codes, and each decision is audited
(APPROVE_VERIFICATION_DOC or REJECT_VERIFICATION_DOC in the audit log).

Making the owner an admin: the console admits a phone whose account holds
ADMIN or SUPER_ADMIN. Once a SUPER_ADMIN exists (staging has one from its
seed), the only way to promote another phone is the two-person break-glass
ceremony in 6b, with the owner's phone as SEED_ADMIN_PHONE:
two different people each sign the printed request with their own key
(deploy/seed-approve.sh), and the operator promotes with both lines in
SEED_PROMOTION_APPROVALS. Nobody signs for someone else, and no private key
ever reaches the server. The promotion SETS that account's roles to
SUPER_ADMIN and CUSTOMER: a phone that is also a store, rider or driver on this
database loses those roles, so promote a phone that is not used as a partner
here. The owner then signs in with that phone and the code texted to it.

To turn the console off, empty ADMIN_HOST and ADMIN_BASIC_AUTH_HASH and rerun
pilot-up.sh (Caddy stops serving the name), then remove the idle container:

    docker compose -f deploy/docker-compose.yml --profile admin rm --stop --force admin

## 3e. A password on the staging website

The staging website (3b) can be limited to the people who have a password:
HTTP basic authentication on WEB_HOST, before any of its pages. It is
optional and off until WEB_BASIC_AUTH_HASH is set. The browser asks once for
the user `tester` and the password, then remembers them for that name.

What stays open without the password:

- The public names (WEB_ALIAS_HOSTS, 3c). swiftgy.com and www keep answering
  everyone: the stores' privacy-policy and account-deletion links point there.
- On WEB_HOST itself, MMG's payment returns under `/pay/mmg/` (MMG sends the
  payer back there in the middle of a payment; that page needs nothing else
  from the site) and the app-link files under `/.well-known/`. A path that
  climbs (`..`) is never one of them.
- The API's names and the admin console's name (the console has its own
  gate, 3d).

What asks for it: every other page on WEB_HOST, including "Continue on the
web" from the MMG return page and, while APP_PUBLIC_URL names the staging
site (3b), the QR codes and the trip and parcel links shared from staging.
Point APP_PUBLIC_URL at the public name if those must open without one.

1. Choose the password and make its hash on this host, as swift-deploy, with
   the Caddy image the stack already runs:

       docker run --rm -it --network none caddy:2.10 caddy hash-password --bcrypt-cost 12

   It asks for the password twice at a prompt that does not show what is
   typed, and prints only the hash (`$2a$12$…`). The password goes into that
   prompt and nowhere else: never into a command argument, a chat, a log, a
   ticket or git. Give it to testers the way you would hand over a key.
   A hash made the console's way (3d) works the same: `htpasswd -nBC 12
   tester` on your own computer, keeping only the part after `tester:`
   (a `$2y$12$…` hash).
2. Put the hash (never the password) in deploy/.env, in single quotes:

       WEB_BASIC_AUTH_HASH='$2a$12$…'

   The single quotes matter: without them Compose reads the `$` signs as
   variables. pilot-up.sh refuses anything but a quoted bcrypt hash of cost
   10 or more, and a hash without WEB_HOST, before anything changes, and it
   never prints the value.
3. Deploy as usual: `./deploy/pilot-up.sh "$APPROVED_SHA"`. With the password
   on, the website is ready when its container reports healthy, its app-link
   file `https://$WEB_HOST/.well-known/apple-app-site-association` answers
   200, and `https://$WEB_HOST/` answers exactly 401. A website that serves
   its home page without the password it was configured with fails the
   deploy. The last website line reads `WEBSITE READY at https://$WEB_HOST
   (exact SHA …; password gate on)`.

Caddy does the checking: the website's container never holds the hash, and
Caddy strips the password from each request it checked before passing it on.

Verify:

    WEB_HOST='staging.swiftgy.com'
    curl -sSI --resolve "$WEB_HOST:443:127.0.0.1" "https://$WEB_HOST/" |
      grep -iE '^HTTP|^www-authenticate'
    curl -sSI --resolve "$WEB_HOST:443:127.0.0.1" \
      "https://$WEB_HOST/.well-known/apple-app-site-association" | grep -iE '^HTTP'
    ./deploy/doctor.sh

The first prints `HTTP/2 401` and a `www-authenticate: Basic` line, the second
`HTTP/2 200`, and the doctor `ok    website https://staging.swiftgy.com → 401
(password gate on)`. Then, in a browser, https://staging.swiftgy.com asks for
`tester` and the password, and https://swiftgy.com still opens without one.

To change the password, make a new hash, replace the old one and redeploy.
To turn the password off, empty WEB_BASIC_AUTH_HASH and redeploy: the staging
name answers everyone again.

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
endpoint in deploy/.env, and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the
encrypted store: the unit declares them as LoadCredentialEncrypted= and systemd
hands them to backup.sh in a private credentials directory for the run. The
unit does not start until both are stored. backup.sh runs pg_dump inside the
private Postgres container (which reads its own password file), checks the
archive table of contents, uploads to the separate bucket, checks the remote
object length, and records a heartbeat. A successful object-length check is
still not a restore proof. Alert on a failed unit and a stale backup
heartbeat; prove the external heartbeat destination receives a signal.

The off-site upload and its byte-count verification run the AWS CLI inside a
pinned container image, because the Ubuntu snap-packaged CLI cannot start
under the unit's NoNewPrivileges=true hardening (and that hardening is never
weakened). Pin the reviewed image digest as AWS_CLI_IMAGE in deploy/.env
(see .env.deploy.example); backup.sh refuses to run while it is unset or still
a placeholder.

**Production (PILOT_ENV=production): hourly, encrypted to the owner's key.**
Every production dump is encrypted on the host (gpg; provision-ubuntu.sh
installs it, on an older host `apt-get install -y --no-install-recommends gpg`)
to the owner's OpenPGP public key before it is kept or uploaded; the plain dump exists only between pg_dump
and the encryption and is removed right after (and on any failure). The
owner's private key is never on any server, so the host cannot read its own
backups. Before the first production backup:

1. On the OWNER's own computer, once: `./deploy/backup-keygen.sh <folder>`.
   It asks for a passphrase at a hidden prompt (twice), prints the
   fingerprint, and writes `swift-backup-public.asc` (for the host) and
   `swift-backup-PRIVATE.asc`. The owner prints the private key, stores its
   text in the password manager (two offline copies), deletes the file and
   keeps the passphrase separately. Without it no production backup can be
   restored.
2. On the host, as root: copy ONLY the public key to a path outside the
   checkout, e.g. `install -m 0644 swift-backup-public.asc /etc/swift/backup-recipient.asc`,
   and set BACKUP_GPG_RECIPIENT_FILE (that path) and BACKUP_GPG_FINGERPRINT
   (the printed fingerprint) in deploy/.env, each on a plain line with no
   comment after the value (systemd keeps a trailing comment as part of it).
   pilot-up.sh refuses production without both, and runs `backup.sh
   --check-key` before it changes anything: the file must exist and hold
   exactly that one public key and no private key, the same proof every
   dump makes. Also set `BACKUP_MAX_AGE_HOURS=3`: the backup freshness alarm
   defaults to 26 hours (a nightly cadence), and pilot-up.sh requires 1–3 on
   production.
3. Install the HOURLY timer in place of the nightly one (staging keeps
   swift-backup.timer):

       install -m 0644 /opt/swift/deploy/swift-backup.service /etc/systemd/system/swift-backup.service
       install -m 0644 /opt/swift/deploy/swift-backup-hourly.timer /etc/systemd/system/swift-backup-hourly.timer
       systemctl daemon-reload
       systemctl start swift-backup.service
       systemctl enable --now swift-backup-hourly.timer
       systemctl list-timers swift-backup-hourly.timer

   The journal shows `encrypted → swift-<stamp>.dump.gpg … to the owner's key
   <fingerprint> only`. A run is ended after 50 minutes (TimeoutStartSec), so
   a hung dump fails visibly instead of silently skipping every later hour.
   pilot-up.sh refuses a production stage that starts the API unless
   swift-backup-hourly.timer is enabled and active, and doctor.sh reports it. Local copies are kept 2 days on production by default
   (BACKUP_RETAIN_DAYS); the off-site bucket is the history. The droplet's
   daily snapshots stay on as well.

## 5. Restore drill, with no live overwrite

Take a fresh backup through the unit (it holds the storage keys) and copy the
object key from its journal. Restore from the off-site object into a new
scratch database through a transient unit that receives the same two keys:

    cd /opt/swift
    sudo systemctl start swift-backup.service
    sudo journalctl -u swift-backup.service -n 20 --no-pager
    OFFSITE_OBJECT='s3://<backup-bucket>/<prefix>/<object-key>'
    SCRATCH_DB="swift_restore_$(date -u +%Y%m%d%H%M%S)"
    sudo systemd-run --pipe --wait --collect --uid=swift-deploy --gid=swift-deploy \
      -p SupplementaryGroups=docker -p WorkingDirectory=/opt/swift \
      -p "UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE" \
      -p LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred \
      -p LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred \
      /opt/swift/deploy/restore.sh --project swift "$OFFSITE_OBJECT" "$SCRATCH_DB"

On production the off-site objects are `.dump.gpg` and the host cannot
decrypt them: restore.sh refuses an encrypted dump. The drill runs from the
OWNER's computer instead:

    SWIFT_RESTORE_PROJECT=swift ./deploy/backup-drill.sh swift-deploy@<host> <ssh-key-file> 's3://<backup-bucket>/<prefix>/swift-<stamp>.dump.gpg'

It asks for the private key (paste the armored block) and its passphrase at
hidden prompts and keeps them only in a throwaway keyring for the run. The
host streams the encrypted object out (`restore.sh --fetch-encrypted`, with
the storage keys from the encrypted store), the owner's computer decrypts it
on the way through, and the plain dump goes straight back into
`restore.sh --project swift --compare-source -` on the host: a new scratch database, compared
with the live one. Nothing plain is written on the owner's computer. Pass is
the host's compare-source line and `RESTORE OK`, then `DRILL OK`. Before
anything is decrypted, the drill checks the object's first packets: public-key
session keys for the owner's key, followed directly by the encrypted data.
Anything else (a message with no encryption, one encrypted to a passphrase or
to another key) is refused, and the host receives nothing. The host makes the
same structural check before it streams an object out.

The drill compares the scratch restore with the LIVE database, row for row,
and the newest hourly object is up to an hour old. On a database that is
taking orders the two always differ, so after launch the drill passes only in
a quiet window: stop the API and worker (`docker compose -f deploy/docker-compose.yml stop api worker`),
run `systemctl start swift-backup.service` for a fresh dump, drill that
object, then start them again. Before launch (no API yet) it passes as is.

The restore script accepts only a new lowercase scratch database name,
refuses an existing or live database, and fails on archive or row-count
errors. The UnsetEnvironment property mirrors swift-backup.service: the two
`*_FILE` names deploy/.env wires for the containers would otherwise shadow the
credential directory systemd provides, exactly the trap the backup unit hit.
Record the actual elapsed time and inspect constraints and policies in the
scratch database. On a new or quiet database, add `--compare-source` (first
argument, before the object) to judge the copy against the live database it
came from instead of fixed minimums: in schemas public and swift_qr, every
table's row count and content checksum, column definitions and defaults,
row-level-security switches, policies, constraints, indexes, triggers,
function definitions, grants and sequence positions must match exactly, and
the script prints both summaries (the backup heartbeats in platform_config
are left out, since backup.sh writes them after the dump). A row written to
the live database since the dump is a mismatch, so run it right after the
backup. Restore an encrypted document from the separate document
bucket and verify it can be decrypted with the off-host MASTER_KEK escrow
copy; the database dump alone cannot prove this. Keep the scratch database
until the drill evidence is reviewed. A controlled cleanup then uses a
separately reviewed SQL DROP DATABASE command against that scratch name only.

## 6. Seed the platform spine (first SUPER_ADMIN)

The runtime image carries dist/ but no src/ or tsx, so the production spine
seed cannot run inside it. deploy/seed-production.sh builds the Dockerfile's
`build` stage and runs prisma/seed-production.ts in a one-off container that
loads the secret files (dist/boot/secret-files.js) and then spawns the seed in
the same process; DATABASE_URL is assembled in memory and never printed. It
refuses to run without the exact deployed full SHA, a deployment_identity row
in the database, and SEED_ADMIN_PHONE in the environment, and it removes its
container.

    cd /opt/swift
    SHA='<full-40-character-main-commit-pilot-up-deployed>'
    SEED_ADMIN_PHONE='+592…' ./deploy/seed-production.sh "$SHA"

The seed prints the plan diff before applying it. On a staging target
(development posture) it applies directly; a production target needs two
approvals by two different people (section 6b) and exits 2 with the request
to sign. No command here authorizes a production seed.

### 6b. Two-person approvals: each approver's own key

A production spine apply, and promoting a SUPER_ADMIN once one exists (a
break-glass change, on any target), need TWO approvals by two DIFFERENT
people. An approval is the person's own signature: each approver has an
Ed25519 key made on their own computer, the server holds only the public
halves, and so the server (or anyone operating it) cannot sign for anyone. A
name is never identity: a signature must verify under the key pinned for that
name, and two approvals need two different pinned keys.

What an approver signs is what they read: the request names, in words, the
database (its name, server and deployment), the configuration version and the
FX rate the seed records, the first admin's phone (its last four digits; the
request carries only the phone's hash) and every change, one line each (a
long value is shown by its start, its length and its digest). The server
rebuilds those words from the change it is about to make and refuses an
approval whose words differ by a single character. Approvals expire (24 hours
as printed, never more than 72 hours after the server ISSUED the request,
however late it is used) and are single-use, even when the plan turns out to
have nothing to change: each one used is recorded in the append-only
privileged-change audit, so replaying it is refused even after the data is
rolled back, in any encoding of the same signature (keyed on the signer and
the request, not the pasted text). Replacing the whole database with an older
backup would also bring back approvals consumed since; the expiry (72 hours
from issue at most) bounds that window.

1. Once per approver, on their own computer (choose a passphrase):

       ssh-keygen -t ed25519 -f ~/.ssh/swift_seed_approver -C <their-name>

   They send the operator only the public line
   (`~/.ssh/swift_seed_approver.pub`). The operator writes one line per
   approver, `<name> ssh-ed25519 AAAA…`, into a file outside the checkout
   and pins it in the store (public keys, but root-only there, so nobody can
   swap one):

       sudo swift-secrets set SEED_APPROVER_KEYS < ~/approver-keys.txt

2. The operator runs the change without approvals. It prints the request
   between two `-----` lines (stdout carries only the request) and exits 2
   (spine) or 3 (promotion):

       cd /opt/swift
       SEED_ADMIN_PHONE=+5920400001 ./deploy/seed-production.sh "$SHA" > ~/seed-request.txt

   The request goes OUTSIDE the checkout: the script refuses a checkout with
   any untracked file, and the shell creates the file before the script runs.

3. Each approver checks the request and signs it on their own computer. The
   script shows the database, the configuration and FX rate, the first
   admin's phone ending and every change, asks for `yes`, and prints one
   line, `{"approver":"…","request":"…","signature":"…"}`. It refuses a
   request that does not say these things in words, or that hides anything
   (control characters, lines after its `end`):

       ./deploy/seed-approve.sh <their-name> ~/.ssh/swift_seed_approver < seed-request.txt

   Never sign for someone else: the control is two people with two keys.
   SEED_APPROVE_YES is for the test suites only (they have no terminal): it
   stands in for the typed yes only when it equals this request's `nonce:`
   line, so a value left in a shell signs nothing else. Never set it.

4. The operator re-runs with both lines, against the same deployment (the
   request is bound to this database's fingerprint, which includes the
   Postgres server's address; a redeploy that recreates the Postgres
   container refuses both as APPROVAL_INVALID, and the ceremony restarts at
   step 2. It fails closed, never open):

       SEED_ADMIN_PHONE=+5920400001 \
       SEED_PROMOTION_APPROVALS='[<first line>,<second line>]' \
         ./deploy/seed-production.sh "$SHA"

   (`SEED_PLAN_APPROVALS` for a production spine apply.) It writes one audit
   row naming both approvers, plus one consumption row per approval.

5. Pass a new staging admin to the journeys: `LIVETEST_ADMIN2_PHONE=+5920400001`.

## 7. Rollback and incident boundary

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

## 8. Pilot journeys on staging (private instance)

The pilot journey suite (scripts/livetest, `--suite=journeys`) drives all 42
launch-proof journeys over real HTTP: signups, orders, dispatch, taxi, courier,
services, safety, money records and admin controls. It signs accounts in with
the dev OTP code, so it runs ONLY against a private instance:

- The public api behind Caddy never carries DEV_OTP_BYPASS or
  TEST_CONTROL_ENABLED. pilot-up.sh refuses a deploy/.env that gives it either.
- deploy/docker-compose.journeys.yml adds `api-journeys` (the public api's exact
  image, settings file and secret mounts, plus DEV_OTP_BYPASS=1 and
  TEST_CONTROL_ENABLED=1, with TEST_CONTROL_SECRET read from the encrypted
  store as a NAME_FILE) and the one-shot `journeys` runner. Both sit only on
  swift-pilot-private, publish no port and have no Caddy route.
- deploy/verify-journeys-isolation.py checks the rendered model: pilot-up.sh
  runs it on every cutover, and journeys-run.sh runs it before it starts
  anything. journeys-run.sh also proves on the live public route that
  /api/v1/test-control/identity answers 404 and the dev code is refused.
- The runner refuses by itself unless the target is private, answers
  /test-control/identity with an environment other than production, declares
  its data synthetic, and every phone it uses is in the +5920 range (below).
- api-journeys pins NOTIFICATION_PROVIDER, EMAIL_PROVIDER and PUSH_PROVIDER to
  `dev` (in memory, nothing leaves the process), whatever deploy/.env says. That
  does NOT cover the worker: api and api-journeys share ONE worker, and it runs
  jobs (vendor alert ladders, SOS pages, queue matches, billing notices) with the
  public provider settings. Once real SMS is on (Phase B) the worker texts the
  phones on file. So every phone the runner creates, files or sends to is in the
  never-a-subscriber +5920 range (a 0 after +592 is never a subscriber number;
  the roster uses the +59204 block), and the runner refuses to start if any
  leaves it (scripts/livetest/guard.ts, gate p). That range is the real
  safeguard; keep it.

After pilot-up.sh, the deployment_identity insert (environment `staging`) and
seed-production with SEED_ADMIN_PHONE=+5920400000, as swift-deploy:

    cd /opt/swift
    LIVETEST_ADMIN_PHONE=+5920400000 ./deploy/journeys-run.sh

Optional: a second admin (a seed-production break-glass promotion with two
approvals, e.g. +5920400001) passed as LIVETEST_ADMIN2_PHONE lets the
two-person admin cases run (refund settlement, settlement import, claim
settlement, fraud-class rejection); without one they are reported SKIP.

api-journeys exists only while the run lasts; the script removes it on exit.
Results land in ~/swift-journeys/<run id>/ (override with JOURNEYS_RESULTS_DIR):
journeys-result.json (per journey: PASS, FAIL or SKIP, the reason, every step
with its evidence, and the target's deploymentId, environment and buildSha) and
journeys-summary.md. The exit status is 0 when no journey failed, 1 when one
did, 2 for a harness error, 3 when the runner refused the target. Record each
journey's staging gate with the run id. Re-runs reuse the roster (accounts in
the +59204 block) and create new orders, bookings and rides; accounts a journey
must create afresh (signup, deletion, onboarding) come from +592049xxxx.

## 9. Production go-live: the TLS pin on api.swiftgy.com

The iOS and Android apps pin `api.swiftgy.com` (and its subdomains) to three CA roots: ISRG Root X1 and X2
(Let's Encrypt) and GTS Root R1 (Google Trust Services). See `NSPinnedDomains` in `apps/mobile/app.config.ts`
and `apps/mobile/plugins/withTlsPinning.js`. `apps/api/src/__tests__/domain-swiftgy-guard.test.ts` keeps both
naming the same host. Staging (`api-staging.swiftgy.com`) is a sibling domain and is not pinned.

Before the first production build ships, confirm the served chain ends at one of those roots:

```sh
openssl s_client -connect api.swiftgy.com:443 -servername api.swiftgy.com -showcerts </dev/null 2>/dev/null \
  | grep -E '^ *[0-9]+ s:|^ *i:'
```

The last issuer must be ISRG Root X1, ISRG Root X2 or GTS Root R1. A proxied host (for example, behind Cloudflare)
can be issued under a different root. In that case, a pinned app cannot reach the API until either the certificate or
the pins change, and changing the pins is an app update.

## 10. Taxi zone pricing: per-km rates and fixed fares

How a taxi trip is priced, in order:

1. **A fixed fare for the pair.** If the pickup and the dropoff resolve to two zones (in that direction) that have a
   fixed fare, that fare is the price. It replaces the formula and any per-km rate. A pair is one direction: the
   return trip is its own fare. A pair inside one zone is a flat fare for every trip within it.
2. **Otherwise, the market's formula** (`TAXI_RATES`: the base, the included kilometres, the rate per kilometre after
   them), with one change: if the pickup's or the dropoff's zone sets its own **taxi rate per km** (`taxiPerKm`),
   that rate is charged for every kilometre beyond the included ones. When both ends set one, the higher applies.
   The base and the included kilometres stay the market's. A stop on the way never sets the rate.

The owner ruled (1 Oct 2026) that airports price per kilometre, never as a fixed pair, because a fixed fare is unfair
to people who live near an airport. A fresh install's seed creates `cjia-airport` and `ogle-airport` at 295 a
kilometre and seeds no fixed fare.

Every change below is platform pricing. The request needs a stated reason (`x-swift-reason`, at least 12
characters). It first answers `202 APPROVAL_REQUIRED` with an approval id. A second admin approves it
(`POST /api/v1/admin/approvals/:id/decide`), then the admin who asked applies it
(`POST /api/v1/admin/approvals/:id/apply`), or uses the console's approvals queue. Only the founder on the default
tenant may do it, and each change writes its audit row in the same transaction. **A change prices new quotes only.**
A ride already requested keeps the fare frozen on its order, through to payment.

- **List** the fixed fares and the zones: `GET /api/v1/admin/zone-fares` returns `{ fares, zones }`. Each fare is
  shown with both zone names and its `id`.
- **Add** a fixed fare: `POST /api/v1/admin/zone-fares` with `{ "fromZoneId", "toZoneId", "fare" }`. The fare is a
  whole amount from 100 to 1,000,000 in the zones' currency. Both zones must be the operator's and in one market.
- **Change** one: `PUT /api/v1/admin/zone-fares/:id` with the same three fields. The pair must be the row's pair.
- **Remove** one: `DELETE /api/v1/admin/zone-fares/:id` with `{ "fromZoneId", "toZoneId" }`.
- **Set or clear a zone's per-km rate:** `PUT /api/v1/admin/zones/:id` with `{ "taxiPerKm": 295 }` (a whole amount
  from 1 to 10,000) or `{ "taxiPerKm": null }`. The change raises the zone's version.
- **Draw a zone the seed would also create** with its seed id, so a later seed run finds it rather than adding an
  overlapping copy: `POST /api/v1/admin/zones` with `"id": "cjia-airport"` (a lowercase slug).
- **Roll back** all zone pricing at once: set `FARE_ZONE_TABLE_KILL=1` and restart the API. Every ride then prices by
  the market's formula, with no fixed fares and no zone rates.

The console's **Zones** page shows the zones with their per-km rates and adds, changes and removes fixed fares.

The seed only creates rows; it never changes or deletes them. An install seeded before October still has the old
Georgetown Central ↔ South 2,000 pair until an admin removes it, and it gains the airport zones only by a seed run or
the admin calls above.

## 11. Audit evidence and retention authority

The current retention decision is a draft pending legal confirmation. The admin
audit trail (`audit_logs`) is permanent legal evidence. Sensitive access records
(`sensitive_read_logs`) have no approved expiry window or implemented legal-hold
release check. The daily `retention-sweep` deliberately retains both: every run
reports `audit_logs(permanent-evidence)` and
`sensitive_read_logs(policy-unapproved)` with zero deletions. Its completion log
includes each skipped class and reason. Adding an enabled registry clock does
not override these decisions. No purge executor membership is granted to the
API login or the ordinary retention worker. The API must use a non-owner,
non-superuser login with no replication or role-administration privilege; a
table owner can alter triggers. The role-contract cutover remains a separate
release gate.

The migration creates two NOLOGIN roles. `swift_audit_purge_owner` owns the
bounded SECURITY DEFINER functions and must have no members.
`swift_audit_purge_executor` can read the two trails and invoke those functions;
it cannot delete, update or truncate tables directly. Function grants inherited
from creation defaults are removed before granting this executor access.
The functions enforce an explicit batch of at most 1,000 IDs and a reason, but
do **not** determine retention eligibility or release legal holds. The admin
trail function is retained for isolated synthetic test cleanup; it is not an
approved live-data retention policy.

Do not provision an automated purge job yet. Before enabling sensitive-read
retention, obtain the approved configurable window and build a reviewed
legal-hold check and deletion receipt that commit with deletion. Separate that
job's sensitive-read authority from the permanent admin trail before granting
it access; the current executor covers both functions.

For a separately authorized maintenance executor, the database administrator
can grant `swift_audit_purge_executor` to a dedicated, least-privilege NOINHERIT
login provisioned outside the repository. That login must not be an API or
ordinary worker login, table owner, superuser, or member of
`swift_audit_purge_owner`. Use `GRANT swift_audit_purge_executor TO
<approved_maintenance_login>` with the actual reviewed login identifier. On the
dedicated connection, begin a transaction, run
`SET LOCAL ROLE swift_audit_purge_executor`, select only the approved explicit
IDs, invoke the relevant helper/function with the recorded authorization
reason, and commit. `SET LOCAL` ends the elevated role at commit or rollback.
Never grant the owner role. Revoke executor membership when the authorization
ends. This procedure does not authorize purging permanent evidence.

The migration's `rollback.sql` sidecar restores the exact previous trigger
bodies and clears the new function search-path settings. It restores the legacy
caller-setting authority, so roll back callers first and explicitly acknowledge
that change with `SET swift.audit_purge_rollback = 'restore-legacy-guard'` on the
same migration-runner connection before executing the sidecar. The sidecar
locks both trails and refuses while either purge role has members or the purge
function owner differs. It removes local purge functions, policies, grants and
the new sensitive-read TRUNCATE trigger. It drops unused roles; cluster-wide
roles with other database/object dependencies remain NOLOGIN with this
database's purge grants removed. Do not remove another database's role to make
rollback pass. Reset the acknowledgement after the rehearsal. Rollback cannot
restore rows already deleted.

## 12. The production host (PILOT_ENV=production)

The same scripts run the production host, a separate server. They never turn a
staging host into production. deploy/.env on that host says
`PILOT_ENV=production`. deploy/deploy.sh (the local and staging convenience
commands) then refuses everything but `logs` and `health`, before any docker
call: it builds whatever is checked out, with no pinned SHA and none of the
checks below, and `nuke` deletes the data volumes. It refuses the same when
deploy/.env sets NODE_ENV=production, in any spelling Compose reads, or when
the shell exports either as production. pilot-up.sh then also refuses, each
before the stack changes (the backup keys are read from the store after the
checkout moves to the requested SHA; everything else before that):

- any NODE_ENV but `production`;
- a served name (API_HOST, API_ALIAS_HOST, WEB_HOST, WEB_ALIAS_HOSTS,
  ADMIN_HOST) containing `staging`;
- documents on the host's disk (STORAGE_PROVIDER must be s3 or r2, and
  STORAGE_ALLOW_LOCAL must be unset) and WEB_ALLOW_SITE_TOKENS;
- a store without AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the backup
  keys);
- any BILLING_TOPUP_HOLD but exactly `1`: admin top-ups stay on hold in
  production (owner ruling, 8 Oct; the API refuses each one with 503
  TOPUP_ON_HOLD and records nothing);
- AGENT_CASH_WEBHOOK_SECRET or AGENT_CASH_WEBHOOK_SECRET_FILE set: partners
  pay the weekly fee only on the MMG checkout page, never through an agent or
  a Swift Number (the agent-cash webhook answers 503 without its secret);
- the launch lock (owner ruling, 13 Oct): until an attorney signs off,
  production takes no card payment and runs no ads. PAYMENT_PROVIDER must be
  exactly `disabled` and CARD_RAIL_KILL exactly `1`; CARD_RAIL_V2,
  CARD_RAIL_V2_DRAIN, CARD_RAIL_ENROLL and ADS_ENABLED must each be unset or
  `0`. Lifting it is a reviewed code change here and in the API's boot guard,
  never a deploy/.env edit;
- for the whole stack and `--no-public` (not `--data-only`), no address-search
  provider: `PLACES_PROVIDER=osm` with `PHOTON_URL=http://photon:2322` (the
  script then also starts the private Photon service from the routing file's
  geocoding profile, never Nominatim; its South America index is about 6.7 GB
  on first start), or `PLACES_PROVIDER=google` with
  `GOOGLE_MAPS_API_KEY_BACKEND_FILE=/run/secrets/GOOGLE_MAPS_API_KEY_BACKEND`
  (the owner's key in the store). The choice is the owner's. Every host also
  needs `MAPS_PROVIDER=osrm` and `OSRM_URL=http://osrm:5000` (road fares and
  ETAs; without them taxi and courier quotes are refused);
- any setting Compose fills from `${…}` that is also set in the operator's
  shell (Compose prefers the shell to deploy/.env, which is what every check
  reads), and the COMPOSE_* switches. Run it from a clean shell;
- DOCKER_HOST, DOCKER_CONTEXT or DOCKER_CONFIG in the shell (on any host), and
  on production a Docker context other than `default`: every docker call must
  act on this host's own daemon;
- a test-environment name (a label that is or starts uat, test, sandbox, dev,
  qa or demo) anywhere a staging name is refused;
- API_PUBLIC_URL other than `https://<API_HOST>` (storage links and card
  return pages are built from it); an APP_PUBLIC_URL that is not the public
  website's `https://` origin (every printed QR code and trip-share link
  names it); and a CORS_ORIGIN that is empty or has an entry that is not an
  `https://` origin of a public name (no http, localhost, address or
  wildcard), or is a staging or test name;
- for the whole stack, a served name that does not already resolve to this
  host, over IPv4 and IPv6 (`getent ahostsv4` and `getent ahostsv6` against
  `hostname -I`; an AAAA record left on the old host sends IPv6 clients and
  the certificate authority there): Caddy obtains the certificates, and the
  public names stay on the old host until DNS moves. The refusal names the
  record (A or AAAA), never the address, so a deploy log kept as evidence
  carries no address.

The website, when WEB_HOST is set, is built on the production channel
(SWIFT_WEB_CHANNEL follows PILOT_ENV), so it must call `https://api.<site
domain>`.

The API refuses to boot in production unless every provider is real or
explicitly off. Beyond the earlier guards:

- **MMG.** `MMG_DRIVER=live` with every credential and the verified
  reference round-trip, or exactly `MMG_DRIVER=disabled` with
  `MMG_CHECKOUT_ENABLED=0`. With MMG off and no live card rail, no partner
  has a way to pay, so EVERY partner's weekly fee is paused, whatever their
  billing method (cash included; ruling of 6 Oct): nothing is charged (not
  even prepaid balance), failed, dunned, suspended, nudged or churned, no
  "due soon" reminder or trial fee notice names a fee, and nobody's grace
  runs (each due fee's dunning clock is paused). The pause follows the
  server's switches only (the MMG driver, and the card rail: CARD_RAIL_V2=1,
  not killed, with a real provider accepted by this build's factory; unknown
  provider names and the card simulator never count), never
  anything a partner sets, so a partner can neither
  cause it nor dodge it. When a way to pay comes back, only the current week
  is billed: one fee covers the weeks nobody could pay and the week in
  progress (owner ruling, 5 Oct), whatever job runs first (billing waits
  until the resume has recorded it). Each pause and resume is in the audit
  log (BILLING_FEE_PAUSE_STARTED/ENDED, and BILLING_FEE_PAUSED/RESUMED per
  fee), and an admin sees the state and counts at
  `GET /api/v1/admin/billing/fee-pause`. A fee whose dunning clock could
  not be paused waits on its own after the resume, never anyone else's:
  the API logs each one at every tick ("could not pause this billing
  clock"), `awaitingRepair` counts this tenant's, and one that stays needs
  a person. The poller leaves every MMG row
  untouched, and any MMG call refuses with MMG_DISABLED.
  To switch MMG on, set `MMG_DRIVER=live` and `MMG_CHECKOUT_ENABLED=1`
  together (cash partners pay through the checkout page) and redeploy;
  turning a real card provider on also ends the pause, so do it only when
  partners can open the card pages (note the per-platform card switch: iOS
  is off unless switched on). While the launch lock below holds, production
  refuses a card provider outright.
- **OPS_ONCALL_PHONES.** One or more E.164 numbers, comma-separated. An
  unacknowledged SOS escalates to them by SMS.
- **Email.** `EMAIL_PROVIDER=smtp` with SMTP_HOST, SMTP_PORT, SMTP_USER,
  EMAIL_FROM and the SMTP_PASS secret (wired as SMTP_PASS_FILE).
- **The launch money rules.** `BILLING_TOPUP_HOLD` exactly `1`, and no
  AGENT_CASH_WEBHOOK_SECRET (nor its `_FILE`): the same two rules pilot-up.sh
  checks, held by the API itself however it is started (a hand-run compose,
  an old script). The refusal names the setting, never a value.
- **The launch lock.** No card payment and no ads until an attorney signs
  off (owner ruling, 13 Oct): the same settings pilot-up.sh checks above
  (PAYMENT_PROVIDER `disabled`, CARD_RAIL_KILL `1`, CARD_RAIL_V2,
  CARD_RAIL_V2_DRAIN, CARD_RAIL_ENROLL and ADS_ENABLED unset or `0`). The
  card rail's own production checks still run first, so a refusal names the
  real problem before the lock. The value-free preflight
  (`deploy/preflight.ts`) lists every one.

### Database first, before the providers and DNS

    cd /opt/swift
    ./deploy/pilot-up.sh --data-only "$APPROVED_SHA"

It runs every check above except DNS, starts Postgres, Redis, search and
routing, and applies the migrations. It never starts, stops or builds the
API, worker, website, console or Caddy, and it refuses outright while an
API or worker is running, or when Docker cannot say whether they are. Then
write the identity row the seed and the
purge tools bind to, once, as swift-deploy:

    docker compose -f deploy/docker-compose.yml exec -T postgres sh -c \
      'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
    INSERT INTO deployment_identity (id, "deploymentId", environment, "updatedAt")
    VALUES ('singleton', 'swift-production', 'production', now());
    SQL

The row also ties the database to the production posture: a production API
or worker refuses to start on a database without it, or whose row says
anything but `production`, and a process in any other mode (a deploy/.env
edited to NODE_ENV=development) refuses a database whose row says
`production`. pilot-up.sh refuses the same mismatches before it stops or
migrates anything: a staging host never deploys onto this database.

Before the API ever starts, the weekly-fee confirmation cutover must report
READY: apps/api/BILLING-CONFIRMATION-CUTOVER.md, step 3 (the versioned
backfill) and step 4 (the check). Until then billing stays BLOCKED: no
collection, no fee demand, no suspension. The backfill runs with tsx, which
the runtime image does not carry, so it runs in the seed's build-stage
container (section 6), never on a host install, through its own script:

    ./deploy/billing-cutover.sh "$APPROVED_SHA" 20260930180000-v1

It makes the seed's refusals (the exact clean SHA on origin/main, one plain
deploy/.env, nothing exported, this host's Docker, NODE_ENV=production on
production), refuses while the API or worker runs, reads the database name
and deployment from the database itself (its deployment_identity row must say
this host's PILOT_ENV), runs step 3, and reads step 4 back: it ends with
`BILLING CUTOVER READY …`, or fails naming the state and the missing count.
It is restartable: an interrupted run leaves BLOCKED and is run again.

Back up and rehearse the restore (sections 4 and 5: the owner's key, the
hourly timer and deploy/backup-drill.sh from the owner's computer, which
restores with `--compare-source`:
in schemas public and swift_qr it compares every table's row count and
content checksum, column definitions and defaults, RLS switches, policies,
constraints, indexes, triggers, function definitions, view definitions and
options (consent_current is a view), grants and sequence positions).

### The spine seed: a two-person ceremony

seed-production.sh on PILOT_ENV=production needs NODE_ENV=production,
SEED_FX_GYD_PER_USD (today's observed GYD per USD) in the environment, and a
database whose deployment_identity says exactly production (a staging host
seeds only a database that says exactly staging). The approvers' public keys
must be pinned first (section 6b, step 1).

1. The first run prints the plan, then the request to sign, and exits 2:

       SEED_FX_GYD_PER_USD=<rate> SEED_ADMIN_PHONE='+592…' ./deploy/seed-production.sh "$SHA" > ~/seed-request.txt

   (Outside the checkout, as in section 6b: an untracked file in it is refused.)

2. Each approver signs it on their own computer (section 6b, step 3).

3. The operator applies with both lines, with the same FX rate and phone
   (the request names both; a different one refuses both lines). While no
   SUPER_ADMIN exists, SEED_ADMIN_PHONE becomes the first one, in the signed
   plan's own transaction and audited with it: on production the first
   SUPER_ADMIN is minted only by a signed plan that names its phone, never
   without approvals. A phone that already holds SUPER_ADMIN changes nothing.

       SEED_FX_GYD_PER_USD=<rate> SEED_ADMIN_PHONE='+592…' \
       SEED_PLAN_APPROVALS='[<first line>,<second line>]' ./deploy/seed-production.sh "$SHA"

**Solo mode (owner ruling, 13 Oct): one approver while there is no second
admin.** Only for the seed that mints the FIRST SUPER_ADMIN (none exists, and
SEED_ADMIN_PHONE is set); anything else on production keeps two people.
SEED_APPROVER_KEYS may then pin just the one approver's key.

   a. Request: `SEED_SOLO=1` with the same command as step 1. The request says,
      in the words signed, that it is a one-person approval; it is valid for
      48 hours from issue, and the run prints from when it may be applied.
   b. The approver signs it on their own computer (section 6b, step 3).
   c. No earlier than 12 hours after the request was issued (the seed refuses
      an early run and says when it may run), and before it expires:

          SEED_SOLO=1 SEED_FX_GYD_PER_USD=<rate> SEED_ADMIN_PHONE='+592…' \
          SEED_PLAN_APPROVALS='[<the one line>]' ./deploy/seed-production.sh "$SHA"

      The approval is single-use, and its signed record (the request and the
      signature) is kept in the append-only audit with the seed; keep the
      request file and the line with the stand-up evidence too. If a
      SUPER_ADMIN appears before it runs, nothing lands and the approval is
      not used up.

   The owner's admin email (production): solo approval in the apps emails
   the owner, so the seed writes his email on the first SUPER_ADMIN's account
   (only if it has none; never over a different one, never one another
   account uses). It is personal data: at a and c the script asks for it at a
   hidden prompt on the terminal (or run `read -rs SEED_ADMIN_EMAIL; export
   SEED_ADMIN_EMAIL` first), and the same address must be used both times.
   Plain ASCII letters, digits and . _ % + - only. The request shows it
   masked, with its full sha256; at b, seed-approve.sh asks the approver to
   type the address he expects (hidden) and signs only if it has that digest.
   The request file and the signed line therefore carry the masked email and
   its digest: personal data. Keep them with the owner's private stand-up
   evidence only, never in tickets, chat, logs or the repository.

4. SEED_PLAN_SECRET is no longer used (approvals are the approvers' own
   signatures). If the production store still holds it, from 5 Oct, remove
   it, then confirm the list no longer names it:

       sudo rm /etc/credstore.encrypted/swift/SEED_PLAN_SECRET.cred
       sudo systemctl restart swift-secrets.service
       sudo swift-secrets list

### The first boot, before DNS moves

    cd /opt/swift
    ./deploy/pilot-up.sh --no-public "$APPROVED_SHA"

Production only. It runs every check above except DNS, stops the API and
worker, migrates, starts the API and worker, and waits until the API
container is healthy, the worker runs and `/ready` answers from inside the
API container. It ends with `API READY at exact SHA … (production, no public
address …)`. Caddy, the website and the console are never built or started,
and only Caddy publishes ports 80 and 443, so nothing is reachable from
outside. It refuses outright while Caddy is running (the names already
serve: use the whole stack), or when Docker cannot say whether it is. Stop
the two again with `docker compose -f deploy/docker-compose.yml stop api
worker` before another `--data-only` run, which refuses while they run.

### The whole stack

Once the owner's provider secrets are stored and wired (TWILIO_*,
SMTP_PASS_FILE, OPS_ONCALL_PHONES) and DNS points at this host, run
`./deploy/pilot-up.sh "$APPROVED_SHA"`. It ends with `PRODUCTION READY at
exact SHA …`. Then follow section 9 for the certificate chain.

## 13. The least-privilege database logins (TA-S0-003)

The API and worker can run on two runtime logins instead of the database
owner: `swift_app_login` (member of `swift_app` only; the tenant wall binds
it) and `swift_system_login` (`swift_app` and `swift_bypass_rls`; audited
system work only). Both are LOGIN, never superuser, BYPASSRLS, CREATEDB,
CREATEROLE or REPLICATION, and own nothing. `deploy/rls-logins.sh` creates
them on the host that runs the stack, as the deploy user, with Postgres up:

    ./deploy/rls-logins.sh fingerprint > ~/rls-target.json    # review it: cluster, database, migration, owner, two digests
    ./deploy/rls-logins.sh plan   --approved-target-file ~/rls-target.json
    ./deploy/rls-logins.sh apply  --approved-target-file ~/rls-target.json
    ./deploy/rls-logins.sh verify --approved-target-file ~/rls-target.json   # twice; identical output

- Every command prints one JSON line of names, counts, digests and a
  constant reason code. It never prints a password, and none travels in an
  argument or an environment variable.
- `apply` refuses before writing anything unless the database is exactly
  the approved target and every catalogue invariant holds (row security on
  and forced, the private QR schema closed to the app, the migrations' own
  revocations in place, no extra default grants, the two groups unchanged
  and owning nothing). It never repairs an existing role.
- The passwords are generated inside the tool, kept in the encrypted store
  (`RLS_LOGIN_SWIFT_APP_LOGIN`, `RLS_LOGIN_SWIFT_SYSTEM_LOGIN`) before either
  login exists, and the database receives only a SCRAM verifier. Each login
  must then sign in on a new connection (a wrong password refused first)
  before `DATABASE_URL` and `SYSTEM_DATABASE_URL` are written to the store.
  A run that stops halfway is finished by running `apply` again, with the
  same credentials; a re-run that finds everything done writes nothing.
- `verify` checks the approved target, so it holds only until the next
  migration. Later deploys run `./deploy/rls-logins.sh roles`: the same role
  and catalogue contract with both logins present, without the target pin.
- One run at a time (a lock). Rotation is not part of this tool.
- The store goes with the stack. Production's project (the commands above,
  with no `--project-name` or extra compose file) uses production's store
  and nothing else. Any other project (the Phase C rehearsal) must name a
  store of its own with both `--store-dir` and `--run-dir`, neither of them
  production's, and its own `--project-name` (never production's `swift`);
  a project that layers `docker-compose.yml` must end with
  `docker-compose.rehearsal.yml` (its own internal network). The tool
  refuses any other pairing before it touches anything.

### The contract posture on the stack, and the rehearsal before it

Phase C switches the API and the worker onto the two logins with one
`deploy/.env` change, after `apply` and `verify` hold: `TENANT_RLS_BIND=1`,
`TENANT_UNSCOPED_ACCESS=deny`, and no `TENANT_WALL_EXPAND_ATTESTED` line.
pilot-up then adds `deploy/docker-compose.wall.yml` to every Compose command.
That file gives the API and the worker `DATABASE_URL_FILE` and
`SYSTEM_DATABASE_URL_FILE` from the store, empties every owner part, and masks
the owner's password file inside their secrets mount; Postgres and migrate
keep the owner, which migrations need. Put no database `*_FILE` line in
`deploy/.env`, and write each of these settings unquoted (`TENANT_RLS_BIND=1`,
not `"1"`): pilot-up reads the text after `=` as it is.

Under `TENANT_RLS_BIND=1`, pilot-up refuses before anything is stopped or
migrated when unscoped access is not `deny`, when the expand declaration is
set, when `deploy/.env` sets `DATABASE_URL_FILE`, `SYSTEM_DATABASE_URL_FILE` or
`POSTGRES_PASSWORD_FILE`, when the store lacks either URL, or when the
database's cluster does not have both logins. After migrating it runs
`./deploy/rls-logins.sh roles` and starts nothing if that holds. The API
refuses to boot in production under the bind with the owner's password in its
process, a URL that is not the matching login, or two URLs naming different
databases, and its boot attestation refuses a login that is a superuser,
BYPASSRLS, a member of the owner of a walled schema or of anything in one, or
(for the request login) a member of `swift_bypass_rls`.

After Phase C production never goes back (owner ruling, 14 Oct): a production
pilot-up without `TENANT_RLS_BIND=1` is refused once the store holds
`RLS_LOGIN_SWIFT_APP_LOGIN`, `RLS_LOGIN_SWIFT_SYSTEM_LOGIN`, `DATABASE_URL` or
`SYSTEM_DATABASE_URL`, or the database's cluster has either login, and
`./deploy/doctor.sh` reports the same. A rollback is the previous compatible
image with the contract posture kept. Staging is unchanged unless its own
`deploy/.env` sets the bind.

The rehearsal, before the owner's go for Phase C, on the production host, as
the deploy user, once `./deploy/pilot-up.sh --data-only "$APPROVED_SHA"` has
built the API image and with production's database running:

    ./deploy/wall/phase-c.sh preflight "$APPROVED_SHA"   # read-only; start the stack first: a stopped API holds on /health
    ./deploy/wall/phase-c.sh snapshot  "$APPROVED_SHA"   # the BEFORE record of the live containers (one 0600 file in $HOME)
    ./deploy/wall/rehearsal.sh up "$APPROVED_SHA"
    ./deploy/wall/rehearsal.sh down     # removes only the rehearsal: its project, volumes, store and secrets
    ./deploy/wall/phase-c.sh proof     "$APPROVED_SHA"   # nothing left over, the live stack unchanged

and after the switch, `./deploy/wall/phase-c.sh verify "$APPROVED_SHA"` (the contract posture, the
roles, both boot lines, /health). Every step ends `PHASE-C <STEP> OK` or `HOLD: <n> check(s)`; a
HOLD stops Phase C.

`up` builds an isolated copy under its own Compose project (`swift-rehearsal`,
`deploy/docker-compose.rehearsal.yml`): an internal network with no route out,
its own volumes, its own freshly generated secrets in its own store, nothing
public. Production is only read: the four group roles without passwords, a
dump streamed straight into the copy, and the census. It checks the copy
matches its source in every catalogue field but the cluster id, runs `plan`,
`apply` and `verify` twice on the copy, then boots the real API and worker in
deny mode and requires both attestation lines from each (the system-login
line in production mode only), each process running and never restarted, and
no `TenantInUnboundTransactionError` or `FATAL` line. Then it checks the wall
itself through the copy's own logins, each on a new connection: the request
login, bound to no tenant, sees no walled row (`deploy/wall/walled-rows.sql`),
the system login sees the copy's rows, the request login cannot `ALTER` a
walled table and the system login cannot become the owner. Any step that does
not hold ends the run non-zero with `REHEARSAL FAILED at step: …`; `PASSED` is
printed only when every step held. It needs passwordless `sudo -n` for
`env … swift-secrets`, `test` and `rm`, and fails closed without it. Never
layer `docker-compose.rehearsal.yml` by hand.

Every provider secret the copy's processes are wired to read (as Compose
renders their settings) gets a fresh throwaway stand-in in the shape the API's
boot guards check (`deploy/wall/stand-in.sh`: PEM keys for MMG's checkout, one
fictional number for the SMS allowlist, a GUID for the card gateway key, URLs
on the `.invalid` domain); no real provider value is ever read. The names are
read from migrate, api and worker: a service that later reads its own `*_FILE`
secret gets no stand-in and refuses to boot, loudly. Once the copy's
API and worker have been started, their logs (the last 400 lines each,
redacted by `deploy/wall/redact-log.py`: secrets, tokens, passwords, keys,
phone numbers and e-mail addresses removed) are kept in
`$REHEARSAL_RESULTS_DIR`, else `~/swift-rehearsal/rehearsal-<UTC>/` (mode
0700), however the run ends, and the first 20 `FATAL` lines are printed in the
run's own output. On the production host these are boot logs of a copy of
production's database: delete that directory when the copy goes.

No journeys run on this copy: it holds production's personal data, and the
journeys sign synthetic accounts in with the development code, which never
touches a copy of production's data (coordinator ruling, 15 Oct). The
walled-login journeys run on the STAGING host instead, as the deploy user,
against a throwaway copy of staging's synthetic database in the same contract
posture, once pilot-up has built the API image for `$SHA`:

    LIVETEST_ADMIN_PHONE=+5920400000 ./deploy/wall/journeys-on-copy.sh "$SHA"

Staging is what the store reviewers use, and the copy is a second stack on
the same host. Run it only inside an announced hold on staging, never while
the owner is testing, and lift the hold only after the copy is gone, the
live staging `/health` answers and the build-9 compatibility smoke passes.

It refuses unless `deploy/.env` says `PILOT_ENV=staging` (and sets
`NODE_ENV=production` in no spelling), the live database says staging, and
the host has room for the copy beside the live stack (2 GiB of memory
available, and twice the database plus 2 GiB free on Docker's disk); then
`rehearsal.sh up` builds the walled copy (which must say staging too), the
copy's worker stops, and the journey roster's fixture fees are reset ON THE
COPY ONLY (`deploy/wall/fixture-fees.sql`). The roster's +5920 partners live
on staging for weeks, so their trials end and billing suspends them for an
unpaid fee. On the copy each gets the fresh 14-day trial a new partner is born
with, and a store that billing suspended gets back what billing took. No
payment, receipt, ledger or clock row is written. The script first proves the
target is the copy (another Postgres cluster than the live one, saying
staging) and prints counts only. Then a private `api-journeys`
(`deploy/docker-compose.journeys-copy.yml`: both logins, `TENANT_RLS_BIND=1`,
deny, no port, the copy's internal network only, uploads to a throwaway
store inside it) serves the journeys and runs the queues. The journeys: an
OTP sign-in (AUTH-01), a vendor route (VEND-02, VEND-05), a rider's and a
driver's profile (RIDE-01, TAXI-02), a dispatch offer (RIDE-02) and a cart
through checkout (CUST-01, CUST-02), every one PASS. A SKIP fails, except
the runner's SKIP whose executed steps all passed and whose only cases left
to the target are the ones the script names (an MMG pay link needs an SMS
step-up the copy cannot do). Then the system jobs `compliance-sample` and
`expiry-sweep`. The instance's own metrics must hold: the 95th-percentile
request time within 1 s, the pool never at its connection limit (the
instance's own limit, read inside its container before the journeys; a query in
flight at a sample is reported, not judged), tenant and non-tenant bindings ran,
and `nontenant_system_in_tx` = 0. The copy is removed however the run ends,
after its api, worker and api-journeys logs (the last 400 lines each, redacted)
are kept in the run's results directory
(`~/swift-journeys-copy/copy-<UTC>/copy-logs/`), with the instance's metrics
samples (`metrics/`, redacted) once sampling began, and the first `FATAL` lines are
printed, and `JOURNEYS PASSED` is printed only when every step held. The live staging API and database are only read. The copy has its own
freshly generated secrets, so staging rows encrypted under the live key do not
read on it; the journeys make their own accounts. Any failure is a stop:
Phase C does not go ahead, and the cause is fixed in code, never by loosening
the wall.

The copy holds production's personal data on the same host. Remove it with
`./deploy/wall/rehearsal.sh down` as soon as the rehearsal's checks finish,
and do not keep it across days: a deletion request honoured in production in
the meantime does not reach the copy.
