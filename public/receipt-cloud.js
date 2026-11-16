/* BasketPilot v0.8 private receipt history. No service-role key, no community sharing. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
const projectUrl='https://vfctfvbufuvmbxnrfmaj.supabase.co';
const publishableKey='sb_publishable_c_5T1bCL67YOtiHAHvGn_Q_czQOk9sv';
const sb=createClient(projectUrl,publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
// The isolated test build injects its synthetic transport here.
const receiptCommunity = null;
const $=id=>document.getElementById(id);
const state={user:null,busy:false,imageURL:null,pendingSave:false};
const storeNames={sams:"Sam's Club",costco:'Costco',publix:'Publix',kroger:'Kroger'};
const sanitizeText=(s,max=180)=>String(s??'').trim().slice(0,max);
const number=n=>n==null||n===''?null:Number(Number(n).toFixed(2));
const money=n=>n===null||n===undefined?'—':'$'+Number(n).toFixed(2);
function status(msg){$('cloud-status').textContent=msg;}
function authStatus(msg){$('auth-status').textContent=msg;}
function busy(value){state.busy=value;for(const id of ['auth-register','auth-login','cloud-refresh'])$(id).disabled=value;$('cloud-save').disabled=value||!state.user;}
function appendText(parent,tag,value,cls){const n=document.createElement(tag);n.textContent=String(value??'');if(cls)n.className=cls;parent.appendChild(n);return n;}
function visible(el,yes){el.classList.toggle('hidden',!yes);}
function input(){return {email:$('auth-email').value.trim().toLowerCase(),password:$('auth-password').value};}
function readableError(error){const raw=error?.message||String(error||'Unknown error');if(/email address not authorized/i.test(raw))return 'Supabase’s free email service currently accepts only project team email addresses. Use the email on your Supabase team.';return raw;}
function clearReviewCommunity(){const host=$('review-community');host.replaceChildren();host.hidden=true;}
async function currentUser(){const {data,error}=await sb.auth.getUser();const nextUser=error?null:data?.user||null;if(state.user?.id!==nextUser?.id){clearReviewCommunity();resetHistory();}state.user=nextUser;return state.user;}
async function refreshAuth(){await currentUser();visible($('cloud-auth'),!state.user);visible($('cloud-signed-in'),!!state.user);$('auth-who').textContent=state.user?.email||'Signed in';$('cloud-save').disabled=!state.user||state.busy;if(state.user)await loadHistory();else resetHistory();}
async function register(){const {email,password}=input();if(!email||password.length<10){authStatus('Enter your email and a password of at least 10 characters.');return;}busy(true);authStatus('Creating your account…');
 try{const {data,error}=await sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin+'/receipts.html'}});if(error)throw error;authStatus(data?.session?'Account created. Signed in.':'Check your email to confirm, then return here and sign in. If the confirmation opens a default localhost page, return here manually.');await refreshAuth();if(state.pendingSave&&state.user){state.pendingSave=false;await save();}}catch(err){authStatus(readableError(err));}finally{busy(false);}}
async function login(){const {email,password}=input();if(!email||!password){authStatus('Enter email and password.');return;}busy(true);authStatus('Signing in…');try{const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;authStatus('Signed in.');await refreshAuth();if(state.pendingSave&&state.user){state.pendingSave=false;await save();}}catch(err){authStatus(readableError(err));}finally{busy(false);}}
async function logout(){const {error}=await sb.auth.signOut();if(error){authStatus(readableError(error));return;}state.user=null;clearReviewCommunity();resetHistory();status('Signed out. Your saved receipts remain private in Supabase.');await refreshAuth();}
function snapshot(){return window.BasketPilotReceiptBridge?.getPayload?.()||null;}
function validatedSnapshot(){const info=snapshot();if(!info?.valid||!info.parsed||!info.retailer||!info.purchaseDate)throw Error('Scan or paste your receipt and correct any missing retailer, date, quantity or price.');
 if(info.isSample)throw Error('The fictional sample cannot be saved to your real purchase history. Upload a receipt or paste actual receipt text.');
 const items=(info.parsed.items||[]).map(item=>({...item})),discounts=(info.parsed.discounts||[]).map(discount=>({...discount}));if(!items.length||items.length>400||items.length+discounts.length>400)throw Error('Receipt must have 1–400 reviewed lines.');
 const gross=items.reduce((n,x)=>n+Number(x.lineTotal),0),saved=discounts.reduce((n,x)=>n+Number(x.lineTotal),0);
 const reconciled=info.parsed.subtotal!==null&&Math.abs(gross-saved-Number(info.parsed.subtotal))<=.05;
 return {...info,parsed:{...info.parsed},items,discounts,reconciled};}
async function fingerprint(data){const payload=[data.retailer,data.storeId,data.purchaseDate,data.parsed.total??null,data.items.map(x=>[x.sku,x.description,x.quantity,x.lineTotal]),data.discounts.map(x=>[x.description,x.lineTotal])];const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function imageMeta(file){if(!file)return null;const mime=(file.type||'').toLowerCase();const suffix={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime];if(!suffix)throw Error('For private photo storage use JPG, PNG or WebP, or uncheck Keep original photo.');if(file.size>8*1024*1024)throw Error('Original photo exceeds 8 MB; choose a smaller photo or uncheck image storage.');return {mime,suffix};}

function showSavedReview(receiptId, owner, reviewRevision) {
  if (state.user?.id !== owner) return;
  $('receipt-view-insights').classList.remove('hidden');
  if (!receiptCommunity || snapshot()?.reviewRevision !== reviewRevision) return;
  const host = $('review-community');
  host.hidden = false;
  receiptCommunity.mount(host, receiptId, { expanded: true });
}

async function reopenExistingReceipt(owner, receiptFingerprint, review) {
  const { data: receipt, error } = await sb.from('receipts')
    .select('id,receipt_items(id),receipt_discounts(id)')
    .eq('owner_id', owner)
    .eq('receipt_fingerprint', receiptFingerprint)
    .maybeSingle();
  if (state.user?.id !== owner) return;
  if (error || !receipt) {
    status('Could not confirm the original save. Check your private history or try again.');
    return;
  }
  if (receipt.receipt_items?.length !== review.items.length || receipt.receipt_discounts?.length !== review.discounts.length) {
    status('This receipt is in your history, but its saved line count differs. Check its details before trying again.');
    await loadHistory();
    return;
  }
  status('This receipt is already in your private history.');
  showSavedReview(receipt.id, owner, review.reviewRevision);
  await loadHistory();
}

async function save(){if(!state.user){status('Sign in before saving.');return;}let data;try{data=validatedSnapshot();if($('cloud-photo').checked&&data.file)imageMeta(data.file);}catch(err){status(readableError(err));return;}
 const owner=state.user.id;
 const keepPhoto=$('cloud-photo').checked;
 clearReviewCommunity();busy(true);status('Saving reviewed items privately…');let receiptId=null;try{
 const receipt_fingerprint=await fingerprint(data);
 const header={owner_id:owner,retailer:data.retailer,store_id:sanitizeText(data.storeId,12)||null,purchase_date:data.purchaseDate,subtotal:number(data.parsed.subtotal),tax_total:number(data.parsed.tax),total:number(data.parsed.total),receipt_fingerprint,source_type:data.file?'receipt_image':'pasted_text',status:'pending_match',contribution_opt_in:false};
 const created=await sb.from('receipts').insert(header).select('id').single();
 if(created.error){if(created.error.code==='23505'){await reopenExistingReceipt(owner,receipt_fingerprint,data);return;}throw created.error;}
 receiptId=created.data.id;
 const itemRows=data.items.map((x,i)=>{
  const hint=window.BasketPilotInsightsCore?.inferMetadata?.({
    description:x.description,matched_title:x.catalogMatch?.title||'',
    retailer:data.retailer,retailer_item_code:x.sku
  })||{};
  return {receipt_id:receiptId,line_position:i,retailer_item_code:sanitizeText(x.sku,40)||null,
    receipt_description:sanitizeText(x.description,180),quantity:Number(x.quantity),
    gross_line_total:number(x.lineTotal),match_status:'unmatched',user_reviewed:true,
    analytics_group:hint.group||null,package_units:hint.units||null,unit_kind:hint.unit||null,
    normalization_source:hint.source||null};
 });
 const itemResult=await sb.from('receipt_items').insert(itemRows);if(itemResult.error)throw itemResult.error;
 if(data.discounts.length){const disRows=data.discounts.map((x,i)=>({receipt_id:receiptId,line_position:i,label:sanitizeText(x.description,180),amount:number(x.lineTotal),allocation_status:'unallocated'}));const dr=await sb.from('receipt_discounts').insert(disRows);if(dr.error)throw dr.error;}
 let imageNote='';
 if(keepPhoto&&data.file){const meta=imageMeta(data.file),path=owner+'/'+receiptId+'/original.'+meta.suffix;
   const up=await sb.storage.from('basketpilot-receipt-images').upload(path,data.file,{contentType:meta.mime,upsert:false});
   if(up.error)imageNote=' Original image was not saved: '+up.error.message;
   else{const update=await sb.from('receipts').update({photo_path:path}).eq('id',receiptId);if(update.error){await sb.storage.from('basketpilot-receipt-images').remove([path]);imageNote=' Image link failed; the image was removed.';}}
 }
 status('Saved '+itemRows.length+' items and '+data.discounts.length+' discounts privately.'+(data.reconciled?' Subtotal reconciled.':' Subtotal needs review.')+' View your updated product trends in My Prices. No community sharing.'+imageNote);
 showSavedReview(receiptId,owner,data.reviewRevision);
 await loadHistory();
 }catch(err){if(receiptId){const rollback=await sb.from('receipts').delete().eq('id',receiptId);status(rollback.error?'Save failed; a partial receipt may remain. Check history. ':'Save failed; no receipt was kept. '+readableError(err));}else status('Save failed: '+readableError(err));}
 finally{busy(false);}}
function receiptCard(r){const box=document.createElement('div');box.className='cloud-history-card';appendText(box,'strong',(storeNames[r.retailer]||r.retailer)+' · '+(r.purchase_date||'Date unknown'));appendText(box,'div',(r.store_id?'Store '+r.store_id+' · ':'')+money(r.total)+' · '+(r.receipt_items||[]).length+' items','muted');
 const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Purchased items and discounts';details.appendChild(summary);const ul=document.createElement('ul');
 for(const item of r.receipt_items||[])appendText(ul,'li',(item.retailer_item_code?'#'+item.retailer_item_code+' · ':'')+(item.match_status==='verified'&&item.matched_title?item.matched_title:item.receipt_description)+' · '+money(item.gross_line_total)+(item.match_status==='verified'?' (catalog item #'+item.matched_product_id+' verified)':' (needs catalog match)'));
 for(const d of r.receipt_discounts||[])appendText(ul,'li','Discount: '+d.label+' −'+money(d.amount));
 details.appendChild(ul);box.appendChild(details);const controls=document.createElement('div');controls.className='buttons';
 if(r.photo_path){const photo=document.createElement('button');photo.type='button';photo.className='button secondary';photo.textContent='View private image';photo.addEventListener('click',()=>viewPhoto(r));controls.appendChild(photo);}
 const del=document.createElement('button');del.type='button';del.className='button ghost';del.textContent='Delete receipt';del.addEventListener('click',()=>deleteReceipt(r));controls.appendChild(del);box.appendChild(controls);receiptCommunity?.mount(box,r.id);return box;}
const historyPageSize = 25;
let historyRequest = 0;
let nextHistoryPage = null;

function resetHistory() {
  historyRequest++;
  nextHistoryPage = null;
  $('cloud-history').replaceChildren();
  $('cloud-history-status').textContent = '';
  $('cloud-history-more').hidden = true;
  $('cloud-history-more').disabled = false;
}

async function loadHistory(older = false) {
  const owner = state.user?.id;
  const more = $('cloud-history-more');
  if (!owner || (older && (!nextHistoryPage || more.disabled))) return;
  if (!older) resetHistory();
  const request = ++historyRequest;
  const list = $('cloud-history');
  const message = $('cloud-history-status');
  more.disabled = true;
  message.textContent = older ? 'Loading older receipts…' : 'Loading saved receipts…';

  try {
    const query = sb.from('receipts')
      .select('id,retailer,store_id,purchase_date,total,photo_path,created_at,receipt_items(retailer_item_code,receipt_description,quantity,gross_line_total,match_status,matched_product_id,matched_title),receipt_discounts(label,amount)')
      .eq('owner_id', owner)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (older) {
      // Keep the database timestamp precision and break ties by receipt ID.
      const { created_at, id } = nextHistoryPage;
      query.or('created_at.lt.' + created_at + ',and(created_at.eq.' + created_at + ',id.lt.' + id + ')');
    }
    const { data, error } = await query.limit(historyPageSize + 1);
    if (state.user?.id !== owner || request !== historyRequest) return;
    if (error) throw error;

    const page = data.slice(0, historyPageSize);
    nextHistoryPage = data.length > historyPageSize ? page.at(-1) : null;
    more.hidden = !nextHistoryPage;
    if (!older && !page.length) {
      message.textContent = 'No saved receipts. Review a scan and choose Save privately.';
      return;
    }
    const cards = page.map(receiptCard);
    list.append(...cards);
    message.textContent = older ? (cards.length ? cards.length + ' older receipts loaded.' : 'You’ve reached the end of your history.') : '';
    if (older && cards.length) {
      const firstTitle = cards[0].querySelector('strong');
      firstTitle.tabIndex = -1;
      firstTitle.focus();
    }
  } catch {
    if (request === historyRequest) message.textContent = older
      ? 'Could not load older receipts. Try again.'
      : 'Could not load saved receipts. Refresh your history to try again.';
  } finally {
    if (request === historyRequest) more.disabled = false;
  }
}
async function viewPhoto(r){if(state.imageURL){URL.revokeObjectURL(state.imageURL);state.imageURL=null;}const {data,error}=await sb.storage.from('basketpilot-receipt-images').download(r.photo_path);if(error){status('Could not load image: '+readableError(error));return;}state.imageURL=URL.createObjectURL(data);const img=$('cloud-photo-preview');img.src=state.imageURL;visible(img,true);img.scrollIntoView({behavior:'smooth',block:'nearest'});}
async function deleteReceipt(r){if(!window.confirm('Permanently delete this saved receipt, its items and the optional photo?'))return;busy(true);try{if(r.photo_path){const remove=await sb.storage.from('basketpilot-receipt-images').remove([r.photo_path]);if(remove.error)throw remove.error;}const result=await sb.from('receipts').delete().eq('id',r.id);if(result.error)throw result.error;clearReviewCommunity();status('Receipt deleted.');if(state.imageURL){URL.revokeObjectURL(state.imageURL);state.imageURL=null;}visible($('cloud-photo-preview'),false);await loadHistory();}catch(err){status('Delete failed: '+readableError(err));}finally{busy(false);}}
async function saveOrPrompt(){
 if(state.busy){status('Saving is already in progress.');return;}
 if(!state.user){
  state.pendingSave=true;
  status('Sign in to your private account once, then this receipt can be saved.');
  $('private-cloud').scrollIntoView({behavior:'smooth',block:'start'});
  $('auth-email').focus();
  return;
 }
 await save();
}
window.BasketPilotCloud=Object.freeze({saveOrPrompt,refreshHistory:loadHistory});
$('auth-register').addEventListener('click',register);$('auth-login').addEventListener('click',login);$('auth-logout').addEventListener('click',logout);
$('cloud-save').addEventListener('click',save);$('cloud-refresh').addEventListener('click',()=>loadHistory());
$('cloud-history-more').addEventListener('click',()=>loadHistory(true));
$('auth-password').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
sb.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||(event==='SIGNED_IN'&&session?.user?.id!==state.user?.id))setTimeout(()=>refreshAuth(),0);});
refreshAuth().catch(e=>authStatus('Cloud unavailable: '+readableError(e)));
