# Swift Customer Storefront — Structure Blueprint

Adapted from the shipped **Canopy** Shopify storefront (westbridgestore.com) into
Swift's multi-vendor super-app model. This is the **information architecture +
component inventory** for the customer-facing storefront — framework-agnostic so
it holds whether the screens land in React Native or Flutter (that decision is
still a founder gate). Palette is **red + white** (see §5), aligned to
`@swift/ui` (`brand.red = #CE1126`, white/neutral surfaces, red as accent).

> **Checkout note:** the Canopy theme stops at the cart and hands off to
> Shopify's hosted checkout — there is no checkout page in a theme, and there
> cannot be. Swift doesn't need one anyway: it is **cash-first and never
> custodies money**, so Swift's "checkout" is *order placement*
> (`POST /customer/checkout`, already built), not a card-payment page.

---

## 1. The model translation (retail → marketplace)

| Canopy (single-brand retail) | Swift (multi-vendor super-app) | Backing API today |
|---|---|---|
| The store | One **Vendor** (restaurant / supermarket / store / service) | `GET /customer/vendors/:id` |
| Collection | A vendor's **category / menu section** | vendor menu in vendor payload |
| Product | A **Listing/Item** (good or service w/ bookingConfig) | `items` on vendor |
| Cart → Shopify checkout | **Cart → order placement** (cash, no payment page) | `/customer/cart`, `/customer/checkout` |
| Account / orders | Account + **live order tracking** | `/customer/orders`, `/customer/profile` |

The decisive structural difference: Canopy has **one store**; Swift's home is a
**discovery layer across many vendors and verticals** (food, grocery, courier,
taxi, marketplace, services). So Canopy's "home → collection → product" becomes
Swift's **"discovery → vendor → listing"**, with the cart split per vendor (the
API already splits a multi-vendor cart into one order each).

---

## 2. Screen map (the structure)

### A. Discovery (home) — adapted from Canopy's 19-section home
A vertical feed of modular sections, reused as a home **section system**:

- **Top bar** — location/address picker + search entry (Canopy: header + search)
- **Vertical switcher** — Food · Grocery · Courier · Taxi · Marketplace · Services
- **Active-order banner** — live status of an in-flight order (Swift-specific)
- **Slideshow / promo hero** — featured campaigns *(Canopy: `slideshow`)*
- **Category tiles** — browse by cuisine/category *(Canopy: `collection-list`)*
- **Featured / nearby vendors** — horizontal rails *(Canopy: `featured-collection`)*
- **"Order again"** — reorder rail (Swift-specific, API: order history)
- **Promo grid / countdown** — deals, flash windows *(Canopy: `promo-grid`, `countdown-timer`)*
- **Newsletter / referral** footer *(Canopy: `newsletter`)*

> Backing API: `GET /customer/home` already returns sections (active order,
> featured, nearby, order-again, categories). The blueprint just defines their
> visual structure.

### B. Vendor (store) page — adapted from Canopy's `collection` template
*(Canopy collection = `banner + products + facet-filters + sort + pagination`.)*

- **Vendor header** — logo, cover, rating, ETA, delivery fee, open/closed, fulfillment badges (DELIVERY / PICKUP / APPOINTMENT)
- **Search within vendor** + **category nav** (sticky) *(Canopy: facet-filters)*
- **Listing grid/list** — item cards *(Canopy: `card-product` snippet)*
- **Sort** (popular / price / prep time) *(Canopy: sort)*
- **Favorite** toggle (API: favorites)

### C. Listing / item detail — adapted from Canopy `main-product` anatomy
Canopy's PDP blocks (`image`, `title`, `price`, `rating`, `description`,
`variant select / radio / color`, `share`, `complementary`) map directly:

- Image gallery → **item image(s)**
- Title + price + rating → same
- **Variant/option groups** (`select` / `radio`) → Swift item **option groups** (size, add-ons)
- Description → item description (optionally AI-polished — `/ai/menu-polish`)
- **APPOINTMENT items**: slot picker (Swift bookingConfig) instead of qty
- Quantity + special instructions → cart
- "Complementary / recommended" rail *(Canopy: `product-recommendations`)*

