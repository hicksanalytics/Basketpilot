# Middle Tennessee community catalog evidence

Checked November 16, 2026. These references support the community price draft and its synthetic tests.

| Retailer | Identifier | What the retailer source supports | Evidence |
| --- | --- | --- | --- |
| Sam’s Club | Club `6249` | Franklin club at 3070 Mallory Lane | [Club finder](https://www.samsclub.com/club/6249) |
| Costco | Warehouse `386` | Brentwood warehouse at 98 Seaboard Lane | [Warehouse finder](https://www.costco.com/warehouse-locations/warehouse-386.html?warehouseNumber=386) |
| Sam’s Club | Item `385385` | Ball Park Beef Franks, 24 count. BasketPilot’s current Sam’s receipt catalog uses `0000385385` for this row. | [Retailer listing](https://www.samsclub.com/ip/Ball-Park-Beef-Franks-24-ct/13585874752) |
| Sam’s Club | Item `866624` | Quaker instant oatmeal variety pack, 52 packets of 1.51 oz. Receipt code `0000866624`. PepsiCo confirms UPC `030000561959` for that box. | [Retailer listing](https://www.samsclub.com/ip/Quaker-Instant-Oatmeal-Variety-Pack-1-51-oz-52-pk/3000056195), [PepsiCo SmartLabel](https://smartlabel.pepsico.info/030000561959-0003-en-US/index.html) |
| Costco | Item `1276702` | Kirkland Signature water filter cartridge, 10-pack. Both Costco listings show the item number. Confirm the exact code format printed on a warehouse receipt before enabling the match. | [Product listing](https://www.costco.com/p/-/kirkland-signature-water-filter-cartridge-10-pack-set/100497360), [Same-Day listing](https://sameday.costco.com/store/costco/products/20144113-kirkland-signature-water-filter-cartridge-each) |
| Costco | Item `2075900` | Pallet of 48 cases, with 40 bottles per case. | [Retailer listing](https://www.costco.com/p/-/kirkland-signature-bottled-water-169-fl-oz-40-count-48-case-pallet/4201023333) |
| Costco | Item `782796` | One case of 40 × 16.9 fl oz bottles. The single-bottle labels also print item `782796` and have their own UPCs, including `096619879045` and `096619756803`. The outer-case barcode needs separate evidence. | [Costco Business Center](https://www.costcobusinessdelivery.com/kirkland-signature-purified-drinking-water%2C-16.9-fl-oz%2C-40-ct-.product.11982447.html), [Connecticut DEEP bottle-label examples](https://portal.ct.gov/-/media/deep/reduce_reuse_recycle/bottles/bbag-mtg-082126.pdf) |

Use the retailer’s named item number and package quantity as evidence. A product page URL can carry a different ID. Preserve the exact receipt code and verify how it maps to the retailer’s catalog before adding it to the allowlist. Record the warehouse or club ID as shown by the retailer and confirm the receipt format separately. The current parser extracts the Sam’s Club number from its register header. Costco store entry is manual.

Leave package barcodes unset until an independent source ties the barcode to the exact sale package. Record a source URL and store the code as a 14-digit GTIN with its GS1 check digit. The Quaker example is `00030000561959`. A personal barcode link only applies to the shopper’s private history. [GS1 check digit reference](https://www.gs1us.org/tools/check-digit-calculator)

The retailer evidence identifies products and locations. The contributing receipt supplies the reported amount, date, and location for the purchase. The Quaker example uses a fictional receipt, location label, and amount in the local fixture. Community searches label their results as shopper-reported historical prices.
