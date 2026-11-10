import { decryptCredential, findWeaponSkinByName, restoreRiotStoreSession } from './riotAuth.js';
import { supabase } from './supabase.js';
import { AttachmentBuilder } from 'discord.js';
import { createStorePages, VALORANT_POINTS_IMAGE } from '../commands/store.js';
import { persistRotatedSsid } from './storeAccounts.js';
import { formatKstDate, getKstDate, getKstDateParts, toMinuteOfDay } from './kstTime.js';
import { getBotOwnerIds } from './admin.js';
import { onUnresolvedBundle } from './valorantAssets.js';

const NOTIFICATION_INTERVAL_MS = 60 * 1000;
const RIOT_MAINTENANCE_RETRY_MS = 15 * 60 * 1000;
const STORE_NOTIFICATION_RETRY_MS = 15 * 60 * 1000;
const DISCORD_CANNOT_DM_USER = 50007;
const MAX_EMBEDS_PER_MESSAGE = 10;
let notificationTimer;
let storeNotificationRunning = false;
const storeNotificationRetryAfter = new Map();
let favoriteRefreshRunning = false;
let favoriteRefreshRetryAfter = 0;
let favoriteItemIdBackfillDone = false;
let unresolvedBundleListenerRegistered = false;

async function getFavoriteMatches(discordId, account, favorites) {
  const ssid = decryptCredential({ encrypted: account.encrypted_ssid, iv: account.iv, authTag: account.auth_tag });
  const session = await restoreRiotStoreSession({ ssid, puuid: account.puuid, shard: account.shard });
  await persistRotatedSsid(discordId, account.account_name, session);
  const { favoriteMatches, favoriteEmbeds } = await createStorePages(session, favorites);
  return { favoriteMatches, favoriteEmbeds };
}

/**
 * Check each account's current store for the favorites, DM the user once about every hit and mark those favorites notified.
 * Expired sessions are collected instead of thrown so one stale account doesn't block the rest.
 */
