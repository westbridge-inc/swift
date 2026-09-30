# MMG hosted checkout: the contract

Code: `mmg-checkout.ts`. Tests: `src/__tests__/mmg-checkout.test.ts`.

**Sources: the MMG UAT package only.**
- `Checkout Flow/MMG Checkout demo.py` for the code structure.
- `Initiate Flow/MMG E-Commerce API Collection - 6D.postman_collection.json` for endpoint, header and field NAMES only.

No value from either file (merchant id, MSISDN, key, secret, client id, token, password) appears in this repository. A third-party shop integration for MMG is **not** a source.

## Confirmed and built

| # | Fact | Source |
|---|------|--------|
| C1 | Request fields, in this order: `secretKey`, `amount`, `merchantId`, `merchantTransactionId`, `productDescription`, `requestInitiationTime`, `merchantName` | demo, lines 96–104 |
| C2 | `requestInitiationTime` is an integer of unix **seconds** | demo, `int(time.time())` |
| C3 | Plaintext: `json.dumps(obj, indent=4)` with Python's default `ensure_ascii`, then `.encode("ISO-8859-1")` | demo, lines 52–56 |
| C4 | RSA-OAEP with a SHA-256 digest, MGF1-SHA-256 and no label | demo, lines 59–64 and 76–81 |
| C5 | Plaintext limit: k − 66 bytes (RFC 8017 §7.1.1), taken from the configured key | RFC 8017 |
| C6 | Token: standard base64 with `+`→`-` and `/`→`_`, **keeping** the `=` padding (`urlsafe_b64encode`) | demo, line 41 |
| C7 | URL: `<page>?token=<token, raw>&merchantId=<merchant MSISDN>&X-Client-ID=<client id>`, in that order. UAT page: `https://mmgpg.mmgtest.net/mmg-pg/web/payments` | demo, line 48 |
| C8 | Reply: base64url with the padding optional → RSA-OAEP-SHA256 under the merchant private key → UTF-8 → JSON | demo, lines 67–90 |
| C9 | The UAT keys are ONE matched 4096-bit pair. Requests are encrypted to its public half; replies are decrypted with its private half | owner shape probe, 09-24 (names and shapes only) |
| C10 | The UAT config holds the amount as a string of digits with no decimal point | owner shape probe, 09-24 |
| C11 | The merchant-initiated API, which verifies payments:<br>• `POST {mwallet}/e-commerce-login/mer`, a form with `grant_type`, `api_key`, `username`, `password`;<br>• `GET {mwallet}/e-merchant-initiated-transactions/lookup?transactionId=…` with headers `x-wss-mid`, `x-wss-mkey`, `x-wss-msecret`, `x-api-key`, `x-wss-correlationid`, `x-wss-token`.<br>The lookup example response has `amount`, `currency`, `debitParty[]`, `creditParty[]`, `metadata[]`, `transactionStatus`, `transactionReference`, `transactionReceipt` and `executionId` | Postman collection |

**How Swift reproduces these:**
- C3: every UTF-16 code unit outside printable ASCII becomes a lowercase `\uXXXX`. That includes DEL (0x7f), and an astral character becomes its surrogate pair. The result is pure ASCII.
- C8: the demo re-pads a token that is already aligned with four `=`. Swift pads only to a multiple of four, and refuses a token that is padded wrongly.
- C8: bytes that are not valid UTF-8 are refused. They are never read as ISO-8859-1.

## Defaults chosen: one function each, so a change is one line

