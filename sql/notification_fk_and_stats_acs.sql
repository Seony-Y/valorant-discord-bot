-- Run this once in the Supabase SQL editor.

-- Store notifications follow their store account on rename/delete.
-- Notifications whose account no longer exists can never be sent, so remove them first.
delete from store_notifications n
where not exists (
  select 1
  from riot_store_sessions s
  where s.discord_id = n.discord_id
    and s.account_name = n.account_name
);

alter table store_notifications
  drop constraint if exists store_notifications_account_fkey;

alter table store_notifications
  add constraint store_notifications_account_fkey
  foreign key (discord_id, account_name)
  references riot_store_sessions (discord_id, account_name)
  on update cascade
  on delete cascade;

-- Team power cache stores ACS alongside KDA.
alter table stats_cache
  add column if not exists acs numeric;
