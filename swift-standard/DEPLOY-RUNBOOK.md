# SWIFT PUBLIC SITE — DEPLOY RUNBOOK
**For the founder. Click-by-click.** Tag SITE-1.1 · written 26 August 2026

Everything is built. This sheet has two jobs: **fill in three company details**, then **put the site
on swiftgy.com**. Budget about 45 minutes, most of which is waiting for DNS.

---

## BEFORE YOU START — the one file (about 2 minutes)

Open this file:

```
apps/web/src/site.config.ts
```

Replace three placeholders with the real values:

| Placeholder | What goes there |
|---|---|
| `{{LEGAL_ENTITY_NAME}}` | The company's **exact** registered name |
| `{{COMPANY_ADDRESS}}` | The company's **exact** registered address, one line |
| `{{COMPANY_PHONE}}` | A number **you will answer** |

> ### ⚠️ Copy the name and address character-for-character from the Dun & Bradstreet record.
> Apple compares this site against D&B during organisation enrollment. "Ltd" versus "Limited",
> a missing comma, "St." versus "Street" — any of those can fail the check.
> **Do not tidy the spelling. Do not improve it. Copy it exactly.**

Apple may telephone the number during enrollment, so it must reach a person.

**You cannot get this wrong silently.** The build refuses to compile while any placeholder remains,
and prints exactly which ones are missing:

```
BUILD REFUSED — 3 company details still unfilled in apps/web/src/site.config.ts:
    • legalEntityName
    • address
    • phone
```

Nothing else in the site needs editing. Every page, footer and the structured data all read from
that one file.

---

## STEP 1 — Create the Vercel account (5 min)

1. Go to **vercel.com/signup**
2. Sign up with **admin@swiftgy.com**
3. Choose **Continue with GitHub** and authorise it
4. Pick the **Hobby** plan — free, **no card required**
5. When it asks for a team name, use the company name

> **On the plan.** Hobby is free forever and is what gets the site live today. Vercel's terms
> describe Hobby as non-commercial, so once Swift is taking real revenue, upgrade that project to
> **Pro ($20/month)**. It is a one-click upgrade, nothing about the site changes, and there is no
> rush — but do not leave a company website on a non-commercial tier indefinitely.
> If you would rather never pay, see **Appendix A** for the Cloudflare route.

---

## STEP 2 — Import the repository (5 min)

1. On the Vercel dashboard press **Add New… → Project**
2. Find **westbridge-inc/swift** and press **Import**
3. Vercel will ask how to build it. Set these **exactly**:

| Field | Value |
|---|---|
| **Framework Preset** | `Next.js` |
| **Root Directory** | `apps/web` ← press *Edit* and select this folder |
| **Build Command** | leave as default (`next build`) |
| **Output Directory** | leave as default |
| **Install Command** | `pnpm install --frozen-lockfile` |
| **Node.js Version** | `20.x` |

4. Open **Environment Variables** and add one:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.swiftgy.com` |

> Use the real API address. It **must** start with `https://` — the build deliberately refuses a
> plaintext `http://` API on a real host, because that would expose tokens to interception.

5. Press **Deploy** and wait about two minutes.

You will get a temporary address like `swift-abc123.vercel.app`. **Open it and click through every
page.** This is your proof the build is good before DNS is involved. If anything is wrong, fix it
here — not after the domain is pointed.

---

## STEP 3 — Add the domain in Vercel (2 min)

1. In the project: **Settings → Domains**
2. Type `swiftgy.com` and press **Add**
3. Type `www.swiftgy.com` and press **Add**
4. Vercel now shows you the DNS records it wants. **Leave this page open** — you need it in Step 4.

Vercel will normally ask for:

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `76.76.21.21` |
| `CNAME` | `www` | `cname.vercel-dns.com` |

**Use whatever the Vercel screen actually shows**, not what is printed here — these values change
occasionally. The table above is only so you can recognise that you are in the right place.

---

## STEP 4 — Point the domain at it, in GoDaddy (10 min)

