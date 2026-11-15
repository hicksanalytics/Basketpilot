alter table public.receipt_items
  add column package_gtin text
  constraint receipt_items_package_gtin_format
  check (package_gtin ~ '^[0-9]{14}$' and package_gtin <> '00000000000000');

comment on column public.receipt_items.package_gtin is
  'Package barcode linked by the receipt owner. Private purchase reference, independent of retailer item codes.';
