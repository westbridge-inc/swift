# Phone test script: one iPhone, build 8

This script is for the owner's phone session on the test server. The iPhone runs **build 8** (commit `c950da9b`, TestFlight) against `api-staging.swiftgy.com`.

Most Phones-gate journeys need a second party: a store that takes your order, a rider who brings it, a driver who picks you up, a customer who orders from your store, or a provider who quotes your job. The **phone helper** (`deploy/phone-helper.sh`) plays that second party. It uses the test server's own test accounts and makes the same requests their apps would make. You hold one phone; the coordinator runs the helper and tells you when to tap.

Button names below are copied from build 8's code. Where a name is in quotes, it is exactly what the screen shows. Some small labels show in capitals on the phone. The label sources are listed at the end for the coordinator.

---

## Read this first (owner)

1. **Never tap "Yes — get help now".** It is the SOS confirm button, and in build 8 it **dials 911 for real** and raises a real safety alert. SAFE-01 below tells you exactly how far to go.
2. **Codes and PINs.** When the script says "read the code to the coordinator", type it into the chat. The helper needs it to play the other person. Don't share your own login code with anyone.
3. **One role at a time.** When you test as a customer, stay offline as a rider or driver: tap **Stop** on the mover screen. Otherwise the app could offer your own order to you.
4. **Be where the test is.** The helper puts its store, rider or driver right next to you, so you don't need to travel. It needs your approximate position once per session. Georgetown works best: the test accounts live there.
5. **Waiting is normal.** A new order is held for about **5 minutes** before the store sees it. The screen shows "Your order goes to {store} in m:ss". That is the free-cancel window, and it is part of the test.
6. **Stop anytime.** If a step looks wrong, stop and say what you see. The coordinator records it. A wrong step is a finding, not something to work around.

---

## Before the session (coordinator)

Run these on the staging host as the deploy user, when no one else is testing:

```bash
cd /opt/swift
export LIVETEST_ADMIN_PHONE=+5920400000        # the seed admin: only proves the private target
./deploy/phone-helper.sh start                 # host guard + the private api-journeys instance
./deploy/phone-helper.sh all status            # every helper account and what it holds
./deploy/phone-helper.sh all cleanup           # helper movers offline, helper stores closed and back home
```

**Get the owner's position.** Ask the owner to share it, or read it without writing anything:

- As a rider or driver: `SELECT "currentLat","currentLng" FROM riders WHERE "userId"=:uid` (or `drivers`).
- As a customer: `SELECT latitude, longitude FROM addresses WHERE "userId"=:uid AND "isDefault"`.

Then set it for the commands below:

```bash
OWNER=6.8013,-58.1551   # replace with the owner's latitude,longitude
```

