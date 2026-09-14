import { ChannelType, EmbedBuilder } from 'discord.js';
import { supabase } from './supabase.js';
import { fetchOfficialValorantNews } from './valorantNews.js';

const CHECK_INTERVAL_MS = 60 * 1000;
const NEWS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ARTICLES_PER_DELIVERY = 5;
const THREAD_NAME = '발로란트 공식 소식';
let notificationTimer;
let notificationRunning = false;

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
    .setFooter({ text: article.locale === 'ko-kr' ? 'VALORANT 한국 공식' : 'VALORANT 글로벌 공식 · 한국어판 없음' });
  if (article.description) embed.setDescription(article.description.slice(0, 4096));
  if (article.image) embed.setImage(article.image);
  return embed;
}

async function createNewsThread(channel) {
  if (channel.type !== ChannelType.GuildText || !channel.threads) {
    throw new Error('일반 텍스트 채널만 소식 알림 채널로 설정할 수 있습니다.');
  }
  return channel.threads.create({
    name: THREAD_NAME,
    type: ChannelType.PublicThread,
    autoArchiveDuration: 1440,
    reason: '발로란트 공식 소식 알림',
  });
}

async function ensureNewsThread(guild, subscription) {
  let thread = subscription.thread_id
    ? await guild.channels.fetch(subscription.thread_id).catch(() => null)
    : null;
  if (thread?.isThread()) {
    if (thread.locked) await thread.setLocked(false, '발로란트 공식 소식 알림 재개');
    if (thread.archived) await thread.setArchived(false, '발로란트 공식 소식 알림 전송');
    return thread;
  }

  const channel = await guild.channels.fetch(subscription.channel_id);
  thread = await createNewsThread(channel);
  const { error } = await supabase
    .from('valorant_news_subscriptions')
    .update({ thread_id: thread.id, updated_at: new Date().toISOString() })
    .eq('guild_id', guild.id);
  if (error) throw error;
  return thread;
}

export async function configureNewsNotification(guild, channel, hour, minute) {
  const articles = await fetchOfficialValorantNews();
  const { data: existing, error: existingError } = await supabase
    .from('valorant_news_subscriptions')
    .select('channel_id, thread_id')
    .eq('guild_id', guild.id)
    .maybeSingle();
  if (existingError) throw existingError;

  let thread = existing?.channel_id === channel.id && existing.thread_id
    ? await guild.channels.fetch(existing.thread_id).catch(() => null)
    : null;
  if (!thread?.isThread()) thread = await createNewsThread(channel);
  if (thread.locked) await thread.setLocked(false, '발로란트 공식 소식 알림 설정');
  if (thread.archived) await thread.setArchived(false, '발로란트 공식 소식 알림 설정');

  const { error: subscriptionError } = await supabase
    .from('valorant_news_subscriptions')
    .upsert({
      guild_id: guild.id,
      channel_id: channel.id,
      thread_id: thread.id,
      enabled: true,
      hour,
      minute,
      last_sent_on: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'guild_id' });
  if (subscriptionError) throw subscriptionError;

  if (articles.length) {
    const { error: deliveryError } = await supabase
      .from('valorant_news_deliveries')
      .upsert(articles.map((article) => ({ guild_id: guild.id, article_id: article.id })), { onConflict: 'guild_id,article_id' });
    if (deliveryError) throw deliveryError;
  }
  return thread;
}

export async function disableNewsNotification(guild) {
  const { data: subscription, error } = await supabase
    .from('valorant_news_subscriptions')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('guild_id', guild.id)
    .select('thread_id')
    .maybeSingle();
  if (error) throw error;
  if (subscription?.thread_id) {
    const thread = await guild.channels.fetch(subscription.thread_id).catch(() => null);
    if (thread?.isThread() && !thread.archived) await thread.setArchived(true, '발로란트 공식 소식 알림 해제');
  }
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
    const thread = await ensureNewsThread(guild, subscription);
    await thread.send({
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
}

async function processNewsNotifications(client) {
  const now = getKstDateParts();
  const today = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const { data: subscriptions, error } = await supabase
    .from('valorant_news_subscriptions')
    .select('guild_id, channel_id, thread_id, hour, minute, last_sent_on')
    .eq('enabled', true);
  if (error) {
    if (error.code !== '42P01' && error.code !== 'PGRST205') console.error(`소식 알림 목록 조회 실패: ${error.message}`);
    return;
  }
  const currentMinute = now.hour * 60 + now.minute;
  const due = (subscriptions ?? []).filter((subscription) =>
    subscription.last_sent_on !== today && currentMinute >= subscription.hour * 60 + subscription.minute);
  if (!due.length) return;

  const articles = await fetchOfficialValorantNews();
  for (const subscription of due) {
    try {
      await sendPendingNews(client, subscription, articles, today);
    } catch (notificationError) {
      console.warn(`소식 알림 전송 실패 (${subscription.guild_id}): ${notificationError.message}`);
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