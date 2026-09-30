# Store alert delivery authority

Store alerts reach the active owner and current active staff. The first alert and both
re-ring jobs authorize each recipient again at inbox persistence and at outbound
handoff. A selected recipient list is not permission to deliver later.

## Revocation ordering

`withStoreAlertAuthority` locks the matching staff/user/store rows, or the
owner/user/store rows, with `FOR SHARE`. The inbox write commits in that same
transaction. Deletion, account changes and ownership changes therefore serialize
with the write.

For a socket or push, the transaction starts the actual emit or transport call
while those locks are held. Both promise handlers are attached immediately. The
transaction then releases its locks before waiting for the provider response.
The Expo adapter carries this callback to every chunk and retry, after its other
awaited checks. A deletion that commits first prevents handoff; a deletion waiting
on the locks commits after handoff. A message already handed off may arrive after
revocation and cannot be recalled by this code.

Authority reads have a four-second monotonic validity window and statement
timeout, inside a five-second transaction with a two-second acquisition limit.
The final check rejects a result that arrives after a process stall. Store-room
convergence likewise checks elapsed time before retaining or readmitting sockets.

## Rung ownership and expiry

The two-minute claim is renewed and checked by token before each handoff. Its
completion and cleanup also compare the token, so an old worker cannot overwrite
a replacement. The response deadline is checked after the final awaited guard,
including budget, membership and Redis work. Auto-cancellation need not have run.

Before the first handoff, an atomic Redis operation writes a separate submission
marker for one day. If a provider response or worker is lost, expiration of the
short claim does not authorize a new submission. The outcome is
`submission_unknown`. The next ladder rung remains the fallback. A crash between
writing that marker and starting transport can lose this rung; the provider call
and Redis write are not an atomic operation. These guards depend on retained Redis
state and do not establish exactly-once provider delivery.

The active worker may continue with distinct recipients/chunks after a successful
response. A proven push rejection or pre-connection failure may use the bounded
retry schedule, with fresh authority on each attempt. An ambiguous response stops
further submissions by that worker. SMS spend is refunded only when no call was
handed off or the provider proves non-submission; a timeout, lost response or
ambiguous provider failure keeps the spend. Provider network work remains bounded
by its adapter timeout and occurs outside membership transactions.

The first rung remains at 30 seconds. Hold/seen stopping rules, owner and staff
delivery, the separate SMS budget and tenant-scoped operator audience remain in
effect.

## Stop and destination ordering

Every rung fences its Redis claim before acquiring Order authority. The final
transaction locks the Order for share, rereads its status/hold and seen/read
receipts, and retains that lock through the actual socket/provider invocation.
Seen, acknowledgement, and inbox-read writes take the same Order for update;
canonical status transitions already do so. A stop committed during the Redis
await wins before handoff. A stop waiting behind the shared lock commits after
handoff and may commit while the provider response is pending. Operator inbox
inserts commit inside the same Order transaction.

The recipient or SMS destination rows are locked inside that transaction. Those
subordinate locks use NOWAIT so they cannot form a wait cycle with existing
User-before-Order or Order-before-Vendor writers. Contention fails closed. Generic
read-all captures its unread rows, locks distinct Order IDs in sorted order, and
updates only that set; a concurrently inserted notice remains unread.

SMS reserves a candidate number's budget, then validates the exact current
Vendor/Owner/User destination under the locks. An inactive owner cannot supply a
fallback phone. A replacement committed first prevents sending to the old number.
Only its unused reservation is refunded, and at most one fresh candidate is tried.
Continued changes or contention can return `not_submitted`, using the existing
three-retry job policy with a one-second offset. Only an attempt with zero actual
inbox/socket/provider invocations may remove its own claim and marker, in a
same-token compare-and-set. Partial or unknown submissions retain their marker
and cannot restart the whole rung. Later escalation jobs remain scheduled.

## Authoritative response cutoff

The durable auto-cancel outbox supplies its original `createdAt + delayMs`
cutoff, matching the queue drainer. Its delay already includes the hold and the
appointment policy. An earlier valid inbox deadline may narrow this window.
Legacy orders without that outbox retain an existing valid server-written inbox
cutoff; when neither exists they use the existing response-window policy. Thus
an absent or failed inbox write cannot disable expiry, and a subsequent SLA
configuration change cannot extend or truncate a stored timing snapshot.

Only currently eligible active same-tenant owners/staff can stop future pending
rungs with seen, acknowledged or read evidence. Historical inbox reading stays
available after removal, and historical receipts remain stored; they no longer
silence the remaining team. Answered order status is independently authoritative.
An ambiguous push after a socket handoff remains `submission_unknown`, including
when later recipients are suppressed; it is never described as a known stop or
restarted as a whole-rung retry.
