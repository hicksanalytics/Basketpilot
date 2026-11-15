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

alter table receipt_community.verified_stores enable row level security;
alter table receipt_community.verified_packages enable row level security;
alter table receipt_community.consent_revisions enable row level security;
alter table receipt_community.observations enable row level security;

revoke all on all tables in schema receipt_community from public, anon, authenticated;

-- The revision is per receipt. A delayed share request cannot undo a later withdrawal.
-- The receipt lock serializes consent changes and a concurrent receipt deletion.
create function receipt_community.set_consent(
  p_receipt_id uuid,
  p_action text,
  p_expected_revision integer default null
)
returns table (outcome text, revision integer, observation_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_receipt public.receipts%rowtype;
  v_revision integer;
  v_count integer;
  v_outcome text;
begin
  if p_action is null or p_action not in ('status', 'share', 'withdraw')
    or (p_action <> 'status' and (p_expected_revision is null or p_expected_revision < 0)) then
    raise exception using errcode = '22023', message = 'Invalid consent request';
  end if;

  select r.* into v_receipt
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

  if p_action = 'status' then
    return query select 'status', v_revision, v_count;
    return;
  end if;

  if p_expected_revision <> v_revision then
    return query select 'stale', v_revision, v_count;
    return;
  end if;

  if p_action = 'share' then
    if v_count > 0 then
      return query select 'shared', v_revision, v_count;
      return;
    end if;

    -- Use independently curated store IDs and package codes. Client-supplied
    -- match labels, private barcode links, and discount allocations are not evidence.
    insert into receipt_community.observations (
      receipt_item_id, receipt_id, retailer, store_id, receipt_item_code,
      purchase_date, package_price_cents
    )
    select i.id, v_receipt.id, s.retailer, s.store_id, p.receipt_item_code,
      v_receipt.purchase_date, (i.gross_line_total * 100 / nullif(i.quantity, 0))::integer
    from public.receipt_items i
    join receipt_community.verified_packages p
      on p.retailer = v_receipt.retailer and p.receipt_item_code = i.retailer_item_code
    join receipt_community.verified_stores s
      on s.retailer = v_receipt.retailer and s.store_id = v_receipt.store_id
    where i.receipt_id = p_receipt_id
      and i.user_reviewed
      and i.quantity between 1 and 1000 and i.quantity = trunc(i.quantity)
      and i.gross_line_total between 0.01 and 20000
      and mod(i.gross_line_total * 100, nullif(i.quantity, 0)) = 0
      and v_receipt.purchase_date <= current_date
      and v_receipt.subtotal > 0
      and v_receipt.subtotal = (
        select sum(all_items.gross_line_total)
        from public.receipt_items all_items
        where all_items.receipt_id = p_receipt_id
      )
      and not exists (
        select 1 from public.receipt_discounts d where d.receipt_id = p_receipt_id
      )
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

  return query select v_outcome, v_revision, v_count;
end;
$function$;

revoke all on function receipt_community.set_consent(uuid, text, integer)
  from public, anon, authenticated;
grant usage on schema receipt_community to authenticated;
grant execute on function receipt_community.set_consent(uuid, text, integer)
  to authenticated;

commit;
