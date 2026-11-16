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

-- The canonical representation is 14 digits, with leading zeroes for UPC-A
-- and EAN. Validate the GS1 check digit before enabling barcode lookup.
create function receipt_community.valid_package_gtin(p_gtin text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case when p_gtin ~ '^[0-9]{14}$' and p_gtin <> '00000000000000'
    then (
      select sum(substr(p_gtin, n, 1)::integer * case when n % 2 = 1 then 3 else 1 end) % 10 = 0
      from generate_series(1, 14) as digits(n)
    )
    else false
  end
$function$;

revoke all on function receipt_community.valid_package_gtin(text) from public, anon, authenticated;

create table receipt_community.verified_packages (
  retailer text not null,
  receipt_item_code text not null,
  package_name text not null,
  evidence_url text not null,
  package_gtin text,
  barcode_evidence_url text,
  constraint verified_packages_barcode_evidence check (
    (package_gtin is null and barcode_evidence_url is null)
    or (
      receipt_community.valid_package_gtin(package_gtin)
      and (barcode_evidence_url ~ '^https://[^[:space:]]+$') is true
    )
  ),
  primary key (retailer, receipt_item_code)
);

create index on receipt_community.verified_packages (package_gtin)
  where package_gtin is not null;

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

-- A hold stays with the private line through withdrawal and can be cleared
-- independently of consent. Deleting the line clears both records.
create table receipt_community.observation_holds (
  receipt_item_id uuid primary key references public.receipt_items(id) on delete cascade,
  reason text not null check (reason in ('suspect_price', 'package_mismatch', 'store_mismatch')),
  created_at timestamptz not null default now()
);

alter table receipt_community.verified_stores enable row level security;
alter table receipt_community.verified_packages enable row level security;
alter table receipt_community.consent_revisions enable row level security;
alter table receipt_community.observations enable row level security;
alter table receipt_community.observation_holds enable row level security;

revoke all on all tables in schema receipt_community from public, anon, authenticated;

-- The same checks drive the preview, exclusions, and inserts. Receipt-wide
-- checks take precedence over line checks. Source IDs stay internal.
create view receipt_community.checked_lines as
with receipts_checked as (
  select r.id, r.retailer, r.store_id, r.purchase_date,
    case
      when nullif(btrim(r.store_id), '') is null then 'store_missing'
      when s.store_id is null then 'store_unverified'
      when (isfinite(r.purchase_date) and r.purchase_date <= current_date) is not true then 'date_invalid'
      when exists (select 1 from public.receipt_discounts d where d.receipt_id = r.id) then 'discounts'
      when totals.item_count = 0 then 'no_items'
      when (r.subtotal > 0 and r.subtotal = totals.gross_total) is not true then 'subtotal'
    end as receipt_reason
  from public.receipts r
  left join receipt_community.verified_stores s
    on s.retailer = r.retailer and s.store_id = r.store_id
  cross join lateral (
    select count(*) as item_count, sum(i.gross_line_total) as gross_total
    from public.receipt_items i
    where i.receipt_id = r.id
  ) totals
), lines_checked as (
  select i.id as receipt_item_id, r.id as receipt_id, r.retailer, r.store_id,
    p.receipt_item_code, r.purchase_date, i.gross_line_total, i.quantity,
    coalesce(r.receipt_reason, case
      when h.receipt_item_id is not null then 'on_hold'
      when i.user_reviewed is not true then 'review'
      when p.receipt_item_code is null then 'package_unverified'
      when (
        i.quantity between 1 and 1000 and i.quantity = trunc(i.quantity)
        and i.gross_line_total between 0.01 and 20000
        and mod(i.gross_line_total * 100, nullif(i.quantity, 0)) = 0
      ) is not true then 'package_price'
    end) as exclusion_reason
  from receipts_checked r
  left join public.receipt_items i on i.receipt_id = r.id
  left join receipt_community.observation_holds h on h.receipt_item_id = i.id
  left join receipt_community.verified_packages p
    on p.retailer = r.retailer and p.receipt_item_code = i.retailer_item_code
)
select receipt_item_id, receipt_id, retailer, store_id, receipt_item_code,
  purchase_date, exclusion_reason,
  case when exclusion_reason is null then
    (gross_line_total * 100 / quantity)::integer
  end as package_price_cents
from lines_checked;

revoke all on receipt_community.checked_lines from public, anon, authenticated;

-- The revision is per receipt. A delayed share request cannot undo a later withdrawal.
-- The receipt lock serializes consent changes and a concurrent receipt deletion.
create function receipt_community.set_consent(
  p_receipt_id uuid,
  p_action text,
  p_expected_revision integer default null,
  p_preview_token text default null
)
returns table (
  outcome text, revision integer, observation_count integer, eligible_count integer,
  price_rows jsonb, preview_token text, exclusion_counts jsonb
)
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
  v_eligible receipt_community.checked_lines[];
  v_exclusions jsonb := '{}'::jsonb;
  v_price_rows jsonb := '[]'::jsonb;
  v_preview_token text;
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

  if p_action <> 'withdraw' or p_expected_revision <> v_revision then
    -- Capture eligible lines and exclusions together for a consistent preview.
    with checks as materialized (
      select l as line, l.exclusion_reason
      from receipt_community.checked_lines l
      where l.receipt_id = p_receipt_id
    )
    select
      (select array_agg(c.line) from checks c where c.exclusion_reason is null),
      (select coalesce(jsonb_object_agg(reasons.exclusion_reason, reasons.line_count), '{}'::jsonb)
        from (select c.exclusion_reason, count(*) as line_count
          from checks c where c.exclusion_reason is not null group by c.exclusion_reason) reasons)
    into v_eligible, v_exclusions;
    v_eligible_count := coalesce(cardinality(v_eligible), 0);

    with displayed as (
      select e.retailer, e.store_id, e.receipt_item_code, e.purchase_date, e.package_price_cents, false as on_hold
      from unnest(v_eligible) e where v_count = 0
      union all
      select o.retailer, o.store_id, o.receipt_item_code, o.purchase_date, o.package_price_cents,
        h.receipt_item_id is not null
      from receipt_community.observations o
      left join receipt_community.observation_holds h on h.receipt_item_id = o.receipt_item_id
      where o.receipt_id = p_receipt_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'retailer', d.retailer,
      'receipt_item_code', d.receipt_item_code,
      'package_name', p.package_name,
      'store_id', d.store_id,
      'location_name', s.location_name,
      'purchase_date', d.purchase_date,
      'package_price_cents', d.package_price_cents,
      'on_hold', d.on_hold
    ) order by p.package_name, d.receipt_item_code, d.purchase_date, d.package_price_cents), '[]'::jsonb)
    into v_price_rows
    from displayed d
    join receipt_community.verified_packages p using (retailer, receipt_item_code)
    join receipt_community.verified_stores s using (retailer, store_id);

    if v_count = 0 then
      v_preview_token := md5(v_price_rows::text);
    end if;
  end if;

  if p_action = 'status' or p_expected_revision <> v_revision then
    v_outcome := case when p_action = 'status' then 'status' else 'stale' end;
    return query select v_outcome, v_revision, v_count, v_eligible_count, v_price_rows, v_preview_token, v_exclusions;
    return;
  end if;

  if p_action = 'share' then
    if v_count > 0 then
      return query select 'shared', v_revision, v_count, null::integer, v_price_rows, null::text, '{}'::jsonb;
      return;
    end if;

    if p_preview_token is distinct from v_preview_token then
      return query select 'preview_changed', v_revision, v_count, v_eligible_count, v_price_rows, v_preview_token, v_exclusions;
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
    from unnest(v_eligible) e
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

  return query select v_outcome, v_revision, v_count, null::integer, v_price_rows, null::text, v_exclusions;
