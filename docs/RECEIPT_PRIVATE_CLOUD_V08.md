# BasketPilot v0.8 — Private Receipt History

Status: Development beta. The public Render site is the app; customer receipts are private in Supabase.

## Receipt capture
- Scan photographs locally using the existing Tesseract-based OCR.
- Parse Sam's internal 10-digit item codes as **strings**, preserving leading zeroes.
- Recognize Sam's `INST SV` negative tax-flagged discount lines and multiple tax lines.
- Require the user to review receipt lines, date and retailer before private saving.
- Keep BOGO/instant-savings separate; do not assume a discounted receipt price is a public shelf price.
- Never guess product size or product identity from an abbreviated label.

## Private Supabase tables
- `receipts`: owner, retailer/store/date/amounts, SHA-256 duplicate fingerprint, optional private photo path.
- `receipt_items`: preserved item codes, original labels, quantities and gross line prices; all matches default to `unmatched`.
- `receipt_discounts`: original discount descriptions and amounts; allocations default to `unallocated`.
- `basketpilot-receipt-images` is a private bucket. Image upload is opt-in; max 8 MB JPG/PNG/WebP.
- No RLS policies for anonymous users. Only authenticated owners have read/write access to their receipts.
- `price_observations` is **not** automatically populated by receipt ingestion.
- The published client uses a Supabase **publishable** key only. It has no secret or service-role keys.

## First-time login caveat
Supabase's built-in free email sender is restricted to addresses on the Supabase project's organization team and may send only a small number of messages per hour. This is appropriate for our owner-only development beta, not public signup. Use the team email to test account creation, confirm it, then return to the receipt page and sign in. The configured email redirect URL may require an allow-list entry under Supabase Authentication → URL Configuration if confirmation links do not return to the page.

## Safely matching products
1. Preserve `retailer` + `retailer_item_code` + the printed description without changing it.
2. Build a retailer-specific mapping table as authorized catalog SKUs are verified.
3. Classify candidate matches by evidence: verified same SKU, exact GTIN, or similar text only.
4. Require verified catalog identity and matching pack size before unit-price comparisons.
5. Reconcile gross receipt lines minus discounts against subtotal, tax and final total.
6. Keep unallocated promotions, clearance and personalized coupons out of public shelf-price history.

## To validate
Use a real photographed receipt in the hosted app; browser OCR accuracy cannot be determined from synthetic text tests. Sign in with a project-team email, confirm review, and press `Save reviewed receipt privately`. Check the new record in `My saved receipts`. Optional original image storage is off by default. Delete test receipts in the UI when finished.

## Free-tier controls
- No new Scavio calls.
- No paid OCR API.
- No automated sharing or external price-publishing jobs.
- No automatic processing of uploaded receipt photos outside the browser.
- Storage and database subject to Supabase's Free plan limits.
