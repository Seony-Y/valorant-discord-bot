import { decryptCredential, restoreRiotStoreSession } from './riotAuth.js';
import { supabase } from './supabase.js';
import { AttachmentBuilder } from 'discord.js';
import { createStorePages, VALORANT_POINTS_IMAGE } from '../commands/store.js';

const NOTIFICATION_INTERVAL_MS = 60 * 1000;
let notificationTimer;

function getKstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

async function sendStoreNotification(client, notification) {
  const accountQuery = supabase
    .from('riot_store_sessions')
    .select('account_name, riot_name, riot_tag, encrypted_ssid, iv, auth_tag, puuid, shard')
    .eq('discord_id', notification.discord_id)
    .eq('account_name', notification.account_name);
  const { data: account, error: accountError } = await accountQuery.maybeSingle();
  if (accountError || !account) throw accountError ?? new Error('알림 계정을 찾을 수 없습니다.');

  const ssid = decryptCredential({ encrypted: account.encrypted_ssid, iv: account.iv, authTag: account.auth_tag });
  const session = await restoreRiotStoreSession({ ssid, puuid: account.puuid, shard: account.shard });
  const { data: favorites, error: favoritesError } = await supabase
    .from('store_favorites')
    .select('item_name')
    .eq('discord_id', notification.discord_id);
  if (favoritesError && favoritesError.code !== '42P01') throw favoritesError;
  const { pages, favoriteMatches } = await createStorePages(session, (favorites ?? []).map((favorite) => favorite.item_name));
  const user = await client.users.fetch(notification.discord_id);
  const favoriteMessage = favoriteMatches.length
    ? `\n\n관심 스킨 등장: ${favoriteMatches.map((name) => `**${name}**`).join(', ')}`
    : '';
  await user.send({
    content: `오늘의 상점 · **${account.account_name}**${account.riot_name && account.riot_tag ? ` · ${account.riot_name}#${account.riot_tag}` : ''}${favoriteMessage}`,
    embeds: pages[0]?.embeds ?? [],
    files: [new AttachmentBuilder(VALORANT_POINTS_IMAGE, { name: 'vp_img.webp' })],
  });
}

async function processStoreNotifications(client) {
  const now = getKstDateParts();
  const today = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const { data: notifications, error } = await supabase
    .from('store_notifications')
    .select('discord_id, account_name, hour, minute, last_sent_on')
    .eq('enabled', true)
    .eq('hour', now.hour)
    .eq('minute', now.minute);
  if (error) {
    if (error.code !== '42P01') console.error(`상점 알림 목록 조회 실패: ${error.message}`);
    return;
  }

  for (const notification of (notifications ?? []).filter((item) => item.last_sent_on !== today)) {
    try {
      await sendStoreNotification(client, notification);
      await supabase
        .from('store_notifications')
        .update({ last_sent_on: today, updated_at: new Date().toISOString() })
        .eq('discord_id', notification.discord_id)
        .eq('account_name', notification.account_name);
    } catch (error) {
      console.warn(`상점 알림 전송 실패 (${notification.discord_id}): ${error.message}`);
      if (error.code === 'RIOT_SESSION_EXPIRED') {
        try {
          const user = await client.users.fetch(notification.discord_id);
          await user.send('상점 알림을 보내지 못했습니다. Riot 로그인 세션이 만료되었으니 `/상점연동`으로 다시 로그인해주세요.');
        } catch (dmError) {
          console.warn(`세션 만료 안내 DM 실패 (${notification.discord_id}): ${dmError.message}`);
        }
      }
    }
  }
}

export function startStoreNotificationScheduler(client) {
  if (notificationTimer) clearInterval(notificationTimer);
  processStoreNotifications(client).catch((error) => console.error(`상점 알림 처리 실패: ${error.message}`));
  notificationTimer = setInterval(() => {
    processStoreNotifications(client).catch((error) => console.error(`상점 알림 처리 실패: ${error.message}`));
  }, NOTIFICATION_INTERVAL_MS);
}
