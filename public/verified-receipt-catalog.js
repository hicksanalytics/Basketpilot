/* Exact product identity reference for verified Sam's Club and Costco item numbers.
   No user receipt data, transactions, prices, or API keys. Never infer identity from label alone. */
(function(root){
 'use strict';
 const products=Object.freeze({
  sams:Object.freeze({
   '0000385385':Object.freeze({id:'385385',title:'Ball Park Beef Franks, 24 ct, 2.81 lb',status:'verified'}),
   '0000866624':Object.freeze({id:'866624',title:'Quaker Instant Oatmeal Variety Pack, 52 packets',status:'verified'}),
   '0980131133':Object.freeze({id:'980131133',title:'Vicks DayQuil & NyQuil Severe LiquiCaps, 72 ct',status:'verified'}),
   '0990420247':Object.freeze({id:'990420247',title:'Jimmy Dean Fully Cooked Original Pork Sausage Links, 48 ct',status:'verified'}),
   '0990514345':Object.freeze({id:'990514345',title:'Ms. Rachel Official Birthday Party Playset with Plush',status:'verified'}),
   '0990559143':Object.freeze({id:'990559143',title:'Bounty Select-A-Size 2-Ply Paper Towels, 12 rolls, 149 sheets/roll',status:'verified'})
  }),
  costco:Object.freeze({
   '782796':Object.freeze({id:'782796',title:'Kirkland Signature Purified Drinking Water, 40 × 16.9 fl oz',status:'verified'}),
   '427381':Object.freeze({id:'427381',title:'Kirkland Signature Organic Large Eggs, 24 ct',status:'verified'}),
   '1068080':Object.freeze({id:'1068080',title:'Kirkland Signature Organic Pasture-Raised Large Eggs, 24 ct',status:'verified'}),
   '1068083':Object.freeze({id:'1068083',title:'Kirkland Signature Organic Free-Range Large Eggs, 24 ct',status:'verified'}),
   '897971':Object.freeze({id:'897971',title:'Kirkland Signature Organic Applesauce Pouches, 24 × 3.17 oz',status:'verified'}),
   '1975527':Object.freeze({id:'1975527',title:'Kirkland Signature Ultra-Filtered Lactose-Free 2% Milk, 3 × 64 fl oz',status:'verified'})
  })
 });
 function lookup(retailer,code){
   const key=String(retailer||'').toLowerCase();
   const itemCode=String(code||'').trim();
   if(!Object.hasOwn(products,key)||!/^\d{4,14}$/.test(itemCode))return null;
   return products[key][itemCode] || null;
 }
 function resolveSavedItem(retailer,item){
   if(item.match_status==='verified')return item.matched_title
     ? {id:item.matched_product_id,title:item.matched_title,status:'verified'} : null;
   return lookup(retailer,item.retailer_item_code);
 }
 const api=Object.freeze({lookup,resolveSavedItem});
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.BasketPilotVerifiedCatalog=api;
})(typeof window!=='undefined'?window:null);
