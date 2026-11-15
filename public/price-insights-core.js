/* BasketPilot personal price history — reads RLS-protected receipts only.
   No live price claims or public receipt sharing. */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.BasketPilotInsightsCore=api;
})(typeof window!=='undefined'?window:null,function buildInsightsEngine(){
"use strict";
const GROUPS=[
{id:"eggs",label:"Eggs",unit:"egg"},
{id:"milk",label:"Milk",unit:"fl_oz"},
{id:"paper_towels",label:"Paper towels",unit:"sheet"},
{id:"dishwasher_pods",label:"Dishwasher pods",unit:"pod"},
{id:"oatmeal",label:"Oatmeal",unit:"packet"},
{id:"hot_dogs",label:"Hot dogs",unit:"count"},
{id:"sausage_links",label:"Sausage links",unit:"count"}];
const groupInfo=id=>GROUPS.find(x=>x.id===id)||null;
function inferMetadata(row){
 const d=String(row.receipt_description??row.description??"");
 const title=String(row.matched_title??row.catalogMatch?.title??"");
 const s=(d+" "+title).toUpperCase().replace(/\s+/g," ");
 let group=null;
 if(/\bEGGS?\b/.test(s)&&!/\b(?:EGG ROLLS?|EGG NOG|EGGNOG|EGG SALAD|EGG NOODLES?|EGG BITES)\b/.test(s))group="eggs";
 else if(/\bMILK\b/.test(s)&&!/\b(?:POWDER|ALMOND|OAT MILK|COCONUT MILK|CHOCOLATE MILK|MILK CHOCOLATE|MILK BONE)\b/.test(s))group="milk";
 else if(/\b(?:PAPER TOWELS?|PPR TWL|BOUNTY)\b/.test(s))group="paper_towels";
 else if(/\b(?:DISHWASHER PODS?|CASCADE PLATINUM)\b/.test(s))group="dishwasher_pods";
 else if(/\b(?:OATMEAL|IQO VAR)\b/.test(s))group="oatmeal";
 else if(/\b(?:BEEF FRANKS?|HOT DOGS?|BP BEEF)\b/.test(s))group="hot_dogs";
 else if(/\b(?:SAUSAGE LINKS?|FC LINKS)\b/.test(s))group="sausage_links";
 if(!group)return {group:null,units:null,unit:null,source:null};
 const unit=groupInfo(group).unit;
 let units=null,source=null;
 const catalogQty=Number(row.catalogPackQty??row.catalog_pack_qty);
 if(Number.isFinite(catalogQty)&&catalogQty>0&&String(row.catalogPackUnit??row.catalog_pack_unit??"").toLowerCase()===unit){units=catalogQty;source="verified_catalog";}
 if(units===null){
  if(group==="eggs"){
   const m=s.match(/\b(?:6|12|18|24|30|36|48|60)\s*(?:CT|COUNT|PK|PACK|EGGS)\b/)||s.match(/\bEGGS?\b[^\d]{0,18}\b(?:6|12|18|24|30|36|48|60)\b/);
   if(m){const n=m[0].match(/6|12|18|24|30|36|48|60/);units=Number(n[0]);source="receipt_inferred";}
   else if(/\b2\s*DOZ(?:EN)?\b/.test(s)){units=24;source="receipt_inferred";}
   else if(/\b(?:1\s*)?DOZ(?:EN)?\b/.test(s)){units=12;source="receipt_inferred";}
  }else if(group==="milk"){
   if(/\bHALF\s*GAL(?:LON)?\b/.test(s)){units=64;source="receipt_inferred";}
   else if(/\b(?:1\s*)?GAL(?:LON)?\b/.test(s)){units=128;source="receipt_inferred";}
   else {const m=s.match(/\b(16|32|64|96|128)\s*(?:FL\s*OZ|FLOZ)\b/);if(m){units=Number(m[1]);source="receipt_inferred";}}
  }else if(group==="paper_towels"){
   const m=s.match(/\b(\d{2,5})\s*SHEETS?\b/);if(m){units=Number(m[1]);source="receipt_inferred";}
  }else{
   const m=s.match(/\b(\d{1,4})\s*(?:CT|COUNT)\b/);if(m){units=Number(m[1]);source="receipt_inferred";}
  }
 }
 return {group,units,unit,source};
}
function priceObservation(receipt,item){
 const guessed=inferMetadata(item),group=String(item.analytics_group||guessed.group||""),info=groupInfo(group);
 if(!info)return null;
 const pack=Number(item.package_units??guessed.units),unit=String(item.unit_kind||guessed.unit||"");
 const qty=Number(item.quantity),paid=Number(item.gross_line_total),date=String(receipt.purchase_date||"").slice(0,10);
 const ts=Date.parse(date+"T12:00:00Z");
 const valid=unit===info.unit&&Number.isFinite(pack)&&pack>0&&Number.isFinite(qty)&&qty>0&&Number.isFinite(paid)&&paid>=0&&Number.isFinite(ts)&&/^\d{4}-\d{2}-\d{2}$/.test(date);
 const disc=receipt.receipt_discounts||[];
 return {id:String(item.id||""),receiptId:String(receipt.id||""),group,category:info.label,unit:info.unit,
   valid,perUnit:valid?Number((paid/(pack*qty)).toFixed(6)):null,
   retailer:String(receipt.retailer||""),storeId:String(receipt.store_id||"").trim(),date,ts,
   amount:Number.isFinite(paid)?paid:null,packUnits:pack>0?pack:null,qty,description:String(item.matched_title||item.receipt_description||""),
   source:item.normalization_source||guessed.source||null,
   discountPending:disc.some(d=>String(d.allocation_status||"unallocated")!=="confirmed")};
}
function allObservations(receipts){const out=[];for(const r of receipts||[])for(const item of r.receipt_items||[]){const o=priceObservation(r,item);if(o)out.push(o);}return out.sort((a,b)=>a.ts-b.ts);}
function compareStores(receipts,group,nowISO){
 const latest=new Map();
 for(const o of allObservations(receipts))if(o.group===group&&o.valid){const k=o.retailer+"|"+(o.storeId||"unknown");if(!latest.has(k)||latest.get(k).ts<=o.ts)latest.set(k,o);}
 const now=Date.parse((nowISO||new Date().toISOString().slice(0,10))+"T12:00:00Z");
 return [...latest.values()].sort((a,b)=>a.perUnit-b.perUnit).map(o=>({...o,daysOld:Number.isFinite(now)?Math.round((now-o.ts)/86400000):null,stale:Number.isFinite(now)&&(now-o.ts)>45*86400000}));
}
function frequentPurchases(receipts){
 const count=new Map();for(const r of receipts||[]){const seen=new Set();
  for(const item of r.receipt_items||[]){
   const o=priceObservation(r,item),sku=String(item.retailer_item_code||"");
   const key=o?.group?"group:"+o.group:sku?"sku:"+r.retailer+":"+sku:null;
   if(!key||seen.has(key))continue;seen.add(key);
   const label=o?.group?groupInfo(o.group).label:String(item.matched_title||item.receipt_description||"Product");
   if(!count.has(key))count.set(key,{key,label,receipts:0});count.get(key).receipts++;
  }
 }
 return [...count.values()].sort((a,b)=>b.receipts-a.receipts||a.label.localeCompare(b.label));
}
return Object.freeze({GROUPS,groupInfo,inferMetadata,priceObservation,allObservations,compareStores,frequentPurchases});
});
