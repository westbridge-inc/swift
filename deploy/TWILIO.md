# Twilio SMS launch controls

Swift's backend sends OTP and alert SMS with a revocable Twilio API key. The
outbound contract is `NOTIFICATION_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`,
`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and EXACTLY ONE sender:
`TWILIO_FROM` (an E.164 phone number) or `TWILIO_MESSAGING_SERVICE_SID` (a
Messaging Service SID, `MG` followed by 32 lowercase hex digits). The API key
SID and secret are the HTTP Basic username and password; the Account SID
selects the account in the Messages URL. With `TWILIO_FROM` the adapter posts
`From=<number>`; with `TWILIO_MESSAGING_SERVICE_SID` it posts
`MessagingServiceSid=<sid>` and Twilio picks the sender from the service's
sender pool. Startup checks these formats locally, but cannot confirm that
Twilio assigned the number or service to this account. Setting both senders,
or neither, refuses to boot, as does a From value that is not E.164 or a
Messaging Service SID that is not `MG` + 32 hex. The master Auth Token is not
used for sending. If inbound webhook signature verification is added later,
give its Auth Token the separate name `TWILIO_WEBHOOK_AUTH_TOKEN` and keep that
value out of the outbound adapter.

The identifiers (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_FROM` and
`TWILIO_MESSAGING_SERVICE_SID`) are settings in the host's `deploy/.env`. The
Messaging Service SID is an identifier, not a secret, so it never enters the
encrypted secret store. The API key secret is entered into the host's
encrypted store with
`deploy/owner/swift-secrets-prompt.command` (or `sudo swift-secrets set
TWILIO_API_KEY_SECRET` on the host, value on stdin) and wired in `deploy/.env`
as `TWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET`; keep an
owner controlled password manager backup. Keep sandbox values in a separate
entry and use them only for local or staging work. Never place live values in
this repository, a local `.env`, mobile or browser builds, or chat. The
examples contain variable names only; production boot refuses an incomplete
Twilio configuration. `deploy/preflight.sh` reads a candidate env file (and
the store with `--secrets-dir`) and runs that same boot guard, but cannot prove
credentials are valid or that delivery is enabled at Twilio.

## Non-production: the recipient allowlist

On any deployment that is not production (staging, loadtest) the real Twilio
adapter texts **only** the numbers in `SMS_RECIPIENT_ALLOWLIST` (E.164,
separated by commas, spaces or new lines). A text to any other number is not
sent; the API answers as if it were, and the counter
`swift_sms_recipient_not_allowlisted_total` goes up (the number is never
logged). This keeps automated testers, crawlers and store reviewers from making
a test deployment text strangers.

- Store the list in the encrypted store (`sudo swift-secrets set
  SMS_RECIPIENT_ALLOWLIST`) and wire `SMS_RECIPIENT_ALLOWLIST_FILE=/run/secrets/SMS_RECIPIENT_ALLOWLIST`
  in the deployment's `deploy/.env`. Phone numbers are personal data: never put
  them in an env file, the repository or a ticket.
- **Empty or unset = SMS is OFF.** The boot log then says `SMS is OFF: no
  allowlisted recipients`; with a list it says how many numbers (never which).
  Check that line after every staging deploy.
- A malformed entry stops boot (the message gives its position, not its value).
- **Production refuses to boot** while either `SMS_RECIPIENT_ALLOWLIST` or its
  `_FILE` form is set, so this can never silently stop real users' codes.
- Known non-production property: an allowlisted number takes a real Twilio
  round trip (and gets the ordinary "couldn't send" error if Twilio fails),
  while any other number answers at once. On a test deployment the allowlist is
  the test team, so this is accepted; production has no allowlist at all.

## Messaging Service setup

A Messaging Service bundles a sender pool, its own geographic permissions and
compliance settings behind one stable SID, so the backend never hardcodes
which number it sends from and numbers can be added, replaced or retired
without a configuration change.

1. In the Twilio Console, open **Messaging → Services → Create messaging
   service** and give it a name (e.g. `swift-production`).
2. Add at least one **sender** to the service's sender pool: an owned Twilio
   phone number, and/or an **alphanumeric sender ID** where the destination
   allows it (verify Guyana support with Twilio before relying on one — some
   destinations reject alphanumeric senders outright).
3. Under the service's **Geo Permissions**, allow outbound messaging to
   **Guyana only** (+592) and leave every other country denied. This is the
   per-service enforcement of the account-level restriction below.
4. Copy the service SID (it starts with `MG`) and set
   `TWILIO_MESSAGING_SERVICE_SID=<sid>` in `deploy/.env`, leaving `TWILIO_FROM`
   unset — the boot guard refuses both being set at once.
5. Re-run `deploy/preflight.sh`, then send one controlled message to a known
   +592 handset before trusting the service in production.

Before enabling live sends, restrict Twilio outbound Messaging Geographic
Permissions to the approved launch destinations (Guyana uses +592) at both the
account level and the Messaging Service level; add other countries only after
launch approval. Set the provider account's available spending limit or alerts
and verify who receives those alerts. Swift's `OTP_PHONE_DAILY_CAP` (default 8),
`OTP_IP_DAILY_CAP` (default 100, unknown numbers per client IP),
`OTP_GLOBAL_DAILY_CAP` (default 5000, unknown numbers) and `OTP_KNOWN_DAILY_CAP`
(default 5000, existing verified accounts and admins) bound OTP volume. Safety
texts (a passenger's trip link and an emergency contact's confirmation code)
have a budget of their own that no login code can spend:
`SMS_SAFETY_SENDER_DAILY_CAP` (default 30 per account),
`SMS_SAFETY_RECIPIENT_DAILY_CAP` (default 10 from one account to one number)
and `SMS_SAFETY_DAILY_CAP` (default 2000 for the whole platform). None of these
caps every alert SMS: the SOS text to a verified emergency contact, on-call
pages and account notices are not budgeted. Every budgeted text (login,
step-up, trip link, emergency-contact code) is refused in the API for a number
outside the launch market before Twilio is called; the Twilio geo-permission is
the backstop for everything else, so an `OPS_ONCALL_PHONES` number outside the
+592 range receives nothing while it is Guyana-only. The worst case for one
Guyana day is the global cap plus the known cap plus the safety cap. Set all
three to explicit affordable numbers for the launch volume, then monitor
provider usage.

For rotation, create a new application API key, set its SID in `deploy/.env`
and its secret with `swift-secrets set` (the previous encrypted version is kept
as `TWILIO_API_KEY_SECRET.cred.prev`), run `sudo systemctl restart
swift-secrets.service`, restart the backend, verify a controlled delivery and
its logs, then revoke the old key. Roll back by restoring the previous secret
version only while that key remains active. If either secret is exposed,
revoke that key first and issue a replacement.
