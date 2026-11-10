import { ChannelType, EmbedBuilder } from 'discord.js';
import { supabase } from './supabase.js';
import { fetchOfficialValorantNews } from './valorantNews.js';
import { formatKstDate, getKstDate, getKstDateParts, toMinuteOfDay } from './kstTime.js';

const CHECK_INTERVAL_MS = 60 * 1000;
const NEWS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ARTICLES_PER_DELIVERY = 5;
const NEWS_CHANNEL_NAME = '발로란트-공식-소식';
const NEWS_RETRY_MS = 15 * 60 * 1000;
// Unknown Guild, Unknown Channel: the destination is gone, so retrying can't help.
const PERMANENT_DISCORD_ERRORS = new Set([10004, 10003]);
// Missing Access, Missing Permissions: an admin often fixes these, so keep retrying for a while before giving up.
const PERMISSION_DISCORD_ERRORS = new Set([50001, 50013]);
const PERMISSION_RETRY_MS = 60 * 60 * 1000;
const PERMISSION_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
let notificationTimer;
let notificationRunning = false;
const newsRetryAfter = new Map();
// First permission failure per guild (in memory, so a restart restarts the grace period).
const permissionFailingSince = new Map();
// Guilds with a delivery in flight; keeps setup and the scheduler from posting the same articles twice.
const guildsSending = new Set();

async function withGuildLock(guildId, task) {
  if (guildsSending.has(guildId)) return null;
  guildsSending.add(guildId);
  try {
    return await task();
  } finally {
    guildsSending.delete(guildId);
  }
}

function getArticleLabel(article) {
  if (article.category === 'announcements') return '국내 공지';
  if (/패치 노트|patch notes/i.test(article.title)) return '패치 노트';
  if (/스킨|skin reveal|collection|bundle/i.test(article.title)) return '신규 스킨';
  if (/요원|agent|맵|map/i.test(article.title)) return '요원 · 맵';
  return '게임 업데이트';
}

function makeArticleEmbed(article) {
  const embed = new EmbedBuilder()
    .setColor(article.category === 'announcements' ? 0xffa500 : 0xff4655)
    .setAuthor({ name: getArticleLabel(article) })
    .setTitle(article.title.slice(0, 256))
    .setURL(article.url)
    .setTimestamp(new Date(article.publishedAt))
    .setFooter({ text: 'VALORANT 한국 공식' });
  if (article.description) embed.setDescription(article.description.slice(0, 4096));
  if (article.image) embed.setImage(article.image);
  return embed;
}

async function createNewsChannel(guild, referenceChannel) {
  return guild.channels.create({
    name: NEWS_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: referenceChannel.parentId,
    permissionOverwrites: referenceChannel.permissionOverwrites.cache.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow,
      deny: overwrite.deny,
    })),
    reason: '발로란트 공식 소식 전용 채널',
  });
}

async function getNewsChannel(guild, channelId) {
  // Only a missing channel counts as permanent; transient fetch errors propagate and get retried later.
  const channel = await guild.channels.fetch(channelId).catch((error) => {
    if (error?.code === 10003) return null;
    throw error;
  });
  if (channel?.type !== ChannelType.GuildText) {
    const error = new Error('설정된 소식 채널을 찾을 수 없습니다. `/소식알림 설정`을 다시 실행해주세요.');
    error.code = 10003;
    throw error;
  }
  return channel;
}

export async function configureNewsNotification(guild, selectedChannel, hour, minute, channelMode) {
  const { data: existing, error: existingError } = await supabase
    .from('valorant_news_subscriptions')
    .select('channel_id, thread_id')
    .eq('guild_id', guild.id)
    .maybeSingle();
  if (existingError) throw existingError;

  let destinationChannel = selectedChannel;
  if (channelMode === 'dedicated') {
    const existingChannel = existing?.channel_id
      ? await guild.channels.fetch(existing.channel_id).catch(() => null)
      : null;
    destinationChannel = existingChannel?.type === ChannelType.GuildText && existingChannel.name === NEWS_CHANNEL_NAME
      ? existingChannel
      : await createNewsChannel(guild, selectedChannel);
  }

  const configured = await withGuildLock(guild.id, async () => {
    const { error: subscriptionError } = await supabase
      .from('valorant_news_subscriptions')
      .upsert({
        guild_id: guild.id,
        channel_id: destinationChannel.id,
        thread_id: null,
        enabled: true,
        hour,
        minute,
        // Keep an existing last_sent_on so reconfiguring doesn't trigger a second delivery today.
        ...(existing ? {} : { last_sent_on: null }),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'guild_id' });
    if (subscriptionError) throw subscriptionError;
    newsRetryAfter.delete(guild.id);
    permissionFailingSince.delete(guild.id);
    await destinationChannel.send(
      `발로란트 공식 소식 알림이 설정되었습니다. 매일 한국 시간 **${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}** 이후 새 소식을 전송합니다.`
    );
    if (!existing) {
      const today = getKstDate();
      const articles = await fetchOfficialValorantNews();
      await sendPendingNews(guild.client, {
        guild_id: guild.id,
        channel_id: destinationChannel.id,
      }, articles, today);
    }
    return true;
  });
  if (!configured) throw new Error('지금 소식을 전송하는 중입니다. 잠시 후 다시 설정해주세요.');
  return destinationChannel;
}

