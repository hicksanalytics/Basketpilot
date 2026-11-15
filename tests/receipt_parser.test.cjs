const {test}=require('node:test');const assert=require('node:assert/strict');
const p=require('../public/receipt-parser.js');
test('Costco item IDs and totals',()=>{
 const r=p.parseReceipt('COSTCO\n1798799 KIRKLAND PAPER TOWELS 19.99\n1798790 MILK 4.99\nSUBTOTAL 24.98\nTAX 0.00\nTOTAL 24.98\n11/14/2026');
 assert.equal(r.retailer,'costco');assert.equal(r.items.length,2);assert.equal(r.items[0].sku,'1798799');assert.equal(r.subtotalDelta,0);assert.equal(r.purchasedOn,'2026-11-14');
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