| # | Default | Function | Status |
|---|---------|----------|--------|
| D1 | The amount is whole major units as digits, e.g. `"1500"`. Cents are refused, never rounded | `formatCheckoutAmount` | Digits only is confirmed (C10). Whether the digits are MAJOR units is U4 |
| D2 | `merchantTransactionId` is 18 digits: 13-digit unix milliseconds, then 5 random digits | `newMerchantTransactionId`, `MERCHANT_TRANSACTION_ID_SHAPE` | The demo sends a numeric string, and 18 digits fit a signed 64-bit column. Uniqueness is PR 2's unique index |
| D3 | The page is `MMG_CHECKOUT_URL`. The UAT page is the default outside production only. Production needs an explicit https, non-UAT value, and there is no live default of any kind | `checkoutPageUrl` | U7 |
| D4 | `productDescription` is `Swift weekly fee`. `merchantName` is `MMG_CHECKOUT_MERCHANT_NAME`, the name registered with MMG | `MMG_CHECKOUT_PRODUCT_DESCRIPTION` | Short printable ASCII |

## UNCONFIRMED — to be fixed from MMG's sample response or the first sandbox run

- **U1** The reply's field names: our reference, MMG's transaction id, the outcome and a message. The UAT sample reply token is empty. PR 1 therefore exposes only `decryptCheckoutResult(token)`, which returns the generic object, plus `describeShape(obj)`, which reports key names and JSON types and never values. Read nothing else from a reply until this is fixed.
- **U2** The outcome codes and what each one means.
- **U3** How the reply reaches the return URL: the parameter name or a path segment, and GET or POST. Also whether MMG sends a server-to-server callback too.
- **U4** Whether the amount digits are MAJOR units (D1). The MMG page displays the amount on the first sandbox run.
- **U5** Whether the merchant-initiated lookup (C11) finds checkout transactions, and which id to use.
- **U6** Whether MMG refuses a repeated `merchantTransactionId`.
- **U7** The live page host.
- **U8** How long a checkout session lives.
- **U9** Whether one merchant can register separate staging and production return URLs.

## Security posture

- **A decrypted reply proves nothing about who sent it.** The UAT key pair is shared with MMG, so anyone holding its public half can mint a reply that decrypts cleanly. Nothing credits a partner until the merchant-initiated lookup confirms the transaction, including its amount, currency and merchant (plan invariant I2, PR 2).
- **The keys stay two settings even though UAT uses one pair:**
  - `MMG_CHECKOUT_PUBLIC_KEY` is plain configuration. The boot guard refuses a private key there rather than quietly deriving the public half from it.
  - `MMG_CHECKOUT_PRIVATE_KEY` is a secret file.
- **The checkout follows `MMG_DRIVER`.** A live checkout is therefore never verified by the sandbox lookup, which approves whatever it is told to.
- **Decryption failures are one generic refusal.** Error messages name the rule that failed, never a secret, a request byte or a token.

## Configuration

| Name | Kind | When required |
|------|------|---------------|
| `MMG_CHECKOUT_ENABLED` | switch, exactly `0` or `1` (default `0`) | always valid; any other spelling refuses to start |
| `MMG_CHECKOUT_URL` | the page | production (https, not UAT) |
| `MMG_CHECKOUT_MERCHANT_ID` | merchant MSISDN, 7–15 digits | enabled + `MMG_DRIVER=live` |
| `MMG_CHECKOUT_CLIENT_ID` | the `X-Client-ID` | enabled + live |
| `MMG_CHECKOUT_MERCHANT_NAME` | the name registered with MMG | enabled + live |
| `MMG_CHECKOUT_PUBLIC_KEY` | RSA public key, PEM (`\n` escapes allowed), ≥ 2048 bits | enabled + live |
| `MMG_CHECKOUT_RETURN_ORIGIN` | https web origin of the registered return pages | enabled + live |
| `MMG_CHECKOUT_PRIVATE_KEY` | secret file, RSA private key, PEM, unencrypted, ≥ 2048 bits | enabled + live |
| `MMG_CHECKOUT_SECRET_KEY` | secret file | enabled + live |

At boot, the guard also runs the widest request this configuration can produce and proves it fits the configured public key. A key that is too small therefore fails the deploy, not the first partner.

**Loading the private key.** It is a multi-line PEM. Store it from its file on the host:

```
sudo swift-secrets set MMG_CHECKOUT_PRIVATE_KEY < the-key-file
```

The store reads all of stdin. The one-line owner prompt tool cannot carry a PEM.