end;
$function$;

revoke all on function receipt_community.set_consent(uuid, text, integer, text)
  from public, anon, authenticated;
grant usage on schema receipt_community to authenticated;
grant execute on function receipt_community.set_consent(uuid, text, integer, text)
  to authenticated;

-- Use one visibility rule for both candidate selection and returned history.
create view receipt_community.visible_observations as
select o.retailer, o.store_id, o.receipt_item_code, o.purchase_date, o.package_price_cents
from receipt_community.observations o
where not exists (
  select 1 from receipt_community.observation_holds h where h.receipt_item_id = o.receipt_item_id
);

revoke all on receipt_community.visible_observations from public, anon, authenticated;

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
  from receipt_community.visible_observations o
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

-- Search only the curated catalog. Private barcode links never seed this lookup.
create function receipt_community.search_package_prices(
  p_name text default null,
  p_package_gtin text default null
)
returns table (
  retailer text, receipt_item_code text, package_name text, package_gtin text,
  store_id text, location_name text, purchase_date date, package_price_cents integer
)
language sql
stable
set search_path = ''
as $function$
  with matched as (
    select p.retailer, p.receipt_item_code, p.package_gtin
    from receipt_community.verified_packages p
    where (
      (p_name is null and p_package_gtin ~ '^[0-9]{14}$' and p.package_gtin = p_package_gtin)
      or (p_package_gtin is null and char_length(btrim(p_name)) between 2 and 120
        and strpos(lower(p.package_name), lower(btrim(p_name))) > 0)
    )
    and exists (
      select 1 from receipt_community.visible_observations o
      where o.retailer = p.retailer and o.receipt_item_code = p.receipt_item_code
    )
    order by p.package_name, p.retailer, p.receipt_item_code
    limit 12
  )
  select h.retailer, h.receipt_item_code, h.package_name, m.package_gtin, h.store_id,
    h.location_name, h.purchase_date, h.package_price_cents
  from matched m
  cross join lateral (
    select * from receipt_community.package_price_history(m.retailer, m.receipt_item_code) h
    order by h.purchase_date desc, h.store_id, h.package_price_cents
    limit 10
  ) h
  order by h.package_name, h.retailer, h.receipt_item_code, h.purchase_date desc,
    h.store_id, h.package_price_cents
$function$;

revoke all on function receipt_community.search_package_prices(text, text)
  from public, anon, authenticated;

commit;
