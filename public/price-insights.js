/* BasketPilot v0.9 private receipt analytics — RLS-backed, browser-based, no community writes. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
const sb=createClient('https://vfctfvbufuvmbxnrfmaj.supabase.co','sb_publishable_c_5T1bCL67YOtiHAHvGn_Q_czQOk9sv',
  {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const E=window.BasketPilotInsightsCore;
const $=id=>document.getElementById(id);
const storeNames={costco:'Costco',sams:"Sam's Club",publix:'Publix',kroger:'Kroger'};
const colors={costco:'#13795d',sams:'#3657ac',publix:'#c07723',kroger:'#b45176'};
let user=null,receipts=[],busy=false;
const money=v=>'$'+Number(v).toFixed(2);
const perUnit=v=>'$'+Number(v).toFixed(3);
function node(tag,content,parent,className){
 const n=document.createElement(tag);if(content!==null&&content!==undefined)n.textContent=String(content);
 if(className)n.className=className;if(parent)parent.appendChild(n);return n;
}
function clean(root){root.replaceChildren();}
function show(el,yes){el.classList.toggle('hidden',!yes);}
function report(msg){$('auth-message').textContent=msg;}
function msgText(err){return err?.message||String(err||'Unknown error');}
function metric(label,val){const m=node('div',null,$('metrics'),'metric');node('small',label,m);node('b',val,m);}
function storeLabel(o){const name=storeNames[o.retailer]||o.retailer||'Unknown';return name+(o.storeId?' · '+o.storeId:' · Store unspecified');}
function getSelection(){return $('group').value||'eggs';}
function populateGroups(){clean($('group'));for(const g of E.GROUPS){const opt=node('option',g.label,$('group'));opt.value=g.id;} $('group').value='eggs';}
function renderOverview(){
 clean($('metrics'));
 metric('Receipts saved',String(receipts.length));
 metric('Total receipt spend',money(receipts.reduce((n,r)=>n+Number(r.total||0),0)));
 metric('Identified product groups',String(new Set(E.allObservations(receipts).map(o=>o.group)).size));
 metric('Store locations observed',String(new Set(receipts.map(r=>r.retailer+'|'+(r.store_id||'?'))).size));
 $('overview-note').textContent=receipts.length?'Based on your latest '+receipts.length+' saved receipts (maximum 300 loaded). Includes all receipt purchases, not groceries only.':'No receipt data yet. Save your first receipt to begin personal purchase analytics.';
}
function renderScores(){
 const root=$('store-scores');clean(root);const group=getSelection(),info=E.groupInfo(group);
 const rows=E.compareStores(receipts,group),stores=new Set(rows.map(x=>x.retailer));
 if(!rows.length){
  node('p', 'No comparable '+info.label.toLowerCase()+' prices yet. Save a receipt that includes the carton or package size, or confirm the size below.',root,'muted');
  $('coverage').textContent='No store comparison is possible without at least one receipt with a known quantity and package size.';
  return;
 }
 rows.forEach((o,i)=>{
  const el=node('div',null,root,'score'+(i===0&&rows.length>1?' best':''));
  const top=node('div',null,el,'flex'),left=node('div',null,top);
  node('strong',storeLabel(o),left);
  node('p',o.date+(o.stale?' · Older price':' · Past purchase'),left,'small');
  const val=node('div',null,top);
  node('div',perUnit(o.perUnit)+' / '+info.unit,val,'price');
  node('div',money(o.amount)+' line price',val,'small');
  const detail=node('p',o.description+' · '+o.packUnits+' '+info.unit+' per package · Qty '+o.qty,el,'detail');
  if(o.discountPending)node('p','This receipt has an unallocated discount. The item price shown is before that discount.',el,'small');
  if(o.stale)node('p','This observation is over 45 days old. Verify the current shelf price before deciding.',el,'small');
  if(i===0&&rows.length>1)node('p','Lowest most-recent observed unit price among your saved stores.',el,'small');
 });
 const missing=['costco','sams','publix','kroger'].filter(x=>!stores.has(x));
 $('coverage').textContent=(rows.length===1?'Only one store observation: upload a comparable purchase from another store to compare. ':rows.length+' store locations with comparable purchases. ')
   +(missing.length?'No comparable receipts yet from '+missing.map(x=>storeNames[x]).join(', ')+'. ':'')
   +'Different egg grades or product formulations may not be directly equivalent.';
}
function svgTag(tag,attrs,parent,caption){
 const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [k,v] of Object.entries(attrs||{}))el.setAttribute(k,String(v));
 if(caption!==undefined)el.textContent=caption;
 if(parent)parent.appendChild(el);return el;
}
function renderChart(){
 const group=getSelection(),info=E.groupInfo(group),range=$('range').value;
 let data=E.allObservations(receipts).filter(o=>o.valid&&o.group===group);
 if(range!=='all'){const cutoff=Date.now()-Number(range)*86400000;data=data.filter(o=>o.ts>=cutoff);}
 clean($('price-chart'));clean($('price-legend'));
 if(!data.length){$('trend-note').textContent='No chartable purchases yet. We need a receipt with a purchase date, an item amount and a known package size.';return;}
 const dates=new Set(data.map(o=>o.date));
 $('trend-note').textContent=dates.size<2?'One purchase date available. Save a receipt from another day to start a price trend.':
 'Historical '+info.label.toLowerCase()+' prices per '+info.unit+' from your own receipts. Lines connect observations within the same store.';
 const svg=svgTag('svg',{viewBox:'0 0 640 270',role:'img','aria-label':'Historical '+info.label+' unit prices from dated receipts'},$('price-chart'));
 const left=76,right=616,top=23,bottom=221;
 let ymin=Math.min(...data.map(o=>o.perUnit)),ymax=Math.max(...data.map(o=>o.perUnit));
 const pad=Math.max((ymax-ymin)*.17,.025);ymin=Math.max(0,ymin-pad);ymax+=pad;
 let tMin=Math.min(...data.map(o=>o.ts)),tMax=Math.max(...data.map(o=>o.ts));
 if(tMax===tMin){tMin-=86400000;tMax+=86400000;}
 const x=o=>left+(o.ts-tMin)/(tMax-tMin)*(right-left);
 const y=o=>bottom-(o.perUnit-ymin)/(ymax-ymin)*(bottom-top);
 for(let i=0;i<=4;i++){
  const yy=top+(bottom-top)*i/4;const amount=ymax-(ymax-ymin)*i/4;
  svgTag('line',{x1:left,y1:yy,x2:right,y2:yy,stroke:'#dce6dc','stroke-width':1},svg);
  svgTag('text',{x:5,y:yy+4,fill:'#677f70','font-size':12},svg,money(amount));
 }
 svgTag('text',{x:left,y:255,fill:'#677f70','font-size':12},svg,new Date(tMin).toISOString().slice(0,10));
 svgTag('text',{x:right,y:255,'text-anchor':'end',fill:'#677f70','font-size':12},svg,new Date(tMax).toISOString().slice(0,10));
 const byStore=new Map();
 for(const o of data){const k=o.retailer+'|'+(o.storeId||'?');if(!byStore.has(k))byStore.set(k,[]);byStore.get(k).push(o);}
 for(const arr of byStore.values()){
  arr.sort((a,b)=>a.ts-b.ts);
  const col=colors[arr[0].retailer]||'#5a7a6b';
  if(arr.length>=2)svgTag('polyline',{points:arr.map(o=>x(o).toFixed(1)+','+y(o).toFixed(1)).join(' '),fill:'none',stroke:col,'stroke-width':3,'stroke-linejoin':'round','stroke-linecap':'round'},svg);
  for(const o of arr){const dot=svgTag('circle',{cx:x(o),cy:y(o),r:5,fill:col,stroke:'white','stroke-width':2},svg);
    svgTag('title',{},dot,storeLabel(o)+' — '+o.date+': '+perUnit(o.perUnit)+'/'+info.unit+(o.discountPending?' (before unallocated discounts)':''));}
  const key=node('span',null,$('price-legend'));const color=node('span',null,key,'swatch');color.style.background=col;node('span',storeLabel(arr[0]),key);
 }
}
function renderFrequent(){
 clean($('frequent'));const result=E.frequentPurchases(receipts).slice(0,12);
 if(!result.length){node('li','No repeat purchases detected yet. Save receipts to reveal your regular products.',$('frequent'));return;}
 for(const item of result){const line=node('li',null,$('frequent'));node('span',item.label,line);node('strong',item.receipts+' receipt'+(item.receipts===1?'':'s'),line);}
}
function renderCorrections(){
 const root=$('corrections');clean(root);const pending=[];
 for(const r of receipts)for(const item of r.receipt_items||[]){
  const guess=E.inferMetadata({...item,retailer:r.retailer});
  const group=item.analytics_group||guess.group;
  const n=Number(item.package_units??guess.units);
  const unit=item.unit_kind||guess.unit;
  const meta=E.groupInfo(group);
  if(!group||!meta||!(n>0)||unit!==meta.unit)pending.push({r,item,guess});
 }
 if(!pending.length){node('p','No missing package-size information in your recognized products.',root,'muted');return;}
 node('p',pending.length+' line item(s) need confirmation to contribute to apples-to-apples unit comparisons. Showing up to 30.',root,'muted');
 for(const {r,item,guess} of pending.slice(0,30)){
  const card=node('div',null,root,'correction');
  node('strong',item.matched_title||item.receipt_description,card);
  node('p',(storeNames[r.retailer]||r.retailer)+' · '+(r.purchase_date||'Date missing')+' · '+money(item.gross_line_total)+' line price',card,'small');
  const fields=node('div',null,card,'fields');
  const groupSelect=node('select',null,fields);
  const unknown=node('option','Choose category',groupSelect);unknown.value='';
  for(const g of E.GROUPS){const option=node('option',g.label,groupSelect);option.value=g.id;}
  groupSelect.value=item.analytics_group||guess.group||'';
  groupSelect.setAttribute('aria-label','Product category');
  const size=node('input',null,fields);size.type='number';size.min='.001';size.step='.001';size.placeholder='Pack count';size.setAttribute('aria-label','Units per package');
  size.value=String(item.package_units??guess.units??'');
  const save=node('button','Save size',fields);save.type='button';
  const note=node('p','Choose a comparable group and enter number of '+(E.groupInfo(groupSelect.value)?.unit||'units')+' per package.',card,'small');
  groupSelect.addEventListener('change',()=>{if(groupSelect.value!==(item.analytics_group||guess.group))size.value='';note.textContent='Enter number of '+(E.groupInfo(groupSelect.value)?.unit||'units')+' per package.';});
  save.addEventListener('click',async()=>{
   const g=groupSelect.value,n=Number(size.value),info=E.groupInfo(g);
   if(!info||!Number.isFinite(n)||n<=0||n>100000){note.textContent='Choose a category and enter a positive number of units per package.';return;}
   save.disabled=true;note.textContent='Saving your correction privately…';
   const result=await sb.from('receipt_items').update({analytics_group:g,package_units:n,unit_kind:info.unit,normalization_source:'user_confirmed'}).eq('id',item.id);
   if(result.error){note.textContent='Could not save: '+msgText(result.error);save.disabled=false;return;}
   await loadHistory();
  });
 }
}
function renderAll(){renderOverview();renderScores();renderChart();renderFrequent();renderCorrections();show($('getting-started'),receipts.length===0);}
async function loadHistory(){
 if(!user)return;
 $('overview-note').textContent='Loading your private receipt history…';
 const result=await sb.from('receipts').select('id,retailer,store_id,purchase_date,created_at,total,receipt_items(id,retailer_item_code,receipt_description,matched_title,quantity,gross_line_total,analytics_group,package_units,unit_kind,normalization_source),receipt_discounts(amount,allocation_status)').order('created_at',{ascending:false}).limit(300);
 if(result.error){$('overview-note').textContent='Could not load history: '+msgText(result.error);return;}
 receipts=result.data||[];renderAll();
}
async function checkAuth(){
 const result=await sb.auth.getUser();user=result.error?null:result.data?.user||null;
 show($('auth-card'),!user);show($('dashboard'),!!user);show($('getting-started'),!user||receipts.length===0);
 if(user){$('who').textContent='Private account: '+(user.email||'Signed in');await loadHistory();}
 else{receipts=[];report('Sign in to see your personal receipt history. Nothing is publicly shared.');}
}
async function signin(create){
 const email=$('email').value.trim().toLowerCase(),password=$('password').value;
 if(!email||password.length<10){report('Enter your email and a password of at least 10 characters.');return;}
 if(busy)return;busy=true;$('login').disabled=true;$('register').disabled=true;
 report(create?'Creating your account…':'Signing in…');
 try{const result=create?await sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin+'/insights.html'}}):await sb.auth.signInWithPassword({email,password});
  if(result.error)throw result.error;
  if(create&&!result.data?.session){report('Check your email to confirm the account, then sign in. Supabase free email limits may apply.');}
  else await checkAuth();
 }catch(err){report('Authentication failed: '+msgText(err));}
 finally{busy=false;$('login').disabled=false;$('register').disabled=false;}
}
$('login').addEventListener('click',()=>signin(false));
$('register').addEventListener('click',()=>signin(true));
$('password').addEventListener('keydown',e=>{if(e.key==='Enter')signin(false);});
$('refresh').addEventListener('click',loadHistory);
$('group').addEventListener('change',()=>{renderScores();renderChart();});
$('range').addEventListener('change',renderChart);
$('logout').addEventListener('click',async()=>{const res=await sb.auth.signOut();if(res.error){$('who').textContent=msgText(res.error);return;}await checkAuth();});
populateGroups();
sb.auth.onAuthStateChange(event=>{if(['SIGNED_IN','SIGNED_OUT','TOKEN_REFRESHED'].includes(event))setTimeout(()=>checkAuth().catch(()=>{}),0);});
checkAuth().catch(err=>report('Account connection unavailable: '+msgText(err)));
