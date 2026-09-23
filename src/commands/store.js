import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  decryptCredential,
  encryptCredential,
  getStorefront,
  getRiotDisplayName,
  restoreRiotStoreSession,
  resolveBundle,
  resolveSkinOffers,
  resolveStoreItems,
} from '../services/riotAuth.js';
import { supabase } from '../services/supabase.js';
import { autocompleteStoreAccount, persistRotatedSsid } from '../services/storeAccounts.js';

const STORE_VIEW_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const storeViews = new Map();
export const VALORANT_POINTS_IMAGE = readFileSync(new URL('../../asset/vp_img.webp', import.meta.url));

export async function saveStoreSession(userId, accountName, { ssid, puuid, shard, riotName, riotTag }) {
  const encryptedSsid = encryptCredential(ssid);
  const { error } = await supabase.from('riot_store_sessions').upsert({
    discord_id: userId,
    account_name: accountName,
    riot_name: riotName ?? null,
    riot_tag: riotTag ?? null,
    encrypted_ssid: encryptedSsid.encrypted,
    iv: encryptedSsid.iv,
    auth_tag: encryptedSsid.authTag,
    puuid,
    shard,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'discord_id,account_name' });
  if (error) throw error;
}

function formatPrice(cost) {
  const amounts = (Number.isFinite(Number(cost)) ? [Number(cost)] : Object.values(cost ?? {}))
    .map((amount) => Number(amount))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
  return amounts.length ? amounts.join(' / ') : '가격 정보 없음';
}

function hasPrice(cost) {
  return Number.isFinite(Number(cost)) || Object.values(cost ?? {}).some((amount) => Number.isFinite(Number(amount)) && Number(amount) >= 0);
}

function getPriceNumber(cost) {
  const direct = Number(cost);
  if (Number.isFinite(direct)) return direct;
  return Object.values(cost ?? {})
    .map((amount) => Number(amount))
    .find((amount) => Number.isFinite(amount));
}

function formatDiscount(discountPercent, cost, originalCost) {
  const current = getPriceNumber(cost);
  const original = getPriceNumber(originalCost);
  if (current === 0) return '-100%';
  let percent = Number(discountPercent);
  if (percent < 0) percent = 100;
  if (Number.isFinite(original) && Number.isFinite(current) && original > current && (!Number.isFinite(percent) || percent <= 0)) {
    percent = (1 - current / original) * 100;
  }
  if (!Number.isFinite(percent) || percent <= 0) return null;
  percent = percent > 0 && percent < 1 ? percent * 100 : percent;
  return `-${Math.round(percent)}%`;
}

function strikeText(value) {
  return [...String(value)].map((character) => `${character}\u0336`).join('');
}

function formatKst(date) {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function resolveEmbedColor(tierColor) {
  const rgb = typeof tierColor === 'string' ? tierColor.replace('#', '').slice(0, 6) : '';
  return /^[0-9a-f]{6}$/i.test(rgb) ? Number.parseInt(rgb, 16) : 0xff4655;
}

function makeItemEmbeds(items) {
  if (!items.length) {
    return [new EmbedBuilder().setDescription('현재 판매 중인 항목이 없습니다.').setColor(0xff4655)];
  }

  return items.slice(0, 10).map(({ name, image, tierImage, tierColor, cost, originalCost, discountPercent }) => {
    const discount = formatDiscount(discountPercent, cost, originalCost);
    const price = discount && originalCost
      ? `${strikeText(formatPrice(originalCost))} ${formatPrice(cost)} (${discount})`
      : discount ? `${formatPrice(cost)} (${discount})` : formatPrice(cost);
    const embed = new EmbedBuilder().setColor(resolveEmbedColor(tierColor));
    if (image) embed.setThumbnail(image);
    if (tierImage) embed.setAuthor({ name, iconURL: tierImage });
    else embed.setTitle(name);
    if (price !== '가격 정보 없음') {
      embed.setFooter({ text: price, iconURL: 'attachment://vp_img.webp' });
    }
    return embed;
  });
}

function makeBundleEmbeds(bundle, items, cost, originalCost, discountPercent, schedule) {
  if (!bundle) return makeItemEmbeds([]);
  const discount = formatDiscount(discountPercent, cost, originalCost);
  const hasDiscountedPrice = discount && hasPrice(cost) && hasPrice(originalCost);
  const price = hasDiscountedPrice
    ? `${strikeText(formatPrice(originalCost))} ${formatPrice(cost)} (${discount})`
    : discount && hasPrice(cost) ? `${formatPrice(cost)} (${discount})` : hasPrice(cost) ? formatPrice(cost) : '';
  const summary = new EmbedBuilder().setTitle(bundle.name).setColor(0xff4655);
  if (bundle.image) summary.setImage(bundle.image);
  if (price) {
    summary.setFooter({ text: price, iconURL: 'attachment://vp_img.webp' });
  }
  if (schedule.endsAt) {
    summary.addFields({ name: '판매 종료일', value: formatKst(schedule.endsAt), inline: false });
  }
  return [summary, ...makeItemEmbeds(items)].slice(0, 10);
}

function getAccessoryItemIds(storefront) {
  return (storefront.AccessoryStore?.AccessoryStoreOffers ?? []).flatMap(
    ({ Offer }) => Offer?.Rewards?.map((reward) => reward.ItemID) ?? []
  );
}

function getPriceByRewardId(offers) {
  const prices = new Map();
  for (const offer of offers) {
    const details = offer.Offer ?? offer;
    for (const reward of details.Rewards ?? []) prices.set(reward.ItemID, details.Cost);
  }
  return prices;
}

function getNightMarketOfferDetails(storefront) {
  return (storefront.BonusStore?.BonusStoreOffers ?? []).flatMap((entry) =>
    (entry.Offer?.Rewards ?? []).map((reward) => ({
      itemId: reward.ItemID,
      cost: entry.DiscountCosts ?? entry.Offer.Cost,
      originalCost: entry.Offer.Cost,
      discountPercent: entry.DiscountPercent,
    }))
  );
}

function getBundleEndDate(bundle, fallbackDuration = null) {
  const duration = bundle?.DurationRemainingInSeconds ?? fallbackDuration;
  return Number.isFinite(duration) && duration >= 0
    ? new Date(Date.now() + duration * 1000)
    : null;
}

function buildViewPayload(view) {
  const page = view.pages[view.index];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`store-view:${view.id}:previous`)
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.index === 0),
    new ButtonBuilder()
      .setCustomId(`store-view:${view.id}:next`)
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(view.index === view.pages.length - 1),
    new ButtonBuilder()
      .setCustomId(`store-view:${view.id}:night-market`)
      .setLabel('야시장')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!view.hasNightMarket)
  );
  return {
    content: `상점 계정: **${view.accountName}**${view.riotName && view.riotTag ? ` · ${view.riotName}#${view.riotTag}` : ''}`,
    embeds: page.embeds,
    components: [row],
    files: [new AttachmentBuilder(VALORANT_POINTS_IMAGE, { name: 'vp_img.webp' })],
  };
}

