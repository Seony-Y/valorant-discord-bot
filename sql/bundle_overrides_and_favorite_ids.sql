-- Run this once in the Supabase SQL editor.

-- Operator-entered names/images for new bundles valorant-api.com hasn't added yet (/번들정보).
create table if not exists bundle_overrides (
  bundle_id text primary key,
  name text not null,
  image_url text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Favorites match by skin uuid so a changed Korean translation doesn't break them; item_name stays as the fallback/key.
alter table store_favorites
  add column if not exists item_id text;
