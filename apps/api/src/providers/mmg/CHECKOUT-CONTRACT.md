# MMG hosted checkout: the contract

Code: `mmg-checkout.ts`. Tests: `src/__tests__/mmg-checkout.test.ts`.

**Sources: the official MMG Merchant Checkout page (owner-supplied transcription, 2026-09-30), and the prior MMG UAT package.**
- The official merchant page confirms the request field names, seven-digit merchant ID, reply field names, result codes and Response/Error/optional Notify URL registration. Its sample represents amount and requestInitiationTime as decimal strings.
- `Checkout Flow/MMG Checkout demo.py` supplies the byte serialization and RSA-OAEP parameters that the newer page does not specify. The newer sample supersedes the demo's numeric timestamp wire type; this type decision is sample evidence, not an explicit prose requirement.
- `Initiate Flow/MMG E-Commerce API Collection - 6D.postman_collection.json` for endpoint, header and field NAMES only.

No credential value from any source (merchant id, MSISDN, key, secret, client id, token, password) appears in this repository. A third-party shop integration for MMG is **not** a source.

## Confirmed and built

| # | Fact | Source |
|---|------|--------|
| C1 | Request fields, in this order: `secretKey`, `amount`, `merchantId`, `merchantTransactionId`, `productDescription`, `requestInitiationTime`, `merchantName` | demo, lines 96–104 |
| C2 | `requestInitiationTime` is a decimal string of whole unix **seconds**, bounded to 10 digits | official page sample; seconds/floor semantics retained from demo |
| C3 | Plaintext: `json.dumps(obj, indent=4)` with Python's default `ensure_ascii`, then `.encode("ISO-8859-1")` | demo, lines 52–56 |
| C4 | RSA-OAEP with a SHA-256 digest, MGF1-SHA-256 and no label | demo, lines 59–64 and 76–81 |
| C5 | Plaintext limit: k − 66 bytes (RFC 8017 §7.1.1), taken from the configured key | RFC 8017 |
| C6 | Token: standard base64 with `+`→`-` and `/`→`_`, **keeping** the `=` padding (`urlsafe_b64encode`) | demo, line 41 |
| C7 | URL: `<page>?token=<token, raw>&merchantId=<merchant MSISDN>&X-Client-ID=<client id>`, in that order. UAT page: `https://mmgpg.mmgtest.net/mmg-pg/web/payments` | demo, line 48 |
| C8 | Reply: canonical standard Base64 or Base64-URL, with optional correct padding → RSA-OAEP-SHA256 under the merchant private key → UTF-8 → JSON | official page says Base64; demo supplies URL-safe alphabet and OAEP |
| C9 | The UAT keys are ONE matched 4096-bit pair. Requests are encrypted to its public half; replies are decrypted with its private half | owner shape probe, 09-24 (names and shapes only) |
| C10 | The UAT config holds the amount as a string of digits with no decimal point | owner shape probe, 09-24 |
| C11 | The merchant-initiated API, which verifies payments:<br>• `POST {mwallet}/e-commerce-login/mer`, a form with `grant_type`, `api_key`, `username`, `password`;<br>• `GET {mwallet}/e-merchant-initiated-transactions/lookup?transactionId=…` with headers `x-wss-mid`, `x-wss-mkey`, `x-wss-msecret`, `x-api-key`, `x-wss-correlationid`, `x-wss-token`.<br>The lookup example response has `amount`, `currency`, `debitParty[]`, `creditParty[]`, `metadata[]`, `transactionStatus`, `transactionReference`, `transactionReceipt` and `executionId` | Postman collection |

**How Swift reproduces these:**
- C3: every UTF-16 code unit outside printable ASCII becomes a lowercase `\uXXXX`. That includes DEL (0x7f), and an astral character becomes its surrogate pair. The result is pure ASCII.
- C8: Swift pads only to a multiple of four. It refuses wrong padding, mixed alphabets, noncanonical trailing bits and all whitespace. Spaces are never converted to `+`. The decoded ciphertext must be exactly one block for the configured RSA key.
- C8: bytes that are not valid UTF-8 are refused. They are never read as ISO-8859-1.

## Defaults chosen: one function each, so a change is one line

