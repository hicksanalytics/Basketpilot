/* Exact product identity reference, intentionally limited to six publicly verified Sam's Club item numbers.
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
  })
 });
 function lookup(retailer,code){
   const map=products[String(retailer||'').toLowerCase()];
   return map?.[String(code||'').trim()] || null;
 }
 root.BasketPilotVerifiedCatalog=Object.freeze({lookup});
})(typeof window!=='undefined'?window:{});
