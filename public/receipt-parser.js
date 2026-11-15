/* BasketPilot v0.8: local OCR parser. Product matches require verification. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BasketReceiptParser = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const stores = {
    costco: 'Costco', sams: "Sam's Club", publix: 'Publix', kroger: 'Kroger'
  };
  const moneyRE = '(-?\\$?\\d{1,5}\\.\\d{2}-?)';
  const moneyEnding = new RegExp('^(.+?)\\s+' + moneyRE + '(?:\\s*-?[A-Z]{1,2})?\\s*$');
  const controlRE = /(?:^|\s)(?:sub\s*total|subtotal|tax|sales tax|total|balance|amount due|tender|payment|visa|mastercard|debit|credit card|change|cash|authorization|transaction|trans(?:action)?\s*#|receipt\s*#|member(?:ship)?\s*(?:number|id|#)|loyalty|gift card|thank you|cashier|savings summary|phone|store\s*#|you saved)(?:\s|$|:)/i;
  const discountRE = /\b(?:coupon|bogo|discount|savings|save[d]?|digital deal|weekly ad|promotion|promo|mfr|rewards redeemed|reward adjustment|store credit|inst\s+sv)\b/i;

  function cleanLine(line) {
    return String(line || '').replace(/[\u00a0\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 180);
  }
  function parseMoney(input) {
    const s = String(input || '').trim();
    if (!/^-?\$?\d{1,5}\.\d{2}-?$/.test(s)) return null;
    const n = Number(s.replace(/[$-]/g, ''));
    if (!Number.isFinite(n) || n > 100000) return null;
    return s.includes('-') ? -n : n;
  }
  function detectRetailer(text) {
    const head = String(text || '').slice(0, 1200);
    if (/\bCOSTCO\b/i.test(head)) return 'costco';
    if (/\bSAM['’]?S(?:\s+CLUB)?\b/i.test(head)) return 'sams';
    if (/\bPUBLIX\b/i.test(head)) return 'publix';
    if (/\bKROGER\b/i.test(head)) return 'kroger';
    return '';
  }
  function extractDate(text) {
    const src = String(text || '').slice(0, 2000);
    let match = src.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
    let y, m, d;
    if (match) { y=Number(match[1]);m=Number(match[2]);d=Number(match[3]); }
    else {
      match=src.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|\d{2})\b/);
      if(!match) return '';
      m=Number(match[1]);d=Number(match[2]);y=Number(match[3]);if(y<100)y+=2000;
    }
    const date=new Date(Date.UTC(y,m-1,d));
    return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d ? date.toISOString().slice(0,10) : '';
  }
  function parseSummary(lines) {
    const out={subtotal:null,tax:null,total:null};
    for(const line of lines) {
      const m=line.match(moneyEnding);if(!m)continue;
      const value=parseMoney(m[2]);if(value===null||value<0)continue;
      const prefix=m[1].toUpperCase().replace(/[:*]/g,'').trim();
      if(/^SUB\s*TOTAL$|^SUBTOTAL$/.test(prefix))out.subtotal=value;
      else if(/^(?:SALES\s+)?TAX(?:\s+\d+\s+[\d.]+\s*%?)?$/.test(prefix))out.tax=Number(((out.tax||0)+value).toFixed(2));
      else if(/^(?:GRAND\s+)?TOTAL$|^TOTAL\s+DUE$|^AMOUNT\s+DUE$|^BALANCE\s+DUE$/.test(prefix))out.total=value;
    }
    return out;
  }
  function extractStoreId(text, retailer) {
    if (retailer !== 'sams') return '';
    // Sam's register header: date, time, register transaction, club number, lane.
    const head = String(text || '').slice(0, 1200);
    const m = head.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s+\d{1,8}\s+(\d{4})\s+\d{1,3}\b/);
    return m ? m[1] : '';
  }
  function parseLine(line, index) {
    const m=line.match(moneyEnding);
    if(!m) return null;
    const amount=parseMoney(m[2]);
    if(amount===null||Math.abs(amount)>20000) return null;
    let label=cleanLine(m[1]);
    if(!label||label.length<3||controlRE.test(label))return null;
    const isDiscount=discountRE.test(label)||amount<0;
    let sku='';
    const skuMatch=label.match(/^(\d{4,14})\s+(.+)$/);
    if(skuMatch){sku=skuMatch[1];label=cleanLine(skuMatch[2]);}
    let qty=1;
    const qtyMatch=label.match(/^(\d+(?:\.\d+)?)\s*[xX@]\s+(.+)$/);
    if(qtyMatch){qty=Number(qtyMatch[1]);label=cleanLine(qtyMatch[2]);}
    if(!label||qty<=0||qty>1000||label.length<2)return null;
    if(/^[\d\W]+$/.test(label))return null;
    const dollar=Math.abs(amount);
    return {
      id:'line-'+index,
      description:label,
      sku:sku,
      quantity:qty,
      lineTotal:Number(dollar.toFixed(2)),
      unitPrice:Number((dollar/qty).toFixed(2)),
      kind:isDiscount?'discount':'item',
      confidence:isDiscount?'review':sku?'medium':'review',
      requiresReview:true,
    };
  }
  function parseReceipt(text) {
    const raw=String(text||'').slice(0,70000);
    const lines=raw.split(/\r?\n/).map(cleanLine).filter(Boolean).slice(0,400);
    const summary=parseSummary(lines);
    const parsed=lines.map((line,i)=>parseLine(line,i)).filter(Boolean);
    const items=parsed.filter(x=>x.kind==='item');
    const discounts=parsed.filter(x=>x.kind==='discount');
    const gross=items.reduce((s,x)=>s+x.lineTotal,0);
    const savings=discounts.reduce((s,x)=>s+x.lineTotal,0);
    const net=Number((gross-savings).toFixed(2));
    const diff=summary.subtotal===null?null:Number((net-summary.subtotal).toFixed(2));
    const warnings=[];
    if(!items.length) warnings.push('No product lines recognized. Try a clearer photo or correct the text manually.');
    if(summary.subtotal===null) warnings.push('Subtotal was not confidently identified.');
    else if(Math.abs(diff)>0.02) warnings.push('Parsed lines do not reconcile to the receipt subtotal. Review missing items, taxes and discounts.');
    if(discounts.length) warnings.push('Discounts were detected but NOT allocated to individual products.');
    warnings.push('Product identities are not catalog-verified; do not use these amounts as public store prices.');
    return {
      retailer:detectRetailer(raw), retailerName:stores[detectRetailer(raw)]||'Unknown retailer',
      purchasedOn:extractDate(raw), storeId:extractStoreId(raw,detectRetailer(raw)), ...summary, items, discounts, recognizedLines:parsed.length,
      sourceLineCount:lines.length, parsedGross:Number(gross.toFixed(2)), parsedDiscounts:Number(savings.toFixed(2)),
      computedNet:net, subtotalDelta:diff, warnings, saved:false, catalogMatched:false,
    };
  }
  return {parseReceipt,parseLine,parseMoney,detectRetailer,extractDate,extractStoreId,stores};
});