| # | Default | Function | Status |
|---|---------|----------|--------|
| D1 | The amount is whole major units as digits, e.g. `"1500"`. Cents are refused, never rounded | `formatCheckoutAmount` | Digits only is confirmed (C10). Whether the digits are MAJOR units is U4 |
| D2 | `merchantTransactionId` is 18 digits: 13-digit unix milliseconds, then 5 random digits | `newMerchantTransactionId`, `MERCHANT_TRANSACTION_ID_SHAPE` | The demo sends a numeric string, and 18 digits fit a signed 64-bit column. Uniqueness is PR 2's unique index |
| D3 | The page is `MMG_CHECKOUT_URL`. The UAT page is the default outside production only. Production needs an explicit https, non-UAT value, and there is no live default of any kind | `checkoutPageUrl` | U7 |
| D4 | `productDescription` is `Swift weekly fee`. `merchantName` is `MMG_CHECKOUT_MERCHANT_NAME`, the name registered with MMG | `MMG_CHECKOUT_PRODUCT_DESCRIPTION` | Short printable ASCII |

## Official decrypted response

Only these root fields have documented meaning:
- `merchantTransactionId`: Swift's exact whole checkout reference, as a string. No trimming, numeric coercion, nested field or substring matching.
- `transactionId`: the MMG transaction to look up. Other fields never supply candidates.
- `ResultCode`: one of the exact strings below.
- `ResultMessage` and `htmlResponse`: provider text; never rendered and never used to decide a payment state.

| ResultCode | MMG meaning | Swift action |
|---|---|---|
| `0` | Transaction Successful | Check MMG's server record; credit automatically only under the six conditions (MMG-CHECKOUT-API.md, owner 1 Oct), otherwise hold for a person. |
| `1` | Agent Not Registered | Not paid: NOT_PAID, the confirmation pause is released, the partner may retry. A named transaction is still checked later. |
| `2` | Payment Failed | Same not-paid rule. |
| `3` | Invalid Secret Key | Configuration or security alert to operators, once per checkout; the checkout is not touched; no lookup, no credit. |
| `4` | Merchant ID Mismatch | Same configuration alert rule. |
| `5` | Token Decryption Failed | Same configuration alert rule. |
| `6` | Transaction Cancelled | Same not-paid rule. |
| `7` | Request Timed Out | Not paid unless the server record says paid: no transaction is NOT_PAID; a named transaction is decided by MMG's lookup (declined is NOT_PAID; paid is held for a person; pending or unknown keeps the pause). |

Unknown/malformed result fields do not change a checkout. A success requires transactionId. After a success answer for a checkout, a later not-paid answer releases nothing, and the disagreement holds a paid record for a person. A previously confirmed credit is never reversed by a later response. A later success naming a different transaction is written down and alerts operators once per checkout; it is never credited automatically.

`merchantTransactionId` in this browser response is not a lookup field: UAT (1 Oct) showed MMG's lookup carries neither it nor the product description, so `MMG_LOOKUP_REFERENCE_FIELDS` stays empty. The lookup answers HTTP 200 with `transactionStatus`, a whole-dollar `amount` string, `currency`, `creationDate` (the moment of the LOOKUP, not of the payment: MMG, 7 Oct; never used to decide), `transactionReference` (MMG's ledger number, a different number from the reply's `transactionId`), `creditParty`/`debitParty` as `[{key: "accountid", value}]`, and `metadata` whose `description` is empty. MMG's Transaction History (UAT, 7 Oct) lists the payment with `transactionReference` and `transactionReceipt` both equal to the reply's `transactionId`, `transactionStatus` `completed`, the amount and currency, and `modificationDate`, when MMG performed it (Guyana time even where it ends in `Z`; read in the zone `MMG_CHECKOUT_CREATION_ZONE` names). Credit requires MMG's success answer for the checkout plus those records: `successful`, exact amount in GYD, our merchant's `accountid`, exactly one history record that agrees and dates the payment inside the checkout's window, and neither number credited before.

## UNCONFIRMED — requires MMG or a sandbox run

