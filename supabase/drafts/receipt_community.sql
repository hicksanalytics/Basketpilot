-- Isolated draft. Keep this outside supabase/migrations until rollout is approved.
begin;

create schema receipt_community;
revoke all on schema receipt_community from public, anon, authenticated;

create table receipt_community.verified_stores (
  retailer text not null,
  store_id text not null,
  location_name text not null,
  evidence_url text not null,
  primary key (retailer, store_id)
);

create table receipt_community.verified_packages (
  retailer text not null,
  receipt_item_code text not null,
  package_name text not null,
  evidence_url text not null,
  primary key (retailer, receipt_item_code)
);

create table receipt_community.consent_revisions (
  receipt_id uuid primary key references public.receipts(id) on delete cascade,
  revision integer not null check (revision > 0)
);

create table receipt_community.observations (
  receipt_item_id uuid primary key references public.receipt_items(id) on delete cascade,
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  retailer text not null,
  store_id text not null,
  receipt_item_code text not null,
  purchase_date date not null,
  package_price_cents integer not null check (package_price_cents > 0),
  foreign key (retailer, store_id)
    references receipt_community.verified_stores(retailer, store_id),
  foreign key (retailer, receipt_item_code)
    references receipt_community.verified_packages(retailer, receipt_item_code)
);

create index on receipt_community.observations (receipt_id);
create index on receipt_community.observations (retailer, receipt_item_code, purchase_date desc);

alter table receipt_community.verified_stores enable row level security;
alter table receipt_community.verified_packages enable row level security;
alter table receipt_community.consent_revisions enable row level security;
alter table receipt_community.observations enable row level security;

revoke all on all tables in schema receipt_community from public, anon, authenticated;

-- Keep the preview and insert on the same eligibility rules. This view is
-- internal to the draft; it exposes source IDs to neither browser role.
create view receipt_community.eligible_lines as
select i.id as receipt_item_id, r.id as receipt_id, s.retailer, s.store_id,
  p.receipt_item_code, r.purchase_date,
  (i.gross_line_total * 100 / nullif(i.quantity, 0))::integer as package_price_cents
from public.receipts r
join public.receipt_items i on i.receipt_id = r.id
join receipt_community.verified_packages p
  on p.retailer = r.retailer and p.receipt_item_code = i.retailer_item_code
join receipt_community.verified_stores s
  on s.retailer = r.retailer and s.store_id = r.store_id
where i.user_reviewed
  and i.quantity between 1 and 1000 and i.quantity = trunc(i.quantity)
  and i.gross_line_total between 0.01 and 20000
  and mod(i.gross_line_total * 100, nullif(i.quantity, 0)) = 0
  and isfinite(r.purchase_date)
  and r.purchase_date <= current_date
  and r.subtotal > 0
  and r.subtotal = (
    select sum(all_items.gross_line_total)
    from public.receipt_items all_items
    where all_items.receipt_id = r.id
  )
  and not exists (
    select 1 from public.receipt_discounts d where d.receipt_id = r.id
  );

revoke all on receipt_community.eligible_lines from public, anon, authenticated;

-- The revision is per receipt. A delayed share request cannot undo a later withdrawal.
-- The receipt lock serializes consent changes and a concurrent receipt deletion.
create function receipt_community.set_consent(
  p_receipt_id uuid,
  p_action text,
  p_expected_revision integer default null
)
returns table (outcome text, revision integer, observation_count integer, eligible_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_revision integer;
  v_count integer;
  v_eligible_count integer;
  v_outcome text;
begin
  if p_action is null or p_action not in ('status', 'share', 'withdraw')
    or (p_action <> 'status' and (p_expected_revision is null or p_expected_revision < 0)) then
    raise exception using errcode = '22023', message = 'Invalid consent request';
  end if;

  perform 1
  from public.receipts r
  where r.id = p_receipt_id and r.owner_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'Receipt unavailable';
  end if;

  select coalesce((
    select c.revision from receipt_community.consent_revisions c
    where c.receipt_id = p_receipt_id
  ), 0) into v_revision;

  select count(*)::integer into v_count
  from receipt_community.observations o
  where o.receipt_id = p_receipt_id;

  if p_action = 'status' or p_expected_revision <> v_revision then
    select count(*)::integer into v_eligible_count
    from receipt_community.eligible_lines e
    where e.receipt_id = p_receipt_id;
    v_outcome := case when p_action = 'status' then 'status' else 'stale' end;
    return query select v_outcome, v_revision, v_count, v_eligible_count;
    return;
  end if;

  if p_action = 'share' then
    if v_count > 0 then
      return query select 'shared', v_revision, v_count, null::integer;
      return;
    end if;

    -- Use independently curated store IDs and package codes. Client-supplied
    -- match labels, private barcode links, and discount allocations are not evidence.
    insert into receipt_community.observations (
      receipt_item_id, receipt_id, retailer, store_id, receipt_item_code,
      purchase_date, package_price_cents
    )
    select e.receipt_item_id, e.receipt_id, e.retailer, e.store_id,
      e.receipt_item_code, e.purchase_date, e.package_price_cents
    from receipt_community.eligible_lines e
    where e.receipt_id = p_receipt_id
    on conflict (receipt_item_id) do nothing;

    get diagnostics v_count = row_count;
    v_outcome := case when v_count = 0 then 'ineligible' else 'shared' end;
  else
    delete from receipt_community.observations o where o.receipt_id = p_receipt_id;
    v_count := 0;
    v_outcome := 'withdrawn';
  end if;

  v_revision := v_revision + 1;
  insert into receipt_community.consent_revisions (receipt_id, revision)
  values (p_receipt_id, v_revision)
  on conflict (receipt_id) do update set revision = excluded.revision;

  return query select v_outcome, v_revision, v_count, null::integer;
end;
$function$;

revoke all on function receipt_community.set_consent(uuid, text, integer)
  from public, anon, authenticated;
grant usage on schema receipt_community to authenticated;
grant execute on function receipt_community.set_consent(uuid, text, integer)
  to authenticated;

-- A future lookup endpoint can expose this projection after activation.
-- Identical visible prices collapse without revealing contribution counts.
create function receipt_community.package_price_history(
  p_retailer text,
  p_receipt_item_code text
)
returns table (
  retailer text, receipt_item_code text, package_name text, store_id text,
  location_name text, purchase_date date, package_price_cents integer
)
language sql
stable
set search_path = ''
as $function$
  select distinct o.retailer, o.receipt_item_code, p.package_name, o.store_id,
    s.location_name, o.purchase_date, o.package_price_cents
  from receipt_community.observations o
  join receipt_community.verified_packages p
    using (retailer, receipt_item_code)
  join receipt_community.verified_stores s
    on s.retailer = o.retailer and s.store_id = o.store_id
  where o.retailer = p_retailer and o.receipt_item_code = p_receipt_item_code
  order by o.purchase_date desc, o.store_id, o.package_price_cents
  limit 50
$function$;

revoke all on function receipt_community.package_price_history(text, text)
  from public, anon, authenticated;

commit;
