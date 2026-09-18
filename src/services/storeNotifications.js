import { decryptCredential, restoreRiotStoreSession } from './riotAuth.js';
import { supabase } from './supabase.js';
import { AttachmentBuilder } from 'discord.js';
import { createStorePages, VALORANT_POINTS_IMAGE } from '../commands/store.js';
import { persistRotatedSsid } from './storeAccounts.js';

const NOTIFICATION_INTERVAL_MS = 60 * 1000;
let notificationTimer;
let favoriteRefreshRunning = false;

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

function getKstDate(date = new Date()) {
  const { year, month, day } = getKstDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function getFavoriteMatches(discordId, account, favoriteNames) {
  const ssid = decryptCredential({ encrypted: account.encrypted_ssid, iv: account.iv, authTag: account.auth_tag });
  const session = await restoreRiotStoreSession({ ssid, puuid: account.puuid, shard: account.shard });
  await persistRotatedSsid(discordId, account.account_name, session);
  const { favoriteMatches, favoriteEmbeds } = await createStorePages(session, favoriteNames);
  return { favoriteMatches, favoriteEmbeds };
}

export async function checkFavoritesAfterAdd(client, userId, itemNames) {
  const { data: notifications, error: notificationError } = await supabase
    .from('store_notifications')
    .select('account_name, hour, minute')
    .eq('discord_id', userId)
    .eq('enabled', true);
  if (notificationError) throw notificationError;
  const scheduledTimes = [...new Set((notifications ?? []).map(({ hour, minute }) =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`))].sort();

  const { data: accounts, error: accountError } = await supabase
    .from('riot_store_sessions')
    .select('account_name, is_default, encrypted_ssid, iv, auth_tag, puuid, shard, updated_at')
    .eq('discord_id', userId)
    .order('updated_at', { ascending: false });
  if (accountError) throw accountError;
  if (!accounts?.length) return { status: 'no-account' };

  const scheduledAccountNames = new Set((notifications ?? []).map((notification) => notification.account_name));
  const targetAccounts = scheduledAccountNames.size
    ? accounts.filter((account) => scheduledAccountNames.has(account.account_name))
    : [accounts.find((account) => account.is_default) ?? accounts[0]];
  if (!targetAccounts.length) return { status: 'no-account' };

  const matchedByAccount = [];
  const expiredAccounts = [];
  let checkedAccountCount = 0;
  for (const account of targetAccounts) {
    try {
      const { favoriteMatches: matches, favoriteEmbeds } = await getFavoriteMatches(userId, account, itemNames);
      checkedAccountCount += 1;
      if (matches.length) matchedByAccount.push({
        accountName: account.account_name,
        matches,
        embeds: favoriteEmbeds,
      });
    } catch (error) {
      if (error.code !== 'RIOT_SESSION_EXPIRED') throw error;
      expiredAccounts.push(account.account_name);
    }
  }
  if (!checkedAccountCount) return { status: 'session-expired', accounts: expiredAccounts };

  const { error: updateError } = await supabase
    .from('store_favorites')
    .update({ last_checked_on: getKstDate() })
    .eq('discord_id', userId)
    .in('item_name', itemNames);
  if (updateError) throw updateError;
  if (!matchedByAccount.length) {
    return scheduledTimes.length
      ? { status: 'scheduled', times: scheduledTimes, expiredAccounts }
      : { status: 'waiting', expiredAccounts };
  }

  const matchedNames = [...new Set(matchedByAccount.flatMap(({ matches }) => matches))];
  const user = await client.users.fetch(userId);
  const lines = matchedByAccount.map(({ accountName, matches }) =>
    `등장 계정: **${accountName}**\n즐겨찾기한 스킨: ${matches.map((name) => `**${name}**`).join(', ')}`);
  await user.send({
    content: `⭐ 즐겨찾기한 스킨이 오늘 상점에 등장했습니다.\n\n${lines.join('\n\n')}`,
    embeds: matchedByAccount.flatMap(({ embeds }) => embeds).slice(0, 10),
    files: [new AttachmentBuilder(VALORANT_POINTS_IMAGE, { name: 'vp_img.webp' })],
  });
  const { error: notifiedError } = await supabase
    .from('store_favorites')
    .update({ last_notified_on: getKstDate() })
    .eq('discord_id', userId)
    .in('item_name', matchedNames);
  if (notifiedError) throw notifiedError;
  return { status: 'notified', matches: matchedByAccount, times: scheduledTimes, expiredAccounts };
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
  await persistRotatedSsid(notification.discord_id, notification.account_name, session);
  const { data: favorites, error: favoritesError } = await supabase
    .from('store_favorites')
    .select('item_name, last_notified_on')
    .eq('discord_id', notification.discord_id);
  if (favoritesError && favoritesError.code !== '42P01') throw favoritesError;
  const today = getKstDate();
  const pendingFavoriteNames = (favorites ?? [])
    .filter((favorite) => favorite.last_notified_on !== today)
    .map((favorite) => favorite.item_name);
  const { pages, favoriteMatches } = await createStorePages(session, pendingFavoriteNames);
  const user = await client.users.fetch(notification.discord_id);
  const favoriteMessage = favoriteMatches.length
    ? `\n\n⭐ 즐겨찾기한 스킨이 오늘 상점에 등장했습니다.\n등장 계정: **${account.account_name}**\n즐겨찾기한 스킨: ${favoriteMatches.map((name) => `**${name}**`).join(', ')}`
    : '';
  await user.send({
    content: `오늘의 상점 · **${account.account_name}**${account.riot_name && account.riot_tag ? ` · ${account.riot_name}#${account.riot_tag}` : ''}${favoriteMessage}`,
    embeds: pages[0]?.embeds ?? [],
    files: [new AttachmentBuilder(VALORANT_POINTS_IMAGE, { name: 'vp_img.webp' })],
  });
  if (favoriteMatches.length) {
    const { error: updateError } = await supabase
      .from('store_favorites')
      .update({ last_notified_on: today })
      .eq('discord_id', notification.discord_id)
      .in('item_name', favoriteMatches);
    if (updateError) throw updateError;
  }
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

async function processFavoriteRefreshNotifications(client) {
  const now = getKstDateParts();
  if (now.hour < 9) return;
  const today = getKstDate();
  const { data: favorites, error: favoriteError } = await supabase
    .from('store_favorites')
    .select('discord_id, item_name')
    .or(`last_checked_on.is.null,last_checked_on.lt.${today}`);
  if (favoriteError) {
    console.error(`즐겨찾기 갱신 목록 조회 실패: ${favoriteError.message}`);
    return;
  }
  if (!favorites?.length) return;

  const userIds = [...new Set(favorites.map((favorite) => favorite.discord_id))];
  const [{ data: notifications, error: notificationError }, { data: accounts, error: accountError }] = await Promise.all([
    supabase
      .from('store_notifications')
      .select('discord_id')
      .in('discord_id', userIds)
      .eq('enabled', true),
    supabase
      .from('riot_store_sessions')
      .select('discord_id, account_name, encrypted_ssid, iv, auth_tag, puuid, shard')
      .in('discord_id', userIds),
  ]);
  if (notificationError || accountError) {
    console.error(`즐겨찾기 갱신 계정 조회 실패: ${(notificationError ?? accountError).message}`);
    return;
  }

  const scheduledUserIds = new Set((notifications ?? []).map((notification) => notification.discord_id));
  for (const userId of userIds) {
    const userFavorites = favorites.filter((favorite) => favorite.discord_id === userId);
    const itemNames = userFavorites.map((favorite) => favorite.item_name);
    try {
      if (!scheduledUserIds.has(userId)) {
        const matchedByAccount = [];
        for (const account of (accounts ?? []).filter((entry) => entry.discord_id === userId)) {
          const { favoriteMatches: matches, favoriteEmbeds } = await getFavoriteMatches(userId, account, itemNames);
          if (matches.length) matchedByAccount.push({
            accountName: account.account_name,
            matches,
            embeds: favoriteEmbeds,
          });
        }
        if (matchedByAccount.length) {
          const user = await client.users.fetch(userId);
          const lines = matchedByAccount.map(({ accountName, matches }) =>
            `등장 계정: **${accountName}**\n즐겨찾기한 스킨: ${matches.map((name) => `**${name}**`).join(', ')}`);
          await user.send({
            content: `⭐ 즐겨찾기한 스킨이 오늘 상점에 등장했습니다.\n\n${lines.join('\n\n')}`,
            embeds: matchedByAccount.flatMap(({ embeds }) => embeds).slice(0, 10),
            files: [new AttachmentBuilder(VALORANT_POINTS_IMAGE, { name: 'vp_img.webp' })],
          });
          const matchedNames = [...new Set(matchedByAccount.flatMap(({ matches }) => matches))];
          const { error: notifiedError } = await supabase
            .from('store_favorites')
            .update({ last_notified_on: today })
            .eq('discord_id', userId)
            .in('item_name', matchedNames);
          if (notifiedError) throw notifiedError;
        }
      }

      const { error: updateError } = await supabase
        .from('store_favorites')
        .update({ last_checked_on: today })
        .eq('discord_id', userId)
        .in('item_name', itemNames);
      if (updateError) throw updateError;
    } catch (error) {
      console.warn(`즐겨찾기 갱신 확인 실패 (${userId}): ${error.message}`);
      if (error.code === 'RIOT_SESSION_EXPIRED') {
        // Mark checked so the same expired session isn't retried (and re-warned) every cycle today.
        await supabase
          .from('store_favorites')
          .update({ last_checked_on: today })
          .eq('discord_id', userId)
          .in('item_name', itemNames);
        try {
          const user = await client.users.fetch(userId);
          await user.send('즐겨찾기 갱신을 확인하지 못했습니다. Riot 로그인 세션이 만료되었으니 `/상점연동`으로 다시 로그인해주세요.');
        } catch (dmError) {
          console.warn(`세션 만료 안내 DM 실패 (${userId}): ${dmError.message}`);
        }
      }
    }
  }
}

function runFavoriteRefreshNotifications(client) {
  if (favoriteRefreshRunning) return;
  favoriteRefreshRunning = true;
  processFavoriteRefreshNotifications(client)
    .catch((error) => console.error(`즐겨찾기 갱신 처리 실패: ${error.message}`))
    .finally(() => {
      favoriteRefreshRunning = false;
    });
}

export function startStoreNotificationScheduler(client) {
  if (notificationTimer) clearInterval(notificationTimer);
  processStoreNotifications(client).catch((error) => console.error(`상점 알림 처리 실패: ${error.message}`));
  runFavoriteRefreshNotifications(client);
  notificationTimer = setInterval(() => {
    processStoreNotifications(client).catch((error) => console.error(`상점 알림 처리 실패: ${error.message}`));
    runFavoriteRefreshNotifications(client);
  }, NOTIFICATION_INTERVAL_MS);
}
