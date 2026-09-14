-- Run this once in the Supabase SQL editor for official VALORANT news notifications.

create table if not exists valorant_news_subscriptions (
  guild_id text primary key,
  channel_id text not null,
  thread_id text,
  enabled boolean not null default true,
  hour smallint not null default 9 check (hour between 0 and 23),
  minute smallint not null default 0 check (minute between 0 and 59),
  last_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists valorant_news_deliveries (
  guild_id text references valorant_news_subscriptions(guild_id) on delete cascade,
  article_id text not null,
  sent_at timestamptz not null default now(),
  primary key (guild_id, article_id)
);