export async function createStorePages(session, favoriteNames = []) {
  const storefront = await getStorefront(session);
  const offerIds = storefront.SkinsPanelLayout.SingleItemOffers;
  const dailyOffers = storefront.SkinsPanelLayout.SingleItemStoreOffers ?? [];
  const accessoryOffers = storefront.AccessoryStore?.AccessoryStoreOffers ?? [];
  const accessoryIds = getAccessoryItemIds(storefront);
  const nightMarketDetails = getNightMarketOfferDetails(storefront);
  const featuredBundle = storefront.FeaturedBundle?.Bundle;
  const bundleEntries = (featuredBundle?.Items ?? []).filter(({ Item }) => Item?.ItemID);
  const bundleItemIds = bundleEntries.map(({ Item }) => Item.ItemID);
  const [offers, accessories, bundle, bundleContents, nightMarketOffers] = await Promise.all([
    resolveSkinOffers(offerIds),
    resolveStoreItems(accessoryIds),
    resolveBundle(featuredBundle?.ID, featuredBundle?.DataAssetID),
    resolveStoreItems(bundleItemIds),
    resolveSkinOffers(nightMarketDetails.map(({ itemId }) => itemId)),
  ]);
  const dailyPrices = getPriceByRewardId(dailyOffers);
  const accessoryPrices = getPriceByRewardId(accessoryOffers);

  const dailyItems = offers.map((offer, index) => ({ ...offer, cost: dailyPrices.get(offerIds[index]) }));
  const bundleItems = bundleContents.map((item, index) => ({
    ...item,
    cost: bundleEntries[index].DiscountedPrice ?? bundleEntries[index].BasePrice,
    originalCost: bundleEntries[index].BasePrice,
    discountPercent: bundleEntries[index].DiscountPercent,
  }));
  const bundlePage = featuredBundle ? {
    embeds: makeBundleEmbeds(
      bundle,
      bundleItems,
      featuredBundle.TotalDiscountedCost ?? featuredBundle.TotalBaseCost,
      featuredBundle.TotalBaseCost,
      featuredBundle.TotalDiscountPercent,
      { endsAt: getBundleEndDate(featuredBundle, storefront.FeaturedBundle?.BundleRemainingDurationInSeconds) },
    ),
  } : null;
  const [dailyPage, accessoryPage, nightMarketPage] = [
    { embeds: makeItemEmbeds(dailyItems) },
    { embeds: makeItemEmbeds(accessories.map((accessory, index) => ({ ...accessory, cost: accessoryPrices.get(accessoryIds[index]) }))) },
    nightMarketDetails.length
      ? { embeds: makeItemEmbeds(nightMarketOffers.map((offer, index) => ({ ...offer, ...nightMarketDetails[index] }))) }
      : null,
  ];
  const favoriteSet = new Set(favoriteNames.map((name) => name.toLocaleLowerCase('ko-KR')));
  const favoriteMatches = offers
    .map((offer) => offer.name)
    .filter((name) => favoriteSet.has(name.toLocaleLowerCase('ko-KR')));
  const favoriteEmbeds = makeItemEmbeds(dailyItems.filter((item) =>
    favoriteSet.has(item.name.toLocaleLowerCase('ko-KR'))));

  const pages = [
    dailyPage,
    accessoryPage,
    ...(bundlePage ? [bundlePage] : []),
  ];
  if (nightMarketPage) pages.push(nightMarketPage);
  return { pages, hasNightMarket: nightMarketDetails.length > 0, favoriteMatches, favoriteEmbeds };
}