1. Sign in to **godaddy.com**
2. **My Products → swiftgy.com → DNS** (or "Manage DNS")

> # 🛑 STOP AND READ THIS
> You are about to edit the same DNS panel that runs **the company email**.
>
> **DO NOT touch, edit or delete any of these:**
> - anything of type **MX**
> - anything with **titan.email** or **titan** in it
> - anything of type **TXT** that mentions **SPF**, **DKIM** or **DMARC**
>
> Deleting an MX record stops all mail to the domain instantly, and mail sent meanwhile is gone —
> it does not queue and arrive later. **If a row is not in the table below, leave it alone.**

### 4a — Remove GoDaddy's parking record

GoDaddy points new domains at its own "coming soon" page. Find the row that is:

- Type **A**, Name **@**, and a value that is **not** `76.76.21.21`

Delete **only** that row. If there is more than one A record on `@`, delete each one whose value is
not the address Vercel gave you.

Also delete any **CNAME** on Name **www** that points at GoDaddy (often `_domainconnect` or a
`godaddysites.com` address). Leave every other CNAME alone.

### 4b — Add the two records Vercel asked for

| Action | Type | Name | Value | TTL |
|---|---|---|---|---|
| **Add** | `A` | `@` | *(the IP from the Vercel screen)* | 600 |
| **Add** | `CNAME` | `www` | *(the value from the Vercel screen)* | 600 |

Press **Save**.

### 4c — Check your email still works

Before moving on: **send yourself an email at your @swiftgy.com address from a different account.**
If it arrives, the mail records are intact. Do this now, not later — it is far easier to fix in the
next five minutes than tomorrow.

---

## STEP 5 — Wait, then verify (10–30 min)

Go back to the Vercel **Domains** page. The two entries will change from *Invalid Configuration* to
a green **Valid Configuration**. HTTPS certificates are issued automatically — you do nothing.

Typical wait is 10–30 minutes. If it is still amber after an hour, re-check Step 4b for a typo.

### Then verify it properly — this is Apple's actual test

**Take out your phone. Turn Wi-Fi OFF. Use mobile data. Open a private/incognito tab.**

That is exactly the state Apple checks from: logged out, no cache, public internet. Then visit:

- [ ] `https://swiftgy.com` — loads, looks like a company
- [ ] `https://www.swiftgy.com` — jumps to the non-www address
- [ ] `/about` — shows the legal entity name and address
- [ ] `/contact` — shows the address, the phone number and support@swiftgy.com
- [ ] `/vendors` and `/drivers`
- [ ] `/faq`
- [ ] `/legal/privacy` and `/legal/terms` — both show a version and an effective date
- [ ] `/account/delete` — opens **without signing in**
- [ ] the padlock is present on every page
- [ ] no `{{CURLY_BRACES}}` visible anywhere

Then tell me it is live and I will run the full 14-point acceptance check against the real domain
and report the results with evidence.

---

## WHAT TO DO IF SOMETHING IS WRONG

| Symptom | Cause | Fix |
|---|---|---|
| Build fails, "BUILD REFUSED" | A placeholder is still in `site.config.ts` | Fill the named fields, commit, redeploy |
| Build fails, "must use https://" | `NEXT_PUBLIC_API_URL` starts with `http://` | Change it to `https://` in Settings → Environment Variables |
| Domain stuck on "Invalid Configuration" | DNS typo, or the old parking record is still there | Re-check Step 4a and 4b |
| Site loads but the old GoDaddy page shows | Cached | Try a private tab, or another network |
| Email stopped arriving | An MX or titan record was changed | Restore it in GoDaddy immediately — tell me and I will help |

---

## FOR THE RECORD — decisions I made, and why

**Vercel over Cloudflare Pages.** The spec's first choice was Cloudflare, because its free tier
permits commercial use. I chose Vercel on evidence:

1. **This repo already deploys to Vercel.** `apps/admin` has a working Vercel pipeline
   (`.github/workflows/deploy-admin.yml`), so the path is proven here rather than assumed.
