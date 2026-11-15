# BasketPilot — Cloud Development Preview

A four-retailer grocery savings app prototype, with **separate demo pricing and real owner-only receipt analytics**.

## Screens

- **`/`** — Fictional grocery basket optimizer demo. All prices here are clearly illustrative.
- **`/receipts.html`** — Photo/Photos receipt scanning with on-device OCR, verified item-number matching, and opt-in private saving.
- **`/products.html`** — Search saved purchases by name, type a UPC/EAN, or scan the package barcode. Link an exact package to a saved purchase to compare recorded prices for that package across stores.
- **`/insights.html`** — Personal receipt analytics: frequent buys, most-recent observed price per store, normalized unit comparisons, historical price charts, and correction of missing pack counts.

## Security, privacy, and data provenance

- Saved receipts, line items, discounts, and user account access are in the existing Supabase development database. **Row-level security limits access to the receipt owner.**
- No personal receipt data or customer information is committed to GitHub, embedded in the static site, or used for demo pricing.
- A Supabase **publishable** browser key is included for client requests; it is not a service-role or database-admin credential. All private data is protected by Supabase Auth and RLS.
- The optional receipt-image upload is private and turned **off by default**.
- Receipt data does **not** automatically populate public/community retailer price tables. No Scavio API calls are initiated.
- Product lookup searches the latest 300 private receipts. The camera decodes barcodes on the device. Explicit barcode links stay in the owner's receipt history. The same linked barcode can compare across retailers, while retailer item numbers stay scoped to their retailer.
- Sample receipts are intentionally blocked from private purchase-history saving.
- Recorded prices are **historical purchases**, not current store quotes. Comparisons use **unit prices** and show observation dates, stale warnings, and unallocated-discount flags.
- Receipts without sufficient product/package identity are not used in comparable unit-price rankings.

## Launch and operations

Render Static Site (free-tier eligible); branch `main`; publish directory `public`; no build dependencies. Static site updates use source commits. This app does not require a Windows computer to host.

## Analytics test suite

Run:

```sh
node --test tests/*.cjs
```

The suite covers receipt parsing, count normalization, purchase history, barcode checksums, and exact-package matching across retailers.

## Community receipt draft

The SQL in `supabase/drafts/receipt_community.sql` runs against a synthetic PostgreSQL fixture. It stores one historical package-price observation per eligible receipt line after explicit owner consent. Withdrawing or deleting the receipt removes its observations. A consent revision prevents a delayed retry from undoing withdrawal.

Eligibility requires a reviewed line, an exact retailer item code and store ID in independently curated lists, and a reconciled subtotal. Receipts with discounts are excluded until their impact can be determined. A store ID match identifies the location recorded on the receipt. The receipt itself is shopper-supplied.

```sh
npm ci --prefix tests/community --ignore-scripts
npm --prefix tests/community test
```

The tests run the receipt page and its controls in a simulated browser DOM with a synthetic database transport. Private save completes first. Receipt review then offers a separate sharing action, and saved receipts offer the same controls in history. The published configuration has the controller disabled. The draft has no hosted endpoint or live catalog seed.

## Future work

- Add explicit receipt-image privacy controls and straightforward account onboarding.
- Grow verified retailer SKU-to-product matching and catalog coverage.
- Improve allocation of discounts to exact purchased items after validation.
- Obtain appropriate commercial price-data rights before community aggregation and subscriptions.
- Add current, store-specific price feeds so the app can eventually answer **where eggs are cheapest today**, rather than only comparing past purchase prices.