- **U1/U2 resolved:** reply field names and codes are documented above.
- **U3 partially resolved:** MMG posts an encrypted TOKEN to the configured Response URL; merchants also register an Error URL and optionally a Notify URL. Exact transport parameter spelling, Notify authentication and server-to-server behavior remain unconfirmed. Checkout series PR 3 must wire the API return/notify routes and verify those boundaries; PR 2 currently provides the service only. MMG registered Swift's UAT Notify URL (`https://api-staging.swiftgy.com/api/v1/billing/mmg-checkout/notify`) on 5 Oct 2026; a notify only prompts Swift's own lookup and never credits by itself.
- **U4** Whether the amount digits are MAJOR units (D1). The MMG page displays the amount on the first sandbox run.
- **U5 resolved (UAT, 1 Oct):** the merchant-initiated lookup finds a checkout payment by the reply's `transactionId` and answers with MMG's own ledger number in `transactionReference`.
- **U6** Whether MMG refuses a repeated `merchantTransactionId`.
- **U7** The live page host.
- **U8** How long a checkout session lives.
- **U9** Whether one merchant can register separate staging and production return URLs.
- **U10 resolved (owner ruling, 4 Oct):** MMG production writes the lookup's `creationDate` in Guyana time labelled `Z`, as UAT does (1 Oct). Staging and production set `MMG_CHECKOUT_CREATION_ZONE=GUYANA_WALL_CLOCK`. **7 Oct:** MMG said the lookup's `creationDate` is the time of the lookup, and that Transaction History's `modificationDate` is when the payment was made; UAT history writes it, and reads its query dates, the same way. Condition 5 now reads the payment's time from history alone. If a real payment ever reads otherwise, it is held (`PAYMENT_TIME_AFTER_REPLY`, or `PAYMENT_TIME_NOT_IN_HISTORY` when history, asked in the wrong zone, has no record of it) and operators are told.

## Security posture

- **A decrypted reply proves nothing about who sent it.** The UAT key pair is shared with MMG, so anyone holding its public half can mint a reply that decrypts cleanly. Nothing credits a partner until the merchant-initiated lookup confirms the transaction, including its status, amount, currency, merchant and time, and the one-credit constraint accepts both of MMG's numbers for it (plan invariant I2, PR 2).
- **The keys stay two settings even though UAT uses one pair:**
  - `MMG_CHECKOUT_PUBLIC_KEY` is the MMG-issued public half, provisioned from the secret store through `MMG_CHECKOUT_PUBLIC_KEY_FILE`. The boot guard refuses a private key there rather than quietly deriving the public half from it.
  - `MMG_CHECKOUT_PRIVATE_KEY` is a secret file.
- **The checkout follows `MMG_DRIVER`.** A live checkout is therefore never verified by the sandbox lookup, which approves whatever it is told to.
- **Decryption failures are one generic refusal.** Error messages name the rule that failed, never a secret, a request byte or a token.

## Configuration

| Name | Kind | When required |
|------|------|---------------|
| `MMG_CHECKOUT_ENABLED` | switch, exactly `0` or `1` (default `0`) | always valid; any other spelling refuses to start |
| `MMG_CHECKOUT_URL` | the page | production (https, not UAT) |
| `MMG_CHECKOUT_MERCHANT_ID` | merchant MSISDN, exactly 7 digits | enabled + `MMG_DRIVER=live` |
| `MMG_CHECKOUT_CLIENT_ID` | the `X-Client-ID` | enabled + live |
| `MMG_CHECKOUT_MERCHANT_NAME` | the name registered with MMG | enabled + live |
| `MMG_CHECKOUT_PUBLIC_KEY` | secret-file RSA public key, PEM (`\n` escapes allowed), ≥ 2048 bits | enabled + live |
| `MMG_CHECKOUT_RETURN_ORIGIN` | https web origin of the registered return pages | enabled + live |
| `MMG_CHECKOUT_PRIVATE_KEY` | secret file, RSA private key, PEM, unencrypted, ≥ 2048 bits | enabled + live |
| `MMG_CHECKOUT_SECRET_KEY` | secret file | enabled + live |
| `MMG_CHECKOUT_CREATION_ZONE` | how MMG's times are read (history's `modificationDate`, and the dates of the history query): exactly `GUYANA_WALL_CLOCK` (`Z` or no zone is Guyana time) or `UTC` (`Z` is UTC; no zone cannot be read); an explicit offset is read as stated | staging and production: `GUYANA_WALL_CLOCK` (U10). Unset is the safety net: no MMG payment is confirmed automatically (each is held for a person). Any other value refuses to start, in every mode |

At boot, the guard also runs the widest request this configuration can produce and proves it fits the configured public key. A key that is too small therefore fails the deploy, not the first partner.

**Loading the keys.** Both PEM halves use the secret store and the corresponding `_FILE` settings; multiline content is preserved; setting both a value and its `_FILE` path is refused. Only the owner performs the hidden setup. Example command structure (no key material):

```
sudo swift-secrets set MMG_CHECKOUT_PRIVATE_KEY < the-key-file
```

The store reads all of stdin. The one-line owner prompt tool cannot carry a PEM.

Actual key material and the shared secret are provisioned only by the owner through hidden secret-store setup. Never paste them into a terminal command, chat, log, repository or documentation. Tests generate unrelated keys in memory. No UAT/provider request or configuration change is part of this code audit.
