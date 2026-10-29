import { getMMR, getMatchSummary } from './henrik.js';
import { computePowerScore } from './scoring.js';
import { supabase } from './supabase.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const SCORE_VERSION_UPDATED_AT = new Date('2026-10-29T00:00:00.000Z').getTime();
export const MATCH_LOOKUP_SIZES = [20, 50, 100];
export const MATCHES_TO_CONSIDER = 10;

async function retryRateLimited(operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error?.response?.status !== 429 || attempt === 2) throw error;
      const retryAfter = Number(error.response.headers?.['retry-after']);
      const waitMilliseconds = Number.isFinite(retryAfter) ? retryAfter * 1000 : 3000 * 2 ** attempt;
      await sleep(Math.min(waitMilliseconds, 15_000));
    }
  }
}

/**
 * Latest competitive/unrated match summary (deathmatch-style modes would skew ACS/KDA).
 * Widens the lookup until MATCHES_TO_CONSIDER games are found, else returns the widest partial result.
 */
export async function getLatestAvailableMatchSummary(region, name, tag) {
  let lastError;
  let partialSummary;
  for (const size of MATCH_LOOKUP_SIZES) {
    try {
      const summary = await retryRateLimited(() => getMatchSummary(region, name, tag, size));
      if (summary.gamesConsidered >= MATCHES_TO_CONSIDER) return summary;
      if (summary.gamesConsidered > 0) partialSummary = summary;
    } catch (error) {
      lastError = error;
      if (error?.response?.status && error.response.status !== 404 && error.response.status !== 429) throw error;
    }
    if (size !== MATCH_LOOKUP_SIZES.at(-1)) await sleep(1_000);
  }
  if (partialSummary) return partialSummary;
  throw lastError ?? new Error('조회 가능한 최근 매치 기록이 없습니다.');
}

export async function savePowerScoreCache(discordId, { mmr, matchSummary, powerScore }) {
  const { error } = await supabase.from('stats_cache').upsert({
    discord_id: discordId,
    kda: matchSummary.kda,
    acs: matchSummary.acs,
    top_agents: matchSummary.topAgents,
    map_winrates: matchSummary.mapWinrates,
    current_tier: mmr.currentTier,
    peak_tier: mmr.peakTier,
    power_score: powerScore,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error(`전적 캐시 저장 실패 (${discordId}): ${error.message}`);
}

export async function getOrRefreshPowerScore(discordUser) {
  const { data: player } = await supabase
    .from('players')
    .select('*')
    .eq('discord_id', discordUser.id)
    .single();

  if (!player) throw new Error(`${discordUser.username}님은 \`/계정등록\`을 먼저 해야 합니다.`);

  const { data: cache } = await supabase
    .from('stats_cache')
    .select('*')
    .eq('discord_id', discordUser.id)
    .single();

  const cacheUpdatedAt = cache ? new Date(cache.updated_at).getTime() : 0;
  const isFresh = cache && cacheUpdatedAt >= SCORE_VERSION_UPDATED_AT && Date.now() - cacheUpdatedAt < 30 * 60 * 1000;
  if (isFresh) {
    return {
      id: discordUser.id,
      name: player.riot_name,
      powerScore: cache.power_score,
      currentTier: cache.current_tier,
      peakTier: cache.peak_tier,
      kda: cache.kda,
      acs: cache.acs,
    };
  }

  let mmr;
  let matchSummary;
  try {
    [mmr, matchSummary] = await Promise.all([
      getMMR(player.region, player.riot_name, player.riot_tag),
      getLatestAvailableMatchSummary(player.region, player.riot_name, player.riot_tag),
    ]);
  } catch (error) {
    if (cache) {
      return {
        id: discordUser.id,
        name: player.riot_name,
        powerScore: cache.power_score,
        currentTier: cache.current_tier,
        peakTier: cache.peak_tier,
        kda: cache.kda,
        acs: cache.acs,
      };
    }
    throw error;
  }
  const powerScore = computePowerScore({
    kda: matchSummary.kda,
    acs: matchSummary.acs,
    currentTier: mmr.currentTier,
    peakTier: mmr.peakTier,
  });

  await savePowerScoreCache(discordUser.id, { mmr, matchSummary, powerScore });

  return {
    id: discordUser.id,
    name: player.riot_name,
    powerScore,
    currentTier: mmr.currentTier,
    peakTier: mmr.peakTier,
    kda: matchSummary.kda,
    acs: matchSummary.acs,
  };
}

export async function getPowerScoreForRiotAccount(name, tag, region) {
  const [mmr, matchSummary] = await Promise.all([
    retryRateLimited(() => getMMR(region, name, tag)),
    getLatestAvailableMatchSummary(region, name, tag),
  ]);
  const powerScore = computePowerScore({
    kda: matchSummary.kda,
    acs: matchSummary.acs,
    currentTier: mmr.currentTier,
    peakTier: mmr.peakTier,
  });

  return {
    name,
    tag,
    region,
    powerScore,
    currentTier: mmr.currentTier,
    peakTier: mmr.peakTier,
    kda: matchSummary.kda,
    acs: matchSummary.acs,
  };
}