### D. Cart — adapted from Canopy `main-cart` + `cart-drawer`
- **Cart drawer** (quick) + **full cart page** — both exist in Canopy, reuse both patterns
- Line items w/ qty, options, special instructions, remove
- **Per-vendor grouping** (Swift multi-vendor split) — *new vs Canopy*
- Delivery vs pickup selection per vendor *(Swift fulfillment)*
- Promo code, tip, delivery fee, **zero-commission subtotal** (customer pays base — §18)
- Address picker
- **Primary CTA → "Place order"** (cash/MMG/card) → `POST /customer/checkout`
  *(this replaces Canopy's "Checkout" handoff button)*

### E. Order lifecycle (Swift-specific, no Canopy equivalent)
- **Order confirmation** → **live tracking** (status timeline, rider map, PIN for taxi)
- 5-minute free-cancel window
- Rate vendor + rider on completion
- Reorder

### F. Account suite — 1:1 with Canopy customer templates
Canopy ships the full set; reuse the structure verbatim:

| Canopy customer template | Swift screen | API |
|---|---|---|
| `login` / `register` / `activate_account` | OTP signup + login | `/auth/*` |
| `reset_password` | OTP reset | `/auth/password/reset` |
| `account` | Profile / role switch | `/customer/profile` |
| `addresses` | Saved addresses | `/customer/addresses` |
| `order` (history + detail) | Orders + tracking | `/customer/orders` |

### G. Utility pages — reuse Canopy's
404, maintenance/password splash, content pages (about / contact / FAQs /
returns→**refund-&-guarantee policy**, maps to the cash guarantee). Gift card and
lookbook are **not** Swift-relevant — drop.

---

## 3. Component inventory (reusable, from Canopy → Swift)

Reimplement these in the chosen mobile framework (do **not** port Liquid/JS):

- `card-product` → **ListingCard** (image, name, price, rating, add button)
- vendor rail → **VendorCard** / horizontal **Rail**
- `cart-drawer` → **CartDrawer** (slide-up sheet)
- `facet-filters` + `sort` → **FilterBar** / **SortSheet**
- `variant-picker` → **OptionGroupSelector**
- `quick-add` → **QuickAdd** button
- `pagination` → infinite scroll
- `media-with-text`, `multi-column`, `promo-grid` → home **section** components
- `countdown-timer` → **Countdown** (flash deals)
- toast/`message` → **Toast/Banner** (reuse `@swift/ui` functional colors)

---

## 4. What to drop vs keep from Canopy

**Keep (structure):** home section system, collection→vendor layout, PDP anatomy,
cart + drawer, full account/order suite, facets/sort/pagination, recommendations.

**Drop (retail-only / Shopify-only):** Shopify checkout handoff (Swift places
orders directly), gift cards, lookbook, blog *(optional)*, all Liquid templates &
Shopify-bound JS, the green/gold color schemes, the 135 KB monolithic CSS.

---

## 5. Palette — red + white

Per request, the storefront uses **red + white only**, which is already the
`@swift/ui` direction (white/neutral surfaces, red as accent — *never* a full
red background). Mapping the Canopy values you liked onto Swift tokens:

| Token | Value | Use |
|---|---|---|
| `surface` / `bg` | `#ffffff` | all primary backgrounds |
| `surface-muted` | `#f7f7f8` (neutral) | cards, panels, section bands |
| `brand-red` | `#CE1126` (`@swift/ui` brand.red) | primary CTA, active nav, key accents |
| `text` | `#1a1a1a` / neutral-900 | headings & body |
| `text-muted` | neutral-500 | secondary text |
| `border` | neutral-200 | card/input borders |
| `on-red` | `#ffffff` | text/icons on red |

Functional colors (success/warn/error, and the loud **order alert** = brand red)
stay as defined in `@swift/ui`; they are reserved meanings, not branding. Green
and gold are **not** used on the consumer storefront under this direction.

> Implementation: this is a **values-only** change — keep using `@swift/ui`
> tokens, just don't surface green/gold on consumer screens. No new color system.

---

## 6. How this maps to existing Swift code (so nothing is rebuilt twice)

The backend for this storefront **already exists** in `apps/api`:
`GET /customer/home`, search, `GET /customer/vendors/:id`, cart CRUD,
`POST /customer/checkout`, `/customer/orders`, `/customer/addresses`, favorites,
ratings. This blueprint is the **front-end structure** that consumes them — no
API work required to build the screens.

**Next step (unblocked once RN-vs-Flutter is chosen):** scaffold screens A–G in
the chosen framework against these endpoints, using the component inventory in §3
and the red/white tokens in §5.
