# BasketPilot v0.8 — Private Receipt History

Status: Development beta. The public Render site is the app; customer receipts are private in Supabase.

## Receipt capture
- Scan photographs locally using the existing Tesseract-based OCR.
- Parse Sam's internal 10-digit item codes as **strings**, preserving leading zeroes.
- Read a six- or seven-digit Costco item number following a separated `E` in a Costco receipt.
- Prefill the Costco warehouse number from an explicit location header or `Whse:` register footer. Keep the field editable. A conflict leaves it blank, and selecting a different retailer clears the previous number.
- Recognize a Costco item number after a printed quantity and unit price when the quantity times unit price equals the line total. An inconsistent amount stays available for manual review.
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

### Costco package reference

Review, saved receipt history, and private Find a Product match these exact Costco item numbers. A previously saved line can show the package name when its saved item number matches. A verified title from the receipt database takes precedence. Package barcodes and warehouse attribution require separate evidence.

| Item number | Package | Retailer evidence |
| --- | --- | --- |
| `782796` | Kirkland Signature Purified Drinking Water, one case of 40 × 16.9 fl oz | [Costco Business Center](https://www.costcobusinessdelivery.com/kirkland-signature-purified-drinking-water%2C-16.9-fl-oz%2C-40-ct-.product.11982447.html) |
| `427381` | Kirkland Signature Organic Large Eggs, 24 ct | [Costco Same-Day](https://sameday.costco.com/store/costco/products/32509-kirkland-signature-organic-brown-eggs-usda-large-grade-aa-2-dozen) |
| `1068080` | Kirkland Signature Organic Pasture-Raised Large Eggs, 24 ct | [Costco Same-Day](https://sameday.costco.com/store/costco/products/17320077-kirkland-signature-organic-pasture-raised-usda-grade-a-eggs-24-ct-24-ct) |
| `1068083` | Kirkland Signature Organic Free-Range Large Eggs, 24 ct | [Costco Same-Day](https://sameday.costco.com/store/costco/products/19232685-kirkland-signature-organic-free-range-egg-usda-grade-a-lg-24-ct-24-ct) |
| `897971` | Kirkland Signature Organic Applesauce Pouches, 24 × 3.17 oz | [Costco Same-Day](https://sameday.costco.com/store/costco/products/19231237-kirkland-signature-organic-applesauce-pouch-24-x-3-17-oz-76-08-oz) |
| `1975527` | Kirkland Signature Ultra-Filtered Lactose-Free 2% Milk, 3 × 64 fl oz | [Costco Business Center](https://www.costcobusinessdelivery.com/milk.html) |

The receipt in the [Harrison Ranch Community Development District agenda](https://campussuite-storage.s3.amazonaws.com/prod/1558907/9ce571a0-ea9f-11e9-bdd7-0a20d2c7fac4/2910919/ee6004a2-e26d-11ef-93b2-0a58a9feac02/file/2025-02-10%20-%20Harrison%20Ranch%20CDD%20-%20Final%20Agenda.pdf) shows the water case item number following `E`. [Costco support](https://productsupport.costco.com/en/customer/search) identifies warehouse receipts as a source of item numbers. All test receipt contents are synthetic.

Published warehouse receipts show the location-name-and-number header and the register footer. Costco lists the [Brentwood warehouse #386](https://www.costco.com/w/-/TN/brentwood/386) and the [Brentwood showroom #1785](https://www.costco.com/w/-/tn/brentwood/1785) at the same street address. Use the printed number to distinguish them. [Receipt format example](https://www.utah.gov/pmn/files/1243261.pdf)

## To validate
Use a real photographed receipt in the hosted app; browser OCR accuracy cannot be determined from synthetic text tests. Sign in with a project-team email, confirm review, and press `Save reviewed receipt privately`. Check the new record in `My saved receipts`. Optional original image storage is off by default. Delete test receipts in the UI when finished.

Run `python3 tests/receipt_ocr_fixture.py` for a local OCR check with Python Pillow, Tesseract CLI and its English model, and Node installed. The script generates a fictional receipt at zero and one degree of rotation and checks warehouse, item ID, quantity, and price. Use `--font` to supply a local DejaVu Sans Mono font path. Native iPhone and Android camera checks remain separate.

## Free-tier controls
- No new Scavio calls.
- No paid OCR API.
- No automated sharing or external price-publishing jobs.
- No automatic processing of uploaded receipt photos outside the browser.
- Storage and database subject to Supabase's Free plan limits.
