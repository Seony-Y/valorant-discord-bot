-- Run this in the Supabase SQL editor.

create table if not exists players (
  discord_id text primary key,
  riot_name text not null,
  riot_tag text not null,
  region text not null default 'kr',
  puuid text,
  created_at timestamptz not null default now()
);

-- QR store login data. The Riot password is never stored.
create table if not exists riot_store_sessions (
  discord_id text references players(discord_id) on delete cascade,
  account_name text not null default '기본계정',
  is_default boolean not null default false,
  riot_name text,
  riot_tag text,
  encrypted_ssid text not null,
  iv text not null,
  auth_tag text not null,
  puuid text not null,
  shard text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (discord_id, account_name)
);

create unique index if not exists riot_store_sessions_one_default_idx
  on riot_store_sessions (discord_id)
  where is_default = true;

create table if not exists store_notifications (
  discord_id text primary key references players(discord_id) on delete cascade,
  account_name text not null,
  enabled boolean not null default true,
  hour smallint not null default 9 check (hour between 0 and 23),
  minute smallint not null default 0 check (minute between 0 and 59),
  last_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cached stats so team matching doesn't hit the Valorant API every time.
create table if not exists stats_cache (
  discord_id text primary key references players(discord_id) on delete cascade,
  kda numeric,
  top_agents jsonb,       -- [{ agent, playRate, winRate }, ...] (TOP5)
  map_winrates jsonb,     -- { mapName: winRate, ... }
  current_tier text,
  peak_tier text,
  power_score numeric,
  updated_at timestamptz not null default now()
);
