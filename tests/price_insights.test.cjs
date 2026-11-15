'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const E=require('../public/price-insights-core.js');
function sample(retailer,store,date,label,price,quantity=1,discounts=[]){
 return {id:retailer+store+date,retailer,store_id:store,purchase_date:date,receipt_items:[{id:label+date,receipt_description:label,gross_line_total:price,quantity}],receipt_discounts:discounts};
}
test('12 and 24 eggs compare on per-egg price',()=>{
 const rows=[sample('kroger','12','2026-11-01','EGGS 12 CT',3.60),sample('sams','6249','2026-11-01','EGGS 24 CT',6.00)];
 const scores=E.compareStores(rows,'eggs','2026-11-14');
 assert.equal(scores[0].perUnit,0.25);
 assert.equal(scores[0].retailer,'sams');
 assert.equal(scores[1].perUnit,0.30);
});
test('unknown carton size is never guessed',()=>{
 assert.equal(E.inferMetadata({receipt_description:'FRESH EGGS'}).units,null);
 assert.equal(E.compareStores([sample('kroger','12','2026-11-01','FRESH EGGS',2.99)],'eggs','2026-11-14').length,0);
});
test('60 eggs do not accidentally become six',()=>{
 assert.equal(E.inferMetadata({receipt_description:'LARGE EGGS 60 COUNT'}).units,60);
});
test('not all egg-like foods are shell eggs',()=>{
 assert.equal(E.inferMetadata({receipt_description:'EGG ROLLS 12 CT'}).group,null);
});
test('multiple cartons divide entire line paid by quantity',()=>{
 const r=sample('kroger','12','2026-11-01','EGGS 12 CT',7.20,2);
 assert.equal(E.allObservations([r])[0].perUnit,.30);
});
test('latest receipt per location and stale flags',()=>{
 const r=[sample('kroger','12','2026-01-01','EGGS 12 CT',3.30),sample('kroger','12','2026-11-02','EGGS 12 CT',3.99)];
 assert.equal(E.compareStores(r,'eggs','2026-11-14').length,1);
 assert.equal(E.compareStores(r,'eggs','2026-11-14')[0].stale,false);
 assert.equal(E.compareStores(r.slice(0,1),'eggs','2026-11-14')[0].stale,true);
});
test('repeat purchases counted by distinct receipts, not line items',()=>{
 const r=sample('kroger','12','2026-11-02','EGGS 12 CT',3.99);
 r.receipt_items.push({...r.receipt_items[0],id:'extra'});
 const second=sample('kroger','12','2026-11-03','EGGS 24 CT',6.20);
 assert.equal(E.frequentPurchases([r,second]).find(x=>x.key==='group:eggs').receipts,2);
});
test('unallocated coupon is not silently subtracted from product prices',()=>{
 const r=sample('publix','101','2026-11-01','EGGS 12 CT',3.99,1,[{amount:1,allocation_status:'unallocated'}]);
 const x=E.priceObservation(r,r.receipt_items[0]);
 assert.equal(x.discountPending,true);
 assert.equal(x.perUnit,Number((3.99/12).toFixed(6)));
});
test('known Bounty bundle uses total sheets, not sheets per roll',()=>{
 const result=E.inferMetadata({retailer:'sams',retailer_item_code:'0990559143',receipt_description:'BOUNTY 12=4',matched_title:'Bounty 12 rolls, 149 sheets/roll'});
 assert.equal(result.units,1788);
 assert.equal(result.unit,'sheet');
});
test('personal price history starts empty when there are no saved receipts',()=>{
 assert.deepEqual(E.allObservations([]),[]);
 assert.deepEqual(E.compareStores([],'eggs','2026-11-14'),[]);
});