2. **The app has genuinely dynamic routes** — `/orders/[id]`, `/store/[slug]`, `/pricing`, the
   `/s/:code` QR proxy rewrite, and two `force-dynamic` route handlers for the app-association
   files. On Vercel these are zero-config. On Cloudflare each one needs an adapter
   (`@cloudflare/next-on-pages`) and is a place the deploy can fail.
3. **I can prove the Vercel build today** — it is the same `next build` that already passes locally.
   I could not prove a Cloudflare build without adding an adapter and deploying it, and the spec's
   own rule is *"build passes = evidence, not assumption."*

The cost of that choice is the licensing note in Step 1. It is real, and the fix is $20/month when
revenue starts. Appendix A is the alternative if you would rather solve it now.

**Apple does not see any of this.** It checks the domain (yours), HTTPS (automatic) and the content
(built). Hosting plan is invisible to it. The only choice that would genuinely hurt is running the
company site on a free *subdomain* like `swift.vercel.app` — which is why the canonical site is
`swiftgy.com` and www redirects to it.

---

## WHAT I CHANGED IN THE SITE

So you know what to look at, and what to tell anyone reviewing it.

**New pages**
- `/faq` — ten real questions with honest answers
- `/legal/privacy` and `/legal/terms` — these previously **redirected to the API**, so they broke
  whenever the API was down. They are now real pages, generated at build time from the same single
  source the app uses, with a version and effective date shown. A script keeps them in sync and CI
  fails if they drift.

**Renamed, with the old links still working (301 redirects)**
- `/for-vendors` → `/vendors`
- `/for-drivers` → `/drivers`
- `/delete-account` → `/account/delete`

**Truthfulness fixes** — these were claims the site could not support:
- `/about` said Swift was *"live across thirteen Caribbean markets."* It now lists only the markets
  in the launch config. This is the single most checkable claim on the site.
- `/vendors` told businesses to *"download the Swift app"* — there is no app yet. It now points at
  the web dashboard, which works today.
- `/pricing`'s fallback message told people to open the app for rates. It now gives the model and an
  email address.
- The footer no longer implies apps exist, and no store badges appear anywhere until they do.

**Added**
- `robots.txt` — marketing indexable, operator and tokenised routes blocked. `/account/delete` is
  explicitly allowed, because Google requires it reachable and a blanket `/account` rule would have
  swallowed it.
- `sitemap.xml` — the eleven public pages, hand-listed so a private route can never leak into it.
- Organization structured data on `/about`, fed from your three details.
- HSTS, a permissions policy, and `application/json` with no redirect on the app-association files.
- The legal entity name in **every** footer.

---

## APPENDIX A — if you want $0 forever and a commercial licence

Cloudflare Pages' free tier permits commercial use. It is more work and I have not proven it builds:

1. Someone adds `@cloudflare/next-on-pages` to `apps/web` and gets a clean local build
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
3. Root directory `apps/web`, build command `npx @cloudflare/next-on-pages@1`, output `.vercel/output/static`
4. Add `swiftgy.com` under **Custom domains**
5. DNS moves to Cloudflare's nameservers — **which means the MX and titan.email records must be
   recreated there exactly, or email stops.** That is the risky part and why I did not choose it
   for a first launch.

Say the word and I will do step 1 and tell you honestly whether it builds cleanly.

---

## APPENDIX B — things I could not decide for you

1. **The privacy policy points people at `privacy@swift.gy`** — a different domain from
   `swiftgy.com`. If `swift.gy` does not receive mail, the stated data-rights contact is dead, which
   is a compliance problem rather than a typo. I did not edit the legal text. Decide whether to
   forward that address or update the policy.
2. **`support@swiftgy.com` must actually receive mail** before enrollment — the site publishes it
   and Apple expects a reply.
3. **The app-association files stay off** until you have an Apple Team ID and an Android signing
   certificate. They return 404 rather than a fake association, which is the honest behaviour and
   costs nothing now.
