const {test}=require('node:test');const assert=require('node:assert/strict');
const p=require('../public/receipt-parser.js');
test('Costco item IDs and totals',()=>{
 const r=p.parseReceipt('COSTCO\n1798799 KIRKLAND PAPER TOWELS 19.99\n1798790 MILK 4.99\nSUBTOTAL 24.98\nTAX 0.00\nTOTAL 24.98\n11/14/2026');
 assert.equal(r.retailer,'costco');assert.equal(r.items.length,2);assert.equal(r.items[0].sku,'1798799');assert.equal(r.subtotalDelta,0);assert.equal(r.purchasedOn,'2026-11-14');
});
test('receipt prefix parsing stays Costco-specific and preserves the printed digits',()=>{
 const row='E 0782796 WATER 4.25 A';
 assert.equal(p.parseReceipt('COSTCO\n'+row).items[0].sku,'0782796');
 assert.equal(p.parseReceipt("SAM'S CLUB\n"+row).items[0].sku,'');
 assert.equal(p.parseReceipt('COSTCO\nE 7827960 WATER 4.25').items[0].sku,'7827960');
 assert.equal(p.parseReceipt('COSTCO\nE 7827961A WATER 4.25').items[0].sku,'');
});
test('Costco warehouse extraction uses the explicit header and register footer',()=>{
 const header=['COSTCO WHOLESALE','Brentwood #386','98 Seaboard Ln','Brentwood, TN 37027'].join('\n');
 const rows='\nE 782796 WATER 4.25 A\nSUBTOTAL 4.25\n';
 const footer='Whse:386 Trm:7 Trn:32 OP:113';
 assert.equal(p.parseReceipt(header+rows).storeId,'386');
 assert.equal(p.parseReceipt(header+rows+footer).storeId,'386');
 assert.equal(p.parseReceipt('COSTCO WHOLESALE'+rows+footer).storeId,'386');
 assert.equal(p.parseReceipt(header.replace('#386','#0386')+rows).storeId,'0386');
 assert.equal(p.parseReceipt(header+rows+'Whse:1785 Trm:7 Trn:32 OP:113').storeId,'');
 assert.equal(p.parseReceipt('COSTCO WHOLESALE'+rows+footer+'\nWhse:1785').storeId,'');
});
test('Costco warehouse extraction leaves address-only and unrelated receipt numbers blank',()=>{
 const rows='\nE 782796 WATER 4.25 A\nSUBTOTAL 4.25\n';
 for(const text of [
   'COSTCO WHOLESALE\n98 Seaboard Ln\nBrentwood, TN 37027'+rows+'OP#: 386',
   'COSTCO WHOLESALE\nOP #386'+rows,
   'COSTCO WHOLESALE'+rows+'Whse:3860X',
   'COSTCO WHOLESALE'+rows+'Whse:386.00',
   'COSTCO WHOLESALE'+rows+'Whse:000',
   "SAM'S CLUB"+rows+'Whse:386'
 ]) assert.equal(p.parseReceipt(text).storeId,'');
});
test('Publix BOGO is kept separate, not assigned as an everyday price',()=>{
 const r=p.parseReceipt('PUBLIX\nRAOS MARINARA 8.99\nRAOS MARINARA 8.99\nBOGO SAVINGS -8.99\nSUBTOTAL 8.99\nTOTAL 9.70');
 assert.equal(r.items.length,2);assert.equal(r.discounts.length,1);assert.equal(r.computedNet,8.99);assert.equal(r.subtotalDelta,0);
 assert.equal(r.catalogMatched,false);assert.ok(r.warnings.some(s=>s.includes('NOT allocated')));
});
test('Refuse to parse payment details and loyalty identifiers',()=>{
 const r=p.parseReceipt('SAMS CLUB\nMILK WHOLE 4.00\nVISA CARD 4111 1111 1111 1111 29.97\nLOYALTY ID 123456789 12.00\nTOTAL 4.00');
 assert.equal(r.items.length,1); assert.equal(r.items[0].description,'MILK WHOLE');
});
test('No fake matches or inferred store',()=>{
 const r=p.parseReceipt('BREAD 3.49\nSUBTOTAL 3.49');
 assert.equal(r.retailer,'');assert.equal(r.items[0].requiresReview,true);assert.equal(r.items[0].confidence,'review');
});
test('Handles two-item quantity and prices',()=>{
 const r=p.parseReceipt('KROGER\n2 X EGGS DOZEN 7.98\nSUBTOTAL 7.98');
 assert.equal(r.items[0].quantity,2);assert.equal(r.items[0].unitPrice,3.99);
});
test('No invalid date or negative tax fake item',()=>{
 const r=p.parseReceipt('PUBLIX 02/30/2026\nTAX 0.49\nSTORE CREDIT -12.00\nSUBTOTAL 8.00');
 assert.equal(r.purchasedOn,'');assert.equal(r.items.length,0);
});
test('Price and date parsing guardrails',()=>{
 assert.equal(p.parseMoney('2.50-'),-2.5); assert.equal(p.parseMoney('$0.02'),0.02);
 assert.equal(p.parseMoney('12,34'),null);assert.equal(p.extractDate('2026-12-01'),'2026-12-01');
});