Every command prints one `OK:` or `FAILED:` line, plus a JSON line with the ids. Everything is appended to `~/swift-journeys/phone-helper/<UTC date>.log`. Order, ride and job ids come from those lines. The owner's own store id and order ids come from the owner's rows, read-only (AX309's queries).

**What the helper is, and is not:**

- **Test accounts only.** It plays journeys roster accounts, all on `+5920…` numbers that no subscriber can hold:
  - customers C4 (orders), C7 (taxi passenger, identity-verified), C8 (parcel sender);
  - stores R1 "TEST-Kitchen-One" and R2;
  - riders DR1–DR4 (also couriers), drivers T1–T3;
  - provider SP1 "Joiner" (carpenter).
- **Real API, no shortcuts.** Every action is one real API request as that account, through the private `api-journeys` instance. That instance shares the database and worker with the public API the phone uses. There is no database write, no admin call and no test-control write. Its guard is the journeys suite's: private target only, not production, synthetic data, `+5920…` phones only.
- **Push banners.** A step the helper takes (for example, the store accepting your order) reaches the phone as a **live screen update and an inbox row, but no push banner**. By design, the private instance's own pushes go to an in-memory adapter. Banners the **worker** sends still arrive for real, such as a delivery offer to you as a rider. So does the store-escalation SMS.
  - An offer banner is titled "🛵 Order available nearby" (delivery or parcel) or "🚕 Someone nearby needs a pickup" (taxi). The offer card inside the app has its own top line; each journey below names it.
  - The worker sends offer banners only while the server's loud-alert switch is on (`ALERTS_LOUD=1`). With it off, the offer shows in the app with no banner.
- **Fixing mistakes.** `store close`, `customer cancel`, `customer cancel-ride` and `<mover> offline` undo what the helper started.
- **Sign-in pacing.** Each command signs in two test accounts with the dev code, and that sign-in is rate limited (5 a minute). When several commands run close together, one may pause about 15 seconds to respect the limit. That is expected.

At the end, whatever happened:

```bash
./deploy/phone-helper.sh stop    # all cleanup, then the private instance removed
```

---

## The 22 journeys at a glance

| Journey | You play | The helper plays | Can finish today? |
|---|---|---|---|
| AUTH-01 phone signup + OTP | new user | — | yes (AX309 steps) |
| AUTH-03 selfie gate | partner-to-be | — | yes (AX309 steps) |
| CUST-02 cash checkout | customer | store R1 + rider DR2 | **cash half yes**; MMG half no (MMG pay links are off) |
| CUST-05 pickup code | customer | store R1 | yes |
| VEND-01 store onboarding | store owner | — (coordinator approves in the admin console) | yes |
| VEND-02 accept → ready | store | customer C4 | yes, once your store is approved |
| VEND-03 MMG pay link | store | — | **no**: MMG pay links are off |
| RIDE-01 online + location | rider | — | yes, once your rider account is approved |
| RIDE-02 accept an offer | rider | store R1 + customer C4 | yes, once approved |
| RIDE-04 door handover | rider | store R1 + customer C4 | yes, continues RIDE-02 |
| TAXI-01 request + queue | passenger | driver T2 | yes, once your ID is verified (L2) |
| TAXI-02 accept → arrived | driver | passenger C7 | yes, in a Driver session once approved (see TAXI-02) |
| TAXI-03 PIN → start → complete | driver | passenger C7 | yes, continues TAXI-02 |
| TAXI-04 cash outcome / no-show | driver | passenger C7 | paid outcome yes; no-show only as a separate last ride |
| COUR-01 courier | courier (rider) | sender C8 | yes, once approved |
| SERV-01 provider onboarding | provider-to-be | — (coordinator approves) | yes |
| SERV-02 job → quote → complete | customer | provider SP1 | yes |
| MONEY-02 MMG rail | store | — | **no**: MMG pay links are off |
| SAFE-01 SOS + contacts | passenger | driver T2 | contacts yes; **SOS confirm no** (it dials 911) |
| SAFE-02 trip share | passenger | driver T2 | yes, during a taxi trip |
| NOTIF-01 push + inbox | any | rider offer (worker push) | yes |
| NOTIF-02 escalation SMS | store | customer C4 | yes, once your store is approved |

**Approvals you need, and who gives them.** Your documents for a store (VEND-01), a rider or driver account, or a provider profile (SERV-01) are reviewed by the coordinator in the **admin console**. Taxi requests also need a verified ID (L2) and a selfie on your account. The helper never approves anything.

**Suggested order (about 90 minutes):**

1. AUTH-01 and AUTH-03.
2. NOTIF-01 set-up.
3. CUST-05, then CUST-02.
4. SERV-02.
5. TAXI-01, including SAFE-02 and the SAFE-01 look.
6. After approvals: VEND-02 and NOTIF-02; RIDE-01, RIDE-02 and RIDE-04; COUR-01; then, in a Driver session, TAXI-02, TAXI-03 and TAXI-04, with the optional no-show ride last of all.
7. `stop`.

---

## AUTH-01, AUTH-03, VEND-01, SERV-01, RIDE-01

These need no second party. Follow AX309 (`deepseek-audits/AX309-phone-scripts-build8.raw.md`) for the exact screens and the coordinator's proof queries. After VEND-01, SERV-01 or a rider/driver onboarding, the coordinator reviews your documents in the admin console. That unlocks the store, rider, driver and provider journeys below.

---

## CUST-05 — pick up at the counter with your code

**What it proves:** a pickup order gets a 6-digit code that only you hold, and the store can hand the order over only with that code.

**Coordinator first:**

```bash
./deploy/phone-helper.sh store open --at $OWNER
# OK: R1 "TEST-Kitchen-One" is open and accepting at … ; order e.g. "R1 Plate" (… GYD)
```

**You:**

1. On **Home**, tap the search bar ("Restaurants, groceries, dishes…") and type `TEST-Kitchen`. Open **TEST-Kitchen-One**.
2. Tap the round **+** next to an item, then **View cart**.
3. In the cart, choose **Pickup**. Payment shows **Pay at the counter**. Tap **Place pickup order**, then **Track order**.
4. You'll see "Your order goes to TEST-Kitchen-One in m:ss". Wait for it to reach zero. The capital label "PICKUP CODE — SHOW AT THE COUNTER" and your code appear.

**Coordinator meanwhile:**

```bash
./deploy/phone-helper.sh store accept --wait 600      # takes the order when its hold ends
./deploy/phone-helper.sh store ready --order <order id from the line above>
```

**You:**

5. The screen changes to **It's ready.** and "SHOW THIS CODE AT THE COUNTER". Read the 6 digits to the coordinator.

**Coordinator:**

```bash
./deploy/phone-helper.sh store handover --order <order id> --code <the 6 digits>
```

**You:**

6. The order moves to **Picked up** or **Completed**.

**Pass:** the code appears only after the hold, the store needs it, and your screen follows every step.
**Fail:** the handover works without your code, the code never appears, or your screen gets stuck on a step the helper already passed.

**Cleanup:** none. The order is complete.

---

## CUST-02 — cash checkout, delivered to your door (cash half)

**What it proves:** a cash delivery goes from checkout to your door, and you give the rider your door PIN.

**Coordinator first:**

```bash
./deploy/phone-helper.sh all cleanup                               # only the helper rider will be online
./deploy/phone-helper.sh store open --at $OWNER
./deploy/phone-helper.sh rider accept --at $OWNER --wait 1200 &    # DR2 waits online near you for the offer
```

**You:**

1. Make sure you are **offline** as a rider or driver.
2. Open **TEST-Kitchen-One** (search `TEST-Kitchen`). Tap **+**, then **View cart**.
3. Choose **Delivery**. Check your delivery address. Payment shows **Cash on delivery**. Tap **Place order**, then **Track order**.
4. Wait out the hold ("Your order goes to TEST-Kitchen-One in m:ss").

**Coordinator meanwhile:**

```bash
./deploy/phone-helper.sh store accept --wait 600
./deploy/phone-helper.sh store ready --order <order id>
# the background rider accept prints: OK: DR2 accepted <order id>
./deploy/phone-helper.sh rider pickup --order <order id>
```

**You:**

5. Watch the timeline under "WHERE IT STANDS": **Accepted**, **Preparing**, **Ready for pickup**, **Rider assigned**, **Picked up**.
6. After **Picked up**, the screen shows "SHOW THIS CODE TO YOUR RIDER AT THE DOOR" and a PIN. Read it to the coordinator.

**Coordinator:**

```bash
./deploy/phone-helper.sh rider deliver --order <order id> --pin <the PIN>
```

**You:**

7. You see **Your order has arrived**. Tap **Rate this order** (or **Later**).

**Pass:** every status reaches your screen live, the PIN appears only after pickup, and the delivery closes with it.
**Fail:** a status never arrives, the PIN shows early, or the handover works with a wrong PIN.

**Not in this run:** the MMG half (MMG pay links are off on the test server).

---

## SERV-02 — a job from quote to completion

**What it proves:** you request a job, the provider quotes, you book a time, the provider confirms and completes it, and you rate it.

**You:**

1. On **Home**, tap **Services**. Pick the **Carpenter / joiner** category chip.
2. On **Joiner**'s card, tap **Request**. Describe the job (at least 10 characters). Tap **Send request**, then **View my jobs**.

**Coordinator:**

```bash
./deploy/phone-helper.sh provider jobs                               # shows the new job's id
./deploy/phone-helper.sh provider quote --job <job id> --amount 45000
```

**You:**

3. **My Jobs** does not update while you look at it: after each coordinator step, pull the list down and let go to refresh it. After the quote, the job shows **Quote received** and "Quote: $45,000".
4. Tap **Accept & book**. Pick a day and a time. Tap **Accept quote — {day} {time}**. It shows **Awaiting confirmation**.

**Coordinator:**

```bash
./deploy/phone-helper.sh provider confirm --job <job id>
```

**You:**

5. Pull down to refresh. The job shows **Time confirmed**. Tell the coordinator you see it.

**Coordinator**, only after the owner sees **Time confirmed**. The server also accepts completion before the time is confirmed, so running it early would skip that check:

```bash
./deploy/phone-helper.sh provider complete --job <job id>
```

**You:**

6. Pull down to refresh. The job shows **Completed**. Under **Rate the work:** tap the stars. You see **Thanks!**.

**Pass:** each step shows after a refresh, and only you can book and rate.
**Fail:** a step is still missing after a refresh, or the booking or rating is refused without a clear reason.

---

## TAXI-01 — the queue, then a real request (you are the passenger)

**Needs:** your account's ID verified (L2) and a selfie. Otherwise the screen shows **Verify your ID — takes a minute** or **Add your photo — your driver sees it**. That result is itself worth recording.

**Queue branch.** The coordinator runs `./deploy/phone-helper.sh all cleanup` so that no helper driver is online. Then you:

1. **Home**, then **Taxi**. Set **Pickup** and **Where to?**.
2. If **Join the queue** appears, tap it. You see **You're in line**. Tap **Leave the queue**.

**Request branch.** The coordinator first:

```bash
./deploy/phone-helper.sh driver accept --at $OWNER --wait 900 &    # T2 online next to you
```

Then you:

3. Tap **Request {class} · {fare}** (or **Request ride**). You see "Finding your driver". The background command prints `OK: T2 accepted <ride id>`.

**Coordinator:**

```bash
./deploy/phone-helper.sh driver arrive --order <ride id>
```

**You:**

4. The banner reads **Your driver is here**. The capital label "SAY THIS CODE TO START THE RIDE" shows your PIN.
5. Now do **SAFE-02** and the **SAFE-01** look (below) before the trip ends.
6. Read the PIN to the coordinator.

**Coordinator:**

```bash
./deploy/phone-helper.sh driver start --order <ride id> --pin <the PIN>
./deploy/phone-helper.sh driver finish --order <ride id>               # cash paid, at the drop-off
```

**You:**

7. The trip starts, then ends.

**Pass:** the queue works with no drivers; with a driver, the request is taken, the arrival and PIN reach you, and the trip closes.
**Fail:** the request shows success with no driver, the PIN is missing, or the trip is stuck.

**If you stop early:** tap **Cancel ride** on your phone. The coordinator then runs `./deploy/phone-helper.sh driver offline`.

---

## SAFE-02 — share the trip, then stop sharing (during TAXI-01)

1. With the ride active, tap **Share trip** and the iPhone share sheet opens. Send the link only to yourself, for example as a note. The page's host must be the test deployment; if unsure, skip opening it.
2. Open the link in Safari. You see **Swift — live trip** with your trip.
3. Back in the app, tap **Stop sharing**. Reload the page. It shows **This trip share is no longer available**.

**Pass:** the page shows the live trip, and stopping kills the link.
**Fail:** the link still works after stopping, or the page shows made-up trip details.

**Guardian monitoring** needs a trip in progress. Once the coordinator has run `driver start` (TAXI-01 step 6), check the trip screen for any monitoring view. Record what you see.

---

## SAFE-01 — emergency contacts, and the SOS button (look only)

- **Emergency contacts:** follow AX309. You need a real person who agrees to receive one test text. The helper cannot receive texts.
- **SOS during a trip:** with the helper driver assigned (TAXI-01), check that **Emergency — get help now** is on the trip screen. Tap it; the sheet **Get emergency help?** opens. **Tap Close.** Do **not** tap **Yes — get help now**: in build 8 it dials 911 and raises a real alert.

The fan-out part of SAFE-01 (the alert reaching your contacts) stays **not run** until you decide to drill it with the safety team warned.

---

## VEND-02 — your store accepts an order (after your store is approved)

**You first:** Profile, then **Switch app** (or the **Earn with Swift** card), then **Swift Business**, then **Orders**. The store must show **Open for orders**.

**Coordinator:** read your store's id (`vendors.id` for your owner row), then:

```bash
./deploy/phone-helper.sh customer order --store <your store id> --pickup
# OK: C4 placed <order id> … ; the store sees it after <time>
```

**You:**

1. After the hold, the full-screen "NEW ORDER · CHIME REPEATS UNTIL YOU ANSWER" appears. Tap **ACCEPT ORDER**.
2. On the board, tap **Start preparing**, then **Ready for pickup**.
3. **Open the order card** (tap it). Don't use the board's own **Mark picked up**: it sends no code. The order screen shows "HANDOVER CHECK".

**Coordinator:**

```bash
./deploy/phone-helper.sh customer codes --order <order id>     # prints: pickup code NNNNNN
```

**You:**

4. Type the 6 digits the coordinator reads you. Tap **Mark picked up**.

**Pass:** the alert rings, each step moves the order, and the handover needs the customer's code.
**Fail:** the order never alerts, a step does nothing, or the handover works without the code.

---

## NOTIF-02 — the store alert escalates to SMS (after your store is approved)

1. Close the Swift app completely (swipe it away). Keep the phone on.
2. **Coordinator:** `./deploy/phone-helper.sh customer order --store <your store id> --pickup`
3. Don't touch the phone. When the hold ends (about 5 minutes), the store is alerted. If nobody answers, a **real SMS** reaches your own phone number about 2 minutes later: "Swift: order {number} is still waiting for your response. Open your dashboard now."
4. Open the app, accept the order (VEND-02 steps 1–2), then finish it with the code, or ask the coordinator to cancel: `customer cancel --order <order id>`.

**Pass:** the SMS arrives while the alert is unanswered.
**Fail:** no SMS after 5 minutes past the hold.

---

## RIDE-02 and RIDE-04 — take a delivery offer and hand it over at the door (after your rider account is approved)

**Coordinator first:**

```bash
./deploy/phone-helper.sh all cleanup                  # no helper rider competes with you
./deploy/phone-helper.sh store open --at $OWNER
```

**You:**

1. **Switch app** (on the customer **Profile** it is the **Earn with Swift** card), then **Swift Driver**. The top of the screen must say **Swift Rider**: only a rider is offered deliveries. (If it asks **How are you working today?**, tap **Deliver orders**. If it says **Swift Driver**, stop and tell the coordinator.) Tap **GO**. You see **You're online**. Stay on this screen.

**Coordinator:**

```bash
./deploy/phone-helper.sh customer order --store <R1 id from store open> --at $OWNER   # express: no hold
./deploy/phone-helper.sh store accept --wait 120
```

**You:**

2. The offer card appears. Its top line reads "EXPRESS · BIGGER FEE", because the helper's order is an express one. A push banner "🛵 Order available nearby" may arrive too. Tap **Accept delivery**. That is RIDE-02.
3. Open the **ACTIVE JOB** card. Tap **I'm on the way to pick up**, then **I've arrived at pickup**.

**Coordinator:**

```bash
./deploy/phone-helper.sh store ready --order <order id>
```

**You:**

4. Tap **Picked up the order**, **I'm on the way to the customer**, then **I've arrived at the customer**. The door is next to you.

**Coordinator:**

```bash
./deploy/phone-helper.sh customer codes --order <order id>    # prints: door PIN NNNN
```

**You:**

5. At "HANDOVER CHECK", type the PIN the coordinator reads you. Tap **Confirm payment & hand over**. That is RIDE-04.

**Pass:** you are offered the job, each step moves it, and the handover needs the customer's PIN and your GPS at the door.
**Fail:** no offer, a step refused without a reason, or a handover that works with a wrong PIN.

**Board grab:** build 8's labels show offers, not a jobs board. If you see a board of open jobs, take one and record it. Otherwise record board grab as not found.

---

## COUR-01 — carry a parcel with photo proof (you are the courier; after approval)

**You:** online as a rider (**GO**; the top of the screen says **Swift Rider**).

**Coordinator:**

```bash
./deploy/phone-helper.sh all cleanup
./deploy/phone-helper.sh customer send --at $OWNER --to <a point about 1 km away>
```

**You:**

1. The offer card appears; its top line reads "NEW DELIVERY REQUEST". Tap **Accept delivery**.
2. Open the **ACTIVE JOB** card.
3. Tap **I'm on the way to pick up**, then, at the pickup, **I've arrived at pickup**.
4. The screen says "The sender pays: collect {fee} BEFORE taking the parcel". Tap **Collected {fee} from the sender**. No real money changes hands in this test.
5. Tap **Capture pickup photo & confirm pickup** and take a photo.
6. Tap **I'm on the way to the customer**, then, at the drop-off, **I've arrived at the customer**.
7. Tap **Capture proof & deliver** and take a photo.

**Pass:** both photos are required and saved, the fee is collected once, and the parcel ends delivered.
**Fail:** a step works without its photo, or the fee is asked for twice.

**If you'd rather be the sender:** tap **Send** on Home and create the parcel. The coordinator runs:

- `courier accept --at $OWNER --wait 600`
- `courier collect --order <id>`
- `courier deliver --order <id>`

---

## TAXI-02, TAXI-03, TAXI-04 — drive a ride (after your driver account is approved)

**You need a Driver session.** **Swift Driver** is one work screen for both delivery and taxi work. At the top, next to **OFFLINE** or **LIVE**, it says which one you are in: **Swift Driver** (taxi) or **Swift Rider** (delivery). Only **Swift Driver** is offered rides.

- Go to the mover screen (from the customer **Profile**: **Earn with Swift**, then **Swift Driver**) and read the top.
- If it asks **How are you working today?**, tap **Drive taxi rides**.
- If it says **Swift Rider**, this account opens as a rider, and build 8 has no switch to taxi work. Use a separate account whose driver application the coordinator approved: tap the round person button at the top right, then **Log out**, and **Log out** again to confirm (this also takes you offline). Sign in with the driver account's phone number, as in AUTH-01, and go to the mover screen again.
- Don't use **Change vehicle** to switch. It changes your saved vehicle and its papers, and a new vehicle is checked again before you can go online.
- No approved driver account? Record TAXI-02, TAXI-03 and TAXI-04 as not run.

**You:** when the top says **Swift Driver**, tap **GO**, and stay on the screen.

**Coordinator:**

```bash
./deploy/phone-helper.sh all cleanup
```

Before asking for a ride, check that the owner really is online as a driver, read-only: `SELECT "isOnline" FROM drivers WHERE "userId"=:uid` must be `true`. If it is not, stop: the owner is not in a Driver session (a Rider session is never offered a ride). Then:

```bash
./deploy/phone-helper.sh customer ride --at $OWNER --to <a point about 2 km away>
# OK: C7 requested ride <ride id> …; the passenger PIN is NNNNNN
```

**You:**

1. The offer card appears; its top line reads "NEW RIDE REQUEST". A push banner "🚕 Someone nearby needs a pickup" may arrive too. Tap **Accept ride**, open the **ACTIVE JOB** card, then tap **I'm on the way**, then **I've arrived**. That is TAXI-02.
2. Type the PIN the coordinator reads you, then tap **Verify rider PIN**. You see **Code accepted — locked in.** Tap **Start trip**, then **Fare collected — complete trip**. That is TAXI-03 and TAXI-04 (paid).
3. **Trip complete** appears. Tap **Rate passenger** or **Skip**.

**Pass:** each step moves the ride, a wrong PIN is refused, and the fare closes the trip.
**Fail:** a step refused without a reason, or the trip starts without the PIN.

**No-show (TAXI-04), a separate last ride.** **Passenger didn't pay** is on the screen only while a trip is under way, so it needs a second ride. It puts a strike on the passenger test account C7, which the journeys need for taxi rides. Do it only as the very last check of the session, and only if the coordinator agrees.

**Coordinator:**

```bash
./deploy/phone-helper.sh customer ride --at $OWNER --to <a point about 2 km away>
# OK: C7 requested ride <second ride id> …; the passenger PIN is NNNNNN
```

**You** (still online, the top still says **Swift Driver**):

4. A new offer card appears ("NEW RIDE REQUEST"). Tap **Accept ride**, open the **ACTIVE JOB** card, then tap **I'm on the way**, then **I've arrived**.
5. Type the new PIN the coordinator reads you, then tap **Verify rider PIN**, then **Start trip**.
6. Do **not** tap **Fare collected — complete trip**. Tap **Passenger didn't pay**, then **Left without paying**. A message starting "Unpaid fare recorded" appears.

**Pass:** each ride ends with exactly one outcome: the first paid, the second unpaid.
**Fail:** **Passenger didn't pay** is missing while the trip is under way, or either ride stays open.

The claim that follows is settled by two admins in the admin console, not on the phone.

**If you stop early:** `./deploy/phone-helper.sh customer cancel-ride --order <ride id>`.

**Cleanup:** when you are done, tap **Stop**. You see **You're offline**.

---

## NOTIF-01 — notifications on, a real banner, the inbox

1. Allow notifications when the app asks (**Turn on**). If already allowed, nothing shows; that is fine.
2. For a **real push banner**, use an event the worker sends. The cleanest is a delivery offer to you as a rider (RIDE-02 step 2) with the app in the background; its banner reads "🛵 Order available nearby". Tap the banner; it should open the offer or order.
3. Open **Profile**, then **Notifications**. The title is "Notification". Rows from the session are there. Tapping an order row opens its tracking screen.

**Pass:** the device registers, a worker banner arrives and opens the right screen, and the inbox matches.
**Fail:** no banner for a worker event, or inbox rows that don't match what happened.

---

## Label sources (for the coordinator)

All paths are in build 8 (`c950da9b`), under `apps/mobile/src/` unless they start with `apps/`.

**Checkout and tracking**
- `Restaurants, groceries, dishes…` — modules/shop/screens/HomeScreen.tsx:518
- `Add to cart · {price}` — MenuItemScreen.tsx:478
- `View cart` — kit/cart-bar.tsx:99
- `Delivery` / `Pickup` — modules/cart/screens/CartScreen.tsx:589
- `Cash on delivery` / `Pay at the counter` — modules/cart/cartPayment.ts:89-93
- `Place order` / `Place pickup order` — CartScreen.tsx:1032
- `Track order` — CartScreen.tsx:1141
- hold `Your order goes to {store} in {m:ss}` — kit/hold-ring.tsx:151, DeliveryScreen.tsx:782
- timeline — modules/orders/screens/DeliveryScreen.tsx:117-242
- pickup code — DeliveryScreen.tsx:1284-1324
- door PIN — DeliveryScreen.tsx:1351-1354
- `Your order has arrived` — DeliveryScreen.tsx:1587

**Store**
- `Switch app` — the sheet's title, components/RoleSwitcherSheet.tsx:146; shown as a control in the store app's header (modules/vendor/shared.tsx:632) and on the mover Account screen (modules/mover/screens/MoverAccountScreen.tsx:231). On a signed-in customer Profile the visible entry is `Earn with Swift`; modules/profile/screens/ProfileScreen.tsx:136 is the guest-only row.
- `Earn with Swift` — ProfileScreen.tsx:424
- `Swift Business` — components/RoleSwitcherSheet.tsx:50
- `ACCEPT ORDER` — modules/vendor/NewOrderTakeover.tsx:210
- `Start preparing` / `Ready for pickup` — modules/vendor/shared.tsx:35-36
- `HANDOVER CHECK` / `Mark picked up` — modules/vendor/screens/VendorOrderDetailScreen.tsx:253, 545
- the board's code-less `Mark picked up` — defined at modules/vendor/shared.tsx:45, rendered by modules/vendor/screens/VendorOps.tsx:259-266

**Rider**
- `GO` / `You're online` — modules/mover/screens/MoverHomeScreen.tsx:721, 742
- `Accept delivery` — MoverHomeScreen.tsx:272
- `ACTIVE JOB` card — MoverHomeScreen.tsx:911-916
- leg steps — lib/riderLeg.ts:23-27
- `Confirm payment & hand over` — modules/mover/screens/ActiveJobScreen.tsx:999
- `Stop` / `You're offline` — MoverHomeScreen.tsx:755, 742
- `Swift Rider` / `Swift Driver` at the top of the mover screen — MoverHomeScreen.tsx:702
- which side opens: live work, then the one online profile, then the remembered side — lib/moverProfile.ts:66-80; GO remembers it (apps/api/src/modules/rider/rider.routes.ts:673, apps/api/src/modules/driver/driver.routes.ts:417)
- `How are you working today?` / `Deliver orders` / `Drive taxi rides` — only for an account with both sides and nothing remembered: MoverHomeScreen.tsx:362, 344, 350, 483-491
- offer card top line `Express · bigger fee` / `New delivery request` / `New ride request` (capitals on the phone) — MoverHomeScreen.tsx:143; the helper's delivery order is express (apps/api/src/modules/order/order.service.ts:1274), its parcel is not (apps/api/src/modules/courier/courier.routes.ts:231)
- offer banner titles, sent only when `ALERTS_LOUD=1` — apps/api/src/modules/dispatch/dispatch.service.ts:1629-1637; banners show with the app open too — services/push.ts:15-22
- the round person button (`Account`) — modules/mover/screens/MoverHomeAccountButton.tsx:12, 33; `Log out`, which goes offline — MoverAccountScreen.tsx:266, 38; its confirm `Log out` — kit/logout-confirm.tsx:80
- `Change vehicle` — MoverAccountScreen.tsx:213; it moves the account between sides by changing the vehicle — apps/api/src/modules/partner/partner.service.ts:300

**Taxi**
- driver steps — ActiveJobScreen.tsx:59-62, 757-782
- rides are offered to drivers only — apps/api/src/modules/dispatch/dispatch.service.ts:144-146
- `Passenger didn't pay` (only while the trip is under way) / `Left without paying` — ActiveJobScreen.tsx:780-787, 1118; `Unpaid fare recorded` — ActiveJobScreen.tsx:430-436; the server takes a fare outcome only during the trip — apps/api/src/modules/cash/cash-rules.service.ts:298-308
- `Trip complete` / `Rate passenger` / `Skip` — ActiveJobScreen.tsx:1259, 1268, 1276
- `Request {class} · {fare}` — modules/movement/screens/TaxiScreen.tsx:717
- ride PIN — TaxiScreen.tsx:829-866
- `Share trip` / `Stop sharing` — TaxiScreen.tsx:1480, 1509
- the trip page `Swift — live trip` / `This trip share is no longer available` (no full stop on the page) — apps/web/src/app/trip/[token]/trip-share-client.tsx:94, 107; the API's own message (apps/api/src/modules/safety/safety.routes.ts:320) is not shown
- SOS — TaxiScreen.tsx:1469, 1600-1645
- the 911 dial — modules/safety/SosCeremony.tsx:124-125, lib/emergencyPolicy.ts:51

**Courier**
- pickup and customer arrival steps — lib/riderLeg.ts:23-27; ActiveJobScreen.tsx:809-835
- sender collection becomes available at pickup — ActiveJobScreen.tsx:360, 828-834
- `Collected {fee} from the sender` — ActiveJobScreen.tsx:829
- `Capture pickup photo & confirm pickup` — ActiveJobScreen.tsx:831
- `Capture proof & deliver` — ActiveJobScreen.tsx:937
- sender-pays only — modules/movement/screens/CourierScreen.tsx:203

**Services**
- `Request` / `Send request` — modules/services/screens/ServicesScreen.tsx:242, 302
- `Quote received` / `Accept & book` / `Accept quote — {day} {time}` — ServiceJobsScreen.tsx:20, 245, 66
- `Quote: $45,000` — ServiceJobsScreen.tsx:219 with lib/money.ts:22
- `Awaiting confirmation` / `Time confirmed` / `Completed` — ServiceJobsScreen.tsx:233, 23
- pull to refresh — ServiceJobsScreen.tsx:326; the open list has no polling or live update — hooks/services.ts:81-83
- completion is accepted before the time is confirmed — apps/api/src/modules/services/services.routes.ts:527
- `Rate the work:` — ServiceJobsScreen.tsx:94

**Inbox**
- `Notification` — modules/profile/screens/NotificationsScreen.tsx:61

The solo journeys' labels are in AX309.
