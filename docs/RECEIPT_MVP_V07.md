# BasketPilot v0.7 — Receipt Scanner MVP

**Scope:** Static, client-side receipt scanning and a user-reviewed CSV/JSON export. Designed to be deployed at `https://basketpilot-preview.onrender.com/receipts.html` from the existing Render static site. **No app-account, Supabase data write, or receipt upload** is included in this release.

## How to use
1. On a phone, choose **Take a photo or choose an image**; use an in-focus, well-lit JPG/PNG/WebP receipt image under 15 MB.
2. Select **Scan image on this device**. The browser loads Tesseract.js 7.0.0 from jsDelivr and its OCR worker/language assets; this may take time on cellular data. The image is passed to the OCR worker in the browser rather than sent to BasketPilot's servers.
3. Read or edit the extracted text and select **Parse / update items**.
4. Correct store and date, then verify each item description, quantity, line price, and separate discount rows.
5. Select the confirmation checkbox and **Download CSV** or **Download JSON**. No receipt information is persisted automatically, and this export is for personal review, **not** an approved community-price contribution.

The **Try a sample receipt** button demonstrates a fictional Publix BOGO receipt with no OCR downloads.

## Scope and guardrails
- Supported retailer detection: Costco, Sam's Club, Publix, Kroger. If no store name is found, the user must select it.
- Extracts item-like lines, membership club SKU candidates, quantity prefixes, separate discount rows, dates, subtotal, tax and total.
- Does not match products with a canonical catalog, parse all receipt formats, allocate coupons to particular products, publish store prices, or make purchase history predictions.
- Skips known personal or payment detail lines in parsed output. **Raw OCR text remains visible within the browser tab** for correction and can include sensitive information. Users should avoid exporting or sharing raw receipt text.
- Third-party OCR code and language assets are requested from a CDN on scanning; never embed secrets, private prices or personal info in query parameters or URLs.
- No localStorage, Supabase upload, real store price lookup, automatic receipt image saving, payments or subscription features.
- User exports are stored by the browser on their device and can contain purchase habits; treat them as private.

## Tests
```bash
node --test tests/receipt_parser.test.cjs
python tests/browser_smoke.py  # requires playwright, Chromium and Pillow; OCR worker mocked
```

The browser test mocks the OCR worker because its external CDN/assets are not available in the restricted test environment. **OCR extraction accuracy on physical receipts remains unverified** and must be assessed with consented test receipts before production use.

## Next secure migration
Private `receipts` and `receipt_items` tables behind user-owned row-level policies, opt-in contribution workflow with separate consent, duplicate detection, retailer aliases, discount attribution, and explicit retention/deletion settings. Don't assume the source retailer or price display rights have been approved.