async function notifyFavoriteMatches(client, userId, accounts, favorites, today) {
  const matchedByAccount = [];
  const expiredAccounts = [];
  let checkedAccountCount = 0;
  for (const account of accounts) {
    try {
      const { favoriteMatches: matches, favoriteEmbeds } = await getFavoriteMatches(userId, account, favorites);
      checkedAccountCount += 1;
      if (matches.length) matchedByAccount.push({ accountName: account.account_name, matches, embeds: favoriteEmbeds });
    } catch (error) {
      if (error.code !== 'RIOT_SESSION_EXPIRED') throw error;
      expiredAccounts.push(account.account_name);
    }
  }

  if (matchedByAccount.length) {
    const user = await client.users.fetch(userId);
    const lines = matchedByAccount.map(({ accountName, matches }) =>
      `등장 계정: **${accountName}**\n즐겨찾기한 스킨: ${matches.map((name) => `**${name}**`).join(', ')}`);
    await user.send({
      content: `⭐ 즐겨찾기한 스킨이 오늘 상점에 등장했습니다.\n\n${lines.join('\n\n')}`,
      embeds: matchedByAccount.flatMap(({ embeds }) => embeds).slice(0, MAX_EMBEDS_PER_MESSAGE),
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
  return { matchedByAccount, expiredAccounts, checkedAccountCount };
}

export async function checkFavoritesAfterAdd(client, userId, favorites) {
  const itemNames = favorites.map((favorite) => favorite.item_name);
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

  const today = getKstDate();
  const { matchedByAccount, expiredAccounts, checkedAccountCount } =
    await notifyFavoriteMatches(client, userId, targetAccounts, favorites, today);
  if (!checkedAccountCount) return { status: 'session-expired', accounts: expiredAccounts };

  const { error: updateError } = await supabase
    .from('store_favorites')
    .update({ last_checked_on: today })
    .eq('discord_id', userId)
    .in('item_name', itemNames);
  if (updateError) throw updateError;
  if (!matchedByAccount.length) {
    return scheduledTimes.length
      ? { status: 'scheduled', times: scheduledTimes, expiredAccounts }
      : { status: 'waiting', expiredAccounts };
  }
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
    .select('item_name, item_id, last_notified_on')
    .eq('discord_id', notification.discord_id);
  if (favoritesError && favoritesError.code !== '42P01') throw favoritesError;
  const today = getKstDate();
  const pendingFavorites = (favorites ?? [])
    .filter((favorite) => favorite.last_notified_on !== today);
  const { pages, favoriteMatches, nightMarketFavoriteEmbeds } = await createStorePages(session, pendingFavorites);
  const user = await client.users.fetch(notification.discord_id);
  const favoriteMessage = favoriteMatches.length
    ? `\n\n⭐ 즐겨찾기한 스킨이 오늘 상점에 등장했습니다.\n등장 계정: **${account.account_name}**\n즐겨찾기한 스킨: ${favoriteMatches.map((name) => `**${name}**`).join(', ')}`
    : '';
  await user.send({
    content: `오늘의 상점 · **${account.account_name}**${account.riot_name && account.riot_tag ? ` · ${account.riot_name}#${account.riot_tag}` : ''}${favoriteMessage}`,
    embeds: [...(pages[0]?.embeds ?? []), ...nightMarketFavoriteEmbeds].slice(0, MAX_EMBEDS_PER_MESSAGE),
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

async function markStoreNotificationSent(notification, today) {
  const { error } = await supabase
    .from('store_notifications')
    .update({ last_sent_on: today, updated_at: new Date().toISOString() })
    .eq('discord_id', notification.discord_id)
    .eq('account_name', notification.account_name);
  if (error) console.error(`상점 알림 발송 기록 실패 (${notification.discord_id}): ${error.message}`);
}

async function processStoreNotifications(client) {
  const now = getKstDateParts();
  const today = formatKstDate(now);
  const currentMinute = toMinuteOfDay(now.hour, now.minute);
  // Due = scheduled time already passed today and not yet sent, so a missed minute (restart, timer drift) is caught up.
  const { data: notifications, error } = await supabase
    .from('store_notifications')
    .select('discord_id, account_name, hour, minute, last_sent_on')
    .eq('enabled', true)
    .or(`last_sent_on.is.null,last_sent_on.lt.${today}`);
  if (error) {
    if (error.code !== '42P01') console.error(`상점 알림 목록 조회 실패: ${error.message}`);
    return;
  }

  const due = (notifications ?? []).filter((notification) =>
    toMinuteOfDay(notification.hour, notification.minute) <= currentMinute
    && (storeNotificationRetryAfter.get(`${notification.discord_id}:${notification.account_name}`) ?? 0) <= Date.now());

  for (const notification of due) {
    const retryKey = `${notification.discord_id}:${notification.account_name}`;
    try {
      await sendStoreNotification(client, notification);
    } catch (error) {
      console.warn(`상점 알림 전송 실패 (${notification.discord_id}): ${error.message}`);
      if (error.code === 'RIOT_SESSION_EXPIRED') {
        try {
          const user = await client.users.fetch(notification.discord_id);
          await user.send('상점 알림을 보내지 못했습니다. Riot 로그인 세션이 만료되었으니 `/상점연동`으로 다시 로그인해주세요.');
        } catch (dmError) {
          console.warn(`세션 만료 안내 DM 실패 (${notification.discord_id}): ${dmError.message}`);
        }
        // Retrying won't help until the user relinks; don't repeat the notice for the rest of the day.
        await markStoreNotificationSent(notification, today);
      } else if (error.code === DISCORD_CANNOT_DM_USER) {
        await markStoreNotificationSent(notification, today);
      } else {
        storeNotificationRetryAfter.set(retryKey, Date.now() + STORE_NOTIFICATION_RETRY_MS);
      }
      continue;
    }
    storeNotificationRetryAfter.delete(retryKey);
    await markStoreNotificationSent(notification, today);
  }
}

function runStoreNotifications(client) {
  if (storeNotificationRunning) return;
  storeNotificationRunning = true;
  processStoreNotifications(client)
    .catch((error) => console.error(`상점 알림 처리 실패: ${error.message}`))
    .finally(() => {
      storeNotificationRunning = false;
    });
}

async function processFavoriteRefreshNotifications(client) {
  const now = getKstDateParts();
  if (now.hour < 9) return;
  const today = getKstDate();
  const { data: favorites, error: favoriteError } = await supabase
    .from('store_favorites')
    .select('discord_id, item_name, item_id')
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
      // Users with a scheduled store DM already get favorite hits there.
      if (!scheduledUserIds.has(userId)) {
        const userAccounts = (accounts ?? []).filter((entry) => entry.discord_id === userId);
        const { expiredAccounts, checkedAccountCount } =
          await notifyFavoriteMatches(client, userId, userAccounts, userFavorites, today);
        if (!checkedAccountCount && expiredAccounts.length) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(
              `즐겨찾기 갱신을 확인하지 못했습니다. 다음 Riot 로그인 세션이 만료되었으니 \`/상점연동\`으로 다시 로그인해주세요: ${expiredAccounts.join(', ')}`
            );
          } catch (dmError) {
            console.warn(`세션 만료 안내 DM 실패 (${userId}): ${dmError.message}`);
          }
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
      if (error.code === 'RIOT_SERVICE_UNAVAILABLE') {
        favoriteRefreshRetryAfter = Date.now() + RIOT_MAINTENANCE_RETRY_MS;
        return;
      }
    }
  }
}

function runFavoriteRefreshNotifications(client) {
  if (favoriteRefreshRunning || Date.now() < favoriteRefreshRetryAfter) return;
  favoriteRefreshRunning = true;
  processFavoriteRefreshNotifications(client)
    .catch((error) => console.error(`즐겨찾기 갱신 처리 실패: ${error.message}`))
    .finally(() => {
      favoriteRefreshRunning = false;
    });
}

// Favorites saved before item_id existed only match by name; fill in the skin uuid once so they survive translation changes.
async function backfillFavoriteItemIds() {
  const { data: favorites, error } = await supabase
    .from('store_favorites')
    .select('discord_id, item_name')
    .is('item_id', null);
  if (error) {
    console.warn(`즐겨찾기 item_id 보정 조회 실패: ${error.message}`);
    return false;
  }

  let filled = 0;
  for (const favorite of favorites ?? []) {
    const skin = await findWeaponSkinByName(favorite.item_name);
    if (!skin) continue;
    const { error: updateError } = await supabase
      .from('store_favorites')
      .update({ item_id: skin.id })
      .eq('discord_id', favorite.discord_id)
      .eq('item_name', favorite.item_name);
    if (updateError) {
      console.warn(`즐겨찾기 item_id 보정 실패 (${favorite.discord_id}): ${updateError.message}`);
      continue;
    }
    filled += 1;
  }
  if (filled) console.info(`즐겨찾기 item_id 보정 완료: ${filled}/${favorites.length}개`);
  return true;
}

function runFavoriteItemIdBackfill() {
  if (favoriteItemIdBackfillDone) return;
  favoriteItemIdBackfillDone = true;
  backfillFavoriteItemIds()
    .then((done) => {
      if (!done) favoriteItemIdBackfillDone = false;
    })
    .catch((error) => {
      favoriteItemIdBackfillDone = false;
      console.warn(`즐겨찾기 item_id 보정 실패: ${error.message}`);
    });
}

// Tell bot owners the first time the store shows a bundle valorant-api.com doesn't know, so they can fill it in with /번들정보.
function registerUnresolvedBundleNotifier(client) {
  if (unresolvedBundleListenerRegistered) return;
  unresolvedBundleListenerRegistered = true;
  onUnresolvedBundle(async ({ bundleId, itemNames }) => {
    const message = '🆕 valorant-api.com에 아직 없는 번들이 상점에 나타났습니다.\n' +
      `번들 ID: \`${bundleId}\`\n` +
      (itemNames.length ? `구성품: ${itemNames.slice(0, 6).join(', ')}\n` : '') +
      '`/번들정보 설정`으로 이름과 이미지를 지정할 수 있습니다.';
    for (const ownerId of getBotOwnerIds()) {
      try {
        const owner = await client.users.fetch(ownerId);
        await owner.send(message);
      } catch (error) {
        console.warn(`신규 번들 운영자 DM 실패 (${ownerId}): ${error.message}`);
      }
    }
  });
}

export function startStoreNotificationScheduler(client) {
  if (notificationTimer) clearInterval(notificationTimer);
  registerUnresolvedBundleNotifier(client);
  runFavoriteItemIdBackfill();
  runStoreNotifications(client);
  runFavoriteRefreshNotifications(client);
  notificationTimer = setInterval(() => {
    runFavoriteItemIdBackfill();
    runStoreNotifications(client);
    runFavoriteRefreshNotifications(client);
  }, NOTIFICATION_INTERVAL_MS);
}