export async function disableNewsNotification(guild) {
  const { data: subscription, error } = await supabase
    .from('valorant_news_subscriptions')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('guild_id', guild.id)
    .select('channel_id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(subscription);
}

async function sendPendingNews(client, subscription, articles, today) {
  const guild = await client.guilds.fetch(subscription.guild_id);
  const { data: deliveries, error: deliveryQueryError } = await supabase
    .from('valorant_news_deliveries')
    .select('article_id')
    .eq('guild_id', subscription.guild_id);
  if (deliveryQueryError) throw deliveryQueryError;

  const sentIds = new Set((deliveries ?? []).map(({ article_id: articleId }) => articleId));
  const cutoff = Date.now() - NEWS_LOOKBACK_MS;
  const pending = articles
    .filter((article) => new Date(article.publishedAt).getTime() >= cutoff && !sentIds.has(article.id))
    .slice(0, MAX_ARTICLES_PER_DELIVERY);
  if (pending.length) {
    const channel = await getNewsChannel(guild, subscription.channel_id);
    await channel.send({
      content: `**${today} 발로란트 공식 소식**`,
      embeds: pending.map(makeArticleEmbed),
    });
    const { error: insertError } = await supabase
      .from('valorant_news_deliveries')
      .upsert(pending.map((article) => ({ guild_id: subscription.guild_id, article_id: article.id })), { onConflict: 'guild_id,article_id' });
    if (insertError) throw insertError;
  }

  const { error: updateError } = await supabase
    .from('valorant_news_subscriptions')
    .update({ last_sent_on: today, updated_at: new Date().toISOString() })
    .eq('guild_id', subscription.guild_id);
  if (updateError) throw updateError;
  return pending.length;
}

export async function sendNewsNotificationNow(client, guildId) {
  const { data: subscription, error } = await supabase
    .from('valorant_news_subscriptions')
    .select('guild_id, channel_id, hour, minute, last_sent_on')
    .eq('guild_id', guildId)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw error;
  if (!subscription) throw new Error('활성화된 소식 알림 설정이 없습니다.');
  const today = getKstDate();
  const articles = await fetchOfficialValorantNews();
  const sent = await withGuildLock(guildId, () => sendPendingNews(client, subscription, articles, today));
  if (sent === null) throw new Error('지금 소식을 전송하는 중입니다. 잠시 후 다시 시도해주세요.');
  return sent;
}

async function disableBrokenSubscription(guildId, reason) {
  const { error } = await supabase
    .from('valorant_news_subscriptions')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('guild_id', guildId);
  if (error) console.error(`소식 알림 비활성화 실패 (${guildId}): ${error.message}`);
  else console.warn(`소식 알림 비활성화 (${guildId}): ${reason}`);
}

async function processNewsNotifications(client) {
  const now = getKstDateParts();
  const today = formatKstDate(now);
  const { data: subscriptions, error } = await supabase
    .from('valorant_news_subscriptions')
    .select('guild_id, channel_id, hour, minute, last_sent_on')
    .eq('enabled', true);
  if (error) {
    if (error.code !== '42P01' && error.code !== 'PGRST205') console.error(`소식 알림 목록 조회 실패: ${error.message}`);
    return;
  }
  const currentMinute = toMinuteOfDay(now.hour, now.minute);
  const due = (subscriptions ?? []).filter((subscription) =>
    subscription.last_sent_on !== today
    && currentMinute >= toMinuteOfDay(subscription.hour, subscription.minute)
    && (newsRetryAfter.get(subscription.guild_id) ?? 0) <= Date.now());
  if (!due.length) return;

  const articles = await fetchOfficialValorantNews();
  for (const subscription of due) {
    try {
      await withGuildLock(subscription.guild_id, () => sendPendingNews(client, subscription, articles, today));
      newsRetryAfter.delete(subscription.guild_id);
      permissionFailingSince.delete(subscription.guild_id);
    } catch (notificationError) {
      console.warn(`소식 알림 전송 실패 (${subscription.guild_id}): ${notificationError.message}`);
      if (PERMANENT_DISCORD_ERRORS.has(notificationError.code)) {
        newsRetryAfter.delete(subscription.guild_id);
        permissionFailingSince.delete(subscription.guild_id);
        await disableBrokenSubscription(subscription.guild_id, notificationError.message);
      } else if (PERMISSION_DISCORD_ERRORS.has(notificationError.code)) {
        const failingSince = permissionFailingSince.get(subscription.guild_id) ?? Date.now();
        permissionFailingSince.set(subscription.guild_id, failingSince);
        if (Date.now() - failingSince >= PERMISSION_GRACE_MS) {
          newsRetryAfter.delete(subscription.guild_id);
          permissionFailingSince.delete(subscription.guild_id);
          await disableBrokenSubscription(subscription.guild_id, `권한 오류가 3일 이상 지속됨: ${notificationError.message}`);
        } else {
          newsRetryAfter.set(subscription.guild_id, Date.now() + PERMISSION_RETRY_MS);
        }
      } else {
        newsRetryAfter.set(subscription.guild_id, Date.now() + NEWS_RETRY_MS);
      }
    }
  }
}

export function startNewsNotificationScheduler(client) {
  if (notificationTimer) clearInterval(notificationTimer);
  notificationTimer = setInterval(() => {
    if (notificationRunning) return;
    notificationRunning = true;
    processNewsNotifications(client)
      .catch((error) => console.error(`소식 알림 처리 실패: ${error.message}`))
      .finally(() => {
        notificationRunning = false;
      });
  }, CHECK_INTERVAL_MS);
}