export const data = new SlashCommandBuilder()
  .setName('상점')
  .setDescription('오늘의 상점 내역을 조회합니다 (/상점연동 필요).')
  .addStringOption((opt) =>
    opt.setName('계정명').setDescription('조회할 연동 계정명 (미지정 시 실제 Riot 닉네임)').setRequired(false).setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  await autocompleteStoreAccount(interaction);
}

export async function execute(interaction) {
  await interaction.deferReply();
  const requestedAccountName = interaction.options.getString('계정명')?.trim();
  const hasExplicitAccountName = Boolean(requestedAccountName);
  let accountName = requestedAccountName || '기본계정';

  let accountQuery = supabase
    .from('riot_store_sessions')
    .select('*')
    .eq('discord_id', interaction.user.id);
  accountQuery = hasExplicitAccountName
    ? accountQuery.eq('account_name', accountName)
    : accountQuery.eq('is_default', true);
  let { data: cred, error } = await accountQuery.maybeSingle();

  if (!cred && !hasExplicitAccountName) {
    const fallback = await supabase
      .from('riot_store_sessions')
      .select('*')
      .eq('discord_id', interaction.user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    cred = fallback.data;
    error = fallback.error;
    if (cred) accountName = cred.account_name;
  }

  if (error || !cred) {
    await interaction.editReply(
      `상점 계정 **${accountName}**이(가) 등록되어 있지 않습니다.\n` +
      `먼저 \/상점연동 계정명:${accountName} 으로 Riot 계정을 연결해주세요.\n` +
      '등록된 계정 확인: `/상점계정목록`'
    );
    return;
  }

  try {
    const ssid = decryptCredential({ encrypted: cred.encrypted_ssid, iv: cred.iv, authTag: cred.auth_tag });
    const session = await restoreRiotStoreSession({ ssid, puuid: cred.puuid, shard: cred.shard });
    await persistRotatedSsid(interaction.user.id, accountName, session);
    let riotName = cred.riot_name;
    let riotTag = cred.riot_tag;
    if (!riotName || !riotTag) {
      try {
        const displayName = await getRiotDisplayName(session);
        riotName = displayName?.riotName ?? riotName;
        riotTag = displayName?.riotTag ?? riotTag;
        if (riotName && riotTag) {
          await supabase
            .from('riot_store_sessions')
            .update({ riot_name: riotName, riot_tag: riotTag, updated_at: new Date().toISOString() })
            .eq('discord_id', interaction.user.id)
            .eq('account_name', accountName);

          if (accountName === '기본계정') {
            const displayAccountName = `${riotName}#${riotTag}`;
            const { error: renameError } = await supabase
              .from('riot_store_sessions')
              .update({ account_name: displayAccountName })
              .eq('discord_id', interaction.user.id)
              .eq('account_name', accountName);
            if (!renameError) accountName = displayAccountName;
          }
        }
      } catch (error) {
        console.warn(`Riot 닉네임 조회 실패: ${error.message}`);
      }
    }
    const view = {
      id: crypto.randomUUID(),
      userId: interaction.user.id,
      accountName,
      riotName,
      riotTag,
      ...(await createStorePages(session)),
      index: 0,
      expiresAt: Date.now() + STORE_VIEW_TIMEOUT_MS,
    };
    storeViews.set(view.id, view);
    setTimeout(() => storeViews.delete(view.id), STORE_VIEW_TIMEOUT_MS).unref();
    await interaction.editReply(buildViewPayload(view));
  } catch (err) {
    if (err.code === 'RIOT_SESSION_EXPIRED') {
      await interaction.editReply(
        `Riot 로그인 세션이 만료되었습니다. **/상점연동 계정명:${accountName}** 을 다시 실행해 로그인한 후 상점을 조회해주세요.`
      );
      return;
    }
    if (err.code === 'RIOT_SERVICE_UNAVAILABLE') {
      await interaction.editReply(err.message);
      return;
    }
    await interaction.editReply(`상점 조회에 실패했습니다: ${err.message}`);
  }
}

export async function handleComponent(interaction) {
  const [, viewId, direction] = interaction.customId.split(':');
  const view = storeViews.get(viewId);
  if (!view || view.expiresAt <= Date.now()) {
    storeViews.delete(viewId);
    await interaction.reply({ content: '상점 화면이 만료되었습니다. `/상점`을 다시 실행해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (view.userId !== interaction.user.id) {
    await interaction.reply({ content: '상점을 조회한 사용자만 화면을 전환할 수 있습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (direction === 'night-market') {
    view.index = view.pages.length - 1;
  } else {
    view.index += direction === 'next' ? 1 : -1;
  }
  view.index = Math.max(0, Math.min(view.index, view.pages.length - 1));
  await interaction.update(buildViewPayload(view));
}
