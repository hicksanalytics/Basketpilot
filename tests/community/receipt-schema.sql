-- Synthetic subset of the existing receipt schema used by the draft.
create role anon;
create role authenticated;
create schema auth;

create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.receipts (
  id uuid primary key,
  owner_id uuid not null,
  retailer text not null,
  store_id text,
  purchase_date date,
  subtotal numeric,
  created_at timestamptz not null default clock_timestamp(),
  contribution_opt_in boolean not null default false,
  receipt_fingerprint text,
  unique (owner_id, receipt_fingerprint)
);

create table public.receipt_items (
  id uuid primary key,
  receipt_id uuid not null references public.receipts on delete cascade,
  retailer_item_code text,
  receipt_description text not null default 'PRIVATE PRINTED LABEL',
  match_status text not null default 'unmatched',
  matched_title text,
  package_gtin text,
  user_reviewed boolean not null default true,
  quantity numeric not null,
  gross_line_total numeric not null
);

create table public.receipt_discounts (
  id uuid primary key,
  receipt_id uuid not null references public.receipts on delete cascade
);

alter table public.receipts enable row level security;
alter table public.receipt_items enable row level security;
alter table public.receipt_discounts enable row level security;

grant select, delete on public.receipts to authenticated;
grant select on public.receipt_items, public.receipt_discounts to authenticated;
grant usage on schema auth to authenticated;
create policy own_receipts on public.receipts to authenticated
  using (owner_id = auth.uid());
create policy own_items on public.receipt_items for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));
create policy own_discounts on public.receipt_discounts for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));
