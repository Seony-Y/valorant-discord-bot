-- Run this once in the Supabase SQL editor for multi-account store support.

alter table riot_store_sessions
  add column if not exists account_name text;

alter table riot_store_sessions
  add column if not exists is_default boolean not null default false;

alter table riot_store_sessions
  add column if not exists riot_name text;

alter table riot_store_sessions
  add column if not exists riot_tag text;

update riot_store_sessions
set account_name = '기본계정'
where account_name is null or btrim(account_name) = '';

alter table riot_store_sessions
  alter column account_name set not null;

alter table riot_store_sessions
  drop constraint if exists riot_store_sessions_pkey;

alter table riot_store_sessions
  add constraint riot_store_sessions_pkey primary key (discord_id, account_name);

create index if not exists riot_store_sessions_discord_id_idx
  on riot_store_sessions (discord_id);

create unique index if not exists riot_store_sessions_one_default_idx
  on riot_store_sessions (discord_id)
  where is_